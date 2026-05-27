/**
 * Shared Electron app launcher for E2E tests.
 *
 * Returns the chooser host wrapped in eval-bridge `WebContentsPage` facades
 * for the panel body and title bar. The parent BrowserWindow has no DOM,
 * so all renderer assertions go through these facades, which run
 * `executeJavaScript` against the underlying WebContentsView's webContents.
 */

import { expect, type ElectronApplication } from '@playwright/test'
import { launchLauncherApp, type SeedOptions } from './support/electronHarness'
import { panelPage, titleBarPage, waitForWebContents, type WebContentsPage } from './support/cdpPages'

/** Poll the main process until both panel.html and comfyTitleBar.html webContents exist. */
async function waitForChooserWebContents(app: ElectronApplication, timeoutMs = 30_000): Promise<void> {
  await expect.poll(
    () => app.evaluate(({ webContents }) => {
      const urls = webContents.getAllWebContents().map((wc) => wc.getURL())
      return {
        hasPanel: urls.some((u) => u.includes('panel.html')),
        hasTitleBar: urls.some((u) => u.includes('comfyTitleBar.html')),
      }
    }).then((s) => s.hasPanel && s.hasTitleBar),
    { timeout: timeoutMs, intervals: [250, 500, 1000] },
  ).toBe(true)
}

export type { SeedOptions, SeedInstallation } from './support/electronHarness'

export interface AppContext {
  app: ElectronApplication
  /** Eval-bridge facade over the chooser host's panel webContents. */
  panel: WebContentsPage
  /** Eval-bridge facade over the chooser host's title-bar webContents. */
  titleBar: WebContentsPage
  cleanup: () => Promise<void>
}

export async function launchApp(options?: SeedOptions): Promise<AppContext> {
  const { application, cleanup: cleanupHarness } = await launchLauncherApp(options)

  // Wait for the chooser host's panel + title-bar webContents to actually
  // exist on the main side BEFORE attempting CDP discovery. The parent
  // BrowserWindow has no DOM; both renderers live in child WebContentsViews
  // that are constructed asynchronously after `whenReady()`.
  await waitForChooserWebContents(application)

  await waitForWebContents(application, 'panel.html')
  await waitForWebContents(application, 'comfyTitleBar.html')

  const panel = panelPage(application)
  const titleBar = titleBarPage(application)

  // Wait for the Vue trees to mount inside each surface. On true cold
  // start (no `firstUseCompleted` seed) the chooser body is gated by
  // the first-use takeover (merged start screen — `.start-hero` is its
  // top-of-hero anchor), so accept either the chooser or the start
  // hero as proof the panel renderer reached an interactive state.
  // Tests that need the chooser explicitly seed the gate.
  await panel.waitForSelector('.panel-shell', { timeout: 30_000 })
  await panel.waitForSelector('.chooser-view, .panel-chooser, .start-hero', { timeout: 15_000 })
  await titleBar.waitForSelector('.title-bar', { timeout: 15_000 })

  return {
    app: application,
    panel,
    titleBar,
    cleanup: cleanupHarness,
  }
}
