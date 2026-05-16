/**
 * Title-bar hover-gate state machine on the install-backed comfy
 * window. Mirrors `title-bar-hover-gate.test.ts` but runs after
 * clicking the always-seeded Cloud chooser tile, which reconstructs
 * the host's title-bar webContents in install-backed mode
 * (`installationId=inst-…`, `sourceCategory='cloud'`,
 * `is-install-less` dropped). Past title-bar bugs have surfaced only
 * once an install attached, so the install-backed surface needs its
 * own regression net even though the underlying composable is shared
 * with the chooser host.
 *
 * Network: the cloud launch path runs `waitForUrl(remoteUrl, 15s)`
 * against `https://cloud.comfy.org/`. The probe accepts any HTTP
 * response (status code agnostic), so a reachable endpoint is
 * sufficient — no auth, no specific status required.
 */

import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import { WebContentsPage, waitForWebContents } from './support/cdpPages'
import {
  dispatchPointerLeave,
  dispatchPointerMove,
  dispatchWindowBlur,
  dispatchWindowFocus,
  isHoverActive,
  waitForHoverActive,
} from './support/hoverGate'

let ctx: AppContext
let titleBar: WebContentsPage

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  ctx = await launchApp({ settings: { firstUseCompleted: true, telemetryEnabled: false } })

  // Click the always-present Cloud tile and wait for the host's
  // title-bar view to be reconstructed in install-backed mode (URL
  // flips from `installationId=` to `installationId=inst-…`). The
  // claim-attach-host path swaps the title-bar WebContentsView in
  // place rather than spawning a second BrowserWindow.
  await ctx.panel.click('.chooser-tile-cloud')
  await waitForWebContents(ctx.app, 'comfyTitleBar.html?installationId=inst-', 30_000)
  titleBar = new WebContentsPage(ctx.app, 'comfyTitleBar.html?installationId=inst-')
  await titleBar.waitForSelector('.title-bar')

  // Sanity: pill flipped out of install-less mode and shows the
  // cloud install's name. Catches a drift in the IPC handshake order
  // before any hover-gate assertion would mask the real failure.
  await expect.poll(() => titleBar.exists('.title-install-pill:not(.is-install-less)'), {
    timeout: 5_000,
    intervals: [100, 200],
  }).toBe(true)
})

test.afterAll(async () => {
  await ctx.cleanup()
})

test.beforeEach(async () => {
  await dispatchWindowBlur(titleBar)
  await waitForHoverActive(titleBar, false)
})

test('hover gate is inert after mount on the comfy-window title bar @windows @macos @linux', async () => {
  expect(await isHoverActive(titleBar)).toBe(false)
})

test('pointermove enables the comfy-window hover gate @windows @macos @linux', async () => {
  await dispatchPointerMove(titleBar)
  await waitForHoverActive(titleBar, true)
})

test('window.blur drops the comfy-window hover gate @windows @macos @linux', async () => {
  await dispatchPointerMove(titleBar)
  await waitForHoverActive(titleBar, true)

  await dispatchWindowBlur(titleBar)
  await waitForHoverActive(titleBar, false)
})

test('window.focus alone does NOT re-enable the comfy-window hover gate — only pointermove does @windows @macos @linux', async () => {
  await dispatchPointerMove(titleBar)
  await waitForHoverActive(titleBar, true)
  await dispatchWindowBlur(titleBar)
  await waitForHoverActive(titleBar, false)

  await dispatchWindowFocus(titleBar)
  await new Promise((r) => setTimeout(r, 150))
  expect(await isHoverActive(titleBar)).toBe(false)

  await dispatchPointerMove(titleBar)
  await waitForHoverActive(titleBar, true)
})

test('pointerleave drops the comfy-window hover gate @windows @macos @linux', async () => {
  await dispatchPointerMove(titleBar)
  await waitForHoverActive(titleBar, true)

  await dispatchPointerLeave(titleBar)
  await waitForHoverActive(titleBar, false)
})
