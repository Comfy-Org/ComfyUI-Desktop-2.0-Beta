/**
 * Chooser E2E: validates the install-less host window's chooser body and
 * its title bar after launch. No installs seeded — covers the cold-start
 * path where the user lands on the chooser.
 */

import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import {
  clickNewInstallTile,
  openTitleMenu,
  expectChooserVisible,
  expectTakeoverOpen,
  dismissOverlay,
} from './support/chooserHelpers'

let ctx: AppContext

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  ctx = await launchApp()
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
  expect(await ctx.titleBar.textOf('.title-install-name')).toMatch(/Desktop 2\.0/i)
})

test('clicking New Install tile opens the new-install takeover @windows @macos @linux', async () => {
  await clickNewInstallTile(ctx.panel)
  await expectTakeoverOpen(ctx.panel)
  await dismissOverlay(ctx.panel)
  await expectChooserVisible(ctx.panel)
})

test('title-bar menu button is reachable via the eval bridge @windows @macos @linux', async () => {
  // The menu popup itself lives in another WebContentsView (comfyTitlePopup)
  // we don't drive in this test; ensure the click dispatches without throwing.
  await openTitleMenu(ctx.titleBar)
  await ctx.titleBar.pressKey('Escape')
})
