/**
 * Smoke test for the G0 E2E dev-hooks bridge. Verifies that the
 * `globalThis.__e2e` helpers are wired up when E2E=1, and that each
 * helper either round-trips a payload or invokes its main-side
 * implementation without throwing.
 *
 * The downstream G1–G4 suites assume this plumbing works; if it
 * regresses, fail loudly here rather than have every dependent test
 * mis-attribute the failure.
 */

import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import {
  seedDownloads,
  setInstallUpdate,
  setAppUpdateState,
  getTitlePopupBounds,
} from './support/devHooks'

let ctx: AppContext

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  ctx = await launchApp({ settings: { firstUseCompleted: true, telemetryEnabled: false } })
})

test.afterAll(async () => {
  await ctx.cleanup()
})

test('dev hooks bridge: seedDownloads, setInstallUpdate, setAppUpdateState all run @windows @macos @linux', async () => {
  await seedDownloads(ctx.app, {
    active: [
      {
        url: 'https://example.test/model.safetensors',
        filename: 'model.safetensors',
        progress: 0.42,
        status: 'downloading',
      },
    ],
    recent: [],
  })

  await setInstallUpdate(ctx.app, {
    available: true,
    version: '99.0.0',
  })
  await setInstallUpdate(ctx.app, { available: false })

  await setAppUpdateState(ctx.app, {
    kind: 'available',
    version: '1.2.3',
    autoUpdate: false,
  })
  await setAppUpdateState(ctx.app, { kind: null, version: null, autoUpdate: true })
})

test('dev hooks bridge: getTitlePopupBounds returns null when no popup is open @windows @macos @linux', async () => {
  const bounds = await getTitlePopupBounds(ctx.app)
  expect(bounds).toBeNull()
})
