/**
 * Test-side wrappers around the main-process `globalThis.__e2e` helpers.
 * Must stay in sync with what `src/main/lib/e2eHooks.ts` exposes.
 */

import type { ElectronApplication } from 'playwright'
import { evalWithRetry } from './evalRetry'

export type DownloadStatus =
  | 'pending'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'error'
  | 'cancelled'

export interface DownloadProgressLike {
  url: string
  filename: string
  directory?: string
  savePath?: string
  progress: number
  receivedBytes?: number
  totalBytes?: number
  speedBytesPerSec?: number
  etaSeconds?: number
  status: DownloadStatus
  error?: string
  createdAt?: number
}

export interface DownloadsTrayStateLike {
  active: DownloadProgressLike[]
  recent: DownloadProgressLike[]
}

export interface AppUpdateStateLike {
  kind: 'available' | 'downloading' | 'ready' | null
  version: string | null
  autoUpdate: boolean
}

export interface PopupBoundsResult {
  kind: 'menu' | 'downloads'
  bounds: { x: number; y: number; width: number; height: number }
}

export async function seedDownloads(
  app: ElectronApplication,
  snapshot: DownloadsTrayStateLike,
): Promise<void> {
  await evalWithRetry(() => app.evaluate((_electron, s) => {
    const helpers = (globalThis as unknown as { __e2e?: { seedDownloads: (s: unknown) => void } }).__e2e
    if (!helpers) throw new Error('E2E helpers not registered (process.env.E2E !== "1"?)')
    helpers.seedDownloads(s)
  }, snapshot))
}

export async function setInstallUpdate(
  app: ElectronApplication,
  opts: { installationId?: string; available: boolean; version?: string },
): Promise<void> {
  await evalWithRetry(() => app.evaluate((_electron, o) => {
    const helpers = (globalThis as unknown as { __e2e?: { setInstallUpdate: (o: unknown) => void } }).__e2e
    if (!helpers) throw new Error('E2E helpers not registered (process.env.E2E !== "1"?)')
    helpers.setInstallUpdate(o)
  }, opts))
}

export async function setAppUpdateState(
  app: ElectronApplication,
  state: AppUpdateStateLike,
): Promise<void> {
  await evalWithRetry(() => app.evaluate((_electron, s) => {
    const helpers = (globalThis as unknown as { __e2e?: { setAppUpdateState: (s: unknown) => void } }).__e2e
    if (!helpers) throw new Error('E2E helpers not registered (process.env.E2E !== "1"?)')
    helpers.setAppUpdateState(s)
  }, state))
}

export async function getTitlePopupBounds(
  app: ElectronApplication,
): Promise<PopupBoundsResult | null> {
  return await evalWithRetry(() => app.evaluate(() => {
    const helpers = (globalThis as unknown as { __e2e?: { getTitlePopupBounds: () => unknown } }).__e2e
    if (!helpers) throw new Error('E2E helpers not registered (process.env.E2E !== "1"?)')
    return helpers.getTitlePopupBounds() as PopupBoundsResult | null
  }))
}

export async function returnFirstInstallHostToDashboard(
  app: ElectronApplication,
): Promise<number | null> {
  return await evalWithRetry(() => app.evaluate(async () => {
    const helpers = (globalThis as unknown as {
      __e2e?: { returnFirstInstallHostToDashboard: () => Promise<number | null> }
    }).__e2e
    if (!helpers) throw new Error('E2E helpers not registered (process.env.E2E !== "1"?)')
    return helpers.returnFirstInstallHostToDashboard()
  }))
}

/** Recorded args for an instrumented IPC channel since the last reset. */
export async function getIpcInvocations(
  app: ElectronApplication,
  channel: string,
): Promise<unknown[]> {
  return await evalWithRetry(() => app.evaluate((_electron, c) => {
    const helpers = (globalThis as unknown as { __e2e?: { getIpcInvocations: (c: string) => unknown[] } }).__e2e
    if (!helpers) throw new Error('E2E helpers not registered (process.env.E2E !== "1"?)')
    return helpers.getIpcInvocations(c)
  }, channel))
}

export async function resetIpcInvocations(
  app: ElectronApplication,
  channel?: string,
): Promise<void> {
  await evalWithRetry(() => app.evaluate((_electron, c) => {
    const helpers = (globalThis as unknown as { __e2e?: { resetIpcInvocations: (c?: string) => void } }).__e2e
    if (!helpers) throw new Error('E2E helpers not registered (process.env.E2E !== "1"?)')
    helpers.resetIpcInvocations(c)
  }, channel))
}

/** URLs captured by the launcher's `shell.openExternal` wrapper in E2E mode. */
export async function getShellOpenExternalCalls(
  app: ElectronApplication,
): Promise<string[]> {
  return await evalWithRetry(() => app.evaluate(() => {
    const helpers = (globalThis as unknown as { __e2e?: { getShellOpenExternalCalls: () => string[] } }).__e2e
    if (!helpers) throw new Error('E2E helpers not registered (process.env.E2E !== "1"?)')
    return helpers.getShellOpenExternalCalls()
  }))
}

export async function resetShellOpenExternalCalls(app: ElectronApplication): Promise<void> {
  await evalWithRetry(() => app.evaluate(() => {
    const helpers = (globalThis as unknown as { __e2e?: { resetShellOpenExternalCalls: () => void } }).__e2e
    if (!helpers) throw new Error('E2E helpers not registered (process.env.E2E !== "1"?)')
    helpers.resetShellOpenExternalCalls()
  }))
}

/** Register a synthetic running session so the REQUIRES_STOPPED guard and
 *  `sessionStore.isRunning` fire without spawning a real ComfyUI process. */
export async function seedRunningSession(
  app: ElectronApplication,
  opts: { installationId: string; installationName: string },
): Promise<void> {
  await evalWithRetry(() => app.evaluate((_electron, o) => {
    const helpers = (globalThis as unknown as {
      __e2e?: { seedRunningSession: (o: unknown) => void }
    }).__e2e
    if (!helpers) throw new Error('E2E helpers not registered (process.env.E2E !== "1"?)')
    helpers.seedRunningSession(o)
  }, opts))
}

/** Mount the install-backed panelView eagerly. Production lazily mounts it
 *  (on Settings click / comfy-lifecycle body); tests that need `panel.html`
 *  reachable right after launch call this to skip the lazy step. */
export async function ensureInstallPanelView(
  app: ElectronApplication,
  installationId: string,
): Promise<boolean> {
  return await evalWithRetry(() => app.evaluate((_electron, id) => {
    const helpers = (globalThis as unknown as {
      __e2e?: { ensureInstallPanelView: (id: string) => boolean }
    }).__e2e
    if (!helpers) throw new Error('E2E helpers not registered (process.env.E2E !== "1"?)')
    return helpers.ensureInstallPanelView(id)
  }, installationId))
}

/** Force every release-cache entry's `checkedAt` to `maxCheckedAt` (ms) to
 *  drive the stale-data auto-refresh watcher without waiting wall-clock. */
export async function ageReleaseCache(
  app: ElectronApplication,
  maxCheckedAt: number,
): Promise<void> {
  await evalWithRetry(() => app.evaluate((_electron, ts) => {
    const helpers = (globalThis as unknown as { __e2e?: { ageReleaseCache: (ts: number) => void } }).__e2e
    if (!helpers) throw new Error('E2E helpers not registered (process.env.E2E !== "1"?)')
    helpers.ageReleaseCache(ts)
  }, maxCheckedAt))
}

/** Drop every synthetic session seeded via `seedRunningSession`. */
export async function clearRunningSessions(app: ElectronApplication): Promise<void> {
  await evalWithRetry(() => app.evaluate(() => {
    const helpers = (globalThis as unknown as { __e2e?: { clearRunningSessions: () => void } }).__e2e
    if (!helpers) throw new Error('E2E helpers not registered (process.env.E2E !== "1"?)')
    helpers.clearRunningSessions()
  }))
}

export interface RunningSessionSnapshotLike {
  pid: number | null
  startedAt: number
  port: number
  url: string | undefined
}

/** Snapshot the live running-session entry for `installationId` (real
 *  or synthetic). Returns `null` when no session is registered. */
export async function getRunningSessionSnapshot(
  app: ElectronApplication,
  installationId: string,
): Promise<RunningSessionSnapshotLike | null> {
  return await evalWithRetry(() => app.evaluate((_electron, id) => {
    const helpers = (globalThis as unknown as {
      __e2e?: { getRunningSessionSnapshot: (id: string) => unknown }
    }).__e2e
    if (!helpers) throw new Error('E2E helpers not registered (process.env.E2E !== "1"?)')
    return helpers.getRunningSessionSnapshot(id) as RunningSessionSnapshotLike | null
  }, installationId))
}

/** Read the `checkedAt` ms timestamp of the shared release-cache entry
 *  for `(repo, channel)`. Returns `null` when no entry exists yet. */
export async function getReleaseCacheCheckedAt(
  app: ElectronApplication,
  repo: string,
  channel: string,
): Promise<number | null> {
  return await evalWithRetry(() => app.evaluate((_electron, args) => {
    const helpers = (globalThis as unknown as {
      __e2e?: { getReleaseCacheCheckedAt: (r: string, c: string) => number | null }
    }).__e2e
    if (!helpers) throw new Error('E2E helpers not registered (process.env.E2E !== "1"?)')
    return helpers.getReleaseCacheCheckedAt(args.repo, args.channel)
  }, { repo, channel }))
}
