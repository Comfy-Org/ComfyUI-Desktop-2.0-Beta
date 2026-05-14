/**
 * Title-bar hover-gate state machine on the dashboard / install-less
 * chooser host. The `:hover` styles for the title bar are gated on a
 * `.is-hover-active` class on `.title-bar`, which is dropped whenever
 * the title-bar webContents loses input (native menu opens, focus
 * leaves the renderer) and re-enabled only once a fresh `pointermove`
 * arrives. The two-step (drop on blur, re-enable on pointermove —
 * NOT on bare focus) is the bit that regresses easily, since
 * `window.focus` can fire without the cursor having moved (clicking
 * back into the title bar to dismiss a menu does exactly that).
 *
 * The install-backed (comfy-window) variant lives in
 * `title-bar-hover-gate-comfy-window.test.ts` — past title-bar bugs
 * have surfaced only after an install attached, so both states need
 * coverage.
 */

import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import {
  dispatchPointerLeave,
  dispatchPointerMove,
  dispatchWindowBlur,
  dispatchWindowFocus,
  isHoverActive,
  waitForHoverActive,
} from './support/hoverGate'

let ctx: AppContext

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  ctx = await launchApp({ settings: { firstUseCompleted: true, telemetryEnabled: false } })
})

test.afterAll(async () => {
  await ctx.cleanup()
})

test.beforeEach(async () => {
  // Reset to the post-mount baseline (gate inert until a fresh
  // pointermove). Done by dispatching window.blur which is the same
  // path the production code relies on after a native menu opens.
  await dispatchWindowBlur(ctx.titleBar)
  await waitForHoverActive(ctx.titleBar, false)
})

test('hover gate is inert immediately after mount @windows @macos @linux', async () => {
  // `onMounted` flips `isHoverActive` off so the user only "earns"
  // hover styles after actually moving the mouse over the bar.
  expect(await isHoverActive(ctx.titleBar)).toBe(false)
})

test('pointermove inside the title bar enables the hover gate @windows @macos @linux', async () => {
  await dispatchPointerMove(ctx.titleBar)
  await waitForHoverActive(ctx.titleBar, true)
})

test('window.blur drops the hover gate @windows @macos @linux', async () => {
  // Prime the gate as enabled.
  await dispatchPointerMove(ctx.titleBar)
  await waitForHoverActive(ctx.titleBar, true)

  await dispatchWindowBlur(ctx.titleBar)
  await waitForHoverActive(ctx.titleBar, false)
})

test('window.focus alone does NOT re-enable the hover gate — only pointermove does @windows @macos @linux', async () => {
  // Prime then drop the gate, then dispatch a bare focus event. The
  // gate must remain off because focus can return without the cursor
  // having moved (clicking back into the title bar to dismiss a
  // native menu refocuses the renderer with a stale cursor position).
  await dispatchPointerMove(ctx.titleBar)
  await waitForHoverActive(ctx.titleBar, true)
  await dispatchWindowBlur(ctx.titleBar)
  await waitForHoverActive(ctx.titleBar, false)

  await dispatchWindowFocus(ctx.titleBar)
  // Hold for a beat so any (bug-introduced) refocus-driven flip has
  // a chance to land and the assertion isn't racing the event loop.
  await new Promise((r) => setTimeout(r, 150))
  expect(await isHoverActive(ctx.titleBar)).toBe(false)

  // A fresh pointermove still earns the gate back.
  await dispatchPointerMove(ctx.titleBar)
  await waitForHoverActive(ctx.titleBar, true)
})

test('pointerleave on the document drops the hover gate @windows @macos @linux', async () => {
  await dispatchPointerMove(ctx.titleBar)
  await waitForHoverActive(ctx.titleBar, true)

  await dispatchPointerLeave(ctx.titleBar)
  await waitForHoverActive(ctx.titleBar, false)
})
