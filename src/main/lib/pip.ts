import { execFile } from 'child_process'

/**
 * PyPI fallback index URLs for users in regions with restricted access
 * to default package sources (e.g. China). Mirrors Desktop's constant.
 */
export const PYPI_FALLBACK_INDEX_URLS: string[] = [
  'https://mirrors.aliyun.com/pypi/simple/',
  'https://mirrors.cloud.tencent.com/pypi/simple/',
  'https://pypi.org/simple/',
]

/**
 * Build `--index-url` and `--extra-index-url` arguments for uv pip commands.
 * When a user-configured mirror is set it becomes the primary index and all
 * other fallbacks are added as extras. When no mirror is set the fallbacks
 * are still added as extras so uv can try them automatically.
 */

/** Trim whitespace and ensure a trailing slash for consistent URL comparison. */
function normalizeIndexUrl(url: string): string {
  const trimmed = url.trim()
  return trimmed.endsWith('/') ? trimmed : trimmed + '/'
}

export function getPipIndexArgs(pypiMirror?: string): string[] {
  const args: string[] = []
  const mirror = pypiMirror?.trim() || undefined
  if (mirror) {
    args.push('--index-url', mirror)
  }
  const normalizedMirror = mirror ? normalizeIndexUrl(mirror) : undefined
  const fallbacks = PYPI_FALLBACK_INDEX_URLS.filter(
    (url) => normalizeIndexUrl(url) !== normalizedMirror
  )
  for (const url of fallbacks) {
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
