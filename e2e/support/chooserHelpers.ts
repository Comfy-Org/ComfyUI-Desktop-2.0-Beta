/**
 * Helpers for asserting against the chooser body and title bar via the
 * eval-bridge WebContentsPage facade.
 */

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
 * Click an installed-card tile by its display name (case-insensitive
 * substring). Excludes the New Install and Cloud tiles — those use
 * dedicated class hooks and their descriptions can incidentally match
 * install-name substrings like "ComfyUI".
 */
export async function clickInstallTile(panel: WebContentsPage, nameSubstring: string): Promise<void> {
  const ok = await panel.clickByText(
    '.chooser-tile:not(.chooser-tile-new):not(.chooser-tile-cloud) .chooser-tile-name',
    nameSubstring,
  )
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
