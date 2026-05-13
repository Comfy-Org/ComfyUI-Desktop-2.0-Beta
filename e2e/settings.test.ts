/**
 * G2 — Settings panel coverage. Drives the unified SettingsModal
 * from the title-bar waffle menu and validates that each install-less
 * tab (Directories / Downloads / Global) renders its body, plus the
 * open / close lifecycle.
 *
 * The "ComfyUI Settings" tab is install-backed only (sidebar gates
 * it on `hasInstallation`) — covered by the lifecycle suite, not
 * here. The chooser host's default tab is `global`.
 */

import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import { openTitleMenu } from './support/chooserHelpers'
import { titlePopupPage, type WebContentsPage } from './support/cdpPages'

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
 * Reset to a known-empty overlay state between tests so a leftover
 * settings modal from a previous test doesn't pollute the next one.
 */
test.beforeEach(async () => {
  // Press Escape repeatedly to close any open settings modal / popup.
  for (let i = 0; i < 4; i++) {
    if (!(await ctx.panel.exists('.settings-modal-shell'))) break
    await ctx.panel.pressKey('Escape')
    await new Promise((r) => setTimeout(r, 100))
  }
  // Step past the title-bar reopen-suppression window so the next open
  // doesn't get debounced.
  await new Promise((r) => setTimeout(r, 150))
})

// ---------------------------------------------------------------------------
// Open lifecycle.
// ---------------------------------------------------------------------------

test('Settings opens from the waffle menu and lands on the install-less default tab @windows @macos @linux', async () => {
  await openSettingsViaWaffle(ctx, popup)

  // Default tab on the install-less chooser is `global`.
  const activeLabel = await ctx.panel.textOf('.settings-sidebar-item.active')
  expect(activeLabel?.toLowerCase()).toContain('global')
})

test('Escape dismisses the Settings modal @windows @macos @linux', async () => {
  await openSettingsViaWaffle(ctx, popup)
  expect(await ctx.panel.exists('.settings-modal-shell')).toBe(true)

  await ctx.panel.pressKey('Escape')
  await expect.poll(() => ctx.panel.exists('.settings-modal-shell'), {
    timeout: 5_000,
    intervals: [100, 200],
  }).toBe(false)
})

test('Settings reopens cleanly after a close @windows @macos @linux', async () => {
  await openSettingsViaWaffle(ctx, popup)
  await ctx.panel.pressKey('Escape')
  await expect.poll(() => ctx.panel.exists('.settings-modal-shell'), {
    timeout: 5_000,
    intervals: [100, 200],
  }).toBe(false)

  // Step past reopen-suppression and open again.
  await new Promise((r) => setTimeout(r, 150))
  await openSettingsViaWaffle(ctx, popup)
  expect(await ctx.panel.exists('.settings-modal-shell')).toBe(true)
})

// ---------------------------------------------------------------------------
// Per-tab body rendering.
// ---------------------------------------------------------------------------

test('Global tab renders SettingsView body @windows @macos @linux', async () => {
  await openSettingsViaWaffle(ctx, popup)
  await selectSettingsTab(ctx, /global/i)
  // SettingsView renders one `.settings-section` per group; the Global
  // tab is non-empty in steady state so at least one section exists.
  await expect.poll(() => ctx.panel.count('.settings-section'), {
    timeout: 5_000,
    intervals: [100, 200],
  }).toBeGreaterThan(0)
})

test('Directories tab renders DirectoriesView body @windows @macos @linux', async () => {
  await openSettingsViaWaffle(ctx, popup)
  await selectSettingsTab(ctx, /directories/i)
  await expect.poll(() => ctx.panel.exists('.directories-panel'), {
    timeout: 5_000,
    intervals: [100, 200],
  }).toBe(true)
})

test('Downloads (settings) tab renders DownloadsView body @windows @macos @linux', async () => {
  await openSettingsViaWaffle(ctx, popup)
  await selectSettingsTab(ctx, /downloads/i)
  await expect.poll(() => ctx.panel.exists('.downloads-tab'), {
    timeout: 5_000,
    intervals: [100, 200],
  }).toBe(true)
})

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** Open the title-bar waffle menu, click the Settings item in the popup,
 *  and wait for the unified SettingsModal to mount in the panel.
 *  MenuView renders items as `<li role="menuitem">` (not buttons). */
async function openSettingsViaWaffle(ctx: AppContext, popup: WebContentsPage): Promise<void> {
  await openTitleMenu(ctx.titleBar)
  await popup.waitForSelector('[role="menuitem"]', { timeout: 5_000 })
  const ok = await popup.clickByText('[role="menuitem"]', 'Settings')
  expect(ok, 'Settings menu item clicked').toBe(true)
  await expect.poll(() => ctx.panel.exists('.settings-modal-shell'), {
    timeout: 5_000,
    intervals: [100, 200],
  }).toBe(true)
}

/** Click the sidebar tab whose label matches `labelPattern`, then wait
 *  for the `.active` modifier to land on it so the body is in sync. */
async function selectSettingsTab(ctx: AppContext, labelPattern: RegExp): Promise<void> {
  const labels = await ctx.panel.allText('.settings-sidebar-item')
  const target = labels.find((l) => labelPattern.test(l))
  expect(target, `tab matching ${labelPattern} found among [${labels.join(', ')}]`).toBeTruthy()
  const ok = await ctx.panel.clickByText('.settings-sidebar-item', target!)
  expect(ok, `tab "${target}" click dispatched`).toBe(true)
  await expect.poll(async () => {
    const active = await ctx.panel.textOf('.settings-sidebar-item.active')
    return active && labelPattern.test(active)
  }, { timeout: 3_000, intervals: [50, 100, 200] }).toBeTruthy()
}
