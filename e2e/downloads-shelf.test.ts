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
import {
  closeTitlePopupIfOpen,
  isPopupVisible,
  titlePopupPage,
  TITLE_REOPEN_SUPPRESSION_MS,
  type WebContentsPage,
} from './support/cdpPages'
import { getTitlePopupBounds, seedDownloads, type DownloadProgressLike } from './support/devHooks'

let ctx: AppContext
let popup: WebContentsPage
let entryCounter = 0

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
 *   4. Reset the makeEntry counter so each test gets deterministic
 *      `createdAt` ordering — without this, parallel test pollution
 *      (or shifts in test order) would couple downstream `createdAt`
 *      assertions to the previous test's seeding.
 */
test.beforeEach(async () => {
  await closeTitlePopupIfOpen(ctx.app)
  await new Promise((r) => setTimeout(r, TITLE_REOPEN_SUPPRESSION_MS))
  await seedDownloads(ctx.app, { active: [], recent: [] })
  entryCounter = 0
})

// ---------------------------------------------------------------------------
// Sizing — these are the assertions that would have caught the
// flex-allocated-height regression without manual smoke testing.
// ---------------------------------------------------------------------------

test('empty drawer fits content (popup height < 260px) @windows @macos @linux', async () => {
  await openDownloadsTray(ctx.titleBar)
  await waitForPopupVisible(ctx.app)
  await waitForStableBounds(ctx.app)

  const bounds = await getTitlePopupBounds(ctx.app)
  expect(bounds?.kind).toBe('downloads')
  // Header + empty placeholder + footer link + ~2px borders measures
  // ~220px after the brand padding bump; anything under 260 means the
  // popup didn't pin to the 396 ceiling.
  expect(bounds!.bounds.height).toBeLessThan(260)
  // Also greater than zero so we know we measured a real visible popup.
  expect(bounds!.bounds.height).toBeGreaterThan(40)
})

test('one downloading entry fits content (NOT clipped at 396 ceiling) @windows @macos @linux', async () => {
  await seedDownloads(ctx.app, {
    active: [makeEntry({ url: 'https://example.test/m1.safetensors', filename: 'm1.safetensors', status: 'downloading', progress: 0.5 })],
    recent: [],
  })
  await openDownloadsTray(ctx.titleBar)
  await waitForPopupVisible(ctx.app)
  await waitForStableBounds(ctx.app)

  const bounds = await getTitlePopupBounds(ctx.app)
  // One row + footer ≈ 130–200px; the bug under test would have left
  // it stuck at the 396 ceiling because `.downloads-list` reports
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
  // Ceiling is min(396, 0.6 * windowContentHeight). The default chooser
  // window is at least 660px tall, so 396 wins under default test bounds.
  expect(bounds!.bounds.height).toBeLessThanOrEqual(396)
  // Pinned to the ceiling (within a few px for borders / fractional
  // pixel rounding).
  expect(bounds!.bounds.height).toBeGreaterThan(356)

  // The internal list overflows.
  const overflow = await popup.evaluate<{ scroll: number; client: number }>(`(() => {
    const el = document.querySelector('.downloads-list')
    return el ? { scroll: el.scrollHeight, client: el.clientHeight } : { scroll: 0, client: 0 }
  })()`)
  expect(overflow.scroll).toBeGreaterThan(overflow.client)
})

// ---------------------------------------------------------------------------
// Per-status row controls — contextual close-X visibility (cancel for
// active rows, remove for terminal rows).
// ---------------------------------------------------------------------------

test('per-status row close button maps to the right action @windows @macos @linux', async () => {
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

  // The redesign replaced the per-row pause/resume/cancel/dismiss
  // button row with a single right-edge close X whose aria-label
  // switches between "Cancel" (active rows) and "Remove from list"
  // (terminal rows). Check the affordance via that aria-label so the
  // test asserts what the user actually sees.
  const summary = await popup.evaluate<Record<string, { close: string | null }>>(`(() => {
    const out = {}
    for (const li of document.querySelectorAll('.downloads-item')) {
      const name = (li.querySelector('.downloads-item-name')?.textContent || '').trim()
      const closeBtn = li.querySelector('.downloads-item-close')
      out[name] = {
        close: closeBtn ? (closeBtn.getAttribute('aria-label') || '').toLowerCase() : null,
      }
    }
    return out
  })()`)

  // Active rows: close X cancels the in-flight download.
  expect(summary['dl.safetensors']?.close).toContain('cancel')
  expect(summary['pa.safetensors']?.close).toContain('cancel')
  expect(summary['pe.safetensors']?.close).toContain('cancel')
  // Terminal rows: close X removes the entry from the list.
  expect(summary['co.safetensors']?.close).toContain('remove')
  expect(summary['er.safetensors']?.close).toContain('remove')
  expect(summary['ca.safetensors']?.close).toContain('remove')
})

test('retry affordance shows on error + cancelled rows only @windows @macos @linux', async () => {
  await seedDownloads(ctx.app, {
    active: [makeEntry({ url: 'u-dl', filename: 'dl.safetensors', status: 'downloading', progress: 0.5 })],
    recent: [
      makeEntry({ url: 'u-co', filename: 'co.safetensors', status: 'completed', progress: 1, savePath: '/tmp/co.safetensors' }),
      makeEntry({ url: 'u-er', filename: 'er.safetensors', status: 'error', progress: 0, error: 'boom' }),
      makeEntry({ url: 'u-ca', filename: 'ca.safetensors', status: 'cancelled', progress: 0 }),
    ],
  })
  await openDownloadsTray(ctx.titleBar)
  await waitForPopupVisible(ctx.app)
  await waitForStableBounds(ctx.app)

  // The retry button (↺) is rendered for `error` AND `cancelled` rows —
  // both can be re-dispatched from main's captured params. Completed
  // (nothing to retry) and in-flight rows must not offer it.
  const summary = await popup.evaluate<Record<string, { retry: boolean }>>(`(() => {
    const out = {}
    for (const li of document.querySelectorAll('.downloads-item')) {
      const name = (li.querySelector('.downloads-item-name')?.textContent || '').trim()
      out[name] = { retry: !!li.querySelector('.downloads-item-retry') }
    }
    return out
  })()`)

  expect(summary['er.safetensors']?.retry).toBe(true)
  expect(summary['ca.safetensors']?.retry).toBe(true)
  expect(summary['co.safetensors']?.retry).toBe(false)
  expect(summary['dl.safetensors']?.retry).toBe(false)
})

// ---------------------------------------------------------------------------
// Title-bar badge — a failed download surfaces a distinct red error
// badge that takes precedence over the green "completed, unseen" badge,
// so a failure never reads as success on the tray icon.
// ---------------------------------------------------------------------------

test('unseen failure shows the red error badge, not the green one @windows @macos @linux', async () => {
  // Keep the popup CLOSED — the badge is the "unseen" indicator and
  // clears the moment the tray is opened (acknowledgeRecent).
  await seedDownloads(ctx.app, {
    active: [],
    recent: [makeEntry({ url: 'u-er', filename: 'er.safetensors', status: 'error', progress: 0, error: 'boom' })],
  })

  await expect.poll(() => ctx.titleBar.count('.title-downloads-badge.is-error'), {
    timeout: 5_000,
    intervals: [100, 200, 400],
  }).toBe(1)
  // The green "completed" badge must NOT be showing for a pure failure.
  expect(await ctx.titleBar.count('.title-downloads-badge.is-unseen')).toBe(0)
})

test('a completed-only download shows the green badge (error badge gated) @windows @macos @linux', async () => {
  await seedDownloads(ctx.app, {
    active: [],
    recent: [makeEntry({ url: 'u-co', filename: 'co.safetensors', status: 'completed', progress: 1, savePath: '/tmp/co.safetensors' })],
  })

  await expect.poll(() => ctx.titleBar.count('.title-downloads-badge.is-unseen'), {
    timeout: 5_000,
    intervals: [100, 200, 400],
  }).toBe(1)
  expect(await ctx.titleBar.count('.title-downloads-badge.is-error')).toBe(0)
})

test('a mid-batch failure shows the red dot while the active count badge persists @windows @macos @linux', async () => {
  // Two still downloading + one already failed: the badge keeps
  // reporting the ACTIVE count (blue, no `is-error` recolour), but the
  // failure is surfaced immediately via the red dot + the tray's
  // `has-error` tint — rather than waiting for the queue to drain.
  //
  // The dot is the *unseen* indicator, so the popup must stay CLOSED
  // (opening it calls `acknowledgeRecent`, zeroing `unseenErrorCount`).
  // `beforeEach` closes it, but assert it here too so a prior test that
  // left it open can't mask the dot.
  await closeTitlePopupIfOpen(ctx.app)
  await new Promise((r) => setTimeout(r, TITLE_REOPEN_SUPPRESSION_MS))
  // A never-before-acknowledged URL so a prior test's `acknowledgeRecent`
  // can't leave it in the `seenUrls` set.
  await seedDownloads(ctx.app, {
    active: [
      makeEntry({ url: 'u-midbatch-dl1', filename: 'dl1.safetensors', status: 'downloading', progress: 0.5 }),
      makeEntry({ url: 'u-midbatch-dl2', filename: 'dl2.safetensors', status: 'downloading', progress: 0.2 }),
    ],
    recent: [makeEntry({ url: 'u-midbatch-er', filename: 'er.safetensors', status: 'error', progress: 0, error: 'boom' })],
  })

  // Red dot appears (the mid-batch failure marker).
  await expect.poll(() => ctx.titleBar.count('.title-downloads-error-dot'), {
    timeout: 5_000,
    intervals: [100, 200, 400],
  }).toBe(1)
  // The tray button carries the danger tint.
  expect(await ctx.titleBar.count('.title-downloads-tray.has-error')).toBe(1)
  // The count badge is still the plain (active-count) variant — NOT
  // recoloured to the error badge, and showing the active total "2".
  expect(await ctx.titleBar.count('.title-downloads-badge.is-error')).toBe(0)
  const badgeText = (await ctx.titleBar.allText('.title-downloads-badge'))[0]?.trim()
  expect(badgeText).toBe('2')
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
// (`isPopupVisible` and `closeTitlePopupIfOpen` already live in
// `support/cdpPages.ts` because they are shared with chooser /
// dropdowns / downloads tests.)
// ---------------------------------------------------------------------------

/** Build a minimal `DownloadProgressLike` with sensible defaults so tests
 *  only set the fields they actually care about. `createdAt` defaults to
 *  a monotonically-increasing counter so insertion-ordered list assertions
 *  match the order the test wrote them. The counter resets in
 *  `beforeEach` so each test starts from 1. */
function makeEntry(partial: Partial<DownloadProgressLike> & { url: string; filename: string }): DownloadProgressLike {
  return {
    progress: 0,
    status: 'downloading',
    createdAt: ++entryCounter,
    ...partial,
  }
}

async function waitForPopupVisible(app: ElectronApplication): Promise<void> {
  await expect.poll(() => isPopupVisible(app, 'comfyTitlePopup.html'), {
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
