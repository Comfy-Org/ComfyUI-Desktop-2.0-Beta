import path from 'path'
import fs from 'fs'
import { app } from 'electron'
import { configDir, cacheDir, homeDir } from './lib/paths'
import { MODEL_FOLDER_TYPES } from './lib/models'
import { readFileSafe, writeFileSafe } from './lib/safe-file'

export interface KnownSettings {
  cacheDir: string
  maxCachedFiles: number
  onAppClose: 'tray' | 'quit'
  modelsDirs: string[]
  inputDir: string
  outputDir: string
  language?: string
  theme?: string
  /**
   * Legacy "Check for updates on startup" toggle. Issue #488 split this
   * into "always auto-check" (no longer gated by a setting) and
   * `autoInstallUpdates` (new toggle for silent install vs prompt).
   * The key stays in the schema so existing settings.json files don't
   * lose data; a future setting may re-expose it.
   */
  autoUpdate?: boolean
  /**
   * Issue #488 — when true (default), Desktop app updates download
   * silently in the background and are installed silently on the next
   * relaunch (or when the user clicks the "Desktop Update Ready" pill).
   * When false, the user is prompted before any download / install.
   */
  autoInstallUpdates?: boolean
  pypiMirror?: string
  useChineseMirrors?: boolean
  chineseMirrorsPrompted?: boolean
  telemetryEnabled?: boolean
  /**
   * `true` once the user has finished the first-use takeover (T&C +
   * telemetry consent + locale-conditional China mirror prompt +
   * Cloud/Local pick). Persists across launches so the takeover only
   * shows on the very first run. Mid-flow cancel does NOT flip this —
   * the takeover replays from step 1 next launch.
   */
  firstUseCompleted?: boolean
  oemManagedModelDirs?: string[]
  oemWorkflowImportVersion?: number
}

export type Settings = KnownSettings & Record<string, unknown>

type DefaultedSettingKey =
  | 'cacheDir'
  | 'maxCachedFiles'
  | 'onAppClose'
  | 'modelsDirs'
  | 'inputDir'
  | 'outputDir'
type SettingsDefaults = Pick<KnownSettings, DefaultedSettingKey>

const dataPath = path.join(configDir(), "settings.json")

const SHARED_ROOT = path.join(homeDir(), "ComfyUI-Shared")

const SETTINGS_SCHEMA = {
  cacheDir: { nullable: false },
  maxCachedFiles: { nullable: false },
  onAppClose: { nullable: false },
  modelsDirs: { nullable: false },
  inputDir: { nullable: false },
  outputDir: { nullable: false },
  language: { nullable: false },
  theme: { nullable: false },
  autoUpdate: { nullable: false },
  autoInstallUpdates: { nullable: false },
  pypiMirror: { nullable: false },
  useChineseMirrors: { nullable: false },
  chineseMirrorsPrompted: { nullable: false },
  telemetryEnabled: { nullable: false },
  firstUseCompleted: { nullable: false },
  oemManagedModelDirs: { nullable: false },
  oemWorkflowImportVersion: { nullable: false },
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
  maxCachedFiles: 5,
  // Docking-to-tray is disabled while the unified-window flow is being
  // rebuilt — see main/index.ts (createTray() is a no-op for now).
  // When docking comes back, default this to 'tray' again and restore
  // the settings UI field in registerSettingsHandlers.ts.
  onAppClose: "quit",
  modelsDirs: [path.join(SHARED_ROOT, "models")],
  inputDir: path.join(SHARED_ROOT, "input"),
  outputDir: path.join(SHARED_ROOT, "output"),
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

/**
 * E2E-only: write the contents of `E2E_SETTINGS_SEED` to settings.json
 * before the first read. Avoids the harness having to guess the
 * platform-specific `userData` path (especially on macOS where
 * Application Support is rooted at the real pw_dir, ignoring HOME).
 * Runs at most once per process.
 */
let e2eSeedApplied = false
function maybeSeedFromEnv(): void {
  if (e2eSeedApplied) return
  e2eSeedApplied = true
  // Hard guard: never run in production builds, even if a malicious
  // env var sneaks in.
  if (app.isPackaged) return
  if (process.env['E2E'] !== '1') return
  const seed = process.env['E2E_SETTINGS_SEED']
  if (!seed) return
  // Drop the env var immediately so it doesn't leak into child
  // processes (Python, ComfyUI server) — the JSON payload may carry
  // sensitive test fixtures we don't want exposed beyond this process.
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

  // Drop legacy pin-related keys (`primaryInstallId`, `pinnedInstallIds`)
  // that no longer back any UI affordance. Purely advisory, so dropping
  // them on first load is sufficient.
  for (const key of ['primaryInstallId', 'pinnedInstallIds']) {
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      delete result[key]
      changed = true
    }
  }

  // Drop a legacy `onAppClose: 'tray'` value while docking-to-tray is
  // disabled. The setting is still in the schema (and the tray-aware
  // close path will come back), but until then a stale `'tray'` value
  // would silently take effect the moment docking is restored. Dropping
  // only the `'tray'` value preserves an explicit `'quit'` choice the
  // user may have set.
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
  }

  // Ensure modelsDirs is a valid array of non-empty strings; inject system default only as a fallback
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

export function get<K extends KnownSettingKey>(key: K): KnownSettings[K]
export function get(key: string): unknown
export function get(key: string): unknown {
  return load()[key]
}

/** Keys whose values should be deleted when set to an empty or whitespace-only string. */
const EMPTY_STRING_MEANS_UNSET: ReadonlySet<string> = new Set<KnownSettingKey>(['pypiMirror'])

export function set<K extends string>(
  key: K,
  value: K extends KnownSettingKey ? KnownSettings[K] | undefined : unknown
): void {
  const settings = load()
  // `undefined` is the canonical "unset/default" value in settings.
  // For known non-nullable keys, treat `null` the same way.
  // For string keys in EMPTY_STRING_MEANS_UNSET, treat '' / whitespace as unset.
  if (
    value === undefined
    || (value === null && isKnownSettingKey(key) && !isNullableKnownSettingKey(key))
    || (typeof value === 'string' && value.trim() === '' && EMPTY_STRING_MEANS_UNSET.has(key))
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

/** Build a PipMirrorConfig from current settings. */
export function getMirrorConfig(): { pypiMirror?: string; useChineseMirrors?: boolean } {
  return { pypiMirror: get('pypiMirror'), useChineseMirrors: get('useChineseMirrors') === true }
}
