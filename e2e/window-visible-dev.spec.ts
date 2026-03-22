import { expect, test } from '@playwright/test'
import { launchLauncherAppDev } from './support/electronHarness'

test.describe('Main window visibility in dev mode (#283)', () => {
  test('main window becomes visible when loaded via ELECTRON_RENDERER_URL @macos @windows @linux', async () => {
    const { application, cleanup } = await launchLauncherAppDev()
    try {
      const mainWindow = await application.firstWindow()

      // The window must become visible even when the renderer is loaded via URL
      // (the code path used by `pnpm dev` / electron-vite dev).
      await expect
        .poll(
          async () => {
            return application.evaluate(({ BrowserWindow }) => {
              const wins = BrowserWindow.getAllWindows()
              return wins.length > 0 && wins[0]!.isVisible()
            })
          },
          {
            message:
              'Main window never became visible in dev mode — reproduces issue #283',
            timeout: 15_000,
            intervals: [500],
          },
        )
        .toBe(true)

      // Sanity: the renderer loaded (the #app mount point exists)
      const appDiv = mainWindow.locator('#app')
      await expect(appDiv).toBeAttached({ timeout: 10_000 })
    } finally {
      await cleanup()
    }
  })
})
