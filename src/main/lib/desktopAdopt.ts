import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'

import { parse as parseYaml } from 'yaml'

import {
  detectDesktopInstall,
  captureDesktopSnapshot,
  ADOPT_MARKER_FILE,
  type DesktopInstallInfo
} from './desktopDetect'
import { defaultInstallDir, allocateUniqueDir, sanitizeDirName } from './paths'
import {
  gitClone,
  gitCheckoutCommit,
  readGitHead,
  fetchTags,
  isGitAvailable,
  isPygit2Configured,
  tryConfigurePygit2Fallback
} from './git'
import { resolveLocalVersion } from './version-resolve'
import type { ComfyVersion } from './version'
import { getComfyUIRemoteUrl } from './github-mirror'
import { getLatestStableTag } from './comfyui-releases'
import { installFilteredRequirements, runUvPip, getPipIndexArgs } from './pip'
import * as installations from '../installations'
import type { InstallationRecord } from '../installations'
import * as settings from '../settings'
import * as telemetry from './telemetry'
import { scrubAll } from '../../shared/piiScrub'
import * as i18n from './i18n'
import { KNOWN_MODEL_FOLDERS } from './models'

const MARKER_FILE = ADOPT_MARKER_FILE
const STAGED_SOURCE_REL = path.join('legacy-staging', 'comfyui')
const BACKUP_REL = 'legacy-backup'
const SNAPSHOTS_REL = '.snapshots'
// Display name for adopted installs. `installations.add()` calls
// `uniqueName()` so a second adoption (or a coexisting standalone
// install named "ComfyUI") gets "ComfyUI (1)", "ComfyUI (2)", etc.
// Keeping the name plain — instead of "Adopted from Legacy Desktop" —
// matches user expectation that the picker shows their app, not the
// provenance story.
const ADOPT_INSTALL_NAME = 'ComfyUI'
const COMFY_SETTINGS_FILE = 'comfy.settings.json'
const DESKTOP_CONFIG_FILE = 'config.json'
const EXTRA_MODELS_YAML = 'extra_models_config.yaml'
const WINDOW_FILE = 'window.json'
const VENV_VALIDATE_TIMEOUT_MS = 30_000

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
  validateLegacyVenv: (
    pythonPath: string,
    signal: AbortSignal
  ) => Promise<{ ok: true } | { ok: false; message: string }>
  copyStagedSource: (src: string, dest: string) => Promise<void>
  cloneSourceFromGit: (
    url: string,
    dest: string,
    sendOutput: (t: string) => void,
    signal: AbortSignal
  ) => Promise<{ ok: true } | { ok: false; message: string }>
  now: () => Date
}

export interface AdoptOptions {
  tools: AdoptTools
  /** @internal — tests override to inject mocks. */
  deps?: Partial<AdoptDeps>
}

export type AdoptSourceMode = 'pre-swap-copy' | 'git-clone-fallback'

/** Subset of legacy `comfy.settings.json` consumed by the orchestrator.
 *  Excludes things v2 already handles via other paths:
 *   - `Comfy.ColorPalette` is a frontend canvas-color setting that
 *     lives in `<basePath>/user/default/comfy.settings.json` — ComfyUI
 *     reads it on its own. v2's `theme` setting is the Electron
 *     launcher chrome (`'system' | 'dark' | 'light'`) and isn't
 *     equivalent.
 *   - `Comfy-Desktop.UV.TorchInstallMirror` has no v2 consumer:
 *     standalone variants ship torch pre-bundled and v2 never runs
 *     `uv pip install torch`. The legacy `comfy.settings.json` is
 *     preserved in `<configDir>/legacy-backup/<timestamp>/` so a
 *     future "rebuild as managed standalone" flow can read it then. */
interface LegacyComfySettings {
  /** `Comfy-Desktop.SendStatistics` — telemetry consent. */
  sendStatistics?: boolean
  /** `Comfy-Desktop.AutoUpdate` — whether the legacy app installed
   *  Desktop updates silently. Maps to v2 `autoInstallUpdates`. */
  autoUpdate?: boolean
  /** `Comfy-Desktop.UV.PypiInstallMirror` — user-pinned PyPI index URL.
   *  Carries verbatim into v2 `pypiMirror` (feeds every `uv pip install`
   *  the launcher runs: requirements during adoption, custom-node
   *  installs, manager extras, snapshot restore). */
  pypiMirror?: string
}

/** Substrings that mark a mirror URL as a known Chinese mirror —
 *  used to infer `useChineseMirrors` from a carried `pypiMirror` so the
 *  locale-triggered prompt doesn't replay for migrated users. */
const CHINESE_MIRROR_HINTS = ['aliyun', 'tencent', 'tsinghua', 'mirrors.cernet.edu.cn']

function looksLikeChineseMirror(url: string | undefined): boolean {
  if (!url) return false
  const lower = url.toLowerCase()
  return CHINESE_MIRROR_HINTS.some((hint) => lower.includes(hint))
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
  signal: AbortSignal
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
          const out =
            (stderr || '').toString().trim() || (stdout || '').toString().trim() || err.message
          resolve({ ok: false, message: out.slice(0, 1000) })
          return
        }
        if (stdout.toString().trim() !== 'ok') {
          resolve({ ok: false, message: `unexpected stdout: ${stdout.toString().slice(0, 200)}` })
          return
        }
        resolve({ ok: true })
      }
    )
    const onAbort = (): void => {
      try {
        child.kill()
      } catch {}
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
 * Full-clone the upstream ComfyUI repo into `dest`. The standalone source
 * also ends up with a full clone after `postInstall` runs `fetchTags
 * --unshallow`, so an adopted install needs the same complete history for
 * release-tag resolution and updates to work consistently. We don't try to
 * match the legacy bundled snapshot's exact commit — adopted installs
 * roll forward to the current stable on their first ComfyUI update
 * anyway, so cloning `main` (or the mirror's default branch) is fine.
 */
export async function cloneSourceFromGitDefault(
  url: string,
  dest: string,
  sendOutput: (t: string) => void,
  signal: AbortSignal
): Promise<{ ok: true } | { ok: false; message: string }> {
  const cloneResult = await gitClone(url, dest, sendOutput, signal)
  if (cloneResult.exitCode !== 0) {
    return { ok: false, message: cloneResult.stderr.slice(0, 1000) || 'clone failed' }
  }
  return { ok: true }
}

/**
 * Keys under a section that are NOT per-type model-folder overrides and must
 * never be treated as model dirs. `custom_nodes` is excluded because pointing
 * the model scanner at a custom-nodes tree would register Python packages as
 * "models"; the other three are metadata legacy desktop wrote per section.
 */
const NON_MODEL_SECTION_KEYS: ReadonlySet<string> = new Set([
  'base_path',
  'is_default',
  'custom_nodes',
  'download_model_base'
])

/** One config group from `extra_models_config.yaml`. */
export interface ExtraModelsSection {
  /** Section name (e.g. `comfyui_desktop`, `my_external`). */
  name: string
  /** `base_path:` value when present (raw, may be relative). */
  basePath?: string
  /** Per-type override key (`checkpoints`, `loras`, …) → path. A value may
   *  carry multiple newline/pipe-delimited paths in the legacy format; each
   *  becomes its own entry keyed by the same type. */
  overrides: Array<{ type: string; path: string }>
}

/** Coerce a YAML scalar into one or more trimmed, non-empty path strings.
 *  Legacy desktop allows `|`-block and pipe-delimited multi-path values
 *  (e.g. ComfyUI's `text_encoders: models/text_encoders/\nmodels/clip/`). */
function splitYamlPaths(value: unknown): string[] {
  if (value == null) return []
  return String(value)
    .split(/[\r\n|]+/)
    .map((s) => s.replace(/#.*$/, '').trim())
    .filter((s) => s.length > 0)
}

/**
 * Parse `extra_models_config.yaml` into structured sections, each with its
 * optional `base_path` and every per-type model-folder override. Uses a real
 * YAML parser so `|`-block scalars and pipe-delimited multi-path values (both
 * valid in the legacy format) are handled correctly. Returns `[]` on any parse
 * failure so a malformed legacy file never aborts adoption.
 */
export function parseExtraModelsSections(content: string): ExtraModelsSection[] {
  let doc: unknown
  try {
    doc = parseYaml(content)
  } catch {
    return []
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return []

  const sections: ExtraModelsSection[] = []
  for (const [name, raw] of Object.entries(doc as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const group = raw as Record<string, unknown>
    const section: ExtraModelsSection = { name, overrides: [] }
    const basePathVals = splitYamlPaths(group['base_path'])
    if (basePathVals.length > 0) section.basePath = basePathVals[0]
    for (const [key, value] of Object.entries(group)) {
      if (NON_MODEL_SECTION_KEYS.has(key)) continue
      for (const p of splitYamlPaths(value)) {
        section.overrides.push({ type: key, path: p })
      }
    }
    sections.push(section)
  }
  return sections
}

/**
 * Back-compat: pull out every `base_path:` string value across sections.
 * Retained for callers that only need the bare base paths. Prefer
 * `parseExtraModelsSections` for the full structured view.
 */
export function parseExtraModelsYaml(content: string): string[] {
  return parseExtraModelsSections(content)
    .map((s) => s.basePath)
    .filter((b): b is string => typeof b === 'string' && b.length > 0)
}

/**
 * Keys legacy desktop wrote into `Comfy.Server.LaunchArgs` that v2 owns
 * itself or stripped from the user-editable string for clarity:
 *  - `extra-model-paths-config` is generated from global `modelsDirs`
 *    when `useSharedModels: true`.
 *  - `front-end-root`, `log-stdout` are v2 plumbing the user can't
 *    meaningfully override.
 *  - `database-url` is pinned by `standalone.getLaunchCommand` to the
 *    legacy `user/comfyui.db` so we own it as structural plumbing; the
 *    user can still override it by re-adding `--database-url` to their
 *    launchArgs.
 */
const STRIPPED_LAUNCH_KEYS: ReadonlySet<string> = new Set([
  'extra-model-paths-config',
  'front-end-root',
  'log-stdout',
  'database-url'
])

/**
 * Keys promoted out of the launchArgs string into first-class
 * per-install record fields. Removed from the editable string so they
 * show up in the v2 settings UI as dedicated folder pickers instead.
 */
const PROMOTED_LAUNCH_KEYS: ReadonlySet<string> = new Set(['input-directory', 'output-directory'])

export interface DerivedLaunchArgs {
  /** Final user-facing `launchArgs` string written to the record. */
  launchArgs: string
  /** Input/output directory overrides extracted from the legacy
   *  `Comfy.Server.LaunchArgs` map. Empty when the user never set them
   *  — caller falls back to `<basePath>/{input,output}`. */
  pathOverrides: {
    inputDir?: string
    outputDir?: string
  }
}

/**
 * Coerce a raw legacy settings value into the flag→value convention used
 * when emitting the launchArgs string: booleans become `''` (flag with no
 * value) when truthy and are dropped when `false`; everything else is
 * stringified. Returns `null` when the entry should be skipped entirely.
 *
 * This normalizes the two legacy stores into one shape. `LaunchArgs`
 * already stores boolean flags as `''` and numbers as strings, while
 * `ServerConfigValues` keeps native `true`/`false`/number values, so a
 * raw `true` here means "emit the bare flag" and a raw `false` means
 * "the user explicitly disabled it — emit nothing".
 */
function normalizeLaunchValue(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return value ? '' : null
  return String(value)
}

/**
 * Build the user-facing `launchArgs` string for an adopted install from
 * the legacy `comfy.settings.json` blob (a flat dotted-key map).
 *
 * Merges both legacy server-config stores, keyed by config id (which is
 * the CLI flag name):
 *  - `Comfy.Server.ServerConfigValues` is the AUTHORITATIVE store of the
 *    user's server-config choices and forms the BASE of the merge. The
 *    legacy frontend already filters out values equal to their default,
 *    so whatever is present here is a deliberate non-default choice.
 *  - `Comfy.Server.LaunchArgs` is a lazily-synced derived copy that only
 *    gets written while the Server-Config settings panel is open, so it
 *    is frequently stale or empty. It OVERRIDES `ServerConfigValues` on
 *    key conflicts (it is the more-recent edit when both are present),
 *    but never erases a value that lives only in `ServerConfigValues`.
 *
 * Legacy `server_config.{listen,port}` keys are baked into defaults by
 * the legacy app itself and never appear here.
 *
 * The synthesized output preserves legacy implicit defaults users notice:
 *  - `--port 8000` when the user hasn't overridden it in EITHER store
 *    (legacy default; matters because legacy users have it bookmarked).
 *  - `--enable-manager` included by default, EXCEPT when the user opted
 *    into the legacy Manager UI (`enable-manager-legacy-ui`). The two
 *    Manager UIs are mutually exclusive, so honoring the legacy choice
 *    must not also inject the new Manager.
 *  - `--listen` is NOT synthesized — legacy's implicit `127.0.0.1`
 *    matches ComfyUI's native default, so emitting it would only add
 *    noise to the editable string. Explicit user-set `listen` values
 *    are preserved.
 *
 * `input-directory` / `output-directory` overrides are stripped from
 * the string and returned in `pathOverrides` so the caller can promote
 * them into the per-install `inputDir` / `outputDir` fields.
 */
export function deriveLaunchArgs(comfySettings: Record<string, unknown>): DerivedLaunchArgs {
  const asMap = (raw: unknown): Record<string, unknown> =>
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}

  const serverConfigValues = asMap(comfySettings['Comfy.Server.ServerConfigValues'])
  const launchArgsMap = asMap(comfySettings['Comfy.Server.LaunchArgs'])

  // ServerConfigValues is the base; LaunchArgs overrides on key conflicts.
  const mergedMap: Record<string, unknown> = { ...serverConfigValues, ...launchArgsMap }

  const parts: string[] = []
  const pathOverrides: DerivedLaunchArgs['pathOverrides'] = {}
  let hasPort = false

  for (const [key, value] of Object.entries(mergedMap)) {
    if (!key) continue
    if (STRIPPED_LAUNCH_KEYS.has(key)) continue
    const strVal = normalizeLaunchValue(value)
    if (strVal === null) continue
    if (PROMOTED_LAUNCH_KEYS.has(key)) {
      if (strVal === '') continue
      if (key === 'input-directory') pathOverrides.inputDir = strVal
      else if (key === 'output-directory') pathOverrides.outputDir = strVal
      continue
    }
    if (key === 'port') hasPort = true
    if (strVal === '') {
      parts.push(`--${key}`)
    } else {
      parts.push(`--${key}`, strVal)
    }
  }

  // Synthesize legacy's baked-in defaults the user expects: port 8000
  // (preserves bookmarked URLs) and --enable-manager. Skip --listen
  // because its legacy implicit `127.0.0.1` matches ComfyUI's native
  // default — writing it adds noise without effect.
  if (!hasPort) parts.unshift('--port', '8000')
  // The new Manager and the legacy Manager UI are mutually exclusive, so
  // don't force the new Manager on when the user opted into the legacy UI.
  const usesLegacyManager = parts.includes('--enable-manager-legacy-ui')
  if (!usesLegacyManager && !parts.includes('--enable-manager')) parts.push('--enable-manager')

  return { launchArgs: parts.join(' '), pathOverrides }
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

function readLegacyComfyPrefs(raw: Record<string, unknown>): LegacyComfySettings {
  const asBool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)
  const asNonEmptyString = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() !== '' ? v : undefined
  return {
    sendStatistics: asBool(raw['Comfy-Desktop.SendStatistics']),
    autoUpdate: asBool(raw['Comfy-Desktop.AutoUpdate']),
    pypiMirror: asNonEmptyString(raw['Comfy-Desktop.UV.PypiInstallMirror'])
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

/** True when `dir` exists on disk as a directory. */
function isDir(dir: string): boolean {
  return fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true
}

/**
 * Reject roots that would scan the whole machine: a filesystem root
 * (`/`, `C:\`) or the user's home directory itself. A pathological legacy
 * override (e.g. `checkpoints: /`) must never become a models root, or boot
 * would recursively walk everything. `os.homedir()` is the platform home.
 */
function isDangerousRoot(resolved: string): boolean {
  if (resolved === path.parse(resolved).root) return true
  try {
    if (path.resolve(os.homedir()) === resolved) return true
  } catch {}
  return false
}

/**
 * Cross-install model dirs to register in `settings.modelsDirs` for the
 * adopted record. The goal for migrations is to carry EVERY real model
 * directory the legacy `extra_models_config.yaml` referenced so nothing
 * shows as "missing" after adoption.
 *
 * For each section we register a models ROOT (a dir whose type subfolders
 * `buildYaml` scans):
 *   - Always `<basePath>/models` (the primary install), first.
 *   - For each section `base_path` B (relative resolved against `basePath`):
 *       `<B>/models` if it exists, else the bare `<B>` if it exists
 *       (catches A1111-style roots whose models live directly under B).
 *   - For each per-type override path P (relative resolved against the
 *     section's base_path): skip if already covered by a carried root;
 *     otherwise if `basename(P)` is a known model-type folder carry
 *     `dirname(P)` so the type subfolder is discovered, else carry P.
 *
 * Filesystem roots and the user's home dir are skipped as a safety guard.
 * Only existing directories are carried. Deduped against `existing` and
 * each other, primary `<basePath>/models` first.
 */
export function computeModelsDirsToCarry(
  basePath: string,
  extraYamlContent: string | null,
  existing: string[]
): string[] {
  const seen = new Set(existing.map((d) => path.resolve(d)))
  const out: string[] = []

  /** Register a single root if it exists, isn't dangerous, and is new. */
  const carry = (dir: string): boolean => {
    const resolved = path.resolve(dir)
    if (seen.has(resolved)) return true // already covered (or queued)
    if (isDangerousRoot(resolved)) {
      console.warn(`[adopt] skipping unsafe legacy models root: ${resolved}`)
      return false
    }
    if (!isDir(resolved)) return false
    seen.add(resolved)
    out.push(resolved)
    return true
  }

  // Primary install root always leads, even if absent (trusted) — matches
  // prior behavior where `<basePath>/models` is carried unconditionally.
  const primary = path.resolve(path.join(basePath, 'models'))
  if (!seen.has(primary)) {
    seen.add(primary)
    out.push(primary)
  }

  if (!extraYamlContent) return out

  for (const section of parseExtraModelsSections(extraYamlContent)) {
    // Resolve relative paths against the section base_path when set,
    // otherwise against the primary install base path.
    const sectionBase = section.basePath
      ? path.resolve(basePath, section.basePath)
      : path.resolve(basePath)

    const carriedRoots: string[] = []

    if (section.basePath) {
      if (carry(path.join(sectionBase, 'models'))) {
        carriedRoots.push(path.resolve(path.join(sectionBase, 'models')))
      } else if (carry(sectionBase)) {
        carriedRoots.push(path.resolve(sectionBase))
      }
    }

    for (const { type, path: overridePath } of section.overrides) {
      const resolvedOverride = path.isAbsolute(overridePath)
        ? path.resolve(overridePath)
        : path.resolve(sectionBase, overridePath)
      // Skip overrides already inside a root we're carrying for this section.
      if (carriedRoots.some((root) => isUnderRoot(resolvedOverride, root))) continue
      if (seen.has(resolvedOverride)) continue
      if (!isDir(resolvedOverride)) continue
      // A type-named leaf (e.g. `.../checkpoints`) means the models root is
      // its parent; carrying the parent lets buildYaml discover the subfolder.
      const root = KNOWN_MODEL_FOLDERS.has(type) && path.basename(resolvedOverride) === type
        ? path.dirname(resolvedOverride)
        : resolvedOverride
      if (carry(root)) carriedRoots.push(path.resolve(root))
    }
  }

  return out
}

/** True when `child` is the same as, or nested under, `root`. */
function isUnderRoot(child: string, root: string): boolean {
  const rel = path.relative(root, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Best-effort copy of legacy userData files into a timestamped backup folder.
 * Logged on failure but never throws so adoption can continue.
 */
async function backupLegacyState(
  configDir: string,
  timestamp: string,
  sendOutput: (t: string) => void
): Promise<void> {
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
 * Read the upstream version embedded in a ComfyUI source tree's
 * `comfyui_version.py`, which looks like `__version__ = "0.3.45"`. Used
 * to populate the adopted record's `version` field for UI display.
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

/**
 * A staged source tree is usable as long as it has the expected entry
 * points. The first ComfyUI update rolls forward to current stable, so
 * the bundled snapshot's exact version doesn't need to match anything.
 */
function isStagedSourceValid(stagingDir: string): boolean {
  return fs.existsSync(path.join(stagingDir, 'main.py'))
}

/**
 * Path to the uv binary that Legacy Desktop pip-installs into its venv as
 * a Python package. Adopted installs reuse this in-venv uv so we don't
 * need to bundle a separate uv with the launcher or depend on the legacy
 * app bundle (which the user may have uninstalled post-cutover).
 */
export function getLegacyVenvUvPath(basePath: string): string {
  return process.platform === 'win32'
    ? path.join(basePath, '.venv', 'Scripts', 'uv.exe')
    : path.join(basePath, '.venv', 'bin', 'uv')
}

interface RequirementsInstallReport {
  uvAvailable: boolean
  coreExitCode: number | null
  managerExitCode: number | null
  /** `uv pip install pygit2` exit code, or null when skipped (no uv). */
  pygit2ExitCode: number | null
}

/**
 * Install ComfyUI's `requirements.txt` (and `manager_requirements.txt`
 * when present) into the legacy venv via its bundled uv. Best-effort:
 * surfaces warnings on failure rather than aborting adoption — the
 * adopted install is still usable, just with potentially stale deps the
 * user can re-sync from the Manager UI later. PyTorch packages are
 * filtered out via `installFilteredRequirements` so we never clobber the
 * legacy CUDA build.
 *
 * Also installs `pygit2` so:
 *   - ComfyUI-Manager v4 picks the pygit2 backend (gated by
 *     `CM_USE_PYGIT2=1`, which `buildLaunchEnv` already sets for every
 *     `sourceId === 'standalone'` install — adopted included). Without
 *     pygit2 Manager falls back to GitPython, which requires `git` on
 *     PATH — Legacy Desktop never required system git, so adopted users
 *     often don't have it.
 *   - The launcher-bundled `update_comfyui.py` can run against the
 *     adopted Python (it imports pygit2 unconditionally), which is what
 *     unblocks in-place ComfyUI source updates for adopted installs.
 *     Without pygit2 in the legacy venv, the only way to update was
 *     Copy & Update (rebuild as a fully managed standalone).
 */
async function installAdoptedRequirements(
  destSource: string,
  installPath: string,
  pythonPath: string,
  basePath: string,
  tools: AdoptTools
): Promise<RequirementsInstallReport> {
  const uvPath = getLegacyVenvUvPath(basePath)
  if (!fs.existsSync(uvPath)) {
    tools.sendOutput(
      `Warning: legacy venv uv not found at ${uvPath} — skipping ComfyUI requirements install. ` +
        `You may need to manually run \`pip install -r requirements.txt\` later if launches fail.\n`
    )
    return { uvAvailable: false, coreExitCode: null, managerExitCode: null, pygit2ExitCode: null }
  }

  const mirrors = settings.getMirrorConfig()
  const report: RequirementsInstallReport = {
    uvAvailable: true,
    coreExitCode: null,
    managerExitCode: null,
    pygit2ExitCode: null
  }

  const coreReqs = path.join(destSource, 'requirements.txt')
  if (fs.existsSync(coreReqs)) {
    tools.sendOutput('Installing ComfyUI requirements into legacy venv via uv…\n')
    const code = await installFilteredRequirements(
      coreReqs,
      uvPath,
      pythonPath,
      installPath,
      '.adopt-core-reqs.txt',
      tools.sendOutput,
      tools.signal,
      mirrors
    )
    report.coreExitCode = code
    if (code !== 0) {
      tools.sendOutput(`Warning: ComfyUI requirements install exited with code ${code}.\n`)
    }
  } else {
    tools.sendOutput(`Warning: ${coreReqs} missing — ComfyUI source may be incomplete.\n`)
  }

  const mgrReqs = path.join(destSource, 'manager_requirements.txt')
  if (fs.existsSync(mgrReqs)) {
    tools.sendOutput('Installing ComfyUI-Manager requirements…\n')
    const code = await installFilteredRequirements(
      mgrReqs,
      uvPath,
      pythonPath,
      installPath,
      '.adopt-mgr-reqs.txt',
      tools.sendOutput,
      tools.signal,
      mirrors
    )
    report.managerExitCode = code
    if (code !== 0) {
      tools.sendOutput(`Warning: manager requirements install exited with code ${code}.\n`)
    }
  }

  // pygit2 is a separate uv invocation rather than a synthetic entry in a
  // requirements file so we surface its exit code distinctly in telemetry
  // (Manager + in-place updates both depend on it; we want to spot a
  // population of adoptions where this specific install fails). Idempotent
  // on reconcile.
  tools.sendOutput('Installing pygit2 into legacy venv (enables Manager + in-place updates)…\n')
  const pygit2Code = await runUvPip(
    uvPath,
    [
      'pip',
      'install',
      'pygit2',
      '--python',
      pythonPath,
      ...getPipIndexArgs(mirrors.pypiMirror, mirrors.useChineseMirrors)
    ],
    installPath,
    tools.sendOutput,
    tools.signal
  )
  report.pygit2ExitCode = pygit2Code
  if (pygit2Code !== 0) {
    tools.sendOutput(
      `Warning: pygit2 install exited with code ${pygit2Code}. Manager will fall back ` +
        `to GitPython (requires system git) and in-place ComfyUI updates will be unavailable ` +
        `until pygit2 is installed manually or via "Copy & Update".\n`
    )
  }

  return report
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
  destDir: string,
  tools: AdoptTools,
  deps: AdoptDeps
): Promise<{ mode: AdoptSourceMode } | { mode: 'failed'; message: string }> {
  const stagedDir = path.join(info.configDir, STAGED_SOURCE_REL)
  if (fs.existsSync(stagedDir) && isStagedSourceValid(stagedDir)) {
    try {
      await deps.copyStagedSource(stagedDir, destDir)
      tools.sendOutput(`Sourced ComfyUI from pre-swap copy at ${stagedDir}\n`)
      return { mode: 'pre-swap-copy' }
    } catch (err) {
      tools.sendOutput(
        `Pre-swap copy failed: ${(err as Error).message}; falling back to git clone\n`
      )
    }
  }
  const url = getComfyUIRemoteUrl(settings.get('useChineseMirrors') === true)
  // Raw `git clone` output is just "Receiving objects: 50% (50/100)" lines
  // with no preamble that this is a multi-hundred-MB download from GitHub.
  // Frame the operation so the user knows what those object counts mean
  // and roughly how long to wait.
  tools.sendOutput(
    `Pre-swap copy not available; downloading ComfyUI source from ${url} …\n` +
      `This is a one-time download and can take a few minutes on a slow connection.\n`
  )
  const cloneResult = await deps.cloneSourceFromGit(url, destDir, tools.sendOutput, tools.signal)
  if (!cloneResult.ok) {
    return { mode: 'failed', message: cloneResult.message }
  }
  tools.sendOutput(`ComfyUI source download complete.\n`)
  return { mode: 'git-clone-fallback' }
}

interface CarryReport {
  addedModelsDirs: string[]
  /** Global settings keys actually written during this carry pass. */
  carriedKeys: string[]
  /** Global settings keys we considered but skipped because v2 already
   *  had a user-set value. Telemetered so we can spot adoption flows
   *  that look like clean migrations but were really first-launches
   *  followed by an adopt. */
  carrySkippedKeys: string[]
}

/**
 * Persist legacy preferences into v2's global settings under the
 * "v2 user choice wins" rule — keys the user has already set in v2 are
 * preserved verbatim; only absent keys are seeded from the legacy
 * install. Uses `settings.has()` (which reads the raw `settings.json`)
 * so built-in defaults don't masquerade as user choices.
 *
 * Carries:
 *   - `modelsDirs`           ← `<basePath>/models` plus every real model
 *                              root referenced by
 *                              `extra_models_config.yaml`: each section's
 *                              `base_path` (as `/models` or the bare dir)
 *                              and each per-type override resolved to its
 *                              models root. See `computeModelsDirsToCarry`.
 *                              Always appended.
 *   - `telemetryEnabled`     ← `Comfy-Desktop.SendStatistics`
 *   - `autoInstallUpdates`   ← force `true`. Adoption ships as an
 *                              in-place app update of Legacy Desktop;
 *                              if the legacy user had `AutoUpdate: false`,
 *                              inheriting it would lock them out of
 *                              future Desktop 2.0 updates — including
 *                              fixes to the adoption flow itself. Forced
 *                              on once at adoption (respects any later
 *                              v2-side toggle).
 *   - `pypiMirror`           ← `Comfy-Desktop.UV.PypiInstallMirror`
 *   - `useChineseMirrors` +
 *     `chineseMirrorsPrompted` ← inferred from `pypiMirror`
 *   - `firstUseCompleted`    ← force `true` (the adopting user has been
 *                              running ComfyUI for months — skip the
 *                              first-launch takeover).
 *   - `inputDir` / `outputDir` ← `<basePath>/input` / `<basePath>/output`
 *                                so fresh managed installs created
 *                                later automatically see the legacy
 *                                workspace.
 */
function carryLegacySettings(
  basePath: string,
  configDir: string,
  legacy: LegacyComfySettings,
  sendOutput: (t: string) => void
): CarryReport {
  let extraYamlContent: string | null = null
  try {
    extraYamlContent = fs.readFileSync(path.join(configDir, EXTRA_MODELS_YAML), 'utf-8')
  } catch {}

  const currentModelsDirs = (settings.get('modelsDirs') as string[] | undefined) ?? [
    ...settings.defaults.modelsDirs
  ]
  const additions = computeModelsDirsToCarry(basePath, extraYamlContent, currentModelsDirs)
  if (additions.length > 0) {
    settings.set('modelsDirs', [...currentModelsDirs, ...additions])
    sendOutput(`Registered ${additions.length} legacy model dir(s) for cross-install visibility.\n`)
  }

  const carriedKeys: string[] = []
  const carrySkippedKeys: string[] = []

  /** Apply the "v2 user choice wins" rule for a single key. */
  function tryCarry<T>(key: string, value: T | undefined): void {
    if (value === undefined) return
    if (settings.has(key)) {
      carrySkippedKeys.push(key)
      return
    }
    settings.set(key, value)
    carriedKeys.push(key)
  }

  tryCarry('telemetryEnabled', legacy.sendStatistics)
  tryCarry('pypiMirror', legacy.pypiMirror)

  // Force Desktop auto-updates on at adoption time, regardless of the
  // legacy `Comfy-Desktop.AutoUpdate` value. The cutover ships as an
  // in-place app update from Legacy Desktop, so users who had auto-update
  // off would never receive subsequent Desktop 2.0 updates — including
  // fixes to the adoption flow itself. We only seed when v2 hasn't already
  // persisted a choice, so users who explicitly toggle it off in v2
  // settings after adoption keep their choice on subsequent reconciles.
  if (!settings.has('autoInstallUpdates')) {
    settings.set('autoInstallUpdates', true)
    carriedKeys.push('autoInstallUpdates')
  }

  if (looksLikeChineseMirror(legacy.pypiMirror)) {
    // Both flags carry together: the mirror toggle drives Git+PyPI
    // routing, and the "already prompted" flag suppresses the locale-
    // triggered prompt that would otherwise replay on next launch.
    tryCarry('useChineseMirrors', true)
    tryCarry('chineseMirrorsPrompted', true)
  }

  // Force-skip the first-launch takeover for adopted users — they've
  // been running ComfyUI for months. Carries unconditionally because
  // re-running adoption on a fresh v2 install (idempotent reconcile)
  // shouldn't replay the takeover either.
  if (!settings.has('firstUseCompleted')) {
    settings.set('firstUseCompleted', true)
    carriedKeys.push('firstUseCompleted')
  }

  // Seed global shared dirs to legacy workspace so fresh managed installs
  // (created later by the same user) see the same input/output by default.
  // Only when v2 hasn't already persisted a choice — adopted users who
  // first ran v2 and configured shared dirs keep their choice.
  tryCarry('inputDir', path.join(basePath, 'input'))
  tryCarry('outputDir', path.join(basePath, 'output'))

  return { addedModelsDirs: additions, carriedKeys, carrySkippedKeys }
}

/**
 * Idempotent reconciliation pass for an already-adopted install. Re-runs
 * the requirements install against the legacy venv so older adoptions
 * (pre-requirements-step) and installs whose deps drifted after a manual
 * ComfyUI source update can self-heal by re-running migrate-to-standalone.
 * Best-effort: any failure is logged and swallowed so the caller still
 * sees the original adopted record (the re-run never destroys a working
 * adoption).
 */
async function reconcileAdoptedRequirements(
  existing: InstallationRecord,
  info: DesktopInstallInfo,
  tools: AdoptTools
): Promise<void> {
  const destSource = path.join(existing.installPath, 'ComfyUI')
  const pythonPath =
    (existing.adoptedPythonPath as string | undefined) ??
    (process.platform === 'win32'
      ? path.join(info.basePath, '.venv', 'Scripts', 'python.exe')
      : path.join(info.basePath, '.venv', 'bin', 'python3'))
  const basePath = (existing.adoptedBaseDir as string | undefined) ?? info.basePath
  try {
    await telemetry.trackedStep(
      'comfy.desktop.adopt.requirements_reconcile',
      { installation_id: existing.id },
      async () => {
        await installAdoptedRequirements(
          destSource,
          existing.installPath,
          pythonPath,
          basePath,
          tools
        )
      }
    )
  } catch (err) {
    tools.sendOutput(`Warning: requirements reconcile threw: ${(err as Error).message}\n`)
  }
}

/**
 * Orchestrate adoption of a Legacy Desktop install into a Desktop 2.0
 * installation record. Idempotent: re-runs detect the marker, return the
 * existing record, and reconcile requirements against the legacy venv.
 *
 * @param opts - Progress/prompt tools and (test-only) dependency overrides.
 * @returns The adopted installation record.
 */
export async function adoptDesktopInstall(opts: AdoptOptions): Promise<InstallationRecord> {
  const { tools } = opts
  const deps: AdoptDeps = {
    detectDesktopInstall: opts.deps?.detectDesktopInstall ?? detectDesktopInstall,
    captureDesktopSnapshot: opts.deps?.captureDesktopSnapshot ?? captureDesktopSnapshot,
    validateLegacyVenv: opts.deps?.validateLegacyVenv ?? validateLegacyVenvDefault,
    copyStagedSource: opts.deps?.copyStagedSource ?? copyStagedSourceDefault,
    cloneSourceFromGit: opts.deps?.cloneSourceFromGit ?? cloneSourceFromGitDefault,
    now: opts.deps?.now ?? (() => new Date())
  }

  const info = deps.detectDesktopInstall()
  if (!info) {
    telemetry.capture('comfy.desktop.adopt.failed', {
      stage: 'detect',
      error_bucket: 'no-legacy-install'
    })
    throw new Error('no-legacy-install')
  }

  // Idempotent re-run when the marker already names a recorded installation.
  // We still reconcile ComfyUI's requirements.txt against the legacy venv so
  // older adoptions (created before the requirements step shipped) and
  // installs whose deps drifted after a manual ComfyUI source update can
  // self-heal by re-running migrate-to-standalone. installFilteredRequirements
  // is idempotent — repeating it on an up-to-date venv is a uv no-op.
  const existing = await findExistingAdoption(info.basePath)
  if (existing) {
    tools.sendOutput(`Already adopted as installation ${existing.id}; reconciling requirements…\n`)
    // Backfill: older adoptions only wrote the marker under
    // `<adoptedBaseDir>`. The install-side marker is required for
    // `sessionActions/delete.ts`' safety check to recognise an
    // adopted install — without it, Delete errors out with the
    // generic "use Forget" message. Best-effort: ignore failures
    // so reconcile still wins.
    if (existing.installPath) {
      try {
        const installMarker = path.join(existing.installPath, MARKER_FILE)
        if (!fs.existsSync(installMarker)) {
          await fs.promises.writeFile(installMarker, existing.id)
        }
      } catch {}
    }
    await reconcileAdoptedRequirements(existing, info, tools)
    return existing
  }

  telemetry.capture('comfy.desktop.adopt.started', {})

  // Track the most recently entered phase so adopt.failed can report
  // *which* step blew up. Without this, every failure surfaces with
  // stage=null and the only debug signal is the free-text
  // `error_message`. sendProgress is called at the start of each
  // runAdoption phase, so the wrapped delegate updates this before the
  // phase begins running. `init` covers everything that happens before
  // runAdoption's first sendProgress (`backup`).
  let currentPhase = 'init'
  const phaseAwareTools: AdoptTools = {
    ...tools,
    sendProgress: (phase, detail) => {
      currentPhase = phase
      tools.sendProgress(phase, detail)
    }
  }

  try {
    const result = await runAdoption(info, phaseAwareTools, deps)
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Scrub before slice so the redacted prefix doesn't get truncated
    // mid-token. The bucket runs on raw text because its regexes don't
    // care about user paths and would otherwise miss a legitimate match
    // hidden inside a `[REDACTED]` substitution.
    telemetry.capture('comfy.desktop.adopt.failed', {
      stage: currentPhase,
      error_bucket: telemetry.bucketError(message),
      error_message: scrubAll(message).slice(0, 500)
    })
    throw err
  }
}

async function runAdoption(
  info: DesktopInstallInfo,
  tools: AdoptTools,
  deps: AdoptDeps
): Promise<InstallationRecord> {
  const { sendProgress, sendOutput, signal } = tools
  const timestamp = deps.now().toISOString().replace(/[:.]/g, '-')

  // Register human-readable step labels for the progress UI. Without
  // this the renderer falls back to displaying the raw phase id
  // ("source", "venv", …) since the labels are otherwise undefined.
  sendProgress('steps', {
    steps: [
      { phase: 'backup', label: i18n.t('desktop.adoptStepBackup') },
      ...(process.platform === 'darwin'
        ? [{ phase: 'tcc', label: i18n.t('desktop.adoptStepTcc') }]
        : []),
      { phase: 'venv', label: i18n.t('desktop.adoptStepVenv') },
      { phase: 'snapshot', label: i18n.t('desktop.adoptStepSnapshot') },
      { phase: 'allocate', label: i18n.t('desktop.adoptStepAllocate') },
      { phase: 'source', label: i18n.t('desktop.adoptStepSource') },
      { phase: 'comfy-update', label: i18n.t('desktop.adoptStepComfyUpdate') },
      { phase: 'requirements', label: i18n.t('desktop.adoptStepRequirements') },
      { phase: 'settings', label: i18n.t('desktop.adoptStepSettings') },
      { phase: 'register', label: i18n.t('desktop.adoptStepRegister') }
    ]
  })

  sendProgress('backup', { percent: 0 })
  await telemetry.trackedStep('comfy.desktop.adopt.backup', {}, async () => {
    await backupLegacyState(info.configDir, timestamp, sendOutput)
  })

  if (process.platform === 'darwin') {
    sendProgress('tcc', { percent: 0 })
    await telemetry.trackedStep('comfy.desktop.adopt.tcc', {}, async () => {
      try {
        await fs.promises.readdir(info.basePath)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'EACCES' || code === 'EPERM') {
          await tools.promptUser('tcc', { path: info.basePath })
          throw new Error('tcc-denied', { cause: err })
        }
        throw err
      }
    })
  }

  sendProgress('venv', { percent: 0 })
  const pythonPath =
    process.platform === 'win32'
      ? path.join(info.basePath, '.venv', 'Scripts', 'python.exe')
      : path.join(info.basePath, '.venv', 'bin', 'python3')

  await telemetry.trackedStep('comfy.desktop.adopt.validate_venv', {}, async () => {
    if (!fs.existsSync(pythonPath)) {
      const choice = await tools.promptUser('venv-broken', { reason: 'venv-missing', pythonPath })
      if (choice.kind === 'venv-broken' && choice.choice === 'cancel')
        throw new Error('venv-broken-cancelled')
      return
    }
    const result = await deps.validateLegacyVenv(pythonPath, signal)
    if (!result.ok) {
      const choice = await tools.promptUser('venv-broken', {
        reason: 'import-failed',
        message: result.message
      })
      if (choice.kind === 'venv-broken' && choice.choice === 'cancel')
        throw new Error('venv-broken-cancelled')
    }
  })

  sendProgress('snapshot', { percent: 0 })
  await telemetry.trackedStep('comfy.desktop.adopt.snapshot', {}, async () => {
    try {
      const snap = await deps.captureDesktopSnapshot(info)
      const snapshotsDir = path.join(info.basePath, SNAPSHOTS_REL)
      await fs.promises.mkdir(snapshotsDir, { recursive: true })
      const snapshotFile = path.join(snapshotsDir, `legacy-adopted-${timestamp}.json`)
      await fs.promises.writeFile(
        snapshotFile,
        JSON.stringify({ ...snap, skipPipSync: true }, null, 2)
      )
    } catch (err) {
      sendOutput(`Warning: forensic snapshot failed: ${(err as Error).message}\n`)
    }
  })

  sendProgress('allocate', { percent: 0 })
  const installPath = allocateUniqueDir(defaultInstallDir(), sanitizeDirName(ADOPT_INSTALL_NAME))
  await fs.promises.mkdir(installPath, { recursive: true })

  sendProgress('source', { percent: 0 })
  const destSource = path.join(installPath, 'ComfyUI')
  let sourceMode: AdoptSourceMode | null = null
  let sourceAttempts = 0
  while (sourceMode === null) {
    sourceAttempts++
    const sourceResult = await telemetry.trackedStep(
      'comfy.desktop.adopt.source',
      { attempt: sourceAttempts },
      async () => {
        return sourceComfyUI(info, destSource, tools, deps)
      }
    )
    if (sourceResult.mode !== 'failed') {
      sourceMode = sourceResult.mode
      break
    }
    const choice = await tools.promptUser('source-missing', {
      message: sourceResult.message,
      attempts: sourceAttempts
    })
    if (choice.kind !== 'source-missing') break
    if (choice.choice === 'cancel') {
      throw new Error(`source-missing: ${sourceResult.message}`)
    }
    if (choice.choice === 'switch-to-managed') {
      // Caller (dispatcher) maps this to the fresh-standalone flow.
      throw new Error('source-missing-switch-to-managed')
    }
    // 'retry' loops.
  }

  // One-shot ComfyUI source update during adoption: the user is
  // receiving the Desktop 2.0 update with the expectation that ComfyUI
  // itself is also fresh. We resolve the latest stable tag and check
  // it out *once* here. Subsequent launches do NOT re-update —
  // `autoUpdateComfyUI` stays `false` on the record, matching Desktop
  // 2.0's standard policy that ComfyUI updates are opt-in per install.
  // Non-fatal: a stale source is still a working install.
  sendProgress('comfy-update', { percent: 0 })
  const updateInfo = await telemetry.trackedStep(
    'comfy.desktop.adopt.comfy_update',
    {},
    async () => {
      return updateComfyToStable(destSource, tools)
    }
  )

  // Resolve a real {commit, baseTag, commitsAhead} from the freshly
  // checked-out source so the release-cache compares the installed
  // *tag* (e.g. "v0.24.0") against latestTag, not the bare
  // `__version__` string from comfyui_version.py (e.g. "0.24.0") which
  // never matches a "v"-prefixed remote tag and so wedges the
  // installation into a permanent "update available" state.
  let resolvedComfyVersion: ComfyVersion | undefined
  if (fs.existsSync(path.join(destSource, '.git'))) {
    try {
      if (!isPygit2Configured() && !(await isGitAvailable())) {
        await tryConfigurePygit2Fallback(installPath)
      }
      await fetchTags(destSource)
      const headCommit = readGitHead(destSource)
      if (headCommit) {
        resolvedComfyVersion = await resolveLocalVersion(
          destSource,
          headCommit,
          updateInfo.tag ?? undefined
        )
      }
    } catch (err) {
      sendOutput(
        `Warning: could not resolve adopted ComfyUI version: ${(err as Error).message}\n`
      )
    }
  }

  sendProgress('requirements', { percent: 0 })
  const reqReport = await telemetry.trackedStep(
    'comfy.desktop.adopt.requirements',
    {},
    async () => {
      try {
        return await installAdoptedRequirements(
          destSource,
          installPath,
          pythonPath,
          info.basePath,
          tools
        )
      } catch (err) {
        sendOutput(`Warning: requirements install threw: ${(err as Error).message}\n`)
        return {
          uvAvailable: false,
          coreExitCode: null,
          managerExitCode: null,
          pygit2ExitCode: null
        }
      }
    }
  )

  const rawComfySettings = readLegacyComfySettings(info.configDir)
  const prefs = readLegacyComfyPrefs(rawComfySettings)
  const derived = deriveLaunchArgs(rawComfySettings)
  const legacyDesktopConfig = readLegacyDesktopConfig(info.configDir)
  const legacyAppVersion = readLegacyAppVersion(info.executablePath)
  const detectedGpu =
    typeof legacyDesktopConfig['detectedGpu'] === 'string'
      ? (legacyDesktopConfig['detectedGpu'] as string)
      : null
  const selectedDevice =
    typeof legacyDesktopConfig['selectedDevice'] === 'string'
      ? (legacyDesktopConfig['selectedDevice'] as string)
      : null

  sendProgress('settings', { percent: 0 })
  const carry = await telemetry.trackedStep('comfy.desktop.adopt.carry_settings', {}, async () => {
    return carryLegacySettings(info.basePath, info.configDir, prefs, sendOutput)
  })

  sendProgress('register', { percent: 0 })
  const record = await telemetry.trackedStep('comfy.desktop.adopt.register', {}, async () => {
    // Re-read post-update so the recorded version matches the checkout.
    const comfyVersion = readComfyVersion(destSource) ?? undefined

    // Per-install input/output: explicit legacy overrides win; otherwise
    // pin to legacy workspace defaults so the adopted install opens the
    // same input/output folders the user had on day one.
    const inputDir = derived.pathOverrides.inputDir ?? path.join(info.basePath, 'input')
    const outputDir = derived.pathOverrides.outputDir ?? path.join(info.basePath, 'output')

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
      // Hardware hints stashed for a future "rebuild as managed standalone"
      // flow that needs to preselect the right variant — no v2 consumer
      // today, but cheap to capture while we have the legacy config open.
      ...(detectedGpu ? { adoptedFromGpu: detectedGpu } : {}),
      ...(selectedDevice ? { adoptedSelectedDevice: selectedDevice } : {}),
      releaseTag: 'legacy-adopted',
      variant: 'legacy-uv-py312',
      pythonVersion: '3.12',
      ...(comfyVersion ? { version: comfyVersion } : {}),
      ...(resolvedComfyVersion ? { comfyVersion: resolvedComfyVersion } : {}),
      ...(updateInfo.tag ? { adoptedComfyTagAtMigration: updateInfo.tag } : {}),
      launchArgs: derived.launchArgs,
      launchMode: 'window',
      browserPartition: 'unique',
      portConflict: 'auto',
      // Adopted records get one-time-update-during-adoption above but
      // stay on opt-in updates from here on out — matching v2's standard
      // policy. Do not conflate the two.
      autoUpdateComfyUI: false,
      // Shared models = on (legacy `models/` lives in the global modelsDirs).
      // Shared input/output = off (workspace pinned to legacy basePath via
      // the per-install inputDir/outputDir fields below).
      useSharedModels: true,
      useSharedInputOutput: false,
      inputDir,
      outputDir,
      copiedFrom: 'legacy-desktop',
      copyReason: 'in-place-adoption',
      status: 'installed',
      seen: false
    }
    const entry = await installations.add(recordData)
    // Marker is written only after the record exists so a crash in between
    // doesn't poison the next adoption attempt with a dangling marker.
    // If the marker write itself fails (disk full, permissions, …) we
    // must roll the DB entry back — otherwise the next re-run sees no
    // marker and creates a duplicate installation record.
    //
    // Two markers, two different jobs:
    //   - `<adoptedBaseDir>/<MARKER_FILE>` lets the next adopt attempt
    //     recognise an already-adopted legacy install and short-circuit
    //     (see `findExistingAdoption`). Also makes `detectDesktopInstall()`
    //     skip this workspace, so the startup auto-tracker can't reseed a
    //     "ComfyUI Legacy Desktop" card alongside the adopted standalone.
    //   - `<installPath>/<MARKER_FILE>` is the safety check used by the
    //     standard delete flow (`sessionActions/delete.ts`) — without it
    //     "Delete" on an adopted install errors out as "not created by
    //     Desktop 2.0". Adopted delete also relies on the install-side
    //     marker before touching anything under `adoptedBaseDir`.
    try {
      await fs.promises.writeFile(path.join(info.basePath, MARKER_FILE), entry.id)
      await fs.promises.writeFile(path.join(installPath, MARKER_FILE), entry.id)
    } catch (err) {
      try {
        await installations.remove(entry.id)
      } catch {}
      throw err
    }
    // Drop the auto-tracked legacy desktop card now that the adopted
    // standalone record represents the same workspace. Without this the
    // dashboard shows two cards for the same install path (one with
    // `launchMode: 'external'` pointing at the no-longer-installed
    // legacy app). The startup auto-tracker won't reseed it because the
    // marker we just wrote disqualifies the path from
    // `detectDesktopInstall()`. Best-effort: a failure here doesn't break
    // adoption — the next app launch reconciles via the marker check.
    try {
      const all = await installations.list()
      for (const i of all) {
        if (i.sourceId !== 'desktop') continue
        if (i.installPath !== info.basePath) continue
        await installations.remove(i.id)
      }
    } catch {}
    return entry
  })

  telemetry.capture('comfy.desktop.adopt.succeeded', {
    installation_id: record.id,
    legacy_version: legacyAppVersion ?? null,
    adopted_source_mode: sourceMode,
    has_venv: info.hasVenv,
    has_extra_models_yaml: fs.existsSync(path.join(info.configDir, EXTRA_MODELS_YAML)),
    models_dir_count: carry.addedModelsDirs.length,
    carried_keys: carry.carriedKeys,
    carry_skipped_keys: carry.carrySkippedKeys,
    adopted_path_override_input: !!derived.pathOverrides.inputDir,
    adopted_path_override_output: !!derived.pathOverrides.outputDir,
    adopted_comfy_tag_at_migration: updateInfo.tag ?? null,
    requirements_uv_available: reqReport.uvAvailable,
    requirements_core_exit: reqReport.coreExitCode,
    requirements_manager_exit: reqReport.managerExitCode,
    requirements_pygit2_exit: reqReport.pygit2ExitCode,
    gpu: detectedGpu,
    selected_device: selectedDevice
  })

  sendProgress('done', { percent: 100 })
  return record
}

/**
 * One-shot "roll forward to current stable" for an adopted ComfyUI
 * source tree. Resolves the latest stable tag and `git checkout`s it.
 *
 * Non-fatal on every failure path — offline lookups, mirror flakes,
 * even checkout errors leave the adoption with whatever was cloned /
 * copied. The user keeps a working install they can update from the
 * settings UI later.
 */
async function updateComfyToStable(
  destSource: string,
  tools: AdoptTools
): Promise<{ tag: string | null }> {
  if (!fs.existsSync(path.join(destSource, '.git'))) {
    tools.sendOutput('Skipping post-adoption ComfyUI update: source is not a git checkout.\n')
    return { tag: null }
  }
  let tag: string | null
  try {
    tag = await getLatestStableTag()
  } catch {
    tag = null
  }
  if (!tag) {
    tools.sendOutput(
      'Skipping post-adoption ComfyUI update: could not resolve latest stable tag.\n'
    )
    return { tag: null }
  }
  // `gitCheckoutCommit` may transparently `git fetch --unshallow` if the
  // tag isn't already local — that surfaces as a wall of "Receiving
  // objects: …" lines with no preamble. Frame it so the user can tell
  // network activity here is the ComfyUI update, not random churn.
  tools.sendOutput(`Updating ComfyUI source to latest stable tag (${tag})…\n`)
  try {
    const result = await gitCheckoutCommit(destSource, tag, tools.sendOutput, tools.signal)
    if (result.exitCode !== 0) {
      tools.sendOutput(
        `Warning: ComfyUI checkout of ${tag} failed (exit ${result.exitCode}). ` +
          `Continuing with whatever was cloned; user can update from Settings later.\n`
      )
      return { tag: null }
    }
    tools.sendOutput(`ComfyUI source now at ${tag}.\n`)
  } catch (err) {
    tools.sendOutput(`Warning: ComfyUI checkout threw: ${(err as Error).message}\n`)
    return { tag: null }
  }
  return { tag }
}
