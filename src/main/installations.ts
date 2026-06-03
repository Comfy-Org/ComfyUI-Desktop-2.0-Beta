import path from 'path'
import { EventEmitter } from 'events'
import { dataDir } from './lib/paths'
import { readFileSafeAsync, writeFileSafeAsync } from './lib/safe-file'
import type { ComfyVersion } from './lib/version'

/** Internal main-process event bus for installation lifecycle changes.
 *
 *  Events:
 *  - `'updated'`(record): a successful `update()` / `markLaunched()` —
 *    main/index.ts uses this to refresh ComfyUI window title bars when
 *    an install is renamed (the title-bar WebContents has its own
 *    preload and isn't subscribed to the renderer broadcast).
 *  - `'changed'`(): any mutation that affects the installs list as a
 *    whole (add, remove, update, markLaunched, reorder, ensureExists,
 *    seedDefaults). main/index.ts subscribes once and rebroadcasts as
 *    `installations-changed` to all renderers so stores can refetch
 *    without every IPC handler having to remember to call broadcast. */
export const installationEvents = new EventEmitter()

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
  /** Epoch ms of the most recent launch keyed by the install's source
   *  category (e.g. 'local' / 'cloud' / 'desktop'). Always written together
   *  with `lastLaunchedAt` via `markLaunched()` so the two stay consistent. */
  lastLaunchedAtByCategory?: Record<string, number>
  /** When true (default), launch injects `--extra-model-paths-config`
   *  derived from the global `modelsDirs` setting so this install sees the
   *  user's shared model library. When false, only this install's
   *  `<installPath>/models` is visible. Off is intentionally rare. */
  useSharedModels?: boolean
  /** When true (default), launch injects `--input-directory` /
   *  `--output-directory` from the global `inputDir` / `outputDir`
   *  settings. When false, launch uses the per-install `inputDir` /
   *  `outputDir` below if set, otherwise ComfyUI's own
   *  `<installPath>/{input,output}` defaults. */
  useSharedInputOutput?: boolean
  /** Per-install input directory, used only when
   *  `useSharedInputOutput === false`. Adopted-from-legacy installs
   *  pre-fill this with `<legacyBasePath>/input`. */
  inputDir?: string
  /** Per-install output directory, used only when
   *  `useSharedInputOutput === false`. */
  outputDir?: string
  [key: string]: unknown
}

/**
 * One-shot in-memory migration from the legacy `useSharedPaths` boolean
 * to the new `useSharedModels` / `useSharedInputOutput` pair.
 *
 * - `useSharedModels` is always set to `true` regardless of the legacy
 *   value. Users who set `useSharedPaths: false` almost certainly did so
 *   to isolate their workspace (input/output), not to lose visibility of
 *   their global model library. Defaulting models-shared back to on is
 *   the safer intent-preserving choice and matches the new default for
 *   fresh installs.
 * - `useSharedInputOutput` copies whatever the legacy boolean was.
 * - The legacy `useSharedPaths` key is stripped from the returned record
 *   so downstream code can't accidentally read both.
 *
 * Applied on every `load()` so callers always see the new shape; legacy
 * fields on disk get cleaned the next time the record is written via
 * `update()` / `add()`.
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
 * Monotonic install-id generator. The naive `inst-${Date.now()}` form
 * collides whenever two `add()` / `seedDefaults()` calls land in the
 * same millisecond — common on fast hardware (CI runners) and trivially
 * reproducible in tests that issue several `add()` calls back-to-back.
 * The collision yielded duplicate IDs which then aliased records in
 * `getRecent()` / `getRecentByCategory()` (see the flake on installations.test.ts
 * `returns the install with the largest global lastLaunchedAt`).
 *
 * Fix: keep the existing `inst-${ms}` shape for the normal case (so all
 * persisted IDs stay readable and existing data on disk is unchanged)
 * and append an in-process counter only for repeat calls inside the same
 * millisecond. Counter resets on the next millisecond tick.
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

/** True when `name` is already taken by an install other than `id`.
 *  The single source of the rename uniqueness rule — shared by the
 *  `update-installation` IPC handler and the `rename` session action so
 *  the check can't drift between the two write paths. */
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

/**
 * Stamp `lastLaunchedAt` (global) and — when `resolveCategory` returns a
 * value — `lastLaunchedAtByCategory[category]` on the install in a single
 * atomic write. Goes through the same `installations.json` queue as
 * `update()` and fires the same 'updated' event on `installationEvents`,
 * so existing subscribers (title-bar refresh, etc.) keep working.
 *
 * `resolveCategory` is invoked with the freshly-loaded record under the
 * queue lock — typically `(inst) => sourceMap[inst.sourceId]?.category` —
 * so this module stays free of any source-plugin dependency and the caller
 * doesn't have to pre-fetch the install just to compute its category.
 * Omit it (or have it return undefined) when the category isn't known
 * (e.g. unit tests on installs whose source isn't registered) and only
 * the global timestamp will be touched.
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
 * Most-recently-launched install whose source category matches `category`.
 *
 * Ranking key per install is
 * `lastLaunchedAtByCategory[category] ?? lastLaunchedAt`, so installs that
 * existed before the per-category field was introduced still participate
 * via their global timestamp until they're launched again (at which point
 * `markLaunched()` populates the category-specific entry).
 *
 * Because `installations.json` doesn't persist `sourceCategory` on the
 * record, the caller passes `resolveCategory` — typically
 * `(inst) => sourceMap[inst.sourceId]?.category` — so this module stays
 * free of any dependency on the source-plugin layer.
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
