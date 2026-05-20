import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'

import { detectDesktopInstall, captureDesktopSnapshot, type DesktopInstallInfo } from './desktopDetect'
import { defaultInstallDir, allocateUniqueDir, sanitizeDirName } from './paths'
import { gitClone, gitCheckoutCommit } from './git'
import { getComfyUIRemoteUrl } from './github-mirror'
import * as installations from '../installations'
import type { InstallationRecord } from '../installations'
import * as settings from '../settings'
import * as telemetry from './telemetry'

const MARKER_FILE = '.comfyui-desktop-2'
const LEGACY_VERSION_FILE = '.comfyui-legacy-version'
const STAGED_SOURCE_REL = path.join('legacy-staging', 'comfyui')
const BACKUP_REL = 'legacy-backup'
const SNAPSHOTS_REL = '.snapshots'
const ADOPT_INSTALL_NAME = 'Adopted from Legacy Desktop'
const COMFY_SETTINGS_FILE = 'comfy.settings.json'
const DESKTOP_CONFIG_FILE = 'config.json'
const EXTRA_MODELS_YAML = 'extra_models_config.yaml'
const WINDOW_FILE = 'window.json'
const VENV_VALIDATE_TIMEOUT_MS = 30_000

export type AdoptTrigger = 'beta-action' | 'first-launch-cutover'

export type AdoptPromptKind = 'tcc' | 'venv-broken' | 'source-missing' | 'confirm-adopt'

export type UserChoice =
  | { kind: 'tcc'; choice: 'continue' | 'denied' }
  | { kind: 'venv-broken'; choice: 'use-anyway' | 'cancel' }
  | { kind: 'source-missing'; choice: 'switch-to-managed' | 'retry' | 'cancel' }
  | { kind: 'confirm-adopt'; choice: 'yes' | 'no' }

export interface AdoptTools {
  sendProgress: (phase: string, detail: Record<string, unknown>) => void
  sendOutput: (text: string) => void
  signal: AbortSignal
  promptUser: (kind: AdoptPromptKind, ctx?: unknown) => Promise<UserChoice>
}

export interface AdoptDeps {
  detectDesktopInstall: typeof detectDesktopInstall
  captureDesktopSnapshot: typeof captureDesktopSnapshot
  validateLegacyVenv: (pythonPath: string, signal: AbortSignal) => Promise<{ ok: true } | { ok: false; message: string }>
  copyStagedSource: (src: string, dest: string) => Promise<void>
  cloneSourceFromGit: (
    url: string,
    dest: string,
    ref: string | null,
    sendOutput: (t: string) => void,
    signal: AbortSignal,
  ) => Promise<{ ok: true } | { ok: false; message: string }>
  now: () => Date
}

export interface AdoptOptions {
  trigger: AdoptTrigger
  tools: AdoptTools
  /** @internal — tests override to inject mocks. */
  deps?: Partial<AdoptDeps>
}

export type AdoptSourceMode = 'pre-swap-copy' | 'git-clone-fallback'

/** Subset of legacy `comfy.settings.json` consumed by the orchestrator. */
interface LegacyConsent {
  sendStatistics?: boolean
}

/**
 * Default sensible non-interactive responses for cutover (silent) adoption.
 */
function defaultCutoverChoice(kind: AdoptPromptKind): UserChoice {
  switch (kind) {
    case 'tcc': return { kind: 'tcc', choice: 'continue' }
    case 'venv-broken': return { kind: 'venv-broken', choice: 'use-anyway' }
    case 'source-missing': return { kind: 'source-missing', choice: 'switch-to-managed' }
    case 'confirm-adopt': return { kind: 'confirm-adopt', choice: 'yes' }
  }
}

/**
 * Spawn the legacy `.venv` Python with a tiny torch-import probe; resolves
 * `{ ok: true }` on a clean exit and `{ ok: false, message }` otherwise.
 *
 * Captures both stdout and stderr and includes them in failure messages so
 * the prompt UI can show the real error (missing torch, broken DLL, etc.).
 */
export function validateLegacyVenvDefault(
  pythonPath: string,
  signal: AbortSignal,
): Promise<{ ok: true } | { ok: false; message: string }> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ ok: false, message: 'aborted' })
      return
    }
    const child = execFile(
      pythonPath,
      ['-c', 'import sys, torch; sys.stdout.write("ok")'],
      { windowsHide: true, timeout: VENV_VALIDATE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (signal.aborted) {
          resolve({ ok: false, message: 'aborted' })
          return
        }
        if (err) {
          const out = (stderr || '').toString().trim() || (stdout || '').toString().trim() || err.message
          resolve({ ok: false, message: out.slice(0, 1000) })
          return
        }
        if (stdout.toString().trim() !== 'ok') {
          resolve({ ok: false, message: `unexpected stdout: ${stdout.toString().slice(0, 200)}` })
          return
        }
        resolve({ ok: true })
      },
    )
    const onAbort = (): void => {
      try { child.kill() } catch {}
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Copy the pre-staged `<userData>/legacy-staging/comfyui` tree into
 * `<installPath>/ComfyUI`. Caller has already validated the staged copy.
 */
export async function copyStagedSourceDefault(src: string, dest: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true })
  await fs.promises.cp(src, dest, { recursive: true })
}

/**
 * Shallow-clone the upstream ComfyUI repo into `dest` and check out a
 * specific ref when provided.
 */
export async function cloneSourceFromGitDefault(
  url: string,
  dest: string,
  ref: string | null,
  sendOutput: (t: string) => void,
  signal: AbortSignal,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const cloneResult = await gitClone(url, dest, sendOutput, signal)
  if (cloneResult.exitCode !== 0) {
    return { ok: false, message: cloneResult.stderr.slice(0, 1000) || 'clone failed' }
  }
  if (ref) {
    const checkout = await gitCheckoutCommit(dest, ref, sendOutput, signal)
    if (checkout.exitCode !== 0) {
      return { ok: false, message: checkout.stderr.slice(0, 1000) || `checkout ${ref} failed` }
    }
  }
  return { ok: true }
}

/**
 * Pull out every `base_path:` string value at the YAML's first nesting depth.
 * Tolerates single/double quotes and trailing comments. Per-folder overrides
 * (other keys under each section) are intentionally ignored.
 */
export function parseExtraModelsYaml(content: string): string[] {
  const out: string[] = []
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '')
    const m = line.match(/^\s+base_path\s*:\s*(.+?)\s*$/)
    if (!m) continue
    let value = m[1]!.trim()
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1)
    }
    if (value) out.push(value)
  }
  return out
}

/**
 * Build the user-facing `launchArgs` string for an adopted install from the
 * legacy `comfy.settings.json` blob (a flat dotted-key map).
 */
export function deriveLaunchArgs(comfySettings: Record<string, unknown>): string {
  const listen = typeof comfySettings['server_config.listen'] === 'string'
    ? (comfySettings['server_config.listen'] as string)
    : '127.0.0.1'
  const portRaw = comfySettings['server_config.port']
  const port = typeof portRaw === 'number' ? portRaw
    : typeof portRaw === 'string' && portRaw.trim() !== '' ? Number(portRaw)
    : 8000
  const parts: string[] = ['--listen', listen, '--port', String(port), '--enable-manager']
  const extra = comfySettings['extra_server_args']
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    for (const [key, value] of Object.entries(extra as Record<string, unknown>)) {
      if (!key) continue
      if (value === undefined || value === null) continue
      const strVal = String(value)
      if (strVal === '') {
        parts.push(`--${key}`)
      } else {
        parts.push(`--${key}`, strVal)
      }
    }
  }
  return parts.join(' ')
}

/**
 * Read & coerce the subset of legacy front-end settings the orchestrator
 * actually uses. Missing values fall back to legacy defaults.
 */
function readLegacyComfySettings(configDir: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(path.join(configDir, COMFY_SETTINGS_FILE), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {}
  return {}
}

function readLegacyConsent(raw: Record<string, unknown>): LegacyConsent {
  return {
    sendStatistics: typeof raw['Comfy-Desktop.SendStatistics'] === 'boolean' ? raw['Comfy-Desktop.SendStatistics'] as boolean : undefined,
  }
}

function readLegacyDesktopConfig(configDir: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(path.join(configDir, DESKTOP_CONFIG_FILE), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {}
  return {}
}

function readLegacyVersionFile(basePath: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(basePath, LEGACY_VERSION_FILE), 'utf-8').trim()
    return raw || null
  } catch {
    return null
  }
}

/**
 * Best-effort: read the legacy desktop app's `package.json` version from the
 * bundle next to the executable. Returns `null` when the bundle is gone
 * (post-cutover) or the file is unreadable.
 */
function readLegacyAppVersion(executablePath: string | null): string | null {
  if (!executablePath) return null
  const candidates: string[] = []
  if (process.platform === 'win32') {
    candidates.push(path.join(path.dirname(executablePath), 'resources', 'app', 'package.json'))
  } else if (process.platform === 'darwin') {
    candidates.push(path.join(executablePath, 'Contents', 'Resources', 'app', 'package.json'))
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as Record<string, unknown>
      if (typeof parsed.version === 'string' && parsed.version) return parsed.version
    } catch {}
  }
  return null
}

/**
 * Compute the cross-install model dirs to register in `settings.modelsDirs`
 * for the adopted record. Dedupes against the caller's existing list.
 */
export function computeModelsDirsToCarry(
  basePath: string,
  extraYamlContent: string | null,
  existing: string[],
): string[] {
  const candidates: string[] = []
  candidates.push(path.join(basePath, 'models'))
  if (extraYamlContent) {
    for (const dir of parseExtraModelsYaml(extraYamlContent)) {
      candidates.push(dir)
    }
  }
  const seen = new Set(existing.map((d) => path.resolve(d)))
  const out: string[] = []
  for (const dir of candidates) {
    const resolved = path.resolve(dir)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    out.push(resolved)
  }
  return out
}

/**
 * Best-effort copy of legacy userData files into a timestamped backup folder.
 * Logged on failure but never throws so adoption can continue.
 */
async function backupLegacyState(configDir: string, timestamp: string, sendOutput: (t: string) => void): Promise<void> {
  const destDir = path.join(configDir, BACKUP_REL, timestamp)
  try {
    await fs.promises.mkdir(destDir, { recursive: true })
  } catch (err) {
    sendOutput(`Warning: could not create backup dir: ${(err as Error).message}\n`)
    return
  }
  const files = [DESKTOP_CONFIG_FILE, COMFY_SETTINGS_FILE, EXTRA_MODELS_YAML, WINDOW_FILE]
  for (const file of files) {
    const src = path.join(configDir, file)
    const dst = path.join(destDir, file)
    try {
      if (fs.existsSync(src)) await fs.promises.copyFile(src, dst)
    } catch (err) {
      sendOutput(`Warning: backup of ${file} failed: ${(err as Error).message}\n`)
    }
  }
}

/**
 * Inspect `<userData>/legacy-staging/comfyui` and verify it contains a
 * recognisable ComfyUI source tree whose embedded version matches the
 * legacy `.comfyui-legacy-version` token (when both are present).
 */
/**
 * Read the upstream version embedded in a ComfyUI source tree's
 * `comfyui_version.py`, which looks like `__version__ = "0.3.45"`.
 */
function readComfyVersion(sourceDir: string): string | null {
  try {
    const content = fs.readFileSync(path.join(sourceDir, 'comfyui_version.py'), 'utf-8')
    const m = content.match(/__version__\s*=\s*['"]([^'"]+)['"]/)
    return m ? m[1]!.trim() : null
  } catch {
    return null
  }
}

function isStagedSourceValid(stagingDir: string, expectedVersion: string | null): boolean {
  if (!fs.existsSync(path.join(stagingDir, 'main.py'))) return false
  const actual = readComfyVersion(stagingDir)
  if (actual === null) return false
  if (!expectedVersion) return true
  // Tolerate `v0.3.45` vs `0.3.45` cosmetic mismatches.
  return expectedVersion.replace(/^v/, '').trim() === actual
}

/**
 * Return any existing adopted installation whose marker matches the install
 * found at `basePath`, so re-runs are no-ops.
 */
async function findExistingAdoption(basePath: string): Promise<InstallationRecord | null> {
  const markerPath = path.join(basePath, MARKER_FILE)
  if (!fs.existsSync(markerPath)) return null
  let markerId: string
  try {
    markerId = fs.readFileSync(markerPath, 'utf-8').trim()
  } catch {
    return null
  }
  if (!markerId) return null
  const list = await installations.list()
  return list.find((i) => i.id === markerId) ?? null
}

/**
 * Source ComfyUI into `installPath/ComfyUI`. Prefers the pre-staged copy
 * when present and valid; otherwise falls back to a shallow git clone.
 * Returns the source mode chosen so the record can store it.
 */
async function sourceComfyUI(
  info: DesktopInstallInfo,
  legacyVersion: string | null,
  destDir: string,
  tools: AdoptTools,
  deps: AdoptDeps,
): Promise<{ mode: AdoptSourceMode } | { mode: 'failed'; message: string }> {
  const stagedDir = path.join(info.configDir, STAGED_SOURCE_REL)
  if (fs.existsSync(stagedDir) && isStagedSourceValid(stagedDir, legacyVersion)) {
    try {
      await deps.copyStagedSource(stagedDir, destDir)
      tools.sendOutput(`Sourced ComfyUI from pre-swap copy at ${stagedDir}\n`)
      return { mode: 'pre-swap-copy' }
    } catch (err) {
      tools.sendOutput(`Pre-swap copy failed: ${(err as Error).message}; falling back to git clone\n`)
    }
  }
  const url = getComfyUIRemoteUrl(settings.get('useChineseMirrors') === true)
  const cloneResult = await deps.cloneSourceFromGit(url, destDir, legacyVersion, tools.sendOutput, tools.signal)
  if (!cloneResult.ok) {
    return { mode: 'failed', message: cloneResult.message }
  }
  return { mode: 'git-clone-fallback' }
}

/**
 * Persist `modelsDirs` and (when unset) the telemetry consent flag derived
 * from the legacy install. Existing `telemetryEnabled` user choice wins.
 */
function carryLegacySettings(
  basePath: string,
  configDir: string,
  legacy: LegacyConsent,
  sendOutput: (t: string) => void,
): { addedModelsDirs: string[] } {
  let extraYamlContent: string | null = null
  try {
    extraYamlContent = fs.readFileSync(path.join(configDir, EXTRA_MODELS_YAML), 'utf-8')
  } catch {}

  const currentModelsDirs = (settings.get('modelsDirs') as string[] | undefined) ?? [...settings.defaults.modelsDirs]
  const additions = computeModelsDirsToCarry(basePath, extraYamlContent, currentModelsDirs)
  if (additions.length > 0) {
    settings.set('modelsDirs', [...currentModelsDirs, ...additions])
    sendOutput(`Registered ${additions.length} legacy model dir(s) for cross-install visibility.\n`)
  }

  // Carry telemetry consent only when the user hasn't already decided.
  const telemetryAlreadySet = Object.prototype.hasOwnProperty.call(settings.getAll(), 'telemetryEnabled')
  if (!telemetryAlreadySet && typeof legacy.sendStatistics === 'boolean') {
    settings.set('telemetryEnabled', legacy.sendStatistics)
  }

  return { addedModelsDirs: additions }
}

/**
 * Orchestrate adoption of a Legacy Desktop install into a Desktop 2.0
 * installation record. Idempotent: re-runs detect the marker and return the
 * existing record without touching disk.
 *
 * @param opts - Trigger context, progress/prompt tools, and (test-only)
 *   dependency overrides.
 * @returns The adopted installation record.
 */
export async function adoptDesktopInstall(opts: AdoptOptions): Promise<InstallationRecord> {
  const { trigger, tools } = opts
  const deps: AdoptDeps = {
    detectDesktopInstall: opts.deps?.detectDesktopInstall ?? detectDesktopInstall,
    captureDesktopSnapshot: opts.deps?.captureDesktopSnapshot ?? captureDesktopSnapshot,
    validateLegacyVenv: opts.deps?.validateLegacyVenv ?? validateLegacyVenvDefault,
    copyStagedSource: opts.deps?.copyStagedSource ?? copyStagedSourceDefault,
    cloneSourceFromGit: opts.deps?.cloneSourceFromGit ?? cloneSourceFromGitDefault,
    now: opts.deps?.now ?? (() => new Date()),
  }

  const cutover = trigger === 'first-launch-cutover'
  const prompt = async (kind: AdoptPromptKind, ctx?: unknown): Promise<UserChoice> => {
    if (cutover) return defaultCutoverChoice(kind)
    return tools.promptUser(kind, ctx)
  }

  const telemetryContext = { trigger }

  const info = deps.detectDesktopInstall()
  if (!info) {
    telemetry.capture('desktop2.adopt.failed', { ...telemetryContext, error_bucket: 'no-legacy-install' })
    throw new Error('no-legacy-install')
  }

  // Idempotent no-op when the marker already names a recorded installation.
  const existing = await findExistingAdoption(info.basePath)
  if (existing) {
    tools.sendOutput(`Already adopted as installation ${existing.id}\n`)
    return existing
  }

  telemetry.capture('desktop2.adopt.started', telemetryContext)

  try {
    const result = await runAdoption(info, trigger, tools, deps, prompt)
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    telemetry.capture('desktop2.adopt.failed', {
      ...telemetryContext,
      error_bucket: telemetry.bucketError(message),
      error_message: message.slice(0, 500),
    })
    throw err
  }
}

async function runAdoption(
  info: DesktopInstallInfo,
  trigger: AdoptTrigger,
  tools: AdoptTools,
  deps: AdoptDeps,
  prompt: (kind: AdoptPromptKind, ctx?: unknown) => Promise<UserChoice>,
): Promise<InstallationRecord> {
  const { sendProgress, sendOutput, signal } = tools
  const telemetryContext = { trigger }
  const timestamp = deps.now().toISOString().replace(/[:.]/g, '-')

  sendProgress('backup', { percent: 0 })
  await telemetry.trackedStep('desktop2.adopt.backup', telemetryContext, async () => {
    await backupLegacyState(info.configDir, timestamp, sendOutput)
  })

  if (process.platform === 'darwin') {
    sendProgress('tcc', { percent: 0 })
    await telemetry.trackedStep('desktop2.adopt.tcc', telemetryContext, async () => {
      try {
        await fs.promises.readdir(info.basePath)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'EACCES' || code === 'EPERM') {
          await prompt('tcc', { path: info.basePath })
          throw new Error('tcc-denied', { cause: err })
        }
        throw err
      }
    })
  }

  sendProgress('venv', { percent: 0 })
  const pythonPath = process.platform === 'win32'
    ? path.join(info.basePath, '.venv', 'Scripts', 'python.exe')
    : path.join(info.basePath, '.venv', 'bin', 'python3')

  await telemetry.trackedStep('desktop2.adopt.validate_venv', telemetryContext, async () => {
    if (!fs.existsSync(pythonPath)) {
      const choice = await prompt('venv-broken', { reason: 'venv-missing', pythonPath })
      if (choice.kind === 'venv-broken' && choice.choice === 'cancel') throw new Error('venv-broken-cancelled')
      return
    }
    const result = await deps.validateLegacyVenv(pythonPath, signal)
    if (!result.ok) {
      const choice = await prompt('venv-broken', { reason: 'import-failed', message: result.message })
      if (choice.kind === 'venv-broken' && choice.choice === 'cancel') throw new Error('venv-broken-cancelled')
    }
  })

  sendProgress('snapshot', { percent: 0 })
  await telemetry.trackedStep('desktop2.adopt.snapshot', telemetryContext, async () => {
    try {
      const snap = await deps.captureDesktopSnapshot(info)
      const snapshotsDir = path.join(info.basePath, SNAPSHOTS_REL)
      await fs.promises.mkdir(snapshotsDir, { recursive: true })
      const snapshotFile = path.join(snapshotsDir, `legacy-adopted-${timestamp}.json`)
      await fs.promises.writeFile(snapshotFile, JSON.stringify({ ...snap, skipPipSync: true }, null, 2))
    } catch (err) {
      sendOutput(`Warning: forensic snapshot failed: ${(err as Error).message}\n`)
    }
  })

  sendProgress('allocate', { percent: 0 })
  const installPath = allocateUniqueDir(defaultInstallDir(), sanitizeDirName(ADOPT_INSTALL_NAME))
  await fs.promises.mkdir(installPath, { recursive: true })

  sendProgress('source', { percent: 0 })
  const legacyVersion = readLegacyVersionFile(info.basePath)
  const destSource = path.join(installPath, 'ComfyUI')
  let sourceMode: AdoptSourceMode | null = null
  let sourceAttempts = 0
  while (sourceMode === null) {
    sourceAttempts++
    const sourceResult = await telemetry.trackedStep('desktop2.adopt.source', { ...telemetryContext, attempt: sourceAttempts }, async () => {
      return sourceComfyUI(info, legacyVersion, destSource, tools, deps)
    })
    if (sourceResult.mode !== 'failed') {
      sourceMode = sourceResult.mode
      break
    }
    const choice = await prompt('source-missing', { message: sourceResult.message, attempts: sourceAttempts })
    if (choice.kind !== 'source-missing') break
    if (choice.choice === 'cancel') {
      throw new Error(`source-missing: ${sourceResult.message}`)
    }
    if (choice.choice === 'switch-to-managed') {
      // Deferred to Phase 3 UI plumbing. For now, surface a clear error so
      // the caller can route the user to the fresh-standalone flow.
      throw new Error('source-missing-switch-to-managed')
    }
    // 'retry' loops.
  }

  const rawComfySettings = readLegacyComfySettings(info.configDir)
  const consent = readLegacyConsent(rawComfySettings)
  const launchArgs = deriveLaunchArgs(rawComfySettings)
  const legacyDesktopConfig = readLegacyDesktopConfig(info.configDir)
  const legacyAppVersion = readLegacyAppVersion(info.executablePath)

  sendProgress('settings', { percent: 0 })
  const carry = await telemetry.trackedStep('desktop2.adopt.carry_settings', telemetryContext, async () => {
    return carryLegacySettings(info.basePath, info.configDir, consent, sendOutput)
  })

  sendProgress('register', { percent: 0 })
  const record = await telemetry.trackedStep('desktop2.adopt.register', telemetryContext, async () => {
    const comfyVersion = readComfyVersion(destSource) ?? undefined

    const recordData: Record<string, unknown> = {
      name: ADOPT_INSTALL_NAME,
      sourceId: 'standalone',
      installPath,
      adopted: true,
      adoptedAt: deps.now().toISOString(),
      adoptedBaseDir: info.basePath,
      adoptedPythonPath: pythonPath,
      adoptedSourceMode: sourceMode!,
      ...(legacyAppVersion ? { adoptedFromLegacyVersion: legacyAppVersion } : {}),
      releaseTag: 'legacy-adopted',
      variant: 'legacy-uv-py312',
      pythonVersion: '3.12',
      ...(comfyVersion ? { version: comfyVersion } : {}),
      launchArgs,
      launchMode: 'window',
      browserPartition: 'unique',
      portConflict: 'auto',
      autoUpdateComfyUI: false,
      useSharedPaths: false,
      copiedFrom: 'legacy-desktop',
      copyReason: 'in-place-adoption',
      status: 'installed',
      seen: false,
    }
    const entry = await installations.add(recordData)
    // Marker is written only after the record exists so a crash in between
    // doesn't poison the next adoption attempt with a dangling marker.
    await fs.promises.writeFile(path.join(info.basePath, MARKER_FILE), entry.id)
    return entry
  })

  telemetry.capture('desktop2.adopt.succeeded', {
    ...telemetryContext,
    installation_id: record.id,
    legacy_version: legacyAppVersion ?? null,
    adopted_source_mode: sourceMode,
    has_venv: info.hasVenv,
    has_extra_models_yaml: fs.existsSync(path.join(info.configDir, EXTRA_MODELS_YAML)),
    models_dir_count: carry.addedModelsDirs.length,
    gpu: typeof legacyDesktopConfig['detectedGpu'] === 'string' ? legacyDesktopConfig['detectedGpu'] as string : null,
    selected_device: typeof legacyDesktopConfig['selectedDevice'] === 'string' ? legacyDesktopConfig['selectedDevice'] as string : null,
  })

  sendProgress('done', { percent: 100 })
  return record
}
