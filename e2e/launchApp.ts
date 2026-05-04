/**
 * Shared Electron app launcher for E2E navigation tests.
 *
 * Builds on the existing electronHarness (isolated temp home dir).
 * Waits for the Vue app to fully mount before returning.
 *
 * Usage:
 *   import { launchApp, type AppContext } from './launchApp'
 *
 *   let ctx: AppContext
 *   test.beforeAll(async () => { ctx = await launchApp() })
 *   test.afterAll(async () => { await ctx.cleanup() })
 */

import type { ElectronApplication, Page } from '@playwright/test'
import { launchLauncherApp, type SeedOptions } from './support/electronHarness'

export type { SeedOptions, SeedInstallation } from './support/electronHarness'

export interface AppContext {
  app: ElectronApplication
  page: Page
  /** CDP remote-debugging port for connecting to WebContentsView targets. */
  cdpPort: number
  cleanup: () => Promise<void>
}

export async function launchApp(options?: SeedOptions): Promise<AppContext> {
  const { application, cdpPort, cleanup } = await launchLauncherApp(options)

  const page = await application.firstWindow()

  // Wait for the Vue app to mount — the sidebar brand text is a reliable marker
  await page.waitForSelector('.sidebar-brand', { timeout: 30_000 })

  // If installations were seeded after launch, the renderer needs to
  // re-fetch the list. Navigate to the Installs tab to trigger a refresh.
  if (options?.installations && options.installations.length > 0) {
    await page.locator('.sidebar-item', { hasText: 'Installs' }).click()
    // Wait for the seeded card to appear
    await page.waitForSelector('.instance-card', { timeout: 10_000 })
    // Return to dashboard
    await page.locator('.sidebar-item', { hasText: 'Dashboard' }).click()
  }

  return { app: application, page, cdpPort, cleanup }
}
