import { app, ipcMain, BrowserWindow } from 'electron'
import todesktop from '@todesktop/runtime'
import * as settings from '../settings'
import { clearQuitReason, setQuitReason } from './quit-state'

/**
 * Title-bar status pills consume the current app-update state via
 * `getCurrentUpdateState()` for the initial push (when a title bar
 * mounts after the broadcast already fired) and via the
 * `onUpdateStateChanged` callback for live updates. The two stay in
 * sync because both writes go through `_setUpdateState`, which fans
 * out to every registered callback.
 *
 * `kind` is `'available'` after `update-available`, `'ready'` after
 * `update-downloaded`, and `null` when nothing is pending. `version`
 * carries the corresponding version string. `update-error` does NOT
 * clear the kind — the pill keeps reflecting the last-known state so
 * the user can still act on a previously-discovered update.
 *
 * `autoUpdate` mirrors the `autoUpdate` setting at the moment the
 * state was committed. With auto-updates ON the `'available'` state
 * is suppressed (main triggers the download itself) so the user only
 * ever sees the `'ready'` pill ("Desktop Update Ready"). With
 * auto-updates OFF the `'available'` pill ("Desktop Update Available")
 * surfaces a confirm-modal that runs the download.
 */
export interface AppUpdateState {
  kind: 'available' | 'ready' | null
  version: string | null
  autoUpdate: boolean
}

let _appUpdateState: AppUpdateState = { kind: null, version: null, autoUpdate: true }
/** Guard against re-entering the update-available → runCheck →
 *  update-available cycle. todesktop usually dedupes per-version
 *  internally, but the intent here is explicit: we only programmatically
 *  kick off the download once per detected version even if the periodic
 *  auto-check refires the event. Reset on `update-downloaded` and on
 *  `update-error` so a subsequent check for a NEW version can trigger
 *  again. */
let _autoDownloadTriggeredFor: string | null = null
/** True when the most recent download was started by an explicit user
 *  action (the auto-off "Desktop Update Available" pill confirm-modal).
 *  Drives the post-download "restart now?" prompt: when the user opted
 *  in to download, surface the restart prompt automatically once the
 *  download finishes. With auto-updates ON the download is silent and
 *  this stays false. Cleared on `update-downloaded` (after broadcasting
 *  the prompt) and on `update-error`. */
let _userInitiatedDownload = false
const _stateChangeCallbacks = new Set<(state: AppUpdateState) => void>()
let _listenersBound = false

function _setUpdateState(next: AppUpdateState): void {
  _appUpdateState = next
  for (const cb of _stateChangeCallbacks) {
    try {
      cb(next)
    } catch {}
  }
}

const NO_UPDATE_AVAILABLE_MESSAGE = 'No update available. Try checking for updates first.'
const UPDATER_UNAVAILABLE_MESSAGE = 'ToDesktop auto-updater is unavailable.'

/** Issue #488 — single source of truth for the auto-install flag.
 *  Default-on: any non-`false` value (including missing) is treated as
 *  enabled. Reads the new `autoInstallUpdates` key (the legacy
 *  `autoUpdate` setting was retired from the UI in #488 — auto-checks
 *  always run now and only the install behavior is user-controllable).
 *  The `AppUpdateState.autoUpdate` field name is kept for the renderer
 *  payload so callers don't have to churn — it now mirrors this flag. */
function isAutoInstallEnabled(): boolean {
  return settings.get('autoInstallUpdates') !== false
}

/**
 * Re-broadcast the cached `_appUpdateState` with a refreshed
 * `autoUpdate` flag. Settings handler calls this when the user toggles
 * the autoUpdate preference so a pending `'ready'` state immediately
 * starts reading as auto-on / auto-off (drives the title-bar pill copy
 * and the click-modal flow without having to wait for the next
 * update-check broadcast). No-op when there's no cached state.
 */
export function notifyAutoUpdateChanged(): void {
  if (_appUpdateState.kind === null) return
  const refreshed = isAutoInstallEnabled()
  if (_appUpdateState.autoUpdate === refreshed) return
  _setUpdateState({ ..._appUpdateState, autoUpdate: refreshed })
}

function isSystemPackageInstall(): boolean {
  if (process.platform !== 'linux' || !app.isPackaged) return false
  if (process.env.APPIMAGE) return false
  // .deb installs place the app under /opt/ or /usr/; check the executable path
  const appPath = app.getPath('exe')
  return appPath.startsWith('/opt/') || appPath.startsWith('/usr/')
}

function broadcast(channel: string, data: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    try {
      if (!win.isDestroyed()) win.webContents.send(channel, data)
    } catch {}
  })
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function versionFromPayload(payload: unknown): string | null {
  const topLevel = asRecord(payload)
  if (!topLevel) return null
  const direct = topLevel.version
  if (typeof direct === 'string' && direct) return direct
  const nested = asRecord(topLevel.updateInfo)
  if (!nested) return null
  const nestedVersion = nested.version
  if (typeof nestedVersion === 'string' && nestedVersion) return nestedVersion
  return null
}

function updaterErrorMessage(args: unknown[]): string {
  for (const arg of args) {
    if (arg instanceof Error && arg.message) return arg.message
  }
  for (const arg of args) {
    if (typeof arg === 'string' && arg.trim()) return arg
  }
  return 'Update check failed.'
}

function getAutoUpdater() {
  return todesktop.autoUpdater
}

function bindUpdaterEvents(): void {
  if (_listenersBound) return
  const updater = getAutoUpdater()
  if (!updater) return
  _listenersBound = true

  updater.on('update-available', (info: unknown) => {
    const version = versionFromPayload(info)
    if (!version) return
    const autoInstall = isAutoInstallEnabled()
    if (autoInstall) {
      // Auto-install ON suppresses the 'available' pill entirely.
      // Main programmatically kicks off the download in the
      // background; only the subsequent 'ready' state surfaces
      // ("Desktop Update Ready"). The download is silent — no user
      // action required, and the install is silent on next quit.
      if (_autoDownloadTriggeredFor !== version) {
        _autoDownloadTriggeredFor = version
        void runCheck('auto-download').catch(() => {})
      }
      return
    }
    _setUpdateState({ kind: 'available', version, autoUpdate: false })
  })

  updater.on('update-downloaded', (event: unknown) => {
    const version = versionFromPayload(event)
    if (!version) return
    _autoDownloadTriggeredFor = null
    _setUpdateState({ kind: 'ready', version, autoUpdate: isAutoInstallEnabled() })
    if (_userInitiatedDownload) {
      // The user opted in to download via the auto-off available pill
      // modal. Push the restart prompt automatically so the flow ends
      // on a single user gesture (Download → wait → Restart) instead
      // of forcing them to find the pill again.
      _userInitiatedDownload = false
      broadcast('app-update:prompt-restart', { version })
    }
  })

  updater.on('error', (...args: unknown[]) => {
    const wasUserInitiated = _userInitiatedDownload
    clearQuitReason()
    _autoDownloadTriggeredFor = null
    _userInitiatedDownload = false
    if (wasUserInitiated) {
      // Only surface failures the user is actively waiting on.
      // Background auto-on download errors stay silent — the user
      // hasn't asked for anything and bothering them with a modal
      // for a transient network blip would be noisy.
      broadcast('app-update:user-action-failed', { message: updaterErrorMessage(args) })
    }
  })
}

async function checkForUpdate(source: string): Promise<{ available: boolean; version?: string; error?: string }> {
  const updater = getAutoUpdater()
  if (!updater) {
    return { available: false, error: UPDATER_UNAVAILABLE_MESSAGE }
  }
  bindUpdaterEvents()
  const result = await updater.checkForUpdates({
    source,
    disableUpdateReadyAction: true,
  })
  const version = versionFromPayload(result)
  return version ? { available: true, version } : { available: false }
}

/**
 * Run an update check and return the result. Exported so callers in
 * main (e.g. the title-bar "Check for Updates" entry routed through
 * `comfy-window:check-for-updates`) can trigger a check without going
 * through the renderer-facing `check-for-update` IPC. Result also flows
 * through the broadcast pipeline (`update-available` / `update-error`)
 * so any subscribed renderer surface still updates.
 */
export function runCheck(
  source: string,
): Promise<{ available: boolean; version?: string; error?: string }> {
  return checkForUpdate(source)
}

/**
 * Phase 3 §18 — current app-update state for the title-bar status
 * pill. Returned by reference for cheapness; callers must not mutate.
 * Title-bar webContents that mount AFTER an `update-available` /
 * `update-downloaded` broadcast still need the latest state to render
 * their pill, so main pushes this on `comfy-titlebar:title-bar-ready`
 * via `comfy-titlebar:app-update-state-changed`.
 */
export function getCurrentUpdateState(): AppUpdateState {
  return _appUpdateState
}

/**
 * Phase 3 §18 — subscribe to app-update state transitions. Main
 * registers once at startup and forwards each call to every host
 * window's title-bar webContents. Returns an unsubscribe function.
 *
 * Skipped over a renderer-side relay (renderer → main → all-renderers
 * → title-bar) because the broadcast() helper already reaches the
 * title-bar webContents via BrowserWindow.getAllWindows; the title-bar
 * preload just doesn't expose those raw events. Forwarding through
 * `comfy-titlebar:app-update-state-changed` keeps the pill data path
 * separate from the banner data path so the two surfaces can evolve
 * independently.
 */
export function onUpdateStateChanged(cb: (state: AppUpdateState) => void): () => void {
  _stateChangeCallbacks.add(cb)
  return () => {
    _stateChangeCallbacks.delete(cb)
  }
}

export function register(): void {
  bindUpdaterEvents()

  ipcMain.handle('check-for-update', async () => {
    try {
      return await runCheck('manual-check')
    } catch (err) {
      return { available: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('download-update', async () => {
    // Marks the next `update-downloaded` as user-initiated so the
    // updater module fires the auto restart-prompt event. The flag is
    // cleared on download completion or on error so a subsequent
    // background auto-on download doesn't re-trigger the prompt.
    _userInitiatedDownload = true
    try {
      const result = await runCheck('download-button')
      if (!result.available && _appUpdateState.kind !== 'ready') {
        _userInitiatedDownload = false
        broadcast('app-update:user-action-failed', { message: result.error || NO_UPDATE_AVAILABLE_MESSAGE })
      }
    } catch (err) {
      _userInitiatedDownload = false
      broadcast('app-update:user-action-failed', { message: err instanceof Error ? err.message : String(err) })
    }
  })

  ipcMain.handle('install-update', () => {
    const updater = getAutoUpdater()
    if (!updater) {
      broadcast('app-update:user-action-failed', { message: UPDATER_UNAVAILABLE_MESSAGE })
      return
    }
    try {
      setQuitReason('update-install')
      updater.restartAndInstall({ isSilent: true })
    } catch (err) {
      clearQuitReason()
      broadcast('app-update:user-action-failed', { message: err instanceof Error ? err.message : String(err) })
    }
  })

  ipcMain.handle('get-update-capabilities', () => {
    const systemManaged = isSystemPackageInstall()
    return { canAutoUpdate: !systemManaged, systemManaged }
  })

  // Issue #488 — always check on startup and periodically. The
  // user-controllable `autoInstallUpdates` setting only gates whether
  // a discovered update silently downloads + installs vs prompts the
  // user; the check loop itself is no longer user-disablable.
  const runAutoCheck = (): void => {
    runCheck('auto-check').catch(() => {})
  }
  setTimeout(runAutoCheck, 2000)
  setInterval(runAutoCheck, 10 * 60 * 1000)
}
