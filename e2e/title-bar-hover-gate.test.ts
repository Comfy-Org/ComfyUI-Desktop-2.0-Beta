/**
 * Title-bar hover-gate state machine. The `:hover` styles for the
 * title bar are gated on a `.is-hover-active` class on `.title-bar`,
 * which is dropped whenever the title-bar webContents loses input
 * (native menu opens, focus leaves the renderer) and re-enabled only
 * once a fresh `pointermove` arrives. The two-step (drop on blur,
 * re-enable on pointermove — NOT on bare focus) is the bit that
 * regresses easily, since `window.focus` can fire without the cursor
 * having moved (clicking back into the title bar to dismiss a menu
 * does exactly that).
 *
 * The gate is asserted by reading the `.is-hover-active` class on
 * `.title-bar` after dispatching events into the title-bar
 * webContents directly — the production paths fire from the same
 * window-level listeners.
 */

import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'

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
  await dispatchWindowBlur()
  await waitForHoverActive(false)
})

test('hover gate is inert immediately after mount @windows @macos @linux', async () => {
  // `onMounted` flips `isHoverActive` off so the user only "earns"
  // hover styles after actually moving the mouse over the bar.
  expect(await isHoverActive()).toBe(false)
})

test('pointermove inside the title bar enables the hover gate @windows @macos @linux', async () => {
  await dispatchPointerMove()
  await waitForHoverActive(true)
})

test('window.blur drops the hover gate @windows @macos @linux', async () => {
  // Prime the gate as enabled.
  await dispatchPointerMove()
  await waitForHoverActive(true)

  await dispatchWindowBlur()
  await waitForHoverActive(false)
})

test('window.focus alone does NOT re-enable the hover gate — only pointermove does @windows @macos @linux', async () => {
  // Prime then drop the gate, then dispatch a bare focus event. The
  // gate must remain off because focus can return without the cursor
  // having moved (clicking back into the title bar to dismiss a
  // native menu refocuses the renderer with a stale cursor position).
  await dispatchPointerMove()
  await waitForHoverActive(true)
  await dispatchWindowBlur()
  await waitForHoverActive(false)

  await dispatchWindowFocus()
  // Hold for a beat so any (bug-introduced) refocus-driven flip has
  // a chance to land and the assertion isn't racing the event loop.
  await new Promise((r) => setTimeout(r, 150))
  expect(await isHoverActive()).toBe(false)

  // A fresh pointermove still earns the gate back.
  await dispatchPointerMove()
  await waitForHoverActive(true)
})

test('pointerleave on the document drops the hover gate @windows @macos @linux', async () => {
  await dispatchPointerMove()
  await waitForHoverActive(true)

  await dispatchPointerLeave()
  await waitForHoverActive(false)
})

// ---------------------------------------------------------------------------
// Helpers — drive the title-bar webContents directly because the host
// BrowserWindow has no DOM and the title bar lives in a sibling
// WebContentsView. Each helper mirrors the production listener's
// trigger.
// ---------------------------------------------------------------------------

async function isHoverActive(): Promise<boolean> {
  return ctx.titleBar.evaluate<boolean>(
    `!!document.querySelector('.title-bar')?.classList.contains('is-hover-active')`,
  )
}

async function waitForHoverActive(expected: boolean): Promise<void> {
  await expect.poll(() => isHoverActive(), {
    timeout: 5_000,
    intervals: [50, 100, 200],
  }).toBe(expected)
}

async function dispatchPointerMove(): Promise<void> {
  await ctx.titleBar.evaluate<void>(`(() => {
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 40, clientY: 18 }))
  })()`)
}

async function dispatchPointerLeave(): Promise<void> {
  await ctx.titleBar.evaluate<void>(`(() => {
    document.documentElement.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }))
  })()`)
}

async function dispatchWindowBlur(): Promise<void> {
  await ctx.titleBar.evaluate<void>(`(() => {
    window.dispatchEvent(new FocusEvent('blur'))
  })()`)
}

async function dispatchWindowFocus(): Promise<void> {
  await ctx.titleBar.evaluate<void>(`(() => {
    window.dispatchEvent(new FocusEvent('focus'))
  })()`)
}
