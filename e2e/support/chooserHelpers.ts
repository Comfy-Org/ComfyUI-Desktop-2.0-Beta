import { expect } from '@playwright/test'
import type { WebContentsPage } from './cdpPages'

/** Assert that the chooser body is visible in the panel. */
export async function expectChooserVisible(panel: WebContentsPage): Promise<void> {
  await panel.waitForVisible('.chooser-view')
}

/** Click the New Install tile. */
export async function clickNewInstallTile(panel: WebContentsPage): Promise<void> {
  await panel.waitForVisible('.chooser-tile-new')
  const ok = await panel.click('.chooser-tile-new')
  expect(ok, 'New install tile click dispatched').toBe(true)
}

/**
 * Click an installed-card tile by display name (case-insensitive substring).
 * Excludes New Install and Cloud tiles. Polls for the tile's named presence
 * because the chooser store hydrates asynchronously after remount, so
 * `.chooser-view` is up before any tiles exist.
 */
export async function clickInstallTile(panel: WebContentsPage, nameSubstring: string): Promise<void> {
  const selector = '.chooser-tile:not(.chooser-tile-new):not(.chooser-tile-cloud) .chooser-tile-name'
  const needle = nameSubstring.toLowerCase()
  await panel.waitFor(
    async () => {
      const texts = await panel.allText(selector)
      return texts.some((t) => t.toLowerCase().includes(needle))
    },
    { timeout: 15_000, message: `Install tile matching "${nameSubstring}" never appeared in chooser` },
  )
  const ok = await panel.clickByText(selector, nameSubstring)
  expect(ok, `Install tile matching "${nameSubstring}" clicked`).toBe(true)
}

/** Click the title-bar waffle/menu button that opens the file menu popup. */
export async function openTitleMenu(titleBar: WebContentsPage): Promise<void> {
  await titleBar.waitForVisible('.title-menu-button--icon')
  const ok = await titleBar.click('.title-menu-button--icon')
  expect(ok, 'Title menu button click dispatched').toBe(true)
}

/** Click the title-bar downloads tray icon that opens the downloads popup. */
export async function openDownloadsTray(titleBar: WebContentsPage): Promise<void> {
  await titleBar.waitForVisible('.title-downloads-tray')
  const ok = await titleBar.click('.title-downloads-tray')
  expect(ok, 'Downloads tray button click dispatched').toBe(true)
}

/** Wait for any flow takeover to be visible inside the panel body. */
export async function expectTakeoverOpen(panel: WebContentsPage): Promise<void> {
  await panel.waitForVisible('.brand-takeover-root', { timeout: 10_000 })
}

/** Dispatch Escape to dismiss the active overlay. */
export async function dismissOverlay(panel: WebContentsPage): Promise<void> {
  await panel.pressKey('Escape')
}
