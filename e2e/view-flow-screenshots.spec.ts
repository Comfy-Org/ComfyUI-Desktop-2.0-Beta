/**
 * View Flow Screenshots — Issue #226
 *
 * Captures a screenshot of every major view and modal in the launcher UI.
 * Screenshots are saved to docs/screenshots/ and can be used by the
 * flow-graph generator (Phase 2) and Figma plugin (Phase 3).
 *
 * Run: pnpm exec playwright test e2e/view-flow-screenshots.spec.ts
 */
import { expect, test } from '@playwright/test'
import path from 'node:path'
import { launchLauncherApp } from './support/electronHarness'

const SCREENSHOT_DIR = path.resolve(__dirname, '..', 'docs', 'screenshots')

// Timeout for waiting on UI elements to appear
const UI_TIMEOUT = 12_000

test.describe('View Flow Screenshots (#226)', () => {
  test('capture all views and modals @macos @windows @linux', async () => {
    const { application, cleanup } = await launchLauncherApp()
    try {
      const page = await application.firstWindow()

      // Wait for the app to fully render
      await expect(page.locator('#app')).toBeAttached({ timeout: UI_TIMEOUT })
      await expect(page.locator('.sidebar')).toBeVisible({ timeout: UI_TIMEOUT })

      // Give Vue time to finish mounting and i18n to load
      await page.waitForTimeout(1500)

      // Helper to take a screenshot with a consistent name
      async function screenshot(name: string): Promise<void> {
        await page.screenshot({
          path: path.join(SCREENSHOT_DIR, `${name}.png`),
          type: 'png',
        })
      }

      // Helper to click a sidebar item by its visible text
      async function clickSidebar(text: string): Promise<void> {
        await page.locator('.sidebar-item', { hasText: text }).click()
        await page.waitForTimeout(500)
      }

      // ── Tab Views ──────────────────────────────────────────────

      // 1. Dashboard (default view on launch — welcome/empty state)
      await screenshot('01-dashboard')

      // 2. Installation List (sidebar label: "Installs")
      await clickSidebar('Installs')
      await screenshot('02-installation-list')

      // 3. Running
      await clickSidebar('Running')
      await screenshot('03-running')

      // 4. Models
      await clickSidebar('Models')
      await screenshot('04-models')

      // 5. Media
      await clickSidebar('Media')
      await screenshot('05-media')

      // 6. Settings
      await clickSidebar('Settings')
      await screenshot('06-settings')

      // ── Modals (opened from Installation List) ─────────────────

      // Switch back to list view for modal entry points
      await clickSidebar('Installs')

      // 7. New Install modal (toolbar button: "+ New Install")
      const newInstallBtn = page.locator('.toolbar button', { hasText: 'New Install' })
      if (await newInstallBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await newInstallBtn.click()
        await page.waitForTimeout(1000)
        await screenshot('07-new-install-modal')
        await page.keyboard.press('Escape')
        await page.waitForTimeout(300)
      }

      // 8. Track Existing modal
      const trackBtn = page.locator('button', { hasText: 'Track Existing' })
      if (await trackBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await trackBtn.click()
        await page.waitForTimeout(1000)
        await screenshot('08-track-modal')
        await page.keyboard.press('Escape')
        await page.waitForTimeout(300)
      }

      // 9. Load Snapshot modal
      const loadSnapshotBtn = page.locator('button', { hasText: 'Load Snapshot' })
      if (await loadSnapshotBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await loadSnapshotBtn.click()
        await page.waitForTimeout(1000)
        await screenshot('09-load-snapshot-modal')
        await page.keyboard.press('Escape')
        await page.waitForTimeout(300)
      }

      // ── Dashboard modal entry points ───────────────────────────

      // Switch to dashboard to capture the Quick Install modal
      await clickSidebar('Dashboard')
      await page.waitForTimeout(300)

      // 10. Quick Install modal (welcome state button: "Install ComfyUI")
      const quickInstallBtn = page.locator('button', { hasText: 'Install ComfyUI' })
      if (await quickInstallBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await quickInstallBtn.click()
        await page.waitForTimeout(1000)
        await screenshot('10-quick-install-modal')
        await page.keyboard.press('Escape')
        await page.waitForTimeout(300)
      }

    } finally {
      await cleanup()
    }
  })
})
