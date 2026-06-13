import path from 'path'
import { EventEmitter } from 'events'
import { dataDir } from './lib/paths'
import { readFileSafeAsync, writeFileSafeAsync } from './lib/safe-file'
import type { ComfyVersion } from './lib/version'

/** Event bus for installation lifecycle changes. `'updated'`(record) fires on
 *  `update()` / `markLaunched()` (main/index.ts refreshes title bars since the
 *  title bar isn't on the renderer broadcast); `'changed'`() fires on any
 *  list-affecting mutation and is rebroadcast as `installations-changed`. */
export const installationEvents = new EventEmitter()

/** Source id of the always-seeded Comfy Cloud entry. */
export const CLOUD_SOURCE_ID = 'cloud'
/** Canonical, non-user-editable name of the Comfy Cloud entry (issue #922). */
export const CLOUD_INSTALL_NAME = 'Comfy Cloud'

export interface InstallationRecord {
  id: string
  name: string
  createdAt: string
  installPath: string
  sourceId: string
  status?: string
  seen?: boolean
  comfyVersion?: ComfyVersion
  /** Epoch ms of the most recent launch, regardless of source category. */
  lastLaunchedAt?: number
  /** Most-recent launch ms keyed by source category; written together with
   *  `lastLaunchedAt` via `markLaunched()` so the two stay consistent. */
  lastLaunchedAtByCategory?: Record<string, number>
  /** When true (default), launch injects `--extra-model-paths-config` from the
   *  global `modelsDirs` so this install sees the shared model library. */
  useSharedModels?: boolean
  /** When true (default), launch injects `--input-directory` /
   *  `--output-directory` from the global settings; else uses the per-install
   *  dirs below or ComfyUI's `<installPath>/{input,output}` defaults. */
  useSharedInputOutput?: boolean
  /** Per-install extra (external) model directories, used only when
   *  `useSharedModels === false`. Never includes the install's own models dir.
   *  Written to a per-install `--extra-model-paths-config` YAML at launch. */
  modelDirs?: string[]
  /** External `modelDirs` entry promoted to primary (`is_default`). Null/absent
   *  means the install's own models dir is primary (ComfyUI's built-in default). */
  modelDirsPrimary?: string | null
  /** Per-install input dir, used only when `useSharedInputOutput === false`. */
  inputDir?: string
  /** Per-install output dir, used only when `useSharedInputOutput === false`. */
  outputDir?: string
  /** POC: starter template id the user picked in the install wizard. Durable
   *  record of intent; survives relaunches. */
  bundledTemplateId?: string
  /** One-shot flag consumed by the first launch — when set, the comfy URL is
   *  decorated with `?template=<id>` so the frontend auto-opens it, then this is
   *  cleared so subsequent relaunches start blank. */
  pendingTemplateOpen?: string | null
  /** When true, the install's `template-models` phase pre-downloads the chosen
   *  template's required models into the shared models dir. Set from the wizard
   *  consent checkbox; only meaningful alongside `bundledTemplateId`. */
  downloadTemplateModels?: boolean
  [key: string]: unknown
}

/**
 * In-memory migration of legacy `useSharedPaths` → `useSharedModels` +
 * `useSharedInputOutput`. `useSharedModels` is forced true (users who isolated
 * paths almost certainly meant input/output, not their model library);
 * `useSharedInputOutput` copies the legacy value; the legacy key is stripped.
 * Applied on every `load()`; disk is cleaned on the next write.
 */
function migrateRecord(record: InstallationRecord): InstallationRecord {
  if (!('useSharedPaths' in record)) return record
  const legacy = record.useSharedPaths as boolean | undefined
  const { useSharedPaths: _drop, ...rest } = record
  return {
    ...rest,
    useSharedModels: true,
    useSharedInputOutput: typeof legacy === 'boolean' ? legacy : true,
  } as InstallationRecord
}

const dataPath = path.join(dataDir(), "installations.json")

/**
 * Monotonic install-id generator. A naive `inst-${Date.now()}` collides when
 * two `add()` calls land in the same millisecond, aliasing records in
 * `getRecent()`. Keeps the `inst-${ms}` shape but appends an in-process counter
 * for repeat calls within the same millisecond; the counter resets each tick.
 */
let _lastIdMs = 0
let _idSeq = 0
function nextInstallId(): string {
  const now = Date.now()
  if (now === _lastIdMs) {
    _idSeq += 1
    return `inst-${now}-${_idSeq}`
  }
  _lastIdMs = now
  _idSeq = 0
  return `inst-${now}`
}

// Serialize all load/save operations to prevent concurrent read-modify-write races
let _queue: Promise<void> = Promise.resolve()
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const p = _queue.then(fn)
  _queue = p.then(() => {}, () => {})
  return p
}

async function load(): Promise<InstallationRecord[]> {
  const raw = await readFileSafeAsync(dataPath)
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length > 0) {
        return (parsed as InstallationRecord[]).map(migrateRecord)
      }
    } catch {}
  }
  return []
}

async function save(installations: InstallationRecord[]): Promise<void> {
  await writeFileSafeAsync(dataPath, JSON.stringify(installations, null, 2), true)
}

export async function list(): Promise<InstallationRecord[]> {
  return load()
}

/** True when `name` is taken by an install other than `id`. The single source
 *  of the rename uniqueness rule, shared across both write paths. */
export async function hasNameConflict(id: string, name: string): Promise<boolean> {
  const all = await load()
  return all.some((i) => i.id !== id && i.name === name)
}

export function uniqueName(baseName: string, existing: InstallationRecord[], excludeId?: string): string {
  const names = new Set(existing.filter((i) => i.id !== excludeId).map((i) => i.name))
  if (!names.has(baseName)) return baseName
  let suffix = 1
  while (names.has(`${baseName} (${suffix})`)) suffix++
  return `${baseName} (${suffix})`
}

export async function add(installation: Record<string, unknown>): Promise<InstallationRecord> {
  const entry = await enqueue(async () => {
    const installations = await load()
    installation.name = uniqueName(installation.name as string, installations)
    const entry = {
      id: nextInstallId(),
      createdAt: new Date().toISOString(),
      ...installation,
    } as InstallationRecord
    installations.unshift(entry)
    await save(installations)
    return entry
  })
  installationEvents.emit('changed')
  return entry
}

export async function remove(id: string): Promise<void> {
  await enqueue(async () => {
    const installations = (await load()).filter((i) => i.id !== id)
    await save(installations)
  })
  installationEvents.emit('changed')
}

export async function update(id: string, data: Record<string, unknown>): Promise<InstallationRecord | null> {
  const updated = await enqueue(async () => {
    const installations = await load()
    const index = installations.findIndex((i) => i.id === id)
    if (index === -1) return null
    const existing = installations[index]!
    installations[index] = { ...existing, ...data } as InstallationRecord
    await save(installations)
    return installations[index]!
  })
  if (updated) {
    installationEvents.emit('updated', updated)
    installationEvents.emit('changed')
  }
  return updated
}

export async function get(id: string): Promise<InstallationRecord | null> {
  return (await load()).find((i) => i.id === id) ?? null
}

export async function reorder(orderedIds: string[]): Promise<void> {
  await enqueue(async () => {
    const installations = await load()
    const byId: Record<string, InstallationRecord> = Object.fromEntries(installations.map((i) => [i.id, i]))
    const reordered: InstallationRecord[] = orderedIds
      .map((id) => byId[id])
      .filter((inst): inst is InstallationRecord => inst != null)
    // Append any installations not in the provided list (safety net)
    for (const inst of installations) {
      if (!orderedIds.includes(inst.id)) reordered.push(inst)
    }
    await save(reordered)
  })
  installationEvents.emit('changed')
}

export async function ensureExists(sourceId: string, data: Record<string, unknown>): Promise<void> {
  const added = await enqueue(async () => {
    const existing = await load()
    if (existing.some((i) => i.sourceId === sourceId)) return false
    existing.push({
      id: nextInstallId(),
      createdAt: new Date().toISOString(),
      ...data,
    } as InstallationRecord)
    await save(existing)
    return true
  })
  if (added) installationEvents.emit('changed')
}

/** Force the seeded Cloud entry back to its canonical name. The Cloud install
 *  is not user-renamable (issue #922); this self-heals any entry that a prior
 *  build let the user rename. No-op when the name already matches or no Cloud
 *  entry exists. */
export async function enforceCloudName(): Promise<void> {
  const updated = await enqueue(async () => {
    const all = await load()
    const index = all.findIndex((i) => i.sourceId === CLOUD_SOURCE_ID)
    if (index === -1) return null
    const existing = all[index]!
    if (existing.name === CLOUD_INSTALL_NAME) return null
    all[index] = { ...existing, name: CLOUD_INSTALL_NAME } as InstallationRecord
    await save(all)
    return all[index]!
  })
  if (updated) {
    installationEvents.emit('updated', updated)
    installationEvents.emit('changed')
  }
}

/**
 * Stamp `lastLaunchedAt` and (when `resolveCategory` returns a value)
 * `lastLaunchedAtByCategory[category]` in one atomic write, firing the same
 * 'updated' event as `update()`. `resolveCategory` is passed in (rather than
 * imported) so this module stays free of the source-plugin layer; omit it to
 * touch only the global timestamp.
 */
export async function markLaunched(
  installationId: string,
  resolveCategory?: (inst: InstallationRecord) => string | undefined,
): Promise<InstallationRecord | null> {
  const updated = await enqueue(async () => {
    const list = await load()
    const index = list.findIndex((i) => i.id === installationId)
    if (index === -1) return null
    const existing = list[index]!
    const now = Date.now()
    const category = resolveCategory?.(existing)
    const existingByCategory =
      (existing.lastLaunchedAtByCategory as Record<string, number> | undefined) ?? {}
    const merged: InstallationRecord = {
      ...existing,
      lastLaunchedAt: now,
      ...(category
        ? { lastLaunchedAtByCategory: { ...existingByCategory, [category]: now } }
        : {}),
    }
    list[index] = merged
    await save(list)
    return merged
  })
  if (updated) {
    installationEvents.emit('updated', updated)
    installationEvents.emit('changed')
  }
  return updated
}

/**
 * POC: consume the one-shot starter-template flag. Clears `pendingTemplateOpen`
 * so the template only auto-opens on the first launch, not on relaunches.
 * No-op (returns false) when the install is gone or the flag was already clear,
 * so the caller can fire-and-forget. Skips the `'updated'` event to avoid a
 * title-bar refresh churn on every first launch — nothing observes this field.
 */
export async function clearPendingTemplateOpen(installationId: string): Promise<boolean> {
  return enqueue(async () => {
    const list = await load()
    const index = list.findIndex((i) => i.id === installationId)
    if (index === -1) return false
    const existing = list[index]!
    if (existing.pendingTemplateOpen == null) return false
    list[index] = { ...existing, pendingTemplateOpen: null } as InstallationRecord
    await save(list)
    return true
  })
}

/** Most-recently-launched install (by global `lastLaunchedAt`), or null
 *  when no install has ever been launched. Installs without a timestamp
 *  are ignored. */
export async function getRecent(): Promise<InstallationRecord | null> {
  const list = await load()
  let best: InstallationRecord | null = null
  let bestTs = -Infinity
  for (const inst of list) {
    const ts = typeof inst.lastLaunchedAt === 'number' ? inst.lastLaunchedAt : -Infinity
    if (ts > bestTs) {
      bestTs = ts
      best = inst
    }
  }
  return best && bestTs > -Infinity ? best : null
}

/**
 * Most-recently-launched install matching `category`, ranked by
 * `lastLaunchedAtByCategory[category] ?? lastLaunchedAt` (so pre-per-category
 * installs still participate). `resolveCategory` is passed in so this module
 * stays free of the source-plugin layer.
 */
export async function getRecentByCategory(
  category: string,
  resolveCategory: (inst: InstallationRecord) => string | undefined,
): Promise<InstallationRecord | null> {
  const list = await load()
  let best: InstallationRecord | null = null
  let bestTs = -Infinity
  for (const inst of list) {
    if (resolveCategory(inst) !== category) continue
    const byCat = inst.lastLaunchedAtByCategory as Record<string, number> | undefined
    const perCategoryTs = byCat?.[category]
    const ts =
      typeof perCategoryTs === 'number'
        ? perCategoryTs
        : typeof inst.lastLaunchedAt === 'number'
          ? inst.lastLaunchedAt
          : -Infinity
    if (ts > bestTs) {
      bestTs = ts
      best = inst
    }
  }
  return best && bestTs > -Infinity ? best : null
}

/** Sentinels for the global auto-launch setting. Duplicated from
 *  `settings.ts` to keep this module free of a settings dependency (which
 *  would cycle: settings depends on paths, paths depends on this module's
 *  `dataDir`). Callers pass the raw setting value through.
 *
 *  - `'none'` / empty / undefined → return null (no auto-launch).
 *  - `'last'` → resolve via `getRecent()`; null when nothing has ever launched.
 *  - any other string → look up by id; null when the id is gone (caller
 *    treats that as "stale selection, fall back to dashboard silently"). */
export async function resolveAutoLaunchInstall(
  autoLaunchValue: string | undefined | null,
): Promise<InstallationRecord | null> {
  if (autoLaunchValue == null || autoLaunchValue === '' || autoLaunchValue === 'none') {
    return null
  }
  if (autoLaunchValue === 'last') {
    return getRecent()
  }
  return get(autoLaunchValue)
}

export async function seedDefaults(defaults: Record<string, unknown>[]): Promise<void> {
  const seeded = await enqueue(async () => {
    const installations = await load()
    if (installations.length > 0) return false
    for (const entry of defaults) {
      installations.push({
        id: nextInstallId(),
        createdAt: new Date().toISOString(),
        status: "installed",
        ...entry,
      } as InstallationRecord)
    }
    if (installations.length > 0) {
      await save(installations)
      return true
    }
    return false
  })
  if (seeded) installationEvents.emit('changed')
}
