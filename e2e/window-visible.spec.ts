import { expect, test } from '@playwright/test'
import { launchLauncherApp } from './support/electronHarness'
import { panelPage, waitForWebContents } from './support/cdpPages'

test.describe('Main window visibility (#283)', () => {
  test('main window becomes visible after launch @macos @windows @linux', async () => {
    const { application, cleanup } = await launchLauncherApp()
    try {
      // The host window starts with show:false and transitions via ready-to-show.
      await expect.poll(
        async () => application.evaluate(({ BrowserWindow }) => {
          const wins = BrowserWindow.getAllWindows()
          return wins.length > 0 && wins[0]!.isVisible()
        }),
        {
          message: 'Main window never became visible — reproduces issue #283',
          timeout: 15_000,
          intervals: [500],
        },
      ).toBe(true)

      const bounds = await application.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        return win?.getBounds()
      })
      expect(bounds).toBeDefined()
      expect(bounds!.width).toBeGreaterThan(0)
      expect(bounds!.height).toBeGreaterThan(0)

      // The chooser host's panel WebContentsView mounts the Vue app at
      // `.panel-shell`. We assert via the eval bridge because the parent
      // BrowserWindow's webContents has no DOM (it only hosts children).
      await waitForWebContents(application, 'panel.html', 15_000)
      const panel = panelPage(application)
      await panel.waitForSelector('.panel-shell', { timeout: 10_000 })
    } finally {
      await cleanup()
    }
  })
})
