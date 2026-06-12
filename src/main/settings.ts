import path from 'path'
import fs from 'fs'
import { app } from 'electron'
import { configDir, cacheDir, homeDir, setInstallDirResolver } from './lib/paths'
import { MODEL_FOLDER_TYPES } from './lib/models'
import { readFileSafe, writeFileSafe } from './lib/safe-file'

export interface KnownSettings {
  cacheDir: string
  /** Number of completed downloads kept in the cache before eviction. Not
   *  exposed in the UI; editable only by hand in settings.json. */
  maxCachedDownloads: number
  onAppClose: 'tray' | 'quit'
  modelsDirs: string[]
  inputDir: string
  outputDir: string
  /** Default suggested parent directory for new installations. */
  installDir: string
  language?: string
  theme?: string
  /** Legacy "check for updates on startup" toggle. No longer gated on a setting;
   *  kept in the schema so existing settings.json files don't lose data. */
  autoUpdate?: boolean
  /** When true (default), Desktop updates download and install silently; when
   *  false, the user is prompted before any download/install. */
  autoInstallUpdates?: boolean
  /** Opt-in auto-launch on Desktop startup. Values:
   *  - `'none'` (default) — land on the dashboard, current behavior.
   *  - `'last'` — launch the install with the largest `lastLaunchedAt`.
   *  - any other string — launch the install with that id; falls back to
   *    `'none'` silently when the id is gone. */
  autoLaunchOnStartup?: string
  /** When true, closing a local-install window asks the user to confirm first
   *  (guards against accidentally killing a ComfyUI that took minutes to boot).
   *  Default false — windows close without a prompt. */
  confirmBeforeClosingWindow?: boolean
  pypiMirror?: string
  useChineseMirrors?: boolean
  chineseMirrorsPrompted?: boolean
  telemetryEnabled?: boolean
  /** `true` once the first-use takeover is finished. Mid-flow cancel does NOT
   *  flip this, so the takeover replays from step 1 next launch. */
  firstUseCompleted?: boolean
  /** When true, hide the Cloud tile (and the Try-Cloud CTA) from the
   *  Dashboard / Instance Picker. Local-only users who never use Cloud
   *  can opt out of seeing it without us removing the feature. Default
   *  false — Cloud stays visible. */
  hideCloudFromPicker?: boolean
  oemManagedModelDirs?: string[]
  oemWorkflowImportVersion?: number
  /** Directory the user last chose in the general "Save image/file" dialog.
   *  Used to seed the dialog's defaultPath so it matches browser behavior. */
  lastSaveDialogDir?: string
  /** Version of a Desktop update whose installer finished downloading in a
   *  previous session and is staged on disk. Gates the bounded startup
   *  install check so boots without a staged update aren't delayed. Cleared
   *  once that version is actually running. */
  pendingDownloadedUpdateVersion?: string
  /** Version we last auto-attempted to install at startup. Loop-breaker: if an
   *  attempt didn't take (still running the old version), we don't auto-retry
   *  the same version on the next boot — the user can still install it manually
   *  via the update pill. Cleared once that version is actually running. */
  lastStartupUpdateAttemptVersion?: string
  /** Hidden, local-only gate (default false / off) for applying a staged Desktop
   *  update on the next launch instead of letting electron-updater install it on
   *  quit. Windows-only — ignored on macOS/Linux, whose updaters don't have the
   *  shutdown install-corruption this addresses. Off: install-on-quit stays armed
   *  and is only suppressed while the OS is shutting down. On: install-on-quit is
   *  disabled and the update applies at startup. Not remote yet — flipped by hand
   *  in settings.json to canary the startup-install path. */
  installUpdatesOnStartup?: boolean
  /** Hidden, local-only gate (default false / off) for showing the NSIS
   *  installer's own progress window while an update installs, instead of
   *  installing fully silently. Windows-only — `isSilent` is an NSIS concept and
   *  is ignored on macOS/Linux. On update the assisted installer skips the
   *  welcome/license/directory pages and our `customFinishPage` auto-launches +
   *  skips the finish page, so the user only sees a progress window (no clicks).
   *  Gives continuous visual feedback during the real file copy, which our
   *  Electron "Updating…" splash can't cover (the copy happens after we quit).
   *  Not remote yet — flipped by hand in settings.json to canary it. */
  showInstallerUI?: boolean
}

export type Settings = KnownSettings & Record<string, unknown>

type DefaultedSettingKey =
  | 'cacheDir'
  | 'maxCachedDownloads'
  | 'onAppClose'
  | 'modelsDirs'
  | 'inputDir'
  | 'outputDir'
  | 'installDir'
type SettingsDefaults = Pick<KnownSettings, DefaultedSettingKey>

const dataPath = path.join(configDir(), "settings.json")

const SHARED_ROOT = path.join(homeDir(), "ComfyUI-Shared")

const SETTINGS_SCHEMA = {
  cacheDir: { nullable: false },
  maxCachedDownloads: { nullable: false },
  onAppClose: { nullable: false },
  modelsDirs: { nullable: false },
  inputDir: { nullable: false },
  outputDir: { nullable: false },
  installDir: { nullable: false },
  language: { nullable: false },
  theme: { nullable: false },
  autoUpdate: { nullable: false },
  autoInstallUpdates: { nullable: false },
  autoLaunchOnStartup: { nullable: false },
  confirmBeforeClosingWindow: { nullable: false },
  pypiMirror: { nullable: false },
  useChineseMirrors: { nullable: false },
  chineseMirrorsPrompted: { nullable: false },
  telemetryEnabled: { nullable: false },
  firstUseCompleted: { nullable: false },
  hideCloudFromPicker: { nullable: false },
  oemManagedModelDirs: { nullable: false },
  oemWorkflowImportVersion: { nullable: false },
  lastSaveDialogDir: { nullable: true },
  pendingDownloadedUpdateVersion: { nullable: true },
  lastStartupUpdateAttemptVersion: { nullable: true },
  installUpdatesOnStartup: { nullable: false },
  showInstallerUI: { nullable: false },
} as const satisfies Record<keyof KnownSettings, { nullable: boolean }>

export type KnownSettingKey = keyof typeof SETTINGS_SCHEMA
export type NullableKnownSettingKey = {
  [K in KnownSettingKey]-?: (typeof SETTINGS_SCHEMA)[K]['nullable'] extends true ? K : never
}[KnownSettingKey]

const KNOWN_SETTING_KEYS = Object.keys(SETTINGS_SCHEMA) as KnownSettingKey[]

function isKnownSettingKey(key: string): key is KnownSettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS_SCHEMA, key)
}

function isNullableKnownSettingKey(key: KnownSettingKey): key is NullableKnownSettingKey {
  return SETTINGS_SCHEMA[key].nullable
}

export const defaults: SettingsDefaults = {
  cacheDir: path.join(cacheDir(), "download-cache"),
  maxCachedDownloads: 1,
  // Docking-to-tray is disabled (createTray() is currently a no-op).
  onAppClose: "quit",
  modelsDirs: [path.join(SHARED_ROOT, "models")],
  inputDir: path.join(SHARED_ROOT, "input"),
  outputDir: path.join(SHARED_ROOT, "output"),
  installDir: path.join(homeDir(), "ComfyUI-Installs"),
}

const systemDefault = defaults.modelsDirs[0]!
const shouldSanitizeCopiedUserDefaults = process.platform === 'win32'

function resolveIfNonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? path.resolve(value) : null
}

function getRelativeDefaultFromHome(currentDefault: string): string | null {
  const home = path.resolve(homeDir())
  const rel = path.relative(home, path.resolve(currentDefault))
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel
}

function isForeignUserDefaultPath(value: unknown, currentDefault: string): boolean {
  const candidate = resolveIfNonEmpty(value)
  if (!candidate) return false

  const currentResolved = path.resolve(currentDefault)
  if (candidate === currentResolved) return false

  const home = path.resolve(homeDir())
  const relativeDefault = getRelativeDefaultFromHome(currentDefault)
  if (!relativeDefault) return false

  let candidateHome = candidate
  for (const _part of relativeDefault.split(path.sep).filter(Boolean)) {
    candidateHome = path.dirname(candidateHome)
  }

  if (candidateHome === home) return false
  if (path.dirname(candidateHome) !== path.dirname(home)) return false

  return path.resolve(path.join(candidateHome, relativeDefault)) === candidate
}

function sanitizeUserDefaultPath(value: unknown, currentDefault: string): string {
  const candidate = resolveIfNonEmpty(value)
  if (!candidate) return currentDefault
  return isForeignUserDefaultPath(candidate, currentDefault) ? currentDefault : candidate
}

function sanitizeModelsDirs(value: unknown, currentDefault: string): string[] {
  const dirs = Array.isArray(value) ? value : []
  const seen = new Set<string>()
  const result: string[] = []

  for (const dir of dirs) {
    const candidate = resolveIfNonEmpty(dir)
    if (!candidate) continue
    if (isForeignUserDefaultPath(candidate, currentDefault)) continue
    if (seen.has(candidate)) continue
    seen.add(candidate)
    result.push(candidate)
  }

  // A non-empty list reflects the user's stated preference — return
  // as-is. Empty / missing input falls back to [systemDefault] in the
  // caller (`load()`).

  return result
}

/** E2E-only: write `E2E_SETTINGS_SEED` to settings.json before the first read,
 *  so the harness needn't guess the platform-specific `userData` path. Runs at
 *  most once per process. */
let e2eSeedApplied = false
function maybeSeedFromEnv(): void {
  if (e2eSeedApplied) return
  e2eSeedApplied = true
  // Hard guard: never run in production builds.
  if (app.isPackaged) return
  if (process.env['E2E'] !== '1') return
  const seed = process.env['E2E_SETTINGS_SEED']
  if (!seed) return
  // Drop the env var so the (possibly sensitive) payload doesn't leak into child
  // processes (Python, ComfyUI server).
  delete process.env['E2E_SETTINGS_SEED']
  try {
    JSON.parse(seed) // validate before writing
    fs.mkdirSync(path.dirname(dataPath), { recursive: true })
    writeFileSafe(dataPath, seed, true)
  } catch (err) {
    console.warn('Settings: failed to apply E2E_SETTINGS_SEED:', (err as Error).message)
  }
}

function load(): Settings {
  maybeSeedFromEnv()
  let parsed: Record<string, unknown> | null = null
  const raw = readFileSafe(dataPath)
  if (raw) {
    try {
      const obj: unknown = JSON.parse(raw)
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) parsed = obj as Record<string, unknown>
    } catch (err) {
      console.warn('Settings: failed to parse settings JSON:', (err as Error).message)
    }
  }
  if (parsed) {
    for (const key of KNOWN_SETTING_KEYS) {
      if (parsed[key] === null && !isNullableKnownSettingKey(key)) {
        delete parsed[key]
      }
    }
  }
  const result: Settings = { ...defaults, ...(parsed || {}) }
  let changed = false

  // Drop legacy keys that no longer back any setting. `maxCachedFiles` was the
  // user-editable predecessor of `maxCachedDownloads`; its old value is
  // discarded so everyone adopts the new default. `closeDirectlyOnLastWindow`
  // backed the removed last-window quit toggle (close confirmation is now gated
  // by `confirmBeforeClosingWindow`, off by default).
  for (const key of [
    'primaryInstallId',
    'pinnedInstallIds',
    'maxCachedFiles',
    'closeDirectlyOnLastWindow',
  ]) {
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      delete result[key]
      changed = true
    }
  }

  // Drop a stale `onAppClose: 'tray'` while docking is disabled, else it would
  // silently take effect the moment docking is restored. Preserves a `'quit'`
  // choice.
  if (result.onAppClose === 'tray') {
    delete (result as Record<string, unknown>).onAppClose
    changed = true
  }

  if (shouldSanitizeCopiedUserDefaults) {
    const nextCacheDir = sanitizeUserDefaultPath(result.cacheDir, defaults.cacheDir)
    if (nextCacheDir !== result.cacheDir) {
      result.cacheDir = nextCacheDir
      changed = true
    }

    const nextModelsDirs = sanitizeModelsDirs(result.modelsDirs, systemDefault)
    if (
      !Array.isArray(result.modelsDirs)
      || nextModelsDirs.length !== result.modelsDirs.length
      || nextModelsDirs.some((dir, index) => dir !== result.modelsDirs[index])
    ) {
      result.modelsDirs = nextModelsDirs
      changed = true
    }

    const nextInputDir = sanitizeUserDefaultPath(result.inputDir, defaults.inputDir)
    if (nextInputDir !== result.inputDir) {
      result.inputDir = nextInputDir
      changed = true
    }

    const nextOutputDir = sanitizeUserDefaultPath(result.outputDir, defaults.outputDir)
    if (nextOutputDir !== result.outputDir) {
      result.outputDir = nextOutputDir
      changed = true
    }

    const nextInstallDir = sanitizeUserDefaultPath(result.installDir, defaults.installDir)
    if (nextInstallDir !== result.installDir) {
      result.installDir = nextInstallDir
      changed = true
    }
  }

  // Keep modelsDirs a valid array of non-empty strings; inject system default as fallback.
  if (Array.isArray(result.modelsDirs)) {
    const before = result.modelsDirs.length
    result.modelsDirs = result.modelsDirs.filter((d): d is string => typeof d === 'string' && d.trim() !== '')
    if (result.modelsDirs.length !== before) changed = true
  }
  if (!Array.isArray(result.modelsDirs) || result.modelsDirs.length === 0) {
    result.modelsDirs = [systemDefault]
    changed = true
  }

  // If none of the user's model directories exist on disk anymore (e.g.
  // the primary was deleted by the user or a system tool), restore the
  // shared default as the primary entry so the app is never left without
  // a usable, non-deletable models directory.
  const anyModelsDirExists = result.modelsDirs.some(
    (d): d is string => typeof d === 'string' && fs.existsSync(path.resolve(d))
  )
  if (!anyModelsDirExists) {
    const others = result.modelsDirs.filter((d) => path.resolve(d) !== path.resolve(systemDefault))
    const restored = [systemDefault, ...others]
    if (
      restored.length !== result.modelsDirs.length
      || restored.some((d, i) => d !== result.modelsDirs[i])
    ) {
      result.modelsDirs = restored
      changed = true
    }
  }

  // Create the shared default models tree whenever it's part of the list
  // (the user chose it, or we just restored it above). A user who moved
  // their models elsewhere and still has those paths keeps an untouched
  // ~/ComfyUI-Shared.
  const usesSystemDefault = result.modelsDirs.some(
    (d): d is string => typeof d === 'string' && path.resolve(d) === path.resolve(systemDefault)
  )
  if (usesSystemDefault) {
    try {
      fs.mkdirSync(systemDefault, { recursive: true })
      for (const folder of MODEL_FOLDER_TYPES) {
        fs.mkdirSync(path.join(systemDefault, folder), { recursive: true })
      }
    } catch {}
  }

  // inputDir/outputDir must always point at a folder that exists. If the
  // designated folder is gone, fall back to the safe shared default
  // (which is always OK to recreate) and surface that in the setting —
  // we don't resurrect a vanished custom path.
  for (const key of ["inputDir", "outputDir"] as const) {
    const designated = result[key] as string | undefined
    const exists =
      typeof designated === 'string'
      && designated.trim() !== ''
      && fs.existsSync(path.resolve(designated))
    if (exists) continue
    if (result[key] !== defaults[key]) {
      result[key] = defaults[key]
      changed = true
    }
    try {
      fs.mkdirSync(defaults[key], { recursive: true })
    } catch {}
  }
  if (changed) save(result)
  return result
}

function save(settings: Settings): void {
  writeFileSafe(dataPath, JSON.stringify(settings, null, 2), true)
}

/** Sentinel values for `autoLaunchOnStartup`. Any string OTHER than these
 *  is treated as an installation id. */
export const AUTO_LAUNCH_NONE = 'none'
export const AUTO_LAUNCH_LAST = 'last'

export function get<K extends KnownSettingKey>(key: K): KnownSettings[K]
export function get(key: string): unknown
export function get(key: string): unknown {
  const value = load()[key]
  // Absence means the default — surface `'none'` to callers so they don't have
  // to special-case undefined everywhere they branch on the auto-launch mode.
  if (key === 'autoLaunchOnStartup' && (value === undefined || value === null)) {
    return AUTO_LAUNCH_NONE
  }
  return value
}

/** Keys whose values should be deleted when set to an empty or whitespace-only string. */
const EMPTY_STRING_MEANS_UNSET: ReadonlySet<string> = new Set<KnownSettingKey>(['pypiMirror'])

/** Keys whose default value should be persisted as absence — `set(k, default)`
 *  drops the key so the file doesn't accumulate no-op writes. */
const DEFAULT_VALUE_MEANS_UNSET: ReadonlyMap<string, unknown> = new Map<KnownSettingKey, unknown>([
  ['autoLaunchOnStartup', AUTO_LAUNCH_NONE],
])

export function set<K extends string>(
  key: K,
  value: K extends KnownSettingKey ? KnownSettings[K] | undefined : unknown
): void {
  const settings = load()
  // `undefined` = unset/default; for non-nullable known keys treat `null` the
  // same, and for EMPTY_STRING_MEANS_UNSET keys treat '' / whitespace as unset.
  if (
    value === undefined
    || (value === null && isKnownSettingKey(key) && !isNullableKnownSettingKey(key))
    || (typeof value === 'string' && value.trim() === '' && EMPTY_STRING_MEANS_UNSET.has(key))
    || (DEFAULT_VALUE_MEANS_UNSET.has(key) && value === DEFAULT_VALUE_MEANS_UNSET.get(key))
  ) {
    delete settings[key]
    save(settings)
    return
  }
  settings[key] = value
  save(settings)
}

export function getAll(): Settings {
  return load()
}

/**
 * `true` iff `key` looks user-chosen: persisted in settings.json as non-null
 * AND, for defaulted keys, differing from the built-in default. The
 * default-comparison guards against `load()`'s merged write persisting defaults
 * as a side effect, which would otherwise fool the legacy-adopt carry. A user
 * who explicitly picks the default value is misclassified as "not set"
 * (accepted). Returns `false` on parse errors or a missing file.
 */
export function has(key: string): boolean {
  const raw = readFileSafe(dataPath)
  if (!raw) return false
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    const value = (parsed as Record<string, unknown>)[key]
    if (value === undefined || value === null) return false
    if (key in defaults) {
      const def = (defaults as Record<string, unknown>)[key]
      if (typeof def === 'string' && typeof value === 'string') {
        if (path.resolve(def) === path.resolve(value)) return false
      } else if (Array.isArray(def) && Array.isArray(value)) {
        if (def.length === value.length
          && def.every((d, i) => typeof d === 'string' && typeof value[i] === 'string'
            ? path.resolve(d as string) === path.resolve(value[i] as string)
            : d === value[i])) {
          return false
        }
      } else if (def === value) {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}

/** Build a PipMirrorConfig from current settings. */
export function getMirrorConfig(): { pypiMirror?: string; useChineseMirrors?: boolean } {
  return { pypiMirror: get('pypiMirror'), useChineseMirrors: get('useChineseMirrors') === true }
}

// Let paths.defaultInstallDir() honor the user's configured location without
// paths.ts importing this module (which would create an init cycle).
setInstallDirResolver(() => get('installDir'))
