// Dev-only (!app.isPackaged) keyboard shortcuts for driving title-bar pill
// state by eye: Cmd+Alt+U cycles the app-update pill, Cmd+Alt+I toggles the
// install-update override. globalShortcut fires regardless of focused window.
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

// Pure cycle for the app-update pill, exported so unit tests pin the sequence.
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
  // Injected to avoid pulling this module into the main/index.ts import graph.
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
