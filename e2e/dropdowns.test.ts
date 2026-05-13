/**
 * G4 — Title-bar dropdown + tooltip regression coverage. Adds three
 * targeted assertions on top of the existing dropdown smoke tests in
 * `chooser.test.ts`:
 *
 * 1. The Reset Zoom item only appears when the comfyView is at a
 *    non-default zoom level (gated branch in `buildTitlePopupMenuItems`).
 * 2. The popup webContents doesn't accumulate listeners across opens
 *    (regression net for `EmbeddedPopupView` lifecycle drift).
 * 3. Showing the title-bar tooltip and then opening the menu hides
 *    the tooltip — the `hideTitleTooltipPopup(...)` call inside
 *    `openTitlePopup` is the regression-prone bit.
 */

import { test, expect, type ElectronApplication } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import { openTitleMenu } from './support/chooserHelpers'
import {
  findWebContentsId,
  titlePopupPage,
  waitForWebContents,
  type WebContentsPage,
} from './support/cdpPages'

let ctx: AppContext
let popup: WebContentsPage

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  ctx = await launchApp({ settings: { firstUseCompleted: true, telemetryEnabled: false } })
  popup = titlePopupPage(ctx.app)
})

test.afterAll(async () => {
  await ctx.cleanup()
})

test.beforeEach(async () => {
  await closeTitlePopupIfOpen(ctx.app)
  await new Promise((r) => setTimeout(r, 150))
})

// ---------------------------------------------------------------------------
// `Reset Zoom` menu-item gating.
// ---------------------------------------------------------------------------

test('Reset Zoom menu item is absent at zoom level 0 @windows @macos @linux', async () => {
  await setComfyViewZoomLevel(ctx.app, 0)
  await openTitleMenu(ctx.titleBar)
  await popup.waitForSelector('[role="menuitem"]', { timeout: 5_000 })

  const labels = await popup.allText('[role="menuitem"]')
  expect(labels.some((l) => /reset zoom/i.test(l))).toBe(false)
})

test('Reset Zoom menu item appears with the current percent label when zoom is non-zero @windows @macos @linux', async () => {
  await setComfyViewZoomLevel(ctx.app, 1)
  await openTitleMenu(ctx.titleBar)
  await popup.waitForSelector('[role="menuitem"]', { timeout: 5_000 })

  const labels = await popup.allText('[role="menuitem"]')
  const resetZoom = labels.find((l) => /reset zoom/i.test(l))
  expect(resetZoom, `expected "Reset Zoom" item among [${labels.join(', ')}]`).toBeTruthy()
  // Label includes the percent (1.2^1 = 120%, rounded).
  expect(resetZoom).toMatch(/\(\s*120\s*%\s*\)/)

  // Reset for downstream tests in the serial run.
  await setComfyViewZoomLevel(ctx.app, 0)
})

// ---------------------------------------------------------------------------
// EmbeddedPopupView listener lifecycle — the popup webContents must not
// accumulate listeners across opens, otherwise repeated open/close cycles
// would leak event handlers (and `tray-state-changed` callbacks etc).
// ---------------------------------------------------------------------------

test('title-popup webContents listener counts are stable across repeated opens @windows @macos @linux', async () => {
  // Prime the popup once so the renderer has loaded and any first-run
  // wiring is in place.
  await openTitleMenu(ctx.titleBar)
  await popup.waitForSelector('[role="menuitem"]', { timeout: 5_000 })
  await closeTitlePopupViaBridge(ctx.app)
  await waitForPopupHidden(ctx.app)
  await new Promise((r) => setTimeout(r, 150))

  const before = await getPopupListenerCount(ctx.app)
  expect(before).toBeGreaterThan(0)

  // Open + close 5 more times.
  for (let i = 0; i < 5; i++) {
    await openTitleMenu(ctx.titleBar)
    await popup.waitForSelector('[role="menuitem"]', { timeout: 5_000 })
    await closeTitlePopupViaBridge(ctx.app)
    await waitForPopupHidden(ctx.app)
    await new Promise((r) => setTimeout(r, 150))
  }

  const after = await getPopupListenerCount(ctx.app)
  expect(after, `listener count grew from ${before} to ${after} across 5 open/close cycles`).toBe(before)
})

// ---------------------------------------------------------------------------
// Tooltip vs menu coexistence — opening the menu must hide a visible
// tooltip; otherwise both popups overlap and the user reads garbage.
// ---------------------------------------------------------------------------

test('opening the title menu hides the title-bar tooltip @windows @macos @linux', async () => {
  // Drive the tooltip directly via the title-bar bridge, mirroring the
  // existing tooltip-on-demand test in chooser.test.ts.
  await ctx.app.evaluate(({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('comfyTitleBar.html'))
    if (!wc) throw new Error('title-bar webContents missing')
    return wc.executeJavaScript(
      `(window).__comfyTitleBar.showTooltip({ text: 'g4 tooltip', leftX: 50, rightX: 200, bottomY: 30 })`,
    )
  })
  await waitForWebContents(ctx.app, 'comfyTitleTooltip.html', 5_000)
  await expect.poll(() => isPopupVisible(ctx.app, 'comfyTitleTooltip.html'), {
    timeout: 5_000,
    intervals: [100, 200],
  }).toBe(true)

  // Open the title menu — this is what `openTitlePopup` runs the
  // `hideTitleTooltipPopup(getTitleTooltipForParent(...))` call against.
  await openTitleMenu(ctx.titleBar)

  await expect.poll(() => isPopupVisible(ctx.app, 'comfyTitleTooltip.html'), {
    timeout: 5_000,
    intervals: [100, 200],
  }).toBe(false)
})

// ---------------------------------------------------------------------------
// Helpers (kept inline; promote to support/ if a third file needs them).
// ---------------------------------------------------------------------------

/** Set the chooser host's comfyView zoom level. The dummy comfyView
 *  on install-less hosts never loads a URL — and Electron's
 *  `setZoomLevel` is a no-op until a webContents has loaded SOMETHING
 *  — so we load `about:blank` first if the URL is empty. We identify
 *  the comfyView as the BrowserWindow's WebContentsView child whose
 *  URL doesn't match any known popup / panel / title-bar marker. */
async function setComfyViewZoomLevel(app: ElectronApplication, level: number): Promise<void> {
  await app.evaluate(async ({ BrowserWindow, WebContentsView }, lvl) => {
    const KNOWN_HTML_MARKERS = [
      'panel.html',
      'comfyTitleBar.html',
      'comfyTitlePopup.html',
      'comfySystemModal.html',
      'comfyTitleTooltip.html',
    ]
    for (const win of BrowserWindow.getAllWindows()) {
      for (const child of win.contentView.children) {
        if (!(child instanceof WebContentsView)) continue
        const url = child.webContents.getURL()
        if (KNOWN_HTML_MARKERS.some((m) => url.includes(m))) continue
        if (url === '') {
          await child.webContents.loadURL('about:blank').catch(() => {})
        }
        child.webContents.setZoomLevel(lvl)
      }
    }
  }, level)
}

/** True iff the WebContentsView whose URL contains `marker` is visible
 *  AND has non-zero bounds — same contract as the chooser test. */
async function isPopupVisible(app: ElectronApplication, marker: string): Promise<boolean> {
  return app.evaluate(({ BrowserWindow, WebContentsView }, m) => {
    for (const win of BrowserWindow.getAllWindows()) {
      for (const child of win.contentView.children) {
        if (!(child instanceof WebContentsView)) continue
        if (!child.webContents.getURL().includes(m)) continue
        if (!child.getVisible()) return false
        const b = child.getBounds()
        return b.width > 0 && b.height > 0
      }
    }
    return false
  }, marker)
}

async function waitForPopupHidden(app: ElectronApplication): Promise<void> {
  await expect.poll(() => isPopupVisible(app, 'comfyTitlePopup.html'), {
    timeout: 5_000,
    intervals: [100, 200],
  }).toBe(false)
}

async function closeTitlePopupViaBridge(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('comfyTitlePopup.html'))
    if (!wc) return
    return wc.executeJavaScript(`(window).__comfyTitlePopup.close()`)
  })
}

async function closeTitlePopupIfOpen(app: ElectronApplication): Promise<void> {
  const id = await findWebContentsId(app, 'comfyTitlePopup.html')
  if (id === null) return
  if (!(await isPopupVisible(app, 'comfyTitlePopup.html'))) return
  await closeTitlePopupViaBridge(app)
  await waitForPopupHidden(app)
}

/** Sum of registered listeners on the popup webContents, summed across
 *  every event name. A leak would show as monotonic growth across
 *  open/close cycles. */
async function getPopupListenerCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('comfyTitlePopup.html'))
    if (!wc) return 0
    type EmitterLike = {
      eventNames(): (string | symbol)[]
      listenerCount(name: string | symbol): number
    }
    const emitter = wc as unknown as EmitterLike
    let total = 0
    for (const name of emitter.eventNames()) {
      total += emitter.listenerCount(name)
    }
    return total
  })
}
