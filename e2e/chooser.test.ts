/**
 * Chooser E2E: validates the install-less host window's chooser body and
 * its title bar after launch. No installs seeded — covers the cold-start
 * path where the user lands on the chooser.
 *
 * Includes regression tests for the three embedded WebContentsView popups
 * hung off the chooser host (titlePopup, systemModal, titleTooltip) so the
 * upcoming P0.1 / P0.2 extractions can be validated end-to-end.
 */

import { test, expect, type ElectronApplication } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import {
  clickNewInstallTile,
  openTitleMenu,
  expectChooserVisible,
  expectTakeoverOpen,
  dismissOverlay,
} from './support/chooserHelpers'
import {
  findWebContentsId,
  isPopupVisible,
  TITLE_REOPEN_SUPPRESSION_MS,
  waitForWebContents,
} from './support/cdpPages'

let ctx: AppContext

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  // `firstUseCompleted: true` keeps the first-use takeover from racing
  // the renderer mount and locking the title bar (consent-lockdown hides
  // the waffle button, breaking the title-popup tests below).
  ctx = await launchApp({ settings: { firstUseCompleted: true, telemetryEnabled: false } })
})

test.afterAll(async () => {
  await ctx.cleanup()
})

test('chooser body renders on cold start @windows @macos @linux', async () => {
  await expectChooserVisible(ctx.panel)
  expect(await ctx.panel.exists('.chooser-tile-new')).toBe(true)
})

test('title bar shows install-less pill on chooser host @windows @macos @linux', async () => {
  expect(await ctx.titleBar.exists('.title-install-pill.is-install-less')).toBe(true)
  expect(await ctx.titleBar.textOf('.title-install-name')).toMatch(/Comfy Desktop/i)
})

test('clicking New Install tile opens the new-install takeover @windows @macos @linux', async () => {
  await clickNewInstallTile(ctx.panel)
  await expectTakeoverOpen(ctx.panel)
  await dismissOverlay(ctx.panel)
  await expectChooserVisible(ctx.panel)
})

// ---------------------------------------------------------------------------
// Host registry regression coverage. `openOrFocusAnyHostWindow` /
// `openOrFocusChooserHostWindow` must dedup against the existing chooser
// host instead of spawning a duplicate; the popup-open tests below double
// as a check that title-bar IPC routing still resolves the existing entry
// after the dedup path runs.
// ---------------------------------------------------------------------------

test('activate hook focuses the existing chooser host instead of spawning a duplicate @windows @macos @linux', async () => {
  // Baseline: exactly one host BrowserWindow is open from `beforeAll`.
  const before = await ctx.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length,
  )
  expect(before).toBe(1)

  // Trigger the platform re-launch hook the registry guards against.
  // `app.on('activate', () => openOrFocusAnyHostWindow())` is registered
  // unconditionally in `whenReady` so emitting it is portable across OSes.
  await ctx.app.evaluate(({ app }) => { app.emit('activate') })
  // Window construction is synchronous in the dedup miss path; the dedup
  // hit path is even faster. A short settle covers both.
  await new Promise((r) => setTimeout(r, 200))

  const after = await ctx.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length,
  )
  expect(after).toBe(1)
})

// ---------------------------------------------------------------------------
// Embedded popup WebContentsView regression coverage. These all live on the
// chooser host and use the same `EmbeddedPopupView`-shaped lifecycle that
// the upcoming P0.1 (titleTooltip) / P0.2 (systemModal) extractions need to
// preserve.
// ---------------------------------------------------------------------------

test('title popup + system modal webContents are pre-warmed on the chooser host @windows @macos @linux', async () => {
  // Both popups are pre-warmed in `comfy-window:title-bar-ready` so the
  // first user trigger doesn't pay the load cost.
  await waitForWebContents(ctx.app, 'comfyTitlePopup.html', 10_000)
  await waitForWebContents(ctx.app, 'comfySystemModal.html', 10_000)
})

test('title popup opens, renders menu items, and closes via bridge @windows @macos @linux', async () => {
  // Click the waffle menu — main pushes a config to the cached title popup
  // and flips it visible. We assert the popup is no longer marked hidden
  // by the EmbeddedPopupView contract (the WebContentsView's bounds become
  // non-empty when shown).
  await openTitleMenu(ctx.titleBar)

  await expect.poll(
    () => isPopupVisible(ctx.app, 'comfyTitlePopup.html'),
    { timeout: 5_000, intervals: [100, 200] },
  ).toBe(true)

  // Renderer mounts an unordered menu list with at least one actionable item.
  const popupItems = await readPopupMenuItems(ctx.app, 'comfyTitlePopup.html')
  expect(popupItems.length).toBeGreaterThan(0)

  // Close via the popup's own bridge — Escape on the title-bar webContents
  // doesn't reach the popup (separate WebContentsView with its own DOM).
  await ctx.app.evaluate(({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('comfyTitlePopup.html'))
    if (!wc) throw new Error('title popup webContents missing')
    return wc.executeJavaScript(`(window).__comfyTitlePopup.close()`)
  })
  await expect.poll(
    () => isPopupVisible(ctx.app, 'comfyTitlePopup.html'),
    { timeout: 5_000, intervals: [100, 200] },
  ).toBe(false)
})

test('title popup reopens after a blur dismiss (menu-closed IPC clears the reopen guard) @windows @macos @linux', async () => {
  // The previous test dismissed the popup via the close bridge — that
  // stamps the title-bar's `menuClosedAt.menu` so a click within 100ms
  // is suppressed by the time-based reopen guard. Wait past that
  // window so the *first* open in this test isn't dropped.
  await new Promise((resolve) => setTimeout(resolve, TITLE_REOPEN_SUPPRESSION_MS))

  // Open the popup once normally.
  await openTitleMenu(ctx.titleBar)
  await expect.poll(
    () => isPopupVisible(ctx.app, 'comfyTitlePopup.html'),
    { timeout: 5_000, intervals: [100, 200] },
  ).toBe(true)

  // Dismiss via a blur on the popup webContents — the same path the
  // OS exercises when the user clicks anywhere outside the popup. The
  // EmbeddedPopupView primitive's `hideOnPopupBlur` listener is what
  // handles this; without an `onHide` notify the title-bar renderer's
  // `isMenuOpen` flag stayed stuck true and every subsequent click was
  // routed to `dismissFileMenu` (a no-op since the popup is already
  // hidden) instead of reopening.
  await ctx.app.evaluate(({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('comfyTitlePopup.html'))
    if (!wc) throw new Error('title popup webContents missing')
    ;(wc as unknown as { emit: (event: string) => void }).emit('blur')
  })
  await expect.poll(
    () => isPopupVisible(ctx.app, 'comfyTitlePopup.html'),
    { timeout: 5_000, intervals: [100, 200] },
  ).toBe(false)

  // Step past the title-bar's 100ms reopen-guard so the second click
  // isn't suppressed by the time-based debounce — the bug under test
  // is the *flag*-based guard (`isMenuOpen.value`), not the timer.
  await new Promise((resolve) => setTimeout(resolve, TITLE_REOPEN_SUPPRESSION_MS))

  // Reopen — must succeed, otherwise the title bar still thinks the
  // menu is open and the click goes to the dismiss path.
  await openTitleMenu(ctx.titleBar)
  await expect.poll(
    () => isPopupVisible(ctx.app, 'comfyTitlePopup.html'),
    { timeout: 5_000, intervals: [100, 200] },
  ).toBe(true)
})

test('title-bar tooltip popup is created on demand and hides cleanly @windows @macos @linux', async () => {
  // No webContents for the tooltip popup exists before the first show —
  // unlike titlePopup / systemModal, the tooltip is NOT pre-warmed.
  expect(await findWebContentsId(ctx.app, 'comfyTitleTooltip.html')).toBeNull()

  // Drive the bridge directly from the title-bar webContents so the test
  // works on Windows too (the Vue `pointermove` handler short-circuits
  // off-mac, so a hover-based test would only cover macOS).
  await ctx.app.evaluate(({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('comfyTitleBar.html'))
    if (!wc) throw new Error('title-bar webContents missing')
    return wc.executeJavaScript(
      `(window).__comfyTitleBar.showTooltip({ text: 'e2e tooltip', leftX: 50, rightX: 200, bottomY: 30 })`,
    )
  })

  // Tooltip popup webContents now exists.
  await waitForWebContents(ctx.app, 'comfyTitleTooltip.html', 5_000)
  await expect.poll(
    () => isPopupVisible(ctx.app, 'comfyTitleTooltip.html'),
    { timeout: 5_000, intervals: [100, 200] },
  ).toBe(true)

  // Hide via the same bridge.
  await ctx.app.evaluate(({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('comfyTitleBar.html'))
    if (!wc) throw new Error('title-bar webContents missing')
    return wc.executeJavaScript(`(window).__comfyTitleBar.hideTooltip()`)
  })

  await expect.poll(
    () => isPopupVisible(ctx.app, 'comfyTitleTooltip.html'),
    { timeout: 5_000, intervals: [100, 200] },
  ).toBe(false)
})

/** Read the popup's currently-rendered menu item labels. */
async function readPopupMenuItems(app: ElectronApplication, marker: string): Promise<string[]> {
  return app.evaluate(({ webContents }, m) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().includes(m))
    if (!wc) throw new Error(`${m} webContents missing`)
    return wc.executeJavaScript(`(() => {
      const candidates = [
        'button.menu-item',
        '[role="menuitem"]',
        '.title-popup-menu-item',
        'li button',
        'button',
      ]
      for (const sel of candidates) {
        const els = Array.from(document.querySelectorAll(sel))
        if (els.length > 0) return els.map(el => (el.textContent || '').trim()).filter(Boolean)
      }
      return []
    })()`) as Promise<string[]>
  }, marker)
}
