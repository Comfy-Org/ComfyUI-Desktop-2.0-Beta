import fs from 'fs'
import path from 'path'
import { execFile, spawn } from 'child_process'
import { killProcTree } from './process'

/** Regex matching PyTorch-family packages that must never be overwritten by pip. */
export const PYTORCH_RE = /^(torch|torchvision|torchaudio|torchsde)(\s*[<>=!~;[#]|$)/i

/** Name prefixes for the CUDA runtime/accelerator distributions whose installed
 *  builds must be preserved across pip operations. CUDA wheels are served only
 *  from download.pytorch.org, which is never part of the update index set, so
 *  letting `uv pip install --upgrade` re-resolve these would silently swap a CUDA
 *  build for the CPU wheel PyPI/mirrors serve on Windows. */
export const CUDA_RUNTIME_PREFIXES = ['nvidia', 'triton', 'cuda'] as const

/** True when a package belongs to the torch/CUDA family that must never be
 *  re-resolved during an update: `torch`/`torchvision`/`torchaudio`/`torchsde`
 *  (shared with the requirements-line filter via `PYTORCH_RE`), other `torch-*`
 *  distributions like `torch-tensorrt`, and the `nvidia`/`triton`/`cuda` runtime
 *  libraries (incl. dashed/underscored variants such as `nvidia-cuda-runtime-cu12`). */
export function isTorchFamilyPackage(name: string): boolean {
  const trimmed = name.trim()
  if (PYTORCH_RE.test(trimmed)) return true
  const lower = trimmed.toLowerCase()
  if (lower.startsWith('torch-') || lower.startsWith('torch_')) return true
  return CUDA_RUNTIME_PREFIXES.some(
    (prefix) => lower === prefix || lower.startsWith(prefix + '-') || lower.startsWith(prefix + '_')
  )
}

/** Build `name==version` constraint lines pinning every installed torch-family
 *  package to its current version. Editable installs and direct URL/VCS
 *  references are skipped (they have no plain version to pin). Pure so it can be
 *  unit-tested without spawning uv. */
export function torchConstraintLinesFrom(installed: Record<string, string>): string[] {
  const lines: string[] = []
  for (const [name, version] of Object.entries(installed)) {
    if (!isTorchFamilyPackage(name)) continue
    if (version.startsWith('-e ') || version.includes('://') || version.includes('@')) continue
    lines.push(`${name}==${version}`)
  }
  return lines
}

/** Run a uv pip command and stream output. Returns the exit code. */
export function runUvPip(
  uvPath: string,
  args: string[],
  cwd: string,
  sendOutput: (text: string) => void,
  signal?: AbortSignal
): Promise<number> {
  if (signal?.aborted) return Promise.resolve(1)
  return new Promise<number>((resolve) => {
    const proc = spawn(uvPath, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })

    const onAbort = (): void => {
      killProcTree(proc)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()

    proc.stdout.on('data', (chunk: Buffer) => sendOutput(chunk.toString('utf-8')))
    proc.stderr.on('data', (chunk: Buffer) => sendOutput(chunk.toString('utf-8')))
    proc.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort)
      sendOutput(`Error: ${err.message}\n`)
      resolve(1)
    })
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      resolve(code ?? 1)
    })
  })
}

export interface PipMirrorConfig {
  pypiMirror?: string
  useChineseMirrors?: boolean
}

/** Write a constraints file pinning the currently-installed torch-family packages
 *  to their exact versions, so a subsequent `uv pip install --upgrade` keeps the
 *  CUDA build instead of re-resolving to the CPU wheel. Returns the file path, or
 *  null if nothing needs pinning (or the freeze failed). The caller owns deletion. */
export async function writeTorchConstraintsFile(
  uvPath: string,
  pythonPath: string,
  installPath: string,
  tempName: string,
): Promise<string | null> {
  let installed: Record<string, string>
  try {
    installed = await pipFreeze(uvPath, pythonPath)
  } catch {
    return null
  }
  const lines = torchConstraintLinesFrom(installed)
  if (lines.length === 0) return null
  const constraintPath = path.join(installPath, tempName)
  await fs.promises.writeFile(constraintPath, lines.join('\n') + '\n', 'utf-8')
  return constraintPath
}

/** Install a requirements file via `uv pip install -r`, filtering out PyTorch packages first.
 *  Pass `upgrade: true` to add `--upgrade` so already-installed packages whose pinned versions
 *  drifted (e.g. the bundled venv's `comfy-aimdo` lagging ComfyUI's `requirements.txt`) get
 *  reconciled instead of skipped by uv's satisfaction check. `upgrade` also pins the installed
 *  torch/CUDA family via `--constraint` (see body) since that is the only mode that can swap it. */
export async function installFilteredRequirements(
  reqPath: string,
  uvPath: string,
  pythonPath: string,
  installPath: string,
  tempName: string,
  sendOutput: (text: string) => void,
  signal?: AbortSignal,
  mirrors?: PipMirrorConfig,
  upgrade = false,
): Promise<number> {
  const content = await fs.promises.readFile(reqPath, 'utf-8')
  const filtered = content.split('\n').filter((l) => !PYTORCH_RE.test(l.trim())).join('\n')
  const filteredPath = path.join(installPath, tempName)
  await fs.promises.writeFile(filteredPath, filtered, 'utf-8')

  let constraintPath: string | null = null
  try {
    // Only `--upgrade` re-resolves the whole graph, letting transitive consumers
    // (kornia/spandrel) pull a CPU torch over the installed CUDA build when
    // download.pytorch.org isn't in the index set. Pin the installed torch/CUDA
    // family there so that can't happen — critical for China users, whose Manager
    // `PIPFixer` reactive repair reinstalls from download.pytorch.org and so can't
    // recover. Plain installs (custom-node deps, snapshot restore, adoption) never
    // re-resolve an already-satisfied torch, so a hard `--constraint` there would
    // only risk failing otherwise-fine installs and distorting restores; the
    // PYTORCH_RE line filter plus restore's file-level torch protection cover those.
    if (upgrade) {
      constraintPath = await writeTorchConstraintsFile(uvPath, pythonPath, installPath, `${tempName}.constraints`)
    }

    const indexArgs = getPipIndexArgs(mirrors?.pypiMirror, mirrors?.useChineseMirrors)
    const upgradeArg = upgrade ? ['--upgrade'] : []
    const constraintArg = constraintPath ? ['--constraint', constraintPath] : []
    return await runUvPip(uvPath, ['pip', 'install', ...upgradeArg, '-r', filteredPath, ...constraintArg, '--python', pythonPath, ...indexArgs], installPath, sendOutput, signal)
  } finally {
    try { await fs.promises.unlink(filteredPath) } catch {}
    if (constraintPath) { try { await fs.promises.unlink(constraintPath) } catch {} }
  }
}

/** The canonical PyPI index — always used as the primary `--index-url`. */
export const PYPI_INDEX_URL = 'https://pypi.org/simple/'

/** Additional PyPI mirror URLs for regions with restricted access (e.g. China). */
export const PYPI_MIRROR_URLS: string[] = [
  'https://mirrors.aliyun.com/pypi/simple/',
  'https://mirrors.cloud.tencent.com/pypi/simple/',
]

/** Trim whitespace and ensure a trailing slash for consistent URL comparison. */
function normalizeIndexUrl(url: string): string {
  const trimmed = url.trim()
  return trimmed.endsWith('/') ? trimmed : trimmed + '/'
}

export function getPipIndexArgs(pypiMirror?: string, useChineseMirrors?: boolean): string[] {
  const mirror = pypiMirror?.trim() || undefined

  // Primary --index-url priority: user mirror, then first Chinese mirror, then pypi.org.
  // The Chinese mirror goes first (not pypi.org as a fallback extra) to avoid uv's first-match
  // strategy stalling on the unreachable pypi.org before falling back.
  let primary: string
  if (mirror) {
    primary = mirror
  } else if (useChineseMirrors && PYPI_MIRROR_URLS.length > 0) {
    primary = PYPI_MIRROR_URLS[0]!
  } else {
    primary = PYPI_INDEX_URL
  }

  const args: string[] = ['--index-url', primary]
  const seen = new Set<string>([normalizeIndexUrl(primary)])
  const extras: string[] = []

  const pypiNorm = normalizeIndexUrl(PYPI_INDEX_URL)
  if (!seen.has(pypiNorm)) {
    extras.push(PYPI_INDEX_URL)
    seen.add(pypiNorm)
  }

  if (useChineseMirrors) {
    for (const url of PYPI_MIRROR_URLS) {
      const norm = normalizeIndexUrl(url)
      if (!seen.has(norm)) {
        extras.push(url)
        seen.add(norm)
      }
    }
  }

  for (const url of extras) {
    args.push('--extra-index-url', url)
  }
  return args
}

export async function pipFreeze(uvPath: string, pythonPath: string): Promise<Record<string, string>> {
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      uvPath,
      ['pip', 'freeze', '--python', pythonPath],
      { windowsHide: true, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = stderr ? stderr.slice(0, 500) : err.message
          return reject(new Error(`uv pip freeze failed: ${detail}`))
        }
        resolve(stdout)
      }
    )
  })

  const packages: Record<string, string> = {}
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    // Editable installs: "-e git+https://...@commit#egg=name"
    if (trimmed.startsWith('-e ')) {
      const eggMatch = trimmed.match(/#egg=(.+)/)
      if (eggMatch) {
        packages[eggMatch[1]!] = trimmed
      }
      continue
    }
    // PEP 508 direct references: "package @ git+https://..." or "package @ file:///..."
    const atMatch = trimmed.match(/^([A-Za-z0-9_.-]+)\s*@\s*(.+)$/)
    if (atMatch) {
      packages[atMatch[1]!] = atMatch[2]!.trim()
      continue
    }
    // Standard: "package==version"
    const eqIdx = trimmed.indexOf('==')
    if (eqIdx > 0) {
      packages[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 2)
    }
  }
  return packages
}
