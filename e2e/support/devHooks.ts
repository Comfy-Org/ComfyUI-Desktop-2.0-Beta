/**
 * Test-side wrappers around the main-process `globalThis.__e2e`
 * helpers registered by `src/main/lib/e2eHooks.ts`. Each helper
 * dispatches via Playwright's `app.evaluate(...)` bridge so tests
 * never hand-roll the bridge boilerplate.
 *
 * The shape mirrors what `e2eHooks.ts` exposes — keep them in sync.
 */

import type { ElectronApplication } from 'playwright'

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
  await app.evaluate((_electron, s) => {
    const helpers = (globalThis as unknown as { __e2e?: { seedDownloads: (s: unknown) => void } }).__e2e
    if (!helpers) throw new Error('E2E helpers not registered (process.env.E2E !== "1"?)')
    helpers.seedDownloads(s)
  }, snapshot)
}

export async function setInstallUpdate(
  app: ElectronApplication,
  opts: { installationId?: string; available: boolean; version?: string },
): Promise<void> {
  await app.evaluate((_electron, o) => {
    const helpers = (globalThis as unknown as { __e2e?: { setInstallUpdate: (o: unknown) => void } }).__e2e
    if (!helpers) throw new Error('E2E helpers not registered (process.env.E2E !== "1"?)')
    helpers.setInstallUpdate(o)
  }, opts)
}

export async function setAppUpdateState(
  app: ElectronApplication,
  state: AppUpdateStateLike,
): Promise<void> {
  await app.evaluate((_electron, s) => {
    const helpers = (globalThis as unknown as { __e2e?: { setAppUpdateState: (s: unknown) => void } }).__e2e
    if (!helpers) throw new Error('E2E helpers not registered (process.env.E2E !== "1"?)')
    helpers.setAppUpdateState(s)
  }, state)
}

export async function getTitlePopupBounds(
  app: ElectronApplication,
): Promise<PopupBoundsResult | null> {
  return await app.evaluate(() => {
    const helpers = (globalThis as unknown as { __e2e?: { getTitlePopupBounds: () => unknown } }).__e2e
    if (!helpers) throw new Error('E2E helpers not registered (process.env.E2E !== "1"?)')
    return helpers.getTitlePopupBounds() as PopupBoundsResult | null
  })
}
