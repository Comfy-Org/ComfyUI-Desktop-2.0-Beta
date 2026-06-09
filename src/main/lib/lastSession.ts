import path from 'path'
import fs from 'fs'
import { stateDir } from './paths'
import { isQuitInProgress } from './quit-state'

/**
 * The surface the user last had active, persisted across quits so the next
 * boot can reopen it. `instance` carries the installation id so the boot flow
 * can re-launch that specific install; `dashboard` opens the chooser host.
 */
export type LastActiveSurface =
  | { kind: 'dashboard' }
  | { kind: 'instance'; installationId: string }

const lastSessionPath = (): string => path.join(stateDir(), 'last-session.json')

let cache: LastActiveSurface | null | undefined
let flushTimer: ReturnType<typeof setTimeout> | null = null

function isSurface(value: unknown): value is LastActiveSurface {
  if (!value || typeof value !== 'object') return false
  const v = value as { kind?: unknown; installationId?: unknown }
  if (v.kind === 'dashboard') return true
  if (v.kind === 'instance') return typeof v.installationId === 'string' && v.installationId.length > 0
  return false
}

function load(): LastActiveSurface | null {
  if (cache !== undefined) return cache
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(lastSessionPath(), 'utf-8'))
    cache = isSurface(parsed) ? parsed : null
  } catch {
    cache = null
  }
  return cache
}

function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => void flushLastSession(), 250)
}

/** Persist the in-memory surface to disk. Safe to call when nothing changed. */
export async function flushLastSession(): Promise<void> {
  if (cache === undefined) return
  try {
    const p = lastSessionPath()
    await fs.promises.mkdir(path.dirname(p), { recursive: true })
    const data = serialize()
    if (data === null) {
      await fs.promises.rm(p, { force: true })
    } else {
      await fs.promises.writeFile(p, data)
    }
  } catch {
    // Best-effort: a failed write just means the next boot falls back to the
    // dashboard, which is the safe default.
  }
}

/** Build the bytes to persist, or `null` to remove the file. */
function serialize(): string | null {
  return cache == null ? null : JSON.stringify(cache, null, 2)
}

/**
 * Persist the in-memory surface synchronously. Used on `will-quit`, where
 * Electron exits without awaiting promises — an async write would be torn down
 * mid-flight and lose a surface change made right before quitting.
 */
export function flushLastSessionSync(): void {
  if (cache === undefined) return
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  try {
    const p = lastSessionPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const data = serialize()
    if (data === null) {
      fs.rmSync(p, { force: true })
    } else {
      fs.writeFileSync(p, data)
    }
  } catch {
    // Best-effort: a failed write just means the next boot falls back to the
    // dashboard, which is the safe default.
  }
}

/** The persisted surface from the previous session, or `null` if none. */
export function getLastActiveSurface(): LastActiveSurface | null {
  return load()
}

/** Record that the dashboard (chooser host) is the active surface. Deduped so
 *  focus churn doesn't spam writes. Skipped while quitting: the user's last
 *  surface is whatever they left from, not focus churn during teardown. */
export function recordDashboardSurface(): void {
  if (isQuitInProgress()) return
  const current = load()
  if (current?.kind === 'dashboard') return
  cache = { kind: 'dashboard' }
  scheduleFlush()
}

/** Record that an instance window is the active surface. Deduped per id.
 *  Skipped while quitting (see {@link recordDashboardSurface}). */
export function recordInstanceSurface(installationId: string): void {
  if (isQuitInProgress()) return
  const current = load()
  if (current?.kind === 'instance' && current.installationId === installationId) return
  cache = { kind: 'instance', installationId }
  scheduleFlush()
}

/** Drop the persisted surface (e.g. the restore target install was deleted). */
export function clearLastActiveSurface(): void {
  if (cache === null) return
  cache = null
  scheduleFlush()
}

/** Test-only reset of the in-memory cache. */
export function _resetLastSessionCacheForTest(): void {
  cache = undefined
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
}
