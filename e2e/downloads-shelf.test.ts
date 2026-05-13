/**
 * G1 — Downloads-shelf coverage. Drives the title-bar downloads tray
 * popup against seeded `comfyDownloadManager` state to catch the
 * sizing + per-status-row regressions that the recent refactors
 * surfaced manually.
 *
 * All tests run on the chooser host (no install needed) and use the
 * G0 `seedDownloads` dev hook to push tray snapshots through the
 * production `tray-state-changed` broadcast pipeline.
 */

import { test, expect, type ElectronApplication } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import { openDownloadsTray } from './support/chooserHelpers'
import { findWebContentsId, titlePopupPage, type WebContentsPage } from './support/cdpPages'
import { getTitlePopupBounds, seedDownloads, type DownloadProgressLike } from './support/devHooks'

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

/**
 * Reset to a known good state between tests:
 *   1. Force-close the title popup so the next open is fresh.
 *   2. Wait past the 100ms reopen-suppression window in the title bar.
 *   3. Clear the seeded downloads buffer so empty-state assertions
 *      aren't polluted by a previous test's residue.
 */
test.beforeEach(async () => {
  await closeTitlePopupIfOpen(ctx.app)
  await new Promise((r) => setTimeout(r, 150))
  await seedDownloads(ctx.app, { active: [], recent: [] })
})

// ---------------------------------------------------------------------------
// Sizing — these are the assertions that would have caught the
// flex-allocated-height regression without manual smoke testing.
// ---------------------------------------------------------------------------

test('empty drawer fits content (popup height < 200px) @windows @macos @linux', async () => {
  await openDownloadsTray(ctx.titleBar)
  await waitForPopupVisible(ctx.app)
  await waitForStableBounds(ctx.app)

  const bounds = await getTitlePopupBounds(ctx.app)
  expect(bounds?.kind).toBe('downloads')
  // Empty placeholder + footer link + ~2px borders comes out to ~80–110px;
  // anything under 200 means the popup didn't pin to the 360 ceiling.
  expect(bounds!.bounds.height).toBeLessThan(200)
  // Also greater than zero so we know we measured a real visible popup.
  expect(bounds!.bounds.height).toBeGreaterThan(40)
})

test('one downloading entry fits content (NOT clipped at 360 ceiling) @windows @macos @linux', async () => {
  await seedDownloads(ctx.app, {
    active: [makeEntry({ url: 'https://example.test/m1.safetensors', filename: 'm1.safetensors', status: 'downloading', progress: 0.5 })],
    recent: [],
  })
  await openDownloadsTray(ctx.titleBar)
  await waitForPopupVisible(ctx.app)
  await waitForStableBounds(ctx.app)

  const bounds = await getTitlePopupBounds(ctx.app)
  // One row + footer ≈ 130–200px; the bug under test would have left
  // it stuck at the 360 ceiling because `.downloads-list` reports
  // `scrollHeight === clientHeight` when items fit.
  expect(bounds!.bounds.height).toBeGreaterThan(80)
  expect(bounds!.bounds.height).toBeLessThan(260)
})

test('many entries cap at the ceiling and the list scrolls @windows @macos @linux', async () => {
  const active: DownloadProgressLike[] = []
  for (let i = 0; i < 12; i++) {
    active.push(
      makeEntry({
        url: `https://example.test/big-${i}.safetensors`,
        filename: `big-${i}.safetensors`,
        status: 'downloading',
        progress: 0.1 * i,
        createdAt: i,
      }),
    )
  }
  await seedDownloads(ctx.app, { active, recent: [] })
  await openDownloadsTray(ctx.titleBar)
  await waitForPopupVisible(ctx.app)
  await waitForStableBounds(ctx.app)

  const bounds = await getTitlePopupBounds(ctx.app)
  // Ceiling is min(360, 0.6 * windowContentHeight). The default chooser
  // window is at least 600px tall, so 360 wins under default test bounds.
  expect(bounds!.bounds.height).toBeLessThanOrEqual(360)
  // Pinned to the ceiling (within a few px for borders / fractional
  // pixel rounding).
  expect(bounds!.bounds.height).toBeGreaterThan(320)

  // The internal list overflows.
  const overflow = await popup.evaluate<{ scroll: number; client: number }>(`(() => {
    const el = document.querySelector('.downloads-list')
    return el ? { scroll: el.scrollHeight, client: el.clientHeight } : { scroll: 0, client: 0 }
  })()`)
  expect(overflow.scroll).toBeGreaterThan(overflow.client)
})

// ---------------------------------------------------------------------------
// Per-status row controls — pause / resume / cancel / dismiss visibility.
// ---------------------------------------------------------------------------

test('per-status row controls render the right action buttons @windows @macos @linux', async () => {
  await seedDownloads(ctx.app, {
    active: [
      makeEntry({ url: 'u-dl', filename: 'dl.safetensors', status: 'downloading', progress: 0.5 }),
      makeEntry({ url: 'u-pa', filename: 'pa.safetensors', status: 'paused', progress: 0.5 }),
      makeEntry({ url: 'u-pe', filename: 'pe.safetensors', status: 'pending', progress: 0 }),
    ],
    recent: [
      makeEntry({ url: 'u-co', filename: 'co.safetensors', status: 'completed', progress: 1, savePath: '/tmp/co.safetensors' }),
      makeEntry({ url: 'u-er', filename: 'er.safetensors', status: 'error', progress: 0, error: 'boom' }),
      makeEntry({ url: 'u-ca', filename: 'ca.safetensors', status: 'cancelled', progress: 0 }),
    ],
  })
  await openDownloadsTray(ctx.titleBar)
  await waitForPopupVisible(ctx.app)
  await waitForStableBounds(ctx.app)

  // Key the per-row affordance check by the seeded filename so tests
  // don't depend on the renderer's `statusKindClass` mapping.
  const summary = await popup.evaluate<Record<string, { pause: boolean; resume: boolean; cancel: boolean; dismiss: boolean }>>(`(() => {
    const out = {}
    for (const li of document.querySelectorAll('.downloads-item')) {
      const name = (li.querySelector('.downloads-item-name')?.textContent || '').trim()
      const labels = Array.from(li.querySelectorAll('.downloads-item-actions button'))
        .map(b => (b.getAttribute('aria-label') || b.textContent || '').toLowerCase().trim())
      out[name] = {
        pause: labels.some(l => l.includes('pause')),
        resume: labels.some(l => l.includes('resume')),
        cancel: labels.some(l => l.includes('cancel')),
        dismiss: !!li.querySelector('.downloads-item-dismiss'),
      }
    }
    return out
  })()`)

  // Downloading: pause + cancel; no resume or dismiss.
  expect(summary['dl.safetensors']).toMatchObject({ pause: true, resume: false, cancel: true, dismiss: false })
  // Paused: resume + cancel; no pause; no dismiss (still active).
  expect(summary['pa.safetensors']).toMatchObject({ pause: false, resume: true, cancel: true, dismiss: false })
  // Pending: cancel only; pause/resume gated on actual progress phase.
  expect(summary['pe.safetensors']).toMatchObject({ pause: false, resume: false, cancel: true, dismiss: false })
  // Terminal entries: cancel hidden, dismiss shown.
  expect(summary['co.safetensors']).toMatchObject({ pause: false, resume: false, cancel: false, dismiss: true })
  expect(summary['er.safetensors']).toMatchObject({ pause: false, resume: false, cancel: false, dismiss: true })
  expect(summary['ca.safetensors']).toMatchObject({ pause: false, resume: false, cancel: false, dismiss: true })
})

// ---------------------------------------------------------------------------
// Header affordance — only render `Clear finished` when there's something
// to clear.
// ---------------------------------------------------------------------------

test('"Clear finished" button only renders when there is at least one terminal entry @windows @macos @linux', async () => {
  // Active-only state: no terminal entries → no clear button.
  await seedDownloads(ctx.app, {
    active: [makeEntry({ url: 'u-dl', filename: 'dl.safetensors', status: 'downloading', progress: 0.5 })],
    recent: [],
  })
  await openDownloadsTray(ctx.titleBar)
  await waitForPopupVisible(ctx.app)
  await waitForStableBounds(ctx.app)
  expect(await popup.exists('.downloads-clear')).toBe(false)

  // Reload state to include a terminal entry; the live broadcast
  // updates the open popup in place.
  await seedDownloads(ctx.app, {
    active: [makeEntry({ url: 'u-dl', filename: 'dl.safetensors', status: 'downloading', progress: 0.5 })],
    recent: [makeEntry({ url: 'u-co', filename: 'co.safetensors', status: 'completed', progress: 1 })],
  })
  await expect.poll(() => popup.exists('.downloads-clear'), {
    timeout: 5_000,
    intervals: [100, 200, 400],
  }).toBe(true)
})

// ---------------------------------------------------------------------------
// Live repaint — the open popup must redraw when the tray-state-changed
// broadcast fires (this is what `comfy-titlepopup:downloads-changed`
// owes the user when a download starts mid-shelf-open).
// ---------------------------------------------------------------------------

test('the open popup repaints live when tray state changes @windows @macos @linux', async () => {
  await openDownloadsTray(ctx.titleBar)
  await waitForPopupVisible(ctx.app)
  await waitForStableBounds(ctx.app)

  // Start at empty.
  expect(await popup.count('.downloads-item')).toBe(0)

  // Push a new active entry mid-open.
  await seedDownloads(ctx.app, {
    active: [makeEntry({ url: 'u-live', filename: 'live.safetensors', status: 'downloading', progress: 0.25 })],
    recent: [],
  })
  await expect.poll(() => popup.count('.downloads-item'), {
    timeout: 5_000,
    intervals: [100, 200, 400],
  }).toBe(1)

  // Push a second entry; the row count keeps up.
  await seedDownloads(ctx.app, {
    active: [
      makeEntry({ url: 'u-live', filename: 'live.safetensors', status: 'downloading', progress: 0.5 }),
      makeEntry({ url: 'u-live2', filename: 'live2.safetensors', status: 'downloading', progress: 0.1, createdAt: 2 }),
    ],
    recent: [],
  })
  await expect.poll(() => popup.count('.downloads-item'), {
    timeout: 5_000,
    intervals: [100, 200, 400],
  }).toBe(2)
})

// ---------------------------------------------------------------------------
// Helpers — kept inline so the test file stays self-contained; promote
// to `support/` if a second test file ends up needing the same logic.
// ---------------------------------------------------------------------------

let entryCounter = 0

/** Build a minimal `DownloadProgressLike` with sensible defaults so tests
 *  only set the fields they actually care about. `createdAt` defaults to
 *  a monotonically-increasing counter so insertion-ordered list assertions
 *  match the order the test wrote them. */
function makeEntry(partial: Partial<DownloadProgressLike> & { url: string; filename: string }): DownloadProgressLike {
  return {
    progress: 0,
    status: 'downloading',
    createdAt: ++entryCounter,
    ...partial,
  }
}

/** True iff the title popup webContentsView is `setVisible(true)` AND has
 *  non-zero bounds — the EmbeddedPopupView contract for "shown to user". */
async function isPopupVisible(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow, WebContentsView }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      for (const child of win.contentView.children) {
        if (!(child instanceof WebContentsView)) continue
        if (!child.webContents.getURL().includes('comfyTitlePopup.html')) continue
        if (!child.getVisible()) return false
        const b = child.getBounds()
        return b.width > 0 && b.height > 0
      }
    }
    return false
  })
}

async function waitForPopupVisible(app: ElectronApplication): Promise<void> {
  await expect.poll(() => isPopupVisible(app), {
    timeout: 5_000,
    intervals: [100, 200],
  }).toBe(true)
}

/** Wait until the popup's bounds height stops changing for `settleMs`,
 *  which is how we know the renderer's `request-size` round-trip has
 *  landed and main has applied the natural-content height. */
async function waitForStableBounds(
  app: ElectronApplication,
  opts: { timeoutMs?: number; settleMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 3_000
  const settleMs = opts.settleMs ?? 250
  const deadline = Date.now() + timeoutMs
  let lastH = -1
  let lastChange = Date.now()
  while (Date.now() < deadline) {
    const bounds = await getTitlePopupBounds(app)
    const h = bounds?.bounds.height ?? 0
    if (h !== lastH) {
      lastH = h
      lastChange = Date.now()
    } else if (Date.now() - lastChange >= settleMs) {
      return
    }
    await new Promise((r) => setTimeout(r, 50))
  }
}

async function closeTitlePopupIfOpen(app: ElectronApplication): Promise<void> {
  const id = await findWebContentsId(app, 'comfyTitlePopup.html')
  if (id === null) return
  if (!(await isPopupVisible(app))) return
  await app.evaluate(({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('comfyTitlePopup.html'))
    if (!wc) return
    return wc.executeJavaScript(`(window).__comfyTitlePopup.close()`)
  })
  await expect.poll(() => isPopupVisible(app), { timeout: 3_000, intervals: [100, 200] }).toBe(false)
}
