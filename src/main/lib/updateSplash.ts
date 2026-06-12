import { BrowserWindow } from 'electron'
import { SPLASH_PURPLE } from './theme'
import { showSplashPage } from './relaunchPage'
import * as i18n from './i18n'

/**
 * Brief "Updating…" window shown while a previously-downloaded Desktop update is
 * applied at startup (see `applyPendingUpdateOnStartup`). It exists only so the
 * user isn't staring at an empty screen during the (bounded) install check; the
 * app quits shortly after and the installer relaunches it. If the install
 * doesn't proceed, the caller destroys this window and opens the normal UI.
 *
 * Self-contained (renders the shared brand splash into its own webContents), so
 * it has no dependency on the host-window / panel renderer wiring that isn't up
 * yet this early in boot.
 */
export function showUpdateInstallSplash(): BrowserWindow {
  const win = new BrowserWindow({
    width: 480,
    height: 360,
    frame: false,
    resizable: false,
    center: true,
    show: false,
    backgroundColor: SPLASH_PURPLE.bg,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  })

  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return
    // Show + focus so the splash comes up frontmost like any normal app window
    // (a window spawned this early can otherwise open without taking focus).
    win.show()
    win.focus()
  })

  void showSplashPage(win.webContents, SPLASH_PURPLE, {
    title: i18n.t('launch.updateInstallTitle'),
    desc: i18n.t('launch.updateInstallDesc')
  })

  return win
}
