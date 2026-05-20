/**
 * Dev-only keyboard shortcuts for driving title-bar pill state without
 * a real updater event or a real install-update probe. Registered only
 * when `!app.isPackaged` (see `index.ts whenReady`).
 *
 * Mirrors the state-mutation helpers `e2eHooks.ts` already wraps for
 * Playwright, but bound to user-facing accelerators so the redesigned
 * pill chrome can be inspected by eye on a running dev build.
 *
 *   - `Ctrl/Cmd+Alt+U` cycles the app-update pill through
 *     `null → available → downloading → ready → null`.
 *   - `Ctrl/Cmd+Alt+I` toggles the install-update override (global) on
 *     and off, then re-broadcasts to every install-backed host so the
 *     pill repaints immediately.
 *
 * Uses `globalShortcut` so the accelerator fires regardless of which
 * window has focus inside the launcher — only registered on dev
 * builds, so the system-wide registration is bounded to developer
 * machines that intentionally run unpackaged.
 */
import { globalShortcut, type WebContentsView } from 'electron'
import {
  _test_setUpdateState,
  getCurrentUpdateState,
  type AppUpdateState,
} from './updater'
import {
  installUpdateOverrides,
  INSTALL_UPDATE_GLOBAL_KEY,
} from './e2eOverrides'
import { comfyWindows, isInstallHost } from '../host/registry'

const APP_UPDATE_ACCELERATOR = 'CommandOrControl+Alt+U'
const INSTALL_UPDATE_ACCELERATOR = 'CommandOrControl+Alt+I'

const DEV_FAKE_VERSION = '99.0.0-dev'

/**
 * Pure cycle for the app-update pill — exported for unit tests so the
 * sequence stays pinned even if the accelerator hookup is refactored.
 * Mirrors the four states `useUpdatePills` knows how to render.
 */
export function cycleAppUpdateState(current: AppUpdateState): AppUpdateState {
  switch (current.kind) {
    case null:
      return { kind: 'available', version: DEV_FAKE_VERSION, autoUpdate: false }
    case 'available':
      return { kind: 'downloading', version: DEV_FAKE_VERSION, autoUpdate: true }
    case 'downloading':
      return { kind: 'ready', version: DEV_FAKE_VERSION, autoUpdate: true }
    case 'ready':
      return { kind: null, version: null, autoUpdate: true }
  }
}

interface DevShortcutsDeps {
  /** Same install-update probe `host/createHostWindow.ts` calls when a
   *  title-bar mounts. Passed in as a dependency to avoid pulling this
   *  module into the `main/index.ts` import graph. */
  computeInstallUpdateAvailable: (
    installationId: string,
  ) => Promise<{ available: boolean; version?: string }>
}

function broadcastInstallUpdateToAllHosts(deps: DevShortcutsDeps): void {
  for (const entry of comfyWindows.values()) {
    if (entry.window.isDestroyed() || !isInstallHost(entry)) continue
    const view: WebContentsView = entry.titleBarView
    if (view.webContents.isDestroyed()) continue
    void deps.computeInstallUpdateAvailable(entry.installationId).then((state) => {
      if (view.webContents.isDestroyed()) return
      view.webContents.send('comfy-titlebar:install-update-changed', state)
    })
  }
}

export function registerDevShortcuts(deps: DevShortcutsDeps): void {
  globalShortcut.register(APP_UPDATE_ACCELERATOR, () => {
    _test_setUpdateState(cycleAppUpdateState(getCurrentUpdateState()))
  })
  globalShortcut.register(INSTALL_UPDATE_ACCELERATOR, () => {
    const wasOn = installUpdateOverrides.has(INSTALL_UPDATE_GLOBAL_KEY)
    if (wasOn) {
      installUpdateOverrides.delete(INSTALL_UPDATE_GLOBAL_KEY)
    } else {
      installUpdateOverrides.set(INSTALL_UPDATE_GLOBAL_KEY, {
        available: true,
        version: DEV_FAKE_VERSION,
      })
    }
    broadcastInstallUpdateToAllHosts(deps)
  })
}

export function unregisterDevShortcuts(): void {
  globalShortcut.unregister(APP_UPDATE_ACCELERATOR)
  globalShortcut.unregister(INSTALL_UPDATE_ACCELERATOR)
}
