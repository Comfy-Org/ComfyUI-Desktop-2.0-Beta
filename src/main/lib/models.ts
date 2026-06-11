import path from 'path'
import fs from 'fs'
import os from 'os'
import { parse as parseYaml } from 'yaml'
import { dataDir } from './paths'
import { writeFileSafe } from './safe-file'
import { findComfyUIDir } from './migrate'
import type { InstallationRecord } from '../installations'

// Canonical ComfyUI model folder types from folder_paths.py. Must stay in sync with that list.
export const MODEL_FOLDER_TYPES = [
  'checkpoints',
  'classifiers',
  'clip_vision',
  'configs',
  'controlnet',
  'diffusers',
  'diffusion_models',
  'embeddings',
  'gligen',
  'hypernetworks',
  'latent_upscale_models',
  'loras',
  'model_patches',
  'audio_encoders',
  'photomaker',
  'style_models',
  'text_encoders',
  'upscale_models',
  'background_removal',
  'frame_interpolation',
  'geometry_estimation',
  'optical_flow',
  'detection',
  'vae',
  'vae_approx'
] as const

const YAML_PATH: string = path.join(dataDir(), 'shared_model_paths.yaml')

/** Per-install YAML path for instance-specific model directories (used when an
 *  install opts out of shared models). Kept under dataDir() so it survives a
 *  reinstall and is trivial to clean up when the install is removed. */
export function instanceModelPathsYaml(installationId: string): string {
  return path.join(dataDir(), 'instance-model-paths', `${installationId}.yaml`)
}

// Canonical names plus legacy/alias directory names ComfyUI maps to canonical names.
export const KNOWN_MODEL_FOLDERS = new Set<string>([
  ...MODEL_FOLDER_TYPES,
  'clip', // legacy alias for text_encoders
  'unet', // legacy alias for diffusion_models
  't2i_adapter' // secondary dir for controlnet
])

// Folder names that must NEVER be registered as model search paths (system dirs, tooling
// dotfolders, `models` self-reference). `custom_nodes` is critical: ComfyUI's prestartup
// does `os.listdir` on every registered custom_nodes path and crashes if it's missing.
const NON_MODEL_FOLDERS = new Set<string>([
  'custom_nodes',
  'user',
  'input',
  'output',
  'temp',
  'models',
  '.venv',
  '.snapshots',
  '.git',
  '__pycache__',
  '.desktop2-downloads' // in-progress download temp dir (see comfyDownloadManager)
])

export interface ModelPathsResult {
  yamlPath: string
  extraFolders: string[]
}

export interface SyncResult {
  newFolders: string[]
  config: ModelPathsResult | null
}

export interface ModelPathsOptions {
  /** Target YAML path; defaults to the global shared YAML. */
  yamlPath?: string
  /** Dir that should carry `is_default: true`. Omit for the first dir (global
   *  shared / legacy); pass `null` for no default so ComfyUI keeps its built-in
   *  `<comfyDir>/models` as the default (per-install, install-owned primary). */
  primaryDir?: string | null
}

/** Lists subdirectory names, including symlinks that resolve to directories. */
function allFoldersIn(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => {
        if (e.isDirectory()) return true
        if (e.isSymbolicLink()) {
          try {
            return fs.statSync(path.join(dir, e.name)).isDirectory()
          } catch {
            return false
          }
        }
        return false
      })
      .map((e) => e.name)
  } catch {
    return []
  }
}

/** Subdirectories not in KNOWN_MODEL_FOLDERS or NON_MODEL_FOLDERS. */
function extraFoldersIn(dir: string): string[] {
  return allFoldersIn(dir).filter(
    (name) => !KNOWN_MODEL_FOLDERS.has(name) && !NON_MODEL_FOLDERS.has(name)
  )
}

/** Extra (custom-node-created) model folders, checking both standalone and portable layouts. */
export function discoverExtraModelFolders(installPath: string): string[] {
  const candidates = [path.join(installPath, 'ComfyUI', 'models'), path.join(installPath, 'models')]
  const seen = new Set<string>()
  for (const dir of candidates) {
    for (const name of extraFoldersIn(dir)) {
      seen.add(name)
    }
  }
  return [...seen].sort()
}

/** Deduplicated, sorted extra model folder names across all shared model directories. */
function discoverExtraFoldersFromSharedDirs(modelsDirs: string[]): string[] {
  const seen = new Set<string>()
  for (const dir of modelsDirs) {
    for (const name of extraFoldersIn(dir)) {
      seen.add(name)
    }
  }
  return [...seen].sort()
}

/**
 * Legacy directory aliases that ComfyUI's own defaults register under canonical
 * folder types (`folder_paths.py`):
 *   - `clip/` is a second path on `text_encoders` (ComfyUI's `map_legacy` maps
 *     a YAML `clip:` key to `text_encoders` automatically).
 *   - `unet/` is a second path on `diffusion_models` (same legacy mapping).
 *   - `t2i_adapter/` is a second path on `controlnet` (no legacy mapping —
 *     emitted as its own key, ComfyUI's controlnet defaults already list it).
 *
 * Without these in the YAML, shared-dir users who keep encoders in
 * `<shared>/clip/` (the historical ComfyUI layout) or diffusion models in
 * `<shared>/unet/` see their files invisible to `DualCLIPLoader` / `UNETLoader`,
 * even though Storage shows the shared dir is configured. ComfyUI's defaults
 * find them when they live under `<install>/ComfyUI/models/clip|unet/` because
 * those are baked into `folder_names_and_paths`, but the extra-paths YAML only
 * registers what we explicitly list. Emitting the aliases for every shared dir
 * keeps the shared layout on equal footing with the install's own defaults. */
const LEGACY_FOLDER_ALIASES: ReadonlyArray<{ key: string; dir: string }> = [
  { key: 'clip', dir: 'clip' },
  { key: 'unet', dir: 'unet' },
  { key: 't2i_adapter', dir: 't2i_adapter' },
]

/** Case-insensitive on Windows, case-sensitive elsewhere. Both inputs are
 *  expected to already be absolute (path.resolve'd by the caller). */
function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** Resolve both paths, then compare with platform-aware case sensitivity. */
export function isSamePath(a: string, b: string): boolean {
  return samePath(path.resolve(a), path.resolve(b))
}

/** The ComfyUI root for an install (where models/input/output live). Falls back
 *  to `<installPath>/ComfyUI` when the dir can't be probed yet. */
export function resolveComfyDir(installPath: string): string {
  return findComfyUIDir(installPath) ?? path.join(installPath, 'ComfyUI')
}

/** The install's own default models / input / output dirs. These are never
 *  persisted (they live inside the install, so a clone must derive its own). */
export function installModelsDir(installPath: string): string {
  return path.join(resolveComfyDir(installPath), 'models')
}
export function installInputDir(installPath: string): string {
  return path.join(resolveComfyDir(installPath), 'input')
}
export function installOutputDir(installPath: string): string {
  return path.join(resolveComfyDir(installPath), 'output')
}

/**
 * @param primaryDir Resolved path that should carry `is_default: true`, or null
 *   for no default (lets ComfyUI keep its built-in `<comfyDir>/models` default).
 */
function buildYaml(
  modelsDirs: string[],
  extraFolders: string[] = [],
  primaryDir: string | null = null
): string {
  const allFolders = [...MODEL_FOLDER_TYPES, ...extraFolders]
  const lines = [
    '# Generated by Comfy Desktop — do not edit manually.',
    '# When ComfyUI supports all_model_folders, this file will be simplified to:',
    '#   comfy.desktop:',
    "#     base_path: '...'",
    '#     is_default: true',
    '#     all_model_folders: true',
    ''
  ]
  modelsDirs.forEach((dir, i) => {
    const escaped = dir.replace(/'/g, "''")
    lines.push(`comfy.desktop_${i}:`)
    lines.push(`  base_path: '${escaped}'`)
    if (primaryDir != null && samePath(dir, primaryDir)) lines.push('  is_default: true')
    for (const folder of allFolders) {
      const escapedFolder = folder.replace(/'/g, "''")
      lines.push(`  '${escapedFolder}': '${escapedFolder}/'`)
    }
    // Emit legacy aliases AFTER the canonical entries so the canonical
    // directories (e.g. `text_encoders/`) stay first in ComfyUI's search
    // order — `add_model_folder_path` appends to the existing list.
    for (const { key, dir } of LEGACY_FOLDER_ALIASES) {
      const escapedKey = key.replace(/'/g, "''")
      const escapedDir = dir.replace(/'/g, "''")
      lines.push(`  '${escapedKey}': '${escapedDir}/'`)
    }
    lines.push('')
  })
  return lines.join('\n')
}

/**
 * Ensures the shared model paths YAML is up to date, including extra subdirectories
 * already present in the shared dirs. Returns null if no directories are configured.
 */
export function ensureModelPathsConfig(
  modelsDirs: string[] | null | undefined,
  options: ModelPathsOptions = {}
): ModelPathsResult | null {
  if (!modelsDirs || !Array.isArray(modelsDirs) || modelsDirs.length === 0) return null
  const yamlPath = options.yamlPath ?? YAML_PATH
  const resolved = modelsDirs.map((d) => path.resolve(d))
  // `primaryDir` omitted → first dir is default (global shared / legacy);
  // explicit `null` → no default (ComfyUI keeps its built-in models default).
  const primaryRaw = options.primaryDir !== undefined ? options.primaryDir : resolved[0]
  const resolvedPrimary = primaryRaw != null ? path.resolve(primaryRaw) : null
  const extraFolders = discoverExtraFoldersFromSharedDirs(resolved)
  const yaml = buildYaml(resolved, extraFolders, resolvedPrimary)

  let existing: string | null = null
  try {
    existing = fs.readFileSync(yamlPath, 'utf-8')
  } catch {}

  if (existing !== yaml) {
    writeFileSafe(yamlPath, yaml)
  }

  return { yamlPath, extraFolders }
}

/** All subdirectory names from the install's models dir, checking standalone and portable layouts. */
function allInstallModelFolders(installPath: string): string[] {
  const candidates = [path.join(installPath, 'ComfyUI', 'models'), path.join(installPath, 'models')]
  const seen = new Set<string>()
  for (const dir of candidates) {
    for (const name of allFoldersIn(dir)) {
      seen.add(name)
    }
  }
  return [...seen].sort()
}

/**
 * Syncs all model folders from the install to the shared model roots and rewrites the YAML.
 * Returns newly added extra folder names and the updated config.
 */
export function syncCustomModelFolders(
  installPath: string,
  modelsDirs: string[] | null | undefined,
  previousExtras: string[] = [],
  options: ModelPathsOptions = {}
): SyncResult {
  if (!modelsDirs || !Array.isArray(modelsDirs) || modelsDirs.length === 0) {
    return { newFolders: [], config: null }
  }

  // Sync ALL folders (including canonical) so users can place models in any folder type.
  const allFolders = allInstallModelFolders(installPath)
  for (const dir of modelsDirs) {
    for (const folder of allFolders) {
      const target = path.join(dir, folder)
      try {
        fs.mkdirSync(target, { recursive: true })
      } catch {}
    }
  }

  const extraFolders = discoverExtraModelFolders(installPath)
  const previousSet = new Set(previousExtras)
  const newFolders = extraFolders.filter((f) => !previousSet.has(f))

  const config = ensureModelPathsConfig(modelsDirs, options)

  return { newFolders, config }
}

// ---------------------------------------------------------------------------
// extra_model_paths.yaml parsing + resolution
//
// ComfyUI auto-loads `<comfyDir>/extra_model_paths.yaml` at startup (see
// main.py `apply_custom_paths` + utils/extra_config.py), in addition to every
// `--extra-model-paths-config` the launcher passes. The launcher otherwise has
// no knowledge of that user-authored file, so model downloads and existence
// checks must resolve it the same way ComfyUI does to stay consistent.
// ---------------------------------------------------------------------------

/** ComfyUI's `folder_paths.map_legacy`: a couple of folder names are aliases
 *  for canonical types. Normalising both sides lets us match a download's
 *  folder hint against an arbitrarily-named extra-paths override. */
const LEGACY_FOLDER_TYPE_MAP: Readonly<Record<string, string>> = {
  unet: 'diffusion_models',
  clip: 'text_encoders',
}

export function mapLegacyFolderType(type: string): string {
  return LEGACY_FOLDER_TYPE_MAP[type] ?? type
}

/**
 * Keys under a section that are NOT per-type model-folder overrides and must
 * never be treated as model dirs. `custom_nodes` is excluded because pointing
 * the model scanner at a custom-nodes tree would register Python packages as
 * "models"; the others are section metadata.
 */
const NON_MODEL_SECTION_KEYS: ReadonlySet<string> = new Set([
  'base_path',
  'is_default',
  'custom_nodes',
  'download_model_base',
])

/** One config group from an `extra_model_paths.yaml`. */
export interface ExtraModelsSection {
  /** Section name (e.g. `comfyui_desktop`, `my_external`). */
  name: string
  /** `base_path:` value when present (raw, may be relative). */
  basePath?: string
  /** `is_default: true` on the section. ComfyUI applies it per declared type. */
  isDefault?: boolean
  /** Per-type override key (`checkpoints`, `loras`, …) → path. A value may
   *  carry multiple newline/pipe-delimited paths; each becomes its own entry
   *  keyed by the same type. */
  overrides: Array<{ type: string; path: string }>
}

/** Coerce a YAML scalar into one or more trimmed, non-empty path strings.
 *  ComfyUI allows `|`-block and pipe-delimited multi-path values
 *  (e.g. `text_encoders: models/text_encoders/\nmodels/clip/`). */
function splitYamlPaths(value: unknown): string[] {
  if (value == null) return []
  return String(value)
    .split(/[\r\n|]+/)
    .map((s) => s.replace(/#.*$/, '').trim())
    .filter((s) => s.length > 0)
}

/**
 * Parse an `extra_model_paths.yaml` into structured sections, each with its
 * optional `base_path`, `is_default` flag, and every per-type model-folder
 * override. Uses a real YAML parser so `|`-block scalars and pipe-delimited
 * multi-path values are handled correctly. Returns `[]` on any parse failure so
 * a malformed file never aborts the caller.
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
    if (group['is_default'] === true) section.isDefault = true
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

/** Normalise like Python's `os.path.normpath`: collapse separators and strip a
 *  trailing one (a YAML subpath such as `loras/` must equal `<base>/loras`, not
 *  `<base>/loras/`, so existence checks line up). */
function normpath(p: string): string {
  const norm = path.normalize(p)
  // Never strip a filesystem root's trailing separator (e.g. `C:\` or `/`),
  // which would corrupt it into `C:` / ``.
  if (norm === path.parse(norm).root) return norm
  const stripped = norm.replace(/[\\/]+$/, '')
  return stripped.length > 0 ? stripped : norm
}

/** Expand `~` and environment variables, mirroring Python's
 *  `os.path.expandvars(os.path.expanduser(...))` for the common cases. */
function expandUserVars(p: string): string {
  let out = p
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
    out = path.join(os.homedir(), out.slice(1))
  }
  out = out.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, braced, bare) => {
    const name = braced ?? bare
    return process.env[name] ?? m
  })
  if (process.platform === 'win32') {
    out = out.replace(/%([^%]+)%/g, (m, name) => process.env[name] ?? m)
  }
  return out
}

/** A model directory contributed by an `extra_model_paths.yaml`, resolved the
 *  same way ComfyUI's `load_extra_path_config` does. */
export interface ResolvedExtraPath {
  /** Section the entry came from (for display grouping). */
  section: string
  /** Canonical folder type (legacy aliases mapped). */
  type: string
  /** Folder type exactly as written in the YAML (for display). */
  rawType: string
  /** Absolute, normalised directory holding files of this type. */
  dir: string
  /** Whether the section carried `is_default: true`. */
  isDefault: boolean
}

/**
 * Resolve an `extra_model_paths.yaml` into per-type absolute directories,
 * mirroring ComfyUI's `utils/extra_config.load_extra_path_config`:
 *  - `base_path` is `~`/env-expanded, then made absolute relative to the YAML's
 *    own directory when relative; per-type subpaths are NOT expanded.
 *  - each per-type subpath is joined onto `base_path` (an absolute subpath wins,
 *    matching `os.path.join`), or resolved relative to the YAML dir when there
 *    is no `base_path`.
 * Returns `[]` when the file is absent or unparseable.
 */
export function resolveExtraModelPaths(yamlPath: string): ResolvedExtraPath[] {
  let content: string
  try {
    content = fs.readFileSync(yamlPath, 'utf-8')
  } catch {
    return []
  }
  const yamlDir = path.dirname(path.resolve(yamlPath))
  const out: ResolvedExtraPath[] = []
  for (const section of parseExtraModelsSections(content)) {
    let base: string | null = null
    if (section.basePath) {
      base = expandUserVars(section.basePath)
      if (!path.isAbsolute(base)) base = path.resolve(yamlDir, base)
    }
    for (const { type, path: sub } of section.overrides) {
      let full: string
      if (base) {
        full = path.isAbsolute(sub) ? sub : path.join(base, sub)
      } else if (path.isAbsolute(sub)) {
        full = sub
      } else {
        full = path.resolve(yamlDir, sub)
      }
      out.push({
        section: section.name,
        type: mapLegacyFolderType(type),
        rawType: type,
        dir: normpath(full),
        isDefault: !!section.isDefault,
      })
    }
  }
  return out
}

/** The complete set of model locations a single install's ComfyUI will search,
 *  matching what the launcher should download into / check before downloading. */
export interface InstallModelSearch {
  /** Models root new downloads land in (the UI-visible primary). Always a
   *  launcher-managed root with a `<type>/` layout, so any folder type is a
   *  safe target. */
  downloadBaseDir: string
  /** Complete model roots (built-in `<comfyDir>/models` + launcher dirs); each
   *  holds files at `<root>/<type>`. */
  modelRoots: string[]
  /** Arbitrary per-type dirs from the install's `extra_model_paths.yaml`. */
  extraPaths: ResolvedExtraPath[]
}

/**
 * Resolve every model search location for an install, mirroring the directories
 * its ComfyUI process actually sees: the built-in `<comfyDir>/models`, the
 * launcher-generated extra-paths (global `modelsDirs` when shared models are on,
 * else the per-install `modelDirs`), and the user-authored
 * `<comfyDir>/extra_model_paths.yaml`.
 *
 * `sharedModelsDirs` is passed in (rather than read from settings) to keep this
 * module free of a settings import cycle.
 */
export function resolveInstallModelSearchPaths(
  inst: InstallationRecord,
  sharedModelsDirs: string[]
): InstallModelSearch {
  const installPath = inst.installPath
  const comfyDir = resolveComfyDir(installPath)
  const builtinRoot = path.resolve(installModelsDir(installPath))

  const useShared = (inst.useSharedModels as boolean | undefined) !== false
  let launcherRoots: string[]
  let primary: string
  if (useShared) {
    launcherRoots = sharedModelsDirs.map((d) => path.resolve(d))
    primary = launcherRoots[0] ?? builtinRoot
  } else {
    const instanceDirs = ((inst.modelDirs as string[] | undefined) ?? []).map((d) => path.resolve(d))
    launcherRoots = instanceDirs
    const primaryRaw = inst.modelDirsPrimary as string | undefined
    primary =
      typeof primaryRaw === 'string' && instanceDirs.some((d) => isSamePath(d, primaryRaw))
        ? path.resolve(primaryRaw)
        : builtinRoot
  }

  const modelRoots: string[] = []
  const seen = new Set<string>()
  for (const root of [builtinRoot, ...launcherRoots]) {
    const key = process.platform === 'win32' ? root.toLowerCase() : root
    if (seen.has(key)) continue
    seen.add(key)
    modelRoots.push(root)
  }

  const extraPaths = resolveExtraModelPaths(path.join(comfyDir, 'extra_model_paths.yaml'))

  return { downloadBaseDir: primary, modelRoots, extraPaths }
}
