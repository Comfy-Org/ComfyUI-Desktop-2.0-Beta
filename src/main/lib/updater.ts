import { app, ipcMain } from 'electron'
import todesktop from '@todesktop/runtime'
import * as settings from '../settings'
import { clearQuitReason, setQuitReason } from './quit-state'
import { _broadcastToRenderer } from './ipc/shared'
import { emit as emitTelemetry, bucketError } from './telemetry'

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
  kind: 'available' | 'downloading' | 'ready' | null
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
/** Telemetry dedup per `(event-name × version)` per process. The
 *  todesktop / electron-updater state machine re-fires `update-available`
 *  and `update-downloaded` on every periodic check that finds a staged
 *  build, and our own `update-available` handler used to call
 *  `runCheck('auto-download')` re-entrantly — together they produced
 *  ~3M+ of each event in 24h across ~27 users (the volume incident
 *  this dedup was introduced for). One emit per version covers every
 *  analytical question (did this user see version X become available?
 *  did the download finish?) without per-cycle re-emit. */
const _appUpdateEmittedOnce: Map<string, Set<string>> = new Map()
function _shouldEmitAppUpdateOnce(event: string, version: string | null): boolean {
  if (!version) return true
  let seen = _appUpdateEmittedOnce.get(event)
  if (!seen) {
    seen = new Set()
    _appUpdateEmittedOnce.set(event, seen)
  }
  if (seen.has(version)) return false
  seen.add(version)
  return true
}
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
  // Broadcast to renderer surfaces (panel views) so the Global
  // Settings update-action panel can mirror the title-bar pill state
  // without a separate poll. Title-bar webContents pick the state up
  // via the dedicated `comfy-titlebar:app-update-state-changed`
  // channel routed through `_stateChangeCallbacks`.
  _broadcastToRenderer('app-update:state-changed', next)
}

const NO_UPDATE_AVAILABLE_MESSAGE = 'No update available. Try checking for updates first.'
const UPDATER_UNAVAILABLE_MESSAGE = 'ToDesktop auto-updater is unavailable.'

/** Issue #488 — single source of truth for the auto-install flag.
 *  Default-on: any non-`false` value (including missing) is treated as
 *  enabled. Reads the `autoInstallUpdates` key — auto-checks always
 *  run, and only the install behavior is user-controllable. The
 *  `AppUpdateState.autoUpdate` field name is kept for the renderer
 *  payload and mirrors this flag. */
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
    if (_shouldEmitAppUpdateOnce('comfy.desktop.app_update.available', version)) {
      emitTelemetry('comfy.desktop.app_update.available', {
        version,
        auto_update_setting: autoInstall ? 'on' : 'off'
      })
    }
    if (autoInstall) {
      // Auto-install ON suppresses the 'available' pill entirely.
      // electron-updater's default `autoDownload: true` already starts
      // the download in the background; we only need to mark the
      // intent for telemetry and let the natural `update-downloaded`
      // event finish the cycle. A previous version called
      // `runCheck('auto-download')` here to "kick" the download — that
      // re-entrant check fired its own `update-available` /
      // `update-downloaded` events and turned what should have been a
      // single transition into a per-cycle telemetry storm. The dedup
      // guard above defends against any residual re-emit even if the
      // underlying updater fires the event multiple times per version.
      if (_autoDownloadTriggeredFor !== version) {
        _autoDownloadTriggeredFor = version
        if (_shouldEmitAppUpdateOnce('comfy.desktop.app_update.download_started', version)) {
          emitTelemetry('comfy.desktop.app_update.download_started', { version, initiator: 'auto' })
        }
      }
      return
    }
    _setUpdateState({ kind: 'available', version, autoUpdate: false })
  })

  updater.on('update-downloaded', (event: unknown) => {
    const version = versionFromPayload(event)
    if (!version) return
    _autoDownloadTriggeredFor = null
    if (_shouldEmitAppUpdateOnce('comfy.desktop.app_update.download_complete', version)) {
      emitTelemetry('comfy.desktop.app_update.download_complete', { version })
    }
    _setUpdateState({ kind: 'ready', version, autoUpdate: isAutoInstallEnabled() })
    if (_userInitiatedDownload) {
      // The user opted in to download via the auto-off available pill
      // modal. Push the restart prompt automatically so the flow ends
      // on a single user gesture (Download → wait → Restart) instead
      // of forcing them to find the pill again.
      _userInitiatedDownload = false
      _broadcastToRenderer('app-update:prompt-restart', { version })
    }
  })

  updater.on('error', (...args: unknown[]) => {
    const wasUserInitiated = _userInitiatedDownload
    // Three buckets so dashboards can route by failure mode:
    //   - `install`: Squirrel / restartAndInstall failed AFTER a
    //     successful download (kind === 'ready'). Usually filesystem
    //     permissions / antivirus / OS code-signing.
    //   - `download`: failed mid-download OR a user-initiated download
    //     attempt failed before the first progress tick (state still
    //     reads `'available'`, but the user's intent was clearly
    //     "download"). Usually network / disk.
    //   - `check`: failed before any download step. Usually network /
    //     GitHub release feed.
    const stage: 'install' | 'download' | 'check' =
      _appUpdateState.kind === 'ready'
        ? 'install'
        : _appUpdateState.kind === 'downloading' || _autoDownloadTriggeredFor || wasUserInitiated
          ? 'download'
          : 'check'
    emitTelemetry('comfy.desktop.app_update.error', {
      stage,
      error_bucket: bucketError(updaterErrorMessage(args)),
      user_initiated: wasUserInitiated
    })
    clearQuitReason()
    _autoDownloadTriggeredFor = null
    _userInitiatedDownload = false
    // Roll a `'downloading'` state back to `'available'` so the
    // pill/panel offer "Download" again and the user can retry.
    if (_appUpdateState.kind === 'downloading') {
      _setUpdateState({
        kind: 'available',
        version: _appUpdateState.version,
        autoUpdate: _appUpdateState.autoUpdate
      })
    }
    if (wasUserInitiated) {
      // Only surface failures the user is actively waiting on.
      // Background auto-on download errors stay silent — the user
      // hasn't asked for anything and bothering them with a modal
      // for a transient network blip would be noisy.
      _broadcastToRenderer('app-update:user-action-failed', { message: updaterErrorMessage(args) })
    }
  })

  // Forward electron-updater's `download-progress` ticks to renderer
  // surfaces (title-bar pill + Global Settings update panel) so the
  // user has feedback during the download instead of staring at a
  // static "Download" affordance. The payload shape is
  // electron-updater's `ProgressInfo` — we narrow it to the fields
  // the UI actually uses.
  //
  // The first tick of a user-initiated download also flips the cached
  // app-update state from `'available'` → `'downloading'`, so the
  // title-bar pill and the Settings panel both swap their CTAs and
  // share a single source of truth (clicking the pill now routes to
  // Settings instead of re-opening the Download confirm modal).
  // Auto-on background downloads stay silent (state stays `null`)
  // until `update-downloaded` flips to `'ready'`, preserving the
  // existing zero-noise auto-install UX.
  updater.on('download-progress', (info: unknown) => {
    const p = asRecord(info)
    if (!p) return
    const percent = typeof p.percent === 'number' ? p.percent : null
    const transferred = typeof p.transferred === 'number' ? p.transferred : null
    const total = typeof p.total === 'number' ? p.total : null
    const bytesPerSecond = typeof p.bytesPerSecond === 'number' ? p.bytesPerSecond : null
    if (
      _userInitiatedDownload &&
      _appUpdateState.kind !== 'downloading' &&
      _appUpdateState.kind !== 'ready'
    ) {
      _setUpdateState({
        kind: 'downloading',
        version: _appUpdateState.version,
        autoUpdate: _appUpdateState.autoUpdate
      })
    }
    _broadcastToRenderer('app-update:download-progress', {
      percent,
      transferred,
      total,
      bytesPerSecond
    })
  })
}

/** Triggers that originate from explicit user intent (the title-bar
 *  "Check for Updates" menu and the auto-off available-pill confirm
 *  modal). Background triggers (`auto-check` every 10 min, plus any
 *  app-open / dashboard-revisit / IPP-click code path that quietly
 *  re-runs a check) are implementation details and would otherwise
 *  fire on every periodic interval without carrying analytical
 *  signal, so `comfy.desktop.app_update.checked` only emits for the
 *  user-initiated set. Per-version dedup also applies — a user
 *  mashing the menu item while a download is staged still produces
 *  one event per version. The `up_to_date` result is intentionally
 *  not emitted at all: every analytical question that needs the
 *  denominator can use `session.started` instead. */
const USER_INITIATED_CHECK_TRIGGERS = new Set(['manual-check', 'download-button'])

async function checkForUpdate(
  source: string
): Promise<{ available: boolean; version?: string; error?: string }> {
  const updater = getAutoUpdater()
  if (!updater) {
    if (USER_INITIATED_CHECK_TRIGGERS.has(source)) {
      emitTelemetry('comfy.desktop.app_update.checked', {
        trigger: source,
        result: 'updater_unavailable'
      })
    }
    return { available: false, error: UPDATER_UNAVAILABLE_MESSAGE }
  }
  bindUpdaterEvents()
  const result = await updater.checkForUpdates({
    source,
    disableUpdateReadyAction: true
  })
  const version = versionFromPayload(result)
  if (
    version &&
    USER_INITIATED_CHECK_TRIGGERS.has(source) &&
    _shouldEmitAppUpdateOnce('comfy.desktop.app_update.checked', version)
  ) {
    emitTelemetry('comfy.desktop.app_update.checked', { trigger: source, result: 'available' })
  }
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
  source: string
): Promise<{ available: boolean; version?: string; error?: string }> {
  return checkForUpdate(source)
}

/**
 * Current app-update state for the title-bar status pill. Returned by
 * reference for cheapness; callers must not mutate.
 * Title-bar webContents that mount AFTER an `update-available` /
 * `update-downloaded` broadcast still need the latest state to render
 * their pill, so main pushes this on `comfy-titlebar:title-bar-ready`
 * via `comfy-titlebar:app-update-state-changed`.
 */
export function getCurrentUpdateState(): AppUpdateState {
  return _appUpdateState
}

/**
 * Subscribe to app-update state transitions. Main
 * registers once at startup and forwards each call to every host
 * window's title-bar webContents. Returns an unsubscribe function.
 *
 * Skipped over a renderer-side relay (renderer → main → all-renderers
 * → title-bar) because the _broadcastToRenderer() helper already reaches the
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

/**
 * User-initiated download of the pending update. Marks the next
 * `update-downloaded` as user-initiated so the updater module fires
 * the auto restart-prompt event; the flag is cleared on download
 * completion or on error so a subsequent background auto-on download
 * doesn't re-trigger the prompt. Failures broadcast
 * `app-update:user-action-failed` so the UI can surface them.
 *
 * Exported so both the renderer-facing `download-update` IPC handler
 * and main-process callers (e.g. the system-modal "Download" confirm)
 * share a single implementation.
 */
export async function downloadUpdate(): Promise<void> {
  _userInitiatedDownload = true
  emitTelemetry('comfy.desktop.app_update.download_started', {
    version: _appUpdateState.version,
    initiator: 'user'
  })
  try {
    const result = await runCheck('download-button')
    if (!result.available && _appUpdateState.kind !== 'ready') {
      _userInitiatedDownload = false
      _broadcastToRenderer('app-update:user-action-failed', {
        message: result.error || NO_UPDATE_AVAILABLE_MESSAGE
      })
    }
  } catch (err) {
    _userInitiatedDownload = false
    _broadcastToRenderer('app-update:user-action-failed', {
      message: err instanceof Error ? err.message : String(err)
    })
  }
}

/**
 * Apply the pending downloaded update by restarting the app under the
 * silent installer. Failures broadcast `app-update:user-action-failed`
 * so the UI can surface them. Exported so both the renderer-facing
 * `install-update` IPC handler and main-process callers (e.g. the
 * system-modal "Restart" confirm) share a single implementation.
 */
export function installUpdate(): void {
  const updater = getAutoUpdater()
  if (!updater) {
    _broadcastToRenderer('app-update:user-action-failed', { message: UPDATER_UNAVAILABLE_MESSAGE })
    return
  }
  emitTelemetry('comfy.desktop.app_update.install_triggered', {
    version: _appUpdateState.version,
    auto_update_setting: isAutoInstallEnabled() ? 'on' : 'off'
  })
  try {
    setQuitReason('update-install')
    updater.restartAndInstall({ isSilent: true })
  } catch (err) {
    clearQuitReason()
    _broadcastToRenderer('app-update:user-action-failed', {
      message: err instanceof Error ? err.message : String(err)
    })
  }
}

/**
 * Test-only: push an arbitrary `AppUpdateState` through the same
 * `_setUpdateState` path the real updater uses, so every subscribed
 * surface (title-bar pills, Global Settings panel) repaints exactly
 * as it would for a real `update-available` / `update-downloaded`
 * event. Only called from `e2eHooks.ts` which is itself only loaded
 * when `process.env['E2E'] === '1'`.
 */
export function _test_setUpdateState(next: AppUpdateState): void {
  _setUpdateState(next)
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
    await downloadUpdate()
  })

  ipcMain.handle('install-update', () => {
    installUpdate()
  })

  ipcMain.handle('get-update-capabilities', () => {
    const systemManaged = isSystemPackageInstall()
    return { canAutoUpdate: !systemManaged, systemManaged }
  })

  // Snapshot of the cached app-update state for renderer surfaces
  // (Global Settings) that mount AFTER an `update-available` /
  // `update-downloaded` broadcast has already fired. Live updates
  // arrive via the `app-update:state-changed` event.
  ipcMain.handle('get-app-update-state', () => getCurrentUpdateState())

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
