/**
 * G3 — Update pill coverage. Drives the title-bar app-update pill and
 * verifies the install-update pill suppression on install-less hosts.
 *
 * Tests run on the chooser host (no install needed) and use the G0
 * `setAppUpdateState` / `setInstallUpdate` dev hooks to push state
 * through the production broadcast pipeline. The install-backed
 * "pill renders + clicks open Settings" path lives in the lifecycle
 * suite (it requires a real install to flip `installationId` away
 * from `null`).
 */

import { test, expect, type ElectronApplication } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import { findWebContentsId } from './support/cdpPages'
import {
  setAppUpdateState,
  setInstallUpdate,
  type AppUpdateStateLike,
} from './support/devHooks'

let ctx: AppContext

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  ctx = await launchApp({ settings: { firstUseCompleted: true, telemetryEnabled: false } })
})

test.afterAll(async () => {
  await ctx.cleanup()
})

/**
 * Reset to the idle state between tests so a leftover modal or pill
 * from a previous test doesn't pollute the next one's assertion.
 */
test.beforeEach(async () => {
  await closeSystemModalIfOpen(ctx.app)
  await setAppUpdateState(ctx.app, IDLE_APP_UPDATE)
  await setInstallUpdate(ctx.app, { available: false })
})

const IDLE_APP_UPDATE: AppUpdateStateLike = { kind: null, version: null, autoUpdate: true }

// ---------------------------------------------------------------------------
// App-update pill — visibility per state.
// ---------------------------------------------------------------------------

test('desktop-update pill is hidden when state is idle @ci', async () => {
  expect(await ctx.titleBar.exists('.title-update-pill.is-app-update')).toBe(false)
})

test('desktop-update pill renders for state=available @ci', async () => {
  await setAppUpdateState(ctx.app, { kind: 'available', version: '1.2.3', autoUpdate: false })
  await expect.poll(() => ctx.titleBar.exists('.title-update-pill.is-app-update'), {
    timeout: 5_000,
    intervals: [100, 200],
  }).toBe(true)
  // Label should NOT include the ready / downloading variants.
  const label = await ctx.titleBar.textOf('.title-update-pill.is-app-update .title-update-pill-label')
  expect(label?.toLowerCase()).toContain('update')
  expect(await ctx.titleBar.exists('.title-update-pill.is-app-update.is-ready')).toBe(false)
  expect(await ctx.titleBar.exists('.title-update-pill.is-app-update.is-downloading')).toBe(false)
})

test('desktop-update pill renders for state=downloading @ci', async () => {
  await setAppUpdateState(ctx.app, { kind: 'downloading', version: '1.2.3', autoUpdate: true })
  await expect.poll(
    () => ctx.titleBar.exists('.title-update-pill.is-app-update.is-downloading'),
    { timeout: 5_000, intervals: [100, 200] },
  ).toBe(true)
})

test('desktop-update pill renders for state=ready @ci', async () => {
  await setAppUpdateState(ctx.app, { kind: 'ready', version: '1.2.3', autoUpdate: true })
  await expect.poll(
    () => ctx.titleBar.exists('.title-update-pill.is-app-update.is-ready'),
    { timeout: 5_000, intervals: [100, 200] },
  ).toBe(true)
})

// ---------------------------------------------------------------------------
// App-update pill — click flow.
// ---------------------------------------------------------------------------

test('clicking the ready desktop-update pill opens the embedded system-modal restart prompt @ci', async () => {
  await setAppUpdateState(ctx.app, { kind: 'ready', version: '1.2.3', autoUpdate: true })
  await expect.poll(
    () => ctx.titleBar.exists('.title-update-pill.is-app-update.is-ready'),
    { timeout: 5_000, intervals: [100, 200] },
  ).toBe(true)

  const ok = await ctx.titleBar.click('.title-update-pill.is-app-update')
  expect(ok, 'desktop-update pill click dispatched').toBe(true)

  // Confirm modal renders via openSystemModal (embedded WebContentsView
  // popup, NOT the panel-side useModal). Detect by the popup's visibility.
  await expect.poll(() => isSystemModalVisible(ctx.app), {
    timeout: 5_000,
    intervals: [100, 200],
  }).toBe(true)
})

// ---------------------------------------------------------------------------
// Install-update pill — install-less suppression.
// ---------------------------------------------------------------------------

test('install-update chip stays hidden on the install-less chooser host even with an override @ci', async () => {
  await setInstallUpdate(ctx.app, { available: true, version: '99.0.0' })
  // Wait a beat to make sure no background re-broadcast snuck the chip on.
  await new Promise((r) => setTimeout(r, 250))
  // The instance update affordance now lives inside the center pill as
  // `.title-install-update-chip` (the standalone trailing pill was
  // removed). Poll rather than a one-shot evaluate so a transient
  // title-bar re-render on the slow Windows runner can't destroy the
  // execution context mid-check — matches the app-update checks above.
  await expect.poll(() => ctx.titleBar.exists('.title-install-update-chip'), {
    timeout: 3_000,
    intervals: [100, 200],
  }).toBe(false)
})

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** True iff the embedded comfySystemModal popup is visible — same
 *  contract as `isPopupVisible` in chooser.test.ts. */
async function isSystemModalVisible(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow, WebContentsView }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      for (const child of win.contentView.children) {
        if (!(child instanceof WebContentsView)) continue
        if (!child.webContents.getURL().includes('comfySystemModal.html')) continue
        if (!child.getVisible()) return false
        const b = child.getBounds()
        return b.width > 0 && b.height > 0
      }
    }
    return false
  })
}

/** Cancel any open system-modal popup so a previous test's leftover
 *  prompt doesn't haunt the next assertion. The popup's renderer
 *  treats Escape as a `cancel` ack, so dispatching the keydown is
 *  enough — main runs the cancel path and hides the view. Dispatched
 *  on `document` because BaseAlert's overlay binds the ESC listener
 *  there (via `useModalOverlay`), and `window.dispatchEvent` does not
 *  propagate to document. */
async function closeSystemModalIfOpen(app: ElectronApplication): Promise<void> {
  const id = await findWebContentsId(app, 'comfySystemModal.html')
  if (id === null) return
  if (!(await isSystemModalVisible(app))) return
  await app.evaluate(({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('comfySystemModal.html'))
    if (!wc) return
    return wc.executeJavaScript(`(() => {
      const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      document.dispatchEvent(ev)
    })()`).catch(() => {})
  })
  await expect.poll(() => isSystemModalVisible(app), { timeout: 3_000, intervals: [100, 200] }).toBe(false)
}
