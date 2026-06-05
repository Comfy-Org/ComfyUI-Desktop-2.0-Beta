import path from 'path'
import fs from 'fs'
import { stateDir } from './paths'

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
    if (cache === null) {
      await fs.promises.rm(p, { force: true })
    } else {
      await fs.promises.writeFile(p, JSON.stringify(cache, null, 2))
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
 *  focus churn doesn't spam writes. */
export function recordDashboardSurface(): void {
  const current = load()
  if (current?.kind === 'dashboard') return
  cache = { kind: 'dashboard' }
  scheduleFlush()
}

/** Record that an instance window is the active surface. Deduped per id. */
export function recordInstanceSurface(installationId: string): void {
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
