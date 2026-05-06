import { app, ipcMain, BrowserWindow } from 'electron'
import todesktop from '@todesktop/runtime'
import * as settings from '../settings'
import { clearQuitReason, setQuitReason } from './quit-state'

interface UpdateInfo {
  version: string
}

/**
 * Phase 3 §18 — title-bar status pills consume the current app-update
 * state via `getCurrentUpdateState()` for the initial push (when a
 * title bar mounts after the broadcast already fired) and via the
 * `onUpdateStateChanged` callback for live updates. The two stay in
 * sync because both writes go through `_setUpdateState`, which fans
 * out to every registered callback.
 *
 * `kind` is `'available'` after `update-available`, `'ready'` after
 * `update-downloaded`, and `null` when nothing is pending. `version`
 * carries the corresponding version string. `update-error` does NOT
 * clear the kind — the banner shows the error transiently, but the
 * pill keeps reflecting the last-known state so the user can still
 * act on a previously-discovered update once the error is dismissed.
 *
 * Track B item 2 — `autoUpdate` mirrors the `autoUpdate` setting at
 * the moment the state was committed. Drives pill copy: with
 * auto-updates ON the `'available'` state is suppressed (main
 * triggers the download itself) so the user only ever sees the
 * `'ready'` pill, which reads "Update will apply on restart".
 * With auto-updates OFF the `'available'` pill reads
 * "Update v{version} available" and clicking it surfaces the manual
 * Download action; the subsequent `'ready'` pill keeps the existing
 * "Restart to update" copy since the user opted in.
 */
export interface AppUpdateState {
  kind: 'available' | 'ready' | null
  version: string | null
  autoUpdate: boolean
}

let _updateInfo: UpdateInfo | null = null
let _appUpdateState: AppUpdateState = { kind: null, version: null, autoUpdate: true }
/** Track B item 2 — guard against re-entering the update-available
 *  → runCheck → update-available cycle. todesktop usually dedupes
 *  per-version internally, but the intent here is explicit: we only
 *  programmatically kick off the download once per detected version
 *  even if the periodic auto-check refires the event. Reset on
 *  `update-downloaded` and on `update-error` so a subsequent check
 *  for a NEW version can trigger again. */
let _autoDownloadTriggeredFor: string | null = null
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

/** Track B item 2 — single source of truth for the autoUpdate flag.
 *  Default-on: any non-`false` value (including missing) is treated as
 *  enabled, matching the gate used by the periodic `runIfEnabled` and
 *  the `auto_update` telemetry property. */
function isAutoUpdateEnabled(): boolean {
  return settings.get('autoUpdate') !== false
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

function numberFromPayload(payload: unknown, key: string): number | null {
  const data = asRecord(payload)
  if (!data) return null
  const value = data[key]
  if (typeof value !== 'number' || Number.isNaN(value)) return null
  return value
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
    const autoUpdate = isAutoUpdateEnabled()
    if (autoUpdate) {
      // Track B item 2 — auto-updates ON suppresses the 'available'
      // pill entirely. Main programmatically kicks off the download
      // (via the same runCheck path the user's manual "Download"
      // button uses) and only re-broadcasts when the kind flips to
      // 'ready'. The renderer banner still gets the raw event so the
      // existing notify-on-available channel keeps working for any
      // surface that wants to react during the silent download
      // window — the title-bar pill is the only consumer that
      // intentionally sits this state out.
      broadcast('update-available', { version })
      if (_autoDownloadTriggeredFor !== version) {
        _autoDownloadTriggeredFor = version
        void runCheck('auto-download').catch(() => {})
      }
      return
    }
    _setUpdateState({ kind: 'available', version, autoUpdate: false })
    broadcast('update-available', { version })
  })

  updater.on('download-progress', (progress: unknown) => {
    const percent = numberFromPayload(progress, 'percent')
    const transferredBytes = numberFromPayload(progress, 'transferred')
    const totalBytes = numberFromPayload(progress, 'total')
    if (percent === null || transferredBytes === null || totalBytes === null) return
    broadcast('update-download-progress', {
      percent: Math.round(percent),
      transferred: (transferredBytes / 1048576).toFixed(1),
      total: (totalBytes / 1048576).toFixed(1),
    })
  })

  updater.on('update-downloaded', (event: unknown) => {
    const version = versionFromPayload(event)
    if (!version) return
    _updateInfo = { version }
    _autoDownloadTriggeredFor = null
    _setUpdateState({ kind: 'ready', version, autoUpdate: isAutoUpdateEnabled() })
    broadcast('update-downloaded', _updateInfo)
  })

  updater.on('error', (...args: unknown[]) => {
    clearQuitReason()
    _autoDownloadTriggeredFor = null
    broadcast('update-error', { message: updaterErrorMessage(args) })
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
    try {
      const result = await runCheck('download-button')
      if (!result.available && !_updateInfo) {
        broadcast('update-error', { message: result.error || NO_UPDATE_AVAILABLE_MESSAGE })
      }
    } catch (err) {
      broadcast('update-error', { message: err instanceof Error ? err.message : String(err) })
    }
  })

  ipcMain.handle('install-update', () => {
    const updater = getAutoUpdater()
    if (!updater) {
      broadcast('update-error', { message: UPDATER_UNAVAILABLE_MESSAGE })
      return
    }
    try {
      setQuitReason('update-install')
      updater.restartAndInstall()
    } catch (err) {
      clearQuitReason()
      broadcast('update-error', { message: err instanceof Error ? err.message : String(err) })
    }
  })

  ipcMain.handle('get-pending-update', () => _updateInfo)

  ipcMain.handle('get-update-capabilities', () => {
    const systemManaged = isSystemPackageInstall()
    return { canAutoUpdate: !systemManaged, systemManaged }
  })

  // Check on startup and periodically (respects autoUpdate setting at each check)
  const runIfEnabled = (): void => {
    if (isAutoUpdateEnabled()) runCheck('auto-check').catch(() => {})
  }
  setTimeout(runIfEnabled, 2000)
  setInterval(runIfEnabled, 10 * 60 * 1000)
}
