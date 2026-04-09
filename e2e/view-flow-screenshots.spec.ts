/**
 * View Flow Screenshots — Issue #226
 *
 * Captures a screenshot of every major view and modal in the launcher UI.
 * Screenshots are saved to docs/screenshots/ and can be used by the
 * flow-graph generator (Phase 2) and Figma plugin (Phase 3).
 *
 * Run: pnpm exec playwright test e2e/view-flow-screenshots.spec.ts
 */
import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type LauncherAppHandle, launchLauncherApp } from './support/electronHarness'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCREENSHOT_DIR = path.resolve(__dirname, '..', 'docs', 'screenshots')

const UI_TIMEOUT = 12_000

let handle: LauncherAppHandle
let page: Page

async function screenshot(name: string): Promise<void> {
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, `${name}.png`),
    type: 'png',
  })
}

async function clickSidebar(text: string): Promise<void> {
  const item = page.locator('.sidebar-item', { hasText: text })
  await item.click()
  await expect(item).toHaveClass(/active/, { timeout: UI_TIMEOUT })
}

async function openModal(locator: ReturnType<Page['locator']>, screenshotName: string): Promise<void> {
  await expect(locator).toBeVisible({ timeout: UI_TIMEOUT })
  await locator.click()
  await expect(page.locator('.modal-overlay, .modal, [class*="modal"]')).toBeVisible({ timeout: UI_TIMEOUT })
  await screenshot(screenshotName)
  await page.keyboard.press('Escape')
  await expect(page.locator('.modal-overlay, .modal, [class*="modal"]')).toBeHidden({ timeout: UI_TIMEOUT })
}

test.describe('View Flow Screenshots (#226)', () => {
  test.beforeAll(async () => {
    handle = await launchLauncherApp()
    page = await handle.application.firstWindow()

    await expect(page.locator('#app')).toBeAttached({ timeout: UI_TIMEOUT })
    await expect(page.locator('.sidebar')).toBeVisible({ timeout: UI_TIMEOUT })
    // Wait for Vue to finish mounting and i18n to load
    await expect(page.locator('.sidebar-item')).toHaveCount(7, { timeout: UI_TIMEOUT })
  })

  test.afterAll(async () => {
    await handle.cleanup()
  })

  // ── Tab Views ──────────────────────────────────────────────

  test('01 — Dashboard @macos @windows @linux', async () => {
    await screenshot('01-dashboard')
  })

  test('02 — Installation List @macos @windows @linux', async () => {
    await clickSidebar('Installs')
    await screenshot('02-installation-list')
  })

  test('03 — Running @macos @windows @linux', async () => {
    await clickSidebar('Running')
    await screenshot('03-running')
  })

  test('04 — Models @macos @windows @linux', async () => {
    await clickSidebar('Models')
    await screenshot('04-models')
  })

  test('05 — Media @macos @windows @linux', async () => {
    await clickSidebar('Media')
    await screenshot('05-media')
  })

  test('06 — Settings @macos @windows @linux', async () => {
    await clickSidebar('Settings')
    await screenshot('06-settings')
  })

  // ── Modals (opened from Installation List) ─────────────────

  test('07 — New Install modal @macos @windows @linux', async () => {
    await clickSidebar('Installs')
    await openModal(
      page.locator('.toolbar button', { hasText: 'New Install' }),
      '07-new-install-modal',
    )
  })

  test('08 — Track Existing modal @macos @windows @linux', async () => {
    await clickSidebar('Installs')
    await openModal(
      page.locator('button', { hasText: 'Track Existing' }),
      '08-track-modal',
    )
  })

  test('09 — Load Snapshot modal @macos @windows @linux', async () => {
    await clickSidebar('Installs')
    await openModal(
      page.locator('button', { hasText: 'Load Snapshot' }),
      '09-load-snapshot-modal',
    )
  })

  // ── Dashboard modal entry points ───────────────────────────

  test('10 — Quick Install modal @macos @windows @linux', async () => {
    await clickSidebar('Dashboard')
    await openModal(
      page.locator('button', { hasText: 'Install ComfyUI' }),
      '10-quick-install-modal',
    )
  })
})
