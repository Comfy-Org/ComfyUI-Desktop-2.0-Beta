import { BrowserWindow } from 'electron'
import { SPLASH_PURPLE } from './theme'
import { showSplashPage } from './relaunchPage'
import * as i18n from './i18n'

/** Countdown shown on the update splash before the app quits to install, so the
 *  user has a few seconds to read what's about to happen. Keep in sync with the
 *  updater's `STARTUP_INSTALL_MIN_SPLASH_MS` (the splash is held that long), so
 *  the countdown finishes right as the install begins. */
export const UPDATE_INSTALL_COUNTDOWN_SECONDS = 5

/**
 * "Updating…" window shown while a previously-downloaded Desktop update is
 * applied at startup (see `applyPendingUpdateOnStartup`). It tells the user an
 * update is about to install and runs a short countdown (so they aren't
 * surprised by the restart) while the bounded install check runs; the app quits
 * shortly after and the installer relaunches it. If the install doesn't proceed,
 * the caller destroys this window and opens the normal UI.
 *
 * Self-contained (renders the shared brand splash into its own webContents), so
 * it has no dependency on the host-window / panel renderer wiring that isn't up
 * yet this early in boot.
 */
export function showUpdateInstallSplash(): BrowserWindow {
  const win = new BrowserWindow({
    width: 480,
    height: 400,
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
    desc: i18n.t('launch.updateInstallDesc'),
    countdownSeconds: UPDATE_INSTALL_COUNTDOWN_SECONDS
  })

  return win
}
