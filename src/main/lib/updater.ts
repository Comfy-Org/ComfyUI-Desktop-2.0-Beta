import { app, ipcMain } from 'electron'
import todesktop from '@todesktop/runtime'
import { autoUpdater as electronAutoUpdater } from 'electron-updater'
import * as settings from '../settings'
import { clearQuitReason, isSessionEnding, setQuitReason } from './quit-state'
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

/**
 * Local, static feature gate for applying a staged update at the next launch
 * (the "startup install" path) instead of letting electron-updater install it
 * on quit.
 *
 * Windows-only. The install corruption this guards against is specific to
 * electron-updater's NSIS install-on-quit, which spawns a detached installer the
 * OS can kill mid-write during a shutdown. macOS (Squirrel.Mac / ShipIt — a
 * launchd-supervised, resumable helper) and Linux don't have that failure mode,
 * so applying updates at startup there would only add risk to a working update
 * channel. On those platforms this always returns false.
 *
 * Default OFF even on Windows. With it off, the app keeps the normal
 * install-on-quit behavior; the `session-end` guard (`suppressInstallOnQuit`)
 * only suppresses that install while the OS is shutting down. With it on,
 * install-on-quit is disabled entirely and the staged update applies on the next
 * boot.
 *
 * Not a remote flag yet — flip it via the hidden `installUpdatesOnStartup`
 * setting (edited by hand in settings.json), so the startup-install path can be
 * canaried before any wider rollout.
 */
function isStartupInstallEnabled(): boolean {
  if (process.platform !== 'win32') return false
  return settings.get('installUpdatesOnStartup') === true
}

/**
 * Local, static gate for showing the NSIS installer's own progress window during
 * an update (`isSilent: false`) instead of installing fully silently.
 *
 * Windows-only — `isSilent` is an NSIS flag with no effect on the macOS
 * (Squirrel) / Linux update paths. On an update the assisted installer skips the
 * welcome/license/directory pages (electron-builder's `skipPageIfUpdated`) and
 * our `customFinishPage` auto-launches the app + aborts the finish page, so the
 * user sees only a progress window with no clicks required. This gives
 * continuous visual feedback during the actual file copy — which our Electron
 * "Updating…" splash can't, since the copy runs after the app has quit.
 *
 * Default OFF. Not remote yet — flip the hidden `showInstallerUI` setting by
 * hand in settings.json to canary it.
 */
function isInstallerUIEnabled(): boolean {
  if (process.platform !== 'win32') return false
  return settings.get('showInstallerUI') === true
}

/**
 * Disable electron-updater's install-on-quit. Called when the OS signals the
 * session is ending (Windows shutdown / restart / logoff) so the quit handler
 * electron-updater registers after a download won't spawn the installer while
 * the OS tears everything down — that mid-write kill is the corruption mode
 * behind the "reinstall on every shutdown" loop. The quit handler re-reads this
 * flag at quit time, so flipping it here is enough. Safe to call in any mode (a
 * no-op when the startup-install path already disabled it at register time).
 */
export function suppressInstallOnQuit(): void {
  try {
    electronAutoUpdater.autoInstallOnAppQuit = false
  } catch {}
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
    // Persist that an installer is staged on disk. electron-updater caches the
    // download across restarts; this marker lets the startup-install path (when
    // enabled) apply it on the next boot. Harmless in the default on-quit mode —
    // it's just a record that a download finished and is cleared once the staged
    // version is the one running.
    try {
      settings.set('pendingDownloadedUpdateVersion', version)
    } catch {}
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
  if (isSessionEnding()) {
    // The OS is shutting down / logging off. Spawning the installer now risks
    // it being force-killed mid-write, corrupting the install — the exact
    // failure this whole flow exists to avoid. The staged update stays put and
    // applies on the next launch instead.
    return
  }
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
    // macOS Squirrel quirk: if requestSingleInstanceLock is still held by
    // the quitting process, ShipIt swaps the .app bundle correctly but
    // the new Squirrel.Mac process cannot acquire the lock and exits
    // silently — the user sees the app close and nothing relaunches.
    // Electron's own docs call this out: quitAndInstall + single-instance
    // lock is a known footgun on darwin. Releasing the lock immediately
    // before restartAndInstall lets the next process come up cleanly.
    // Windows / Linux update paths don't have this contention and don't
    // need the release.
    if (process.platform === 'darwin') {
      app.releaseSingleInstanceLock()
    }
    // `isSilent: false` shows the NSIS progress window during the install (see
    // `isInstallerUIEnabled` — Windows-only, gated, default off). Off everywhere
    // else, so the macOS/Linux paths and the default Windows path stay silent.
    updater.restartAndInstall({ isSilent: !isInstallerUIEnabled() })
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

/** Upper bound on how long the startup-install check may delay boot. The
 *  installer was already downloaded in a previous session, so this only
 *  re-validates the cached file against the release feed (no re-download); the
 *  cap keeps a slow / offline network from ever hanging the launch. */
const STARTUP_UPDATE_CHECK_TIMEOUT_MS = 5000

/** Minimum time the "Updating…" splash stays up before the install quits the
 *  app. The bounded check above usually resolves near-instantly (the installer
 *  was already downloaded and cached), which would otherwise flash the splash
 *  for a fraction of a second before the app quits — feeling like a glitch
 *  rather than an intentional update. This floor (measured from when the splash
 *  was shown, so the check's own elapsed time counts toward it) keeps the splash
 *  up long enough for the user to read it and watch the countdown finish. Keep
 *  in sync with `UPDATE_INSTALL_COUNTDOWN_SECONDS` (updateSplash.ts), the
 *  countdown the splash shows over this window. Only applies when a splash is
 *  actually up (startup-install path). */
const STARTUP_INSTALL_MIN_SPLASH_MS = 5000

/** Why a startup install was or wasn't attempted. The skip reasons that carry
 *  canary signal (`loop_breaker`, `session_ending`, `not_ready`) are reported via
 *  `comfy.desktop.app_update.startup_install_skipped`; the rest are normal boots
 *  and stay silent. */
type StartupInstallDecision =
  | { attempt: true; version: string }
  | {
      attempt: false
      reason: 'disabled' | 'e2e' | 'system_managed' | 'session_ending' | 'no_pending' | 'loop_breaker'
    }

/**
 * Decide whether to install a staged Desktop update on this launch. Cheap and
 * synchronous (reads only persisted markers + environment).
 *
 * Returns a skip for: the startup-install gate being off (the default — installs
 * still happen on quit), E2E runs, system-package-managed installs (apt/dnf own
 * the update), an OS session that's already ending, no staged download (or one
 * that's already the running version), and the loop-breaker case (we already
 * auto-attempted this exact version and are still on the old one).
 */
function evaluateStartupInstall(): StartupInstallDecision {
  if (!isStartupInstallEnabled()) return { attempt: false, reason: 'disabled' }
  if (process.env['E2E'] === '1') return { attempt: false, reason: 'e2e' }
  if (isSystemPackageInstall()) return { attempt: false, reason: 'system_managed' }
  if (isSessionEnding()) return { attempt: false, reason: 'session_ending' }
  const pending = settings.get('pendingDownloadedUpdateVersion')
  if (!pending || pending === app.getVersion()) return { attempt: false, reason: 'no_pending' }
  const lastAttempt = settings.get('lastStartupUpdateAttemptVersion')
  if (lastAttempt === pending) return { attempt: false, reason: 'loop_breaker' }
  return { attempt: true, version: pending }
}

/**
 * True when there is a staged Desktop update we should try to install on this
 * launch. Lets callers decide whether to show an "Updating…" splash before the
 * bounded `applyPendingUpdateOnStartup` check runs.
 */
export function hasPendingStartupUpdate(): boolean {
  return evaluateStartupInstall().attempt
}

/**
 * Kick off a startup update check and resolve once the update reaches the
 * `'ready'` state or the deadline passes. Don't rely on `runCheck` resolving to
 * imply readiness — the `'ready'` transition happens in the `update-downloaded`
 * handler, which (depending on the updater) can fire slightly after the check
 * promise settles. Subscribing first closes that race.
 */
function waitForReadyState(timeoutMs: number): Promise<void> {
  if (getCurrentUpdateState().kind === 'ready') return Promise.resolve()
  return new Promise<void>((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      unsub()
      clearTimeout(timer)
      resolve()
    }
    const unsub = onUpdateStateChanged((s) => {
      if (s.kind === 'ready') finish()
    })
    const timer = setTimeout(finish, timeoutMs)
    runCheck('startup-install')
      .then(() => {
        if (getCurrentUpdateState().kind === 'ready') finish()
      })
      .catch(() => {})
  })
}

/**
 * Apply a previously-downloaded Desktop update at startup instead of on quit.
 * Installing on quit is what gets interrupted by a Windows shutdown and leaves
 * a corrupted install; doing it at launch decouples the install from the
 * shutdown entirely. Returns `true` when an install was triggered (the caller
 * should then keep the splash up and NOT open the normal UI — the app is about
 * to quit and the installer relaunches it). Returns `false` (open the UI as
 * usual) when there's nothing to do, the check can't confirm a ready update, or
 * the loop-breaker is engaged.
 *
 * `splashShownAt` is the timestamp (from `Date.now()`) when the caller put up
 * the "Updating…" splash; when provided, the install is held until the splash
 * has been visible for at least `STARTUP_INSTALL_MIN_SPLASH_MS` so it doesn't
 * flash by before the app quits.
 */
export async function applyPendingUpdateOnStartup(splashShownAt?: number): Promise<boolean> {
  // Clear stale markers once the attempted/staged version is actually running
  // (the install succeeded on a previous boot).
  const running = app.getVersion()
  if (settings.get('lastStartupUpdateAttemptVersion') === running) {
    settings.set('lastStartupUpdateAttemptVersion', undefined)
  }
  if (settings.get('pendingDownloadedUpdateVersion') === running) {
    settings.set('pendingDownloadedUpdateVersion', undefined)
  }

  const decision = evaluateStartupInstall()
  if (!decision.attempt) {
    // Only the skips that mean "a staged update exists but we declined it"
    // carry canary signal; normal boots (no pending / feature off) stay silent.
    if (decision.reason === 'loop_breaker' || decision.reason === 'session_ending') {
      emitTelemetry('comfy.desktop.app_update.startup_install_skipped', {
        reason: decision.reason,
        version: settings.get('pendingDownloadedUpdateVersion') ?? null
      })
    }
    return false
  }

  // The installer is cached on disk from a previous session; this check
  // re-validates it (no re-download) and populates the updater's ready state.
  // Bounded so a slow/offline network can't hang boot — if it doesn't resolve
  // to a ready update in time, we open the UI and try again next launch.
  await waitForReadyState(STARTUP_UPDATE_CHECK_TIMEOUT_MS)

  const state = getCurrentUpdateState()
  // Require the ready version to be the exact staged version we decided to
  // install — a concurrent check could surface a different (or no) ready
  // version, which must not bypass the loop-breaker recorded for `decision.version`.
  if (state.kind !== 'ready' || state.version !== decision.version) {
    emitTelemetry('comfy.desktop.app_update.startup_install_skipped', {
      reason: 'not_ready',
      version: decision.version
    })
    return false
  }
  // Hold the "Updating…" splash on screen for a readable minimum before the
  // install quits the app. The check above often resolves instantly (cached
  // installer), so without this the splash would flash by in a fraction of a
  // second. Measured from when the splash was shown, so the check's own elapsed
  // time counts toward the floor.
  if (splashShownAt !== undefined) {
    const remaining = STARTUP_INSTALL_MIN_SPLASH_MS - (Date.now() - splashShownAt)
    if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, remaining))
  }

  // The session may have started ending while we awaited the check / held the
  // splash up.
  if (isSessionEnding()) {
    emitTelemetry('comfy.desktop.app_update.startup_install_skipped', {
      reason: 'session_ending',
      version: state.version
    })
    return false
  }

  // Record the attempt BEFORE installing so a failed install (app relaunches on
  // the old version) trips the loop-breaker next boot instead of looping.
  settings.set('lastStartupUpdateAttemptVersion', state.version)
  emitTelemetry('comfy.desktop.app_update.startup_install', { version: state.version })
  installUpdate()
  return true
}

export function register(): void {
  bindUpdaterEvents()

  // Default ("Option B"): keep electron-updater's install-on-quit. A normal
  // quit still installs a staged update; the `session-end` guard
  // (`suppressInstallOnQuit`) flips `autoInstallOnAppQuit` off only when the OS
  // is shutting down, so a Windows shutdown/restart/logoff can't kill the
  // installer mid-write (the "reinstall on every shutdown" corruption loop).
  //
  // Gated ("Option C"): when the startup-install path is enabled, disable
  // install-on-quit entirely up front — the staged update applies on the next
  // launch (`applyPendingUpdateOnStartup`) instead. `electronAutoUpdater` is the
  // same singleton the ToDesktop runtime drives, so this affects the real updater.
  if (isStartupInstallEnabled()) {
    suppressInstallOnQuit()
  }

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
