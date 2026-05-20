/**
 * Lifecycle E2E: New Install (recommended standalone variant for the host
 * GPU, latest stable release) → ComfyUI auto-launches via brand chrome →
 * dashboard return → relaunch → stop.
 *
 * Downloads ~500 MB of standalone payload. Tagged @lifecycle and runs under
 * the dedicated Playwright project (10-minute per-test timeout).
 *
 * Run:
 *   pnpm run build && pnpm run test:e2e:windows -- --project=lifecycle
 *
 * Requirements: network access, ~2 GB free disk.
 *
 * Redesign notes (vs. the pre-2.0-Beta lifecycle test):
 * - The new-install takeover is a single Configure screen wrapped in
 *   `BrandTakeoverLayout` (root: `.brand-takeover-root`). No multi-step
 *   wizard, no Next button.
 * - Standalone is pre-selected on open. `loadFieldOptions('release')`
 *   picks the recommended option ("Latest Stable") and recursively
 *   loads `loadFieldOptions('variant')` which picks its own recommended
 *   option (CPU on a no-GPU CI runner, NVIDIA on an NVIDIA box, etc.).
 *   So by the time `saveDisabled` flips false, the form is fully
 *   pre-filled — no explicit release / variant picking needed.
 * - The primary CTA is `.brand-primary.config-continue` labelled
 *   "Continue" (formerly `button.primary` "Add Install").
 * - `handleSave` emits `show-progress` with `autoLaunchOnFinish: true`,
 *   so the install op chains directly into a launch op under the same
 *   brand-takeover chrome. There is no intermediate "Done" button and
 *   no need to click the chooser tile to launch — the chooser host
 *   transforms in place into the install host (issue #449 path).
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import {
  clickNewInstallTile,
  clickInstallTile,
  expectChooserVisible,
  expectTakeoverOpen,
} from './support/chooserHelpers'
import { returnFirstInstallHostToDashboard } from './support/devHooks'
import { waitForWebContents } from './support/cdpPages'

let ctx: AppContext

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  if (!process.env['GITHUB_TOKEN']) {
    for (let depth = 2; depth <= 8; depth++) {
      const segments = Array(depth).fill('..')
      const p = resolve(__dirname, ...segments, 'githubtoken.txt')
      try {
        process.env['GITHUB_TOKEN'] = readFileSync(p, 'utf-8').trim()
        break
      } catch { /* try next depth */ }
    }
  }
  ctx = await launchApp()
})

test.afterAll(async () => {
  await ctx.cleanup()
})

/** True iff a webContents with a localhost URL exists and is loaded. */
async function comfyFrontendIsLoaded(): Promise<boolean> {
  return ctx.app.evaluate(({ webContents }) =>
    webContents.getAllWebContents().some((wc) =>
      /^http:\/\/(127\.0\.0\.1|localhost):/.test(wc.getURL()) && !wc.isLoading(),
    ),
  )
}

// ---------------------------------------------------------------------------
// Install via the New Install takeover
// ---------------------------------------------------------------------------

test('chooser shows New Install tile on cold start @lifecycle', async () => {
  await expectChooserVisible(ctx.panel)
  expect(await ctx.panel.exists('.chooser-tile-new')).toBe(true)
})

test('opens New Install takeover with form pre-filled @lifecycle', async () => {
  await clickNewInstallTile(ctx.panel)
  await expectTakeoverOpen(ctx.panel)

  // Standalone is pre-selected on open. The release + variant fields
  // live inside the Advanced disclosure but are populated eagerly via
  // `loadFieldOptions('release')` → recursive `loadFieldOptions('variant')`.
  // `.brand-primary.config-continue` is bound to `:disabled="!canContinue"`,
  // so once it goes enabled the form is fully pre-filled (release picked,
  // variant picked, no path issues). That's the single signal we need
  // before clicking Continue.
  await ctx.panel.waitFor(
    async () => ctx.app.evaluate(({ webContents }) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('panel.html'))
      if (!wc) return false
      return wc.executeJavaScript(`(() => {
        const btn = document.querySelector('.brand-primary.config-continue')
        return !!btn && !btn.disabled
      })()`) as Promise<boolean>
    }),
    { timeout: 60_000, message: 'Continue button never became enabled (form did not pre-fill)' },
  )
})

test('completes install (auto-launches via brand chrome) @lifecycle', async () => {
  // No explicit variant / release / name picking — trust the
  // recommended defaults the modal has already filled in. On a no-GPU
  // CI runner that's CPU; on a GPU box it's the matching GPU variant.
  // Either is fine for the lifecycle smoke test.
  expect(await ctx.panel.clickByText('.brand-primary', 'Continue')).toBe(true)

  // Install op mounts the brand-progress takeover, then auto-launches
  // into a launch op under the same chrome. The terminal signal is
  // the comfy webContents loading a localhost URL — covers both the
  // install completing and the server coming up.
  await ctx.panel.waitForVisible('.brand-progress', { timeout: 10_000 })
  await expect.poll(comfyFrontendIsLoaded, { timeout: 480_000, intervals: [1_000, 2_000] }).toBe(true)
})

// ---------------------------------------------------------------------------
// Launch & verify split-view + dark background
// ---------------------------------------------------------------------------

test('auto-launch landed on a single host window (in-place attach) @lifecycle', async () => {
  // In-place attach guard: the redesigned install flow has
  // `autoLaunchOnFinish: true`, so the chooser host transforms into
  // the install host without spawning a fresh BrowserWindow. The
  // previous test already polled `comfyFrontendIsLoaded` to true — at
  // this point exactly one window should exist and it should host the
  // comfy webContents. A close+open swap path would leak windows or
  // leave the original chooser host alive alongside a new install host.
  const state = await ctx.app.evaluate(({ BrowserWindow, WebContentsView }) => {
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    const comfyHost = wins.find((w) =>
      w.contentView.children.some((v) =>
        v instanceof WebContentsView &&
        /^http:\/\/(127\.0\.0\.1|localhost):/.test(v.webContents.getURL()),
      ),
    )
    return { count: wins.length, comfyHostId: comfyHost?.id ?? null }
  })
  expect(state.count).toBe(1)
  expect(state.comfyHostId).not.toBeNull()
})

/**
 * Regression guard for #449: per-install BrowserWindow uses the title-bar +
 * content split-view (≥2 WebContentsView children) and the parent
 * BrowserWindow background is dark (#171717) so no white frame flashes
 * pre-load.
 */
test('ComfyUI window has dark background and split-view architecture @lifecycle', async () => {
  const arch = await ctx.app.evaluate(({ BrowserWindow, WebContentsView }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      const children = win.contentView.children
      const comfyChild = children.find((v) =>
        v instanceof WebContentsView &&
        /^http:\/\/(127\.0\.0\.1|localhost):/.test(v.webContents.getURL()),
      ) as { getBounds(): { x: number; y: number; width: number; height: number }; getVisible(): boolean } | undefined
      if (!comfyChild) continue
      const bounds = comfyChild.getBounds()
      return {
        childCount: children.length,
        allWebContentsViews: children.every((v) => v instanceof WebContentsView),
        bg: win.getBackgroundColor(),
        comfyBounds: bounds,
        comfyVisible: comfyChild.getVisible(),
      }
    }
    return null
  })

  expect(arch, 'ComfyUI BrowserWindow not found among open windows').not.toBeNull()
  expect(arch!.childCount).toBeGreaterThanOrEqual(2)
  expect(arch!.allWebContentsViews).toBe(true)
  expect(arch!.bg.toLowerCase()).toBe('#171717')
  // Regression guard for the chooser-pick in-place attach onto a unique-
  // partition install: rebuildComfyViewIfNeeded swaps entry.comfyView, and
  // a stale closure in layoutViews used to leave the freshly-built view
  // at default 0×0 invisible bounds — ComfyUI would load but never paint.
  expect(arch!.comfyVisible, 'comfyView is hidden').toBe(true)
  expect(arch!.comfyBounds.width, 'comfyView width is 0').toBeGreaterThan(0)
  expect(arch!.comfyBounds.height, 'comfyView height is 0').toBeGreaterThan(0)
})

// ---------------------------------------------------------------------------
// Return to Dashboard — symmetric undo of in-place attach
// ---------------------------------------------------------------------------

test('return-to-dashboard flips install host in place (same window id) @lifecycle', async () => {
  // Snapshot the live BrowserWindow ids BEFORE the flip so the
  // post-flip assertion can prove the install-backed host was reused
  // as the chooser host instead of being closed and replaced.
  const before = await ctx.app.evaluate(({ BrowserWindow }) => {
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    return { count: wins.length, ids: wins.map((w) => w.id) }
  })

  // Trigger the same code path the File menu's "Return to Dashboard"
  // entry runs (popup item handler calls `returnToDashboard(parentEntryId)`).
  const flippedId = await returnFirstInstallHostToDashboard(ctx.app)
  expect(flippedId, 'no install-backed host window found to flip').not.toBeNull()
  expect(before.ids).toContain(flippedId)

  // After the flip the comfyView should no longer be loading a localhost URL
  // (the install was detached and the comfyView navigated to about:blank).
  await expect.poll(comfyFrontendIsLoaded, { timeout: 30_000, intervals: [500] }).toBe(false)

  const after = await ctx.app.evaluate(({ BrowserWindow }) => {
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    return { count: wins.length, ids: wins.map((w) => w.id) }
  })

  // Same window count (no fresh window) and the flipped id is still alive —
  // proving the install-backed host stayed the same BrowserWindow when it
  // returned to chooser mode.
  expect(after.count).toBe(before.count)
  expect(after.ids).toContain(flippedId)

  // The chooser body should be visible again on the same window. The
  // install-backed PanelApp was destroyed at attach time, so wait for
  // the chooser PanelApp's webContents to be (re-)created by the in-place
  // detach before driving DOM assertions through it.
  await waitForWebContents(ctx.app, 'panel.html')
  await expectChooserVisible(ctx.panel)

  // Re-launch ComfyUI from the same chooser host so the subsequent stop
  // test can find a running comfy webContents to close. The host id must
  // STILL be the same one we just flipped (chooser → install in place).
  await clickInstallTile(ctx.panel, 'ComfyUI')
  await expect.poll(comfyFrontendIsLoaded, { timeout: 180_000, intervals: [1_000] }).toBe(true)

  const reattached = await ctx.app.evaluate(({ BrowserWindow, WebContentsView }) => {
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    const comfyHost = wins.find((w) =>
      w.contentView.children.some((v) =>
        v instanceof WebContentsView &&
        /^http:\/\/(127\.0\.0\.1|localhost):/.test(v.webContents.getURL()),
      ),
    )
    return { count: wins.length, comfyHostId: comfyHost?.id ?? null }
  })
  expect(reattached.count).toBe(before.count)
  expect(reattached.comfyHostId).toBe(flippedId)
})

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

test('stops running ComfyUI by closing its host window @lifecycle', async () => {
  // After launch, the chooser host transforms in place to host the install
  // (the original `panel.html` body is detached). Drive the stop through the
  // BrowserWindow `close()` call instead — the window's close handler tears
  // the comfy process down via the same path the chooser-tile close button
  // would use. Closing the last host window also quits the Electron app,
  // which is why the subsequent poll treats an evaluate failure (app gone)
  // as the terminal "stopped" state.
  const closed = await ctx.app.evaluate(({ BrowserWindow, WebContentsView }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      const hasComfy = win.contentView.children.some((v) =>
        v instanceof WebContentsView &&
        /^http:\/\/(127\.0\.0\.1|localhost):/.test(v.webContents.getURL()),
      )
      if (hasComfy) {
        win.close()
        return true
      }
    }
    return false
  })
  expect(closed, 'ComfyUI host window not found among open windows').toBe(true)

  await expect.poll(
    async () => {
      try {
        return await comfyFrontendIsLoaded()
      } catch {
        // App was torn down by the close — that's a stronger "stopped" signal
        // than the comfy webContents going away on its own.
        return false
      }
    },
    { timeout: 60_000, intervals: [500] },
  ).toBe(false)
})
