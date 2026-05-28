import { app, Menu, ipcMain, net } from 'electron'
import type { BrowserWindow, WebContentsView } from 'electron'
import type { Tray } from 'electron'
import path from 'path'
import fs from 'fs'
import { normaliseFirstUseMode } from '../shared/firstUseMode'
import { execFile } from 'child_process'
import type { ChildProcess } from 'child_process'
import todesktop from '@todesktop/runtime'
import * as ipc from './lib/ipc'
import { getAppVersion } from './lib/ipc'
import * as updater from './lib/updater'
import * as settings from './settings'
import { installAppMenu } from './menu'
import * as i18n from './lib/i18n'
import { migrateXdgPaths } from './lib/paths'
import { saveWindowBounds } from './lib/windowState'
import { registerProcessErrorHandlers } from './lib/processErrorHandlers'
import {
  registerTitleTooltipIpc,
} from './popups/titleTooltip'
import {
  openSystemModal,
  openSystemModalAsync,
  registerSystemModalIpc,
} from './popups/systemModal'
import { registerTitlePopupIpc, triggerPickerSnapshotBroadcast, type InstancePickerInstall } from './popups/titlePopup'
import { registerPickerSettingsIpc } from './popups/pickerSettingsHandlers'
import { waitForPort, COMFY_BOOT_TIMEOUT_MS } from './lib/process'
import { isQuitInProgress, setQuitReason } from './lib/quit-state'
import type { InstallationRecord } from './installations'
import {
  cleanupTempDownloads,
  downloadEvents,
  getDownloadsTrayState,
} from './lib/comfyDownloadManager'
import { registerAssetDownloadHandlers } from './lib/ipc/registerAssetDownloadHandlers'
import { registerDownloadHandlers } from './lib/ipc/registerDownloadHandlers'
import { get as getInstallation, installationEvents, list as listInstallations } from './installations'
import { startPeriodicReleaseChecks } from './lib/release-cache-startup'
import { showModelFolderRelaunchPage } from './lib/relaunchPage'
import { COMFY_BG, SPLASH_DARK, TITLEBAR_BG, type SplashTheme } from './lib/theme'
import { titleBarOverlayForTheme } from './lib/titleBarOverlay'
import {
  sourceMap, _broadcastToRenderer, _runningSessions,
  _operationAborts, _activeOperationStatus, stopRunning,
  resolveTheme, MSG_CANCELLED,
  type PickerOperationStatus,
} from './lib/ipc/shared'
import { enrichInstallationsForRenderer } from './lib/ipc/registerInstallationHandlers'
import { getSnapshotListData } from './lib/snapshots'
import { update as updateInstallation } from './installations'
import { lookupInstallUpdateOverride, recordIpcInvocation } from './lib/e2eOverrides'
import * as mainTelemetry from './lib/telemetry'
import { getDeviceId } from './lib/deviceId'

import {
  claimAttachHost,
  comfyWindows,
  computeBodyMode,
  consumeAttachClaim,
  findEntryByTitleBarSender,
  getEntryByInstallationId,
  isChooserHost,
  isInstallHost,
  openOrFocusAnyHostWindow,
  openOrFocusChooserHostWindow,
  setHostFactories,
} from './host/registry'
import {
  applyChooserHostThemeToAll,
  createHostWindow,
  expectedPartitionFor,
  openChooserHostWindow,
  rebuildComfyViewIfNeeded,
  setHostWindowFactories,
} from './host/createHostWindow'
import { attachInstall, setAttachFactories } from './host/attach'
import { IN_PLACE_RELAUNCH, REQUIRES_STOPPED } from '../types/ipc'
import { dispatchSessionAction, handleLaunch } from './lib/ipc/sessionActions'
import { applyAttachHostPreview, clearAttachHostPreview } from './host/attachHostPreview'
import {
  _detachInstallImpl,
  confirmAndCloseAllHostWindows,
  confirmAndCloseHostWindow,
  confirmCloseInstanceWindow,
  consultPanelRendererClose,
  detachOrphanedInstallHosts,
  preClearedClose,
  returnToDashboard,
} from './host/detach'
import {
  destroyPanelView,
  ensurePanelView,
  refreshComfyTabBody,
  registerPanelViewIpc,
  sendToPanelDeferred,
  setActivePanel,
} from './host/panelView'

export type { ComfyPanelKey } from './host/registry'

todesktop.init({ autoUpdater: false })

const APP_VERSION = getAppVersion()

// The chooser host window plus per-install ComfyUI windows are the
// only top-level surfaces.
let tray: Tray | null = null

/** Stop handle for the periodic release-cache poll registered in
 *  `whenReady`. Cleared in `before-quit` so the interval doesn't
 *  linger across `app.relaunch()`. */
let _stopPeriodicReleaseChecks: (() => void) | null = null

function focusExternalProcessWindow(pid: number): void {
  if (process.platform === 'win32') {
    // AppActivate accepts a numeric PID to bring the process window to the foreground.
    // wscript is near-instant compared to PowerShell.
    const vbsPath = path.join(app.getPath('temp'), `comfy-focus-${pid}.vbs`)
    fs.writeFileSync(vbsPath, `CreateObject("WScript.Shell").AppActivate ${pid}`)
    execFile('wscript.exe', ['//Nologo', '//B', vbsPath], { windowsHide: true }, () => {
      fs.unlink(vbsPath, () => { })
    })
  } else if (process.platform === 'darwin') {
    execFile('osascript', ['-e',
      `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`,
    ], () => { })
  }
}
function updateTrayMenu(): void {
  if (!tray) return
  // The install-less chooser host is the primary surface. "Show
  // App" focuses the chooser host.
  const contextMenu = Menu.buildFromTemplate([
    {
      label: i18n.t('tray.showApp'),
      click: () => { openOrFocusChooserHostWindow() },
    },
    { type: 'separator' },
    { label: i18n.t('tray.quit'), click: () => quitApp() },
  ])
  tray.setContextMenu(contextMenu)
}

// `createTray()` has been removed while docking-to-tray is disabled —
// see whenReady()'s comment about restoring docking. The `tray` module
// state and `updateTrayMenu()` (a no-op when tray is null) are kept so
// that `onLocaleChanged: updateTrayMenu` and the `before-quit` cleanup
// path stay valid without conditional churn for the eventual restore.

function quitApp(): void {
  setQuitReason('user-quit')
  ipc.cancelAll()
  for (const [, entry] of comfyWindows) {
    if (!entry.window.isDestroyed()) entry.window.destroy()
  }
  comfyWindows.clear()
  if (tray) {
    tray.destroy()
    tray = null
  }
  app.quit()
}


function onComfyExited({ installationId }: { installationId?: string } = {}): void {
  if (!installationId) return
  // The window stays alive — exit (clean or crash) just swaps the body to the
  // lifecycle panel so the user can re-launch, look at logs, or close the
  // window themselves. Window destruction only happens via explicit close
  // paths (user closes window, app quits, install deleted via close-comfy-window).
  refreshComfyTabBody(installationId)
}

interface RelaunchState {
  /** The real ComfyUI URL before we replaced it with the splash page. */
  originalUrl: string
  /** Detected splash theme for seamless background-color transition. */
  theme: SplashTheme
  /** will-navigate blocker attached to the comfy window. */
  navBlocker: (e: Electron.Event) => void
  /** Monotonically-increasing token — stale onComfyRestarted calls abort when this changes. */
  token: number
}

/** Consolidated relaunch state per installation. */
const relaunchStates = new Map<string, RelaunchState>()
/** Cancel functions for pending did-fail-load retry timers per installation. */
const comfyFailRetryTimerCancels = new Map<string, () => void>()
/** Counter for generating unique relaunch tokens. */
let relaunchTokenCounter = 0

async function onModelFolderRelaunch({ installationId }: { installationId: string }): Promise<void> {
  const entry = getEntryByInstallationId(installationId)
  if (!entry || entry.window.isDestroyed()) return
  const comfyContents = entry.comfyView.webContents

  // If a relaunch is already in progress, clean up the previous state first
  // so the stale onComfyRestarted call will abort (token mismatch).
  const prev = relaunchStates.get(installationId)
  if (prev) comfyContents.off('will-navigate', prev.navBlocker)

  // Capture the real ComfyUI URL — but only if we're not already on the splash page.
  const currentUrl = comfyContents.getURL()
  const originalUrl = prev ? prev.originalUrl : currentUrl

  // Cancel any pending did-fail-load retry so it doesn't navigate away from the splash
  const cancelRetry = comfyFailRetryTimerCancels.get(installationId)
  if (cancelRetry) cancelRetry()

  // Block navigations on the comfy view until onComfyRestarted loads the real URL.
  const blockNav = (e: Electron.Event): void => { e.preventDefault() }
  comfyContents.on('will-navigate', blockNav)

  // Always use dark splash — the frontend's own loading screen is always dark,
  // so a light splash would cause a jarring dark flash when ComfyUI loads.
  const theme: SplashTheme = SPLASH_DARK
  const token = ++relaunchTokenCounter

  relaunchStates.set(installationId, { originalUrl, theme, navBlocker: blockNav, token })
  await showModelFolderRelaunchPage(comfyContents, theme)
}

function onComfyRestarted({ installationId, process: _proc }: { installationId?: string; process?: ChildProcess } = {}): void {
  if (!installationId) return
  const entry = getEntryByInstallationId(installationId)
  if (!entry || entry.window.isDestroyed()) return
  const comfyContents = entry.comfyView.webContents

  const state = relaunchStates.get(installationId)
  const myToken = state?.token

  const currentUrl = state?.originalUrl || comfyContents.getURL()
  if (!currentUrl) return

  const url = new URL(currentUrl)
  const port = parseInt(url.port, 10)
  if (!port) return

  const cleanupRelaunchState = (): void => {
    // Only clean up if this is still the active relaunch (token matches)
    const current = relaunchStates.get(installationId)
    if (current && current.token === myToken) {
      if (!entry.window.isDestroyed()) comfyContents.off('will-navigate', current.navBlocker)
      relaunchStates.delete(installationId)
    }
  }

  /** Returns true if a newer relaunch has superseded this one. */
  const isStale = (): boolean => {
    const current = relaunchStates.get(installationId)
    return !!current && current.token !== myToken
  }

  waitForPort(port, '127.0.0.1', { timeoutMs: COMFY_BOOT_TIMEOUT_MS })
    .then(async () => {
      // The TCP port may be open before the HTTP server is ready.
      // Probe with HTTP HEAD requests so the splash page stays visible
      // until the server actually responds.
      for (let attempt = 0; attempt < 10; attempt++) {
        if (entry.window.isDestroyed() || isStale()) { cleanupRelaunchState(); return }
        try {
          const resp = await net.fetch(currentUrl, { method: 'HEAD' })
          resp.body?.cancel()
          break
        } catch {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
        }
      }
      if (entry.window.isDestroyed() || isStale()) { cleanupRelaunchState(); return }
      // Non-relaunch restart while a relaunch is active — defer to the relaunch.
      if (relaunchStates.has(installationId) && !state) return
      cleanupRelaunchState()
      // Set the dark/theme background on the comfyView (the parent BrowserWindow's
      // backgroundColor is hidden behind the views and would have no visual effect).
      entry.comfyView.setBackgroundColor(state?.theme.bg ?? COMFY_BG)
      await comfyContents.loadURL(currentUrl)
    })
    .catch((err) => {
      cleanupRelaunchState()
      // The install's own window is the right surface for
      // restart-failure UX, but its comfyView is mid-load here so
      // an inline message would be racy. Logging + the existing
      // splash error path are sufficient for now.
      console.error(`ComfyUI restart failed for ${installationId}:`, err)
    })
}

function onStop({ installationId }: { installationId?: string } = {}): void {
  // Stopping the process no longer destroys the window — the window stays
  // open so the user can re-launch, view logs, or open Settings.
  // Window destruction stays bound to explicit close paths
  // (user closes window, app quits, install deleted via close-comfy-window).
  if (installationId) {
    refreshComfyTabBody(installationId)
  } else {
    // Refresh every install-backed entry's comfy tab; chooser hosts
    // have no comfy lifecycle to refresh, so they're skipped naturally.
    for (const entry of comfyWindows.values()) {
      if (isInstallHost(entry)) {
        refreshComfyTabBody(entry.installationId)
      }
    }
  }
}


function onLaunch({ port, url, process: proc, installation, mode }: {
  port: number
  url?: string
  process: ChildProcess | null
  installation: InstallationRecord
  mode: string
}): void {
  const comfyUrl = url || `http://127.0.0.1:${port}`
  const installationId = installation.id

  if (mode === 'console' || mode === 'external') {
    return
  }

  // Re-launch into an existing window: a previous launch left the comfy
  // window alive (stop / crash leaves the window open with the lifecycle
  // body). Reuse the existing views; just point the comfyView at the new URL
  // and let `refreshComfyTabBody` swap the body back from lifecycle to comfy.
  const existing = getEntryByInstallationId(installationId)
  if (existing && !existing.window.isDestroyed()) {
    // Drop any pending in-place attach claim for this install — the
    // chooser host renderer may have staked one before kicking off the
    // launch, but we're reusing the existing window instead of flipping
    // the chooser host. Without this drop the claim sits in the map
    // until the chooser host closes (`dropAttachClaimsForWindow`).
    consumeAttachClaim(installationId)
    existing.comfyUrl = comfyUrl
    if (!existing.comfyView.webContents.isDestroyed()) {
      existing.comfyView.setBackgroundColor(COMFY_BG)
      void existing.comfyView.webContents.loadURL(comfyUrl).catch(() => { })
    }
    // A relaunch implicitly means "land me in the live ComfyUI view",
    // so force the host's activePanel back to `'comfy'`. Without this, a
    // launch kicked off from a non-comfy panel (e.g. the install-settings
    // DetailModal) would leave the body stranded on the lifecycle /
    // settings panel — `refreshComfyTabBody` early-returns on
    // `activePanel !== 'comfy'`. The trailing `refreshComfyTabBody`
    // still handles the comfy-lifecycle → comfy body-mode swap when the
    // entry was already on `'comfy'` (setActivePanel early-returns there).
    //
    // EXCEPTION: the `'progress'` panel mode is reserved for picker-
    // driven ProgressModal takeovers that explicitly own the panel
    // until the user picks a terminal-state CTA. A relaunch fired
    // mid-update (the wantsRelaunch step in `useComfyUISettings`) must
    // NOT yank the panel out from under the running modal — the user
    // would lose the success screen and be dumped into Comfy with no
    // sense of what just happened. The renderer's `handleProgressClose`
    // restores `'comfy'` once the modal dismisses.
    if (existing.activePanel !== 'progress') {
      setActivePanel(existing.windowKey, 'comfy')
    }
    refreshComfyTabBody(installationId)
    if (proc) {
      proc.on('exit', () => {
        // Session registry handles state cleanup
      })
    }
    return
  }

  // Chooser-pick in-place attach — the chooser claimed this host before
  // launching. Reconcile partition mismatches by rebuilding the comfyView.
  const claimedKey = consumeAttachClaim(installationId)
  if (claimedKey !== undefined) {
    const claimed = comfyWindows.get(claimedKey)
    if (
      claimed &&
      !claimed.window.isDestroyed() &&
      isChooserHost(claimed)
    ) {
      rebuildComfyViewIfNeeded(claimed, installation)
      // No title-bar URL reload here — `attachInstall` pushes the new
      // installationId via `comfy-titlebar:installation-id-changed` and
      // the renderer's `isInstallLess` is reactive on that channel.
      // Keeping the long-lived title-bar webContents avoids the
      // blank-then-rehydrate flicker the URL reload used to cause
      // between preview identity and the post-attach steady state.
      // Drop the chooser PanelApp before the install takes over the
      // host. The chooser pick flow runs the launch action through a
      // Tier 2 progress overlay mounted on this panel; once the
      // install-backed comfyView is shown, the overlay would survive
      // hidden behind it, and a later `consultPanelRendererClose`
      // (window close) would funnel through its cancel-prompt and
      // hang waiting for input the user can't see. The next
      // `ensurePanelView` (Settings click, comfy-lifecycle body, …)
      // builds a fresh install-backed panel.
      destroyPanelView(claimed)
      const ok = attachInstall(claimed, { installation, comfyUrl, isLocal: !url })
      if (ok) {
        claimed.layoutViews()
        if (proc) {
          proc.on('exit', () => {
            // Session registry handles state cleanup
          })
        }
        return
      }
      // Attach failed (telemetry-only — every current call site
      // already gates with `isChooserHost(entry)` but the boolean
      // return keeps us from blowing up if a future caller forgets).
      // Fall through to the fresh-window path below so the user still
      // gets the install they asked for.
    }
  }

  // Install-backed wrapper. Construction is split in two:
  //   1. `createHostWindow()` — mode-agnostic skeleton (BrowserWindow +
  //      titleBarView + comfyView + layoutViews + macOS fullscreen +
  //      bounds-save + close/closed + title-bar-ready handshake +
  //      generic comfyContents listeners — popup creation / window-
  //      open routing / will-prevent-unload / OS context menu — all
  //      harmless on a chooser host's idle view).
  //   2. `attachInstall()` — install-specific wiring (install-record
  //      subscription, theme observer, fail-retry, render-process-gone,
  //      before-input keystrokes, attachSessionDownloadHandler, content-
  //      script injection, comfyContents URL load).
  const initialSourceCategory = sourceMap[installation.sourceId]?.category ?? null

  const { entry } = createHostWindow({
    windowTitle: `${installation.name} — Desktop 2.0 v${APP_VERSION}`,
    boundsKey: installationId,
    initialTheme: { bg: COMFY_BG, text: '#dddddd' },
    titleBarOverlay: process.platform === 'darwin' ? undefined : titleBarOverlayForTheme(resolveTheme() === 'dark'),
    comfyWebPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/comfyPreload.js'),
      partition: expectedPartitionFor(installation),
    },
    titleBarBackground: TITLEBAR_BG,
    titleBarInstallationIdParam: installationId,
    initialTitleBarText: installation.name,
    initialSourceCategory,
  })

  // Bind the install — wires every install-keyed listener +
  // attachSessionDownloadHandler + comfyContents.loadURL, and stashes
  // a symmetric undo on `entry._installCleanup` (consumed by the
  // close handler, and by `detachInstall()` for an in-place flip).
  // Generic listeners (popup, window-open, context-menu) are pre-
  // wired by `createHostWindow()` so attach/detach doesn't churn them.
  // attachInstall returns false only if the entry is already attached
  // — which can't happen on a freshly-constructed entry today, but
  // tear the just-created window down cleanly on the off-chance a
  // future regression breaks the install-less-at-construction
  // invariant.
  const attached = attachInstall(entry, { installation, comfyUrl, isLocal: !url })
  if (!attached) {
    entry.window.destroy()
    return
  }

  // Now that all wiring is in place, layout for the first time.
  // (The shared helper deferred this so the wrapper could install
  // anything that needs to settle before the first paint, e.g. the
  // comfyContents URL load inside `attachInstall`.)
  entry.layoutViews()

  if (proc) {
    proc.on('exit', () => {
      // Session registry handles state cleanup
    })
  }
}


ipcMain.handle('quit-app', () => quitApp())

ipcMain.handle('app:relaunch', () => {
  setQuitReason('user-quit')
  ipc.cancelAll()
  for (const [, entry] of comfyWindows) {
    if (!entry.window.isDestroyed()) entry.window.destroy()
  }
  comfyWindows.clear()
  if (tray) {
    tray.destroy()
    tray = null
  }
  app.relaunch()
  app.quit()
})

// `reset-zoom` has no callers; per-install ComfyUI windows manage
// their own zoom independently. Kept as a stubbed handler so any
// straggling renderer still bound to the channel doesn't reject.
ipcMain.handle('reset-zoom', () => {
  // no-op
})

/**
 * First-use takeover step plumbing.
 *
 * Forwards the panel renderer's `setFirstUseMode(mode)` push to the
 * host's title-bar WebContentsView (consumed by the lockdown) AND
 * caches the value on the entry — `buildTitlePopupMenuItems`
 * (file-menu popup config builder) reads `entry.firstUseMode`
 * synchronously when the user clicks the waffle, so the cached
 * value has to be ground-truth.
 */
ipcMain.on(
  'comfy-window:set-first-use-mode',
  (event, payload: { mode: unknown }) => {
    const mode = normaliseFirstUseMode(payload?.mode)
    recordIpcInvocation('comfy-window:set-first-use-mode', { mode })
    for (const entry of comfyWindows.values()) {
      if (entry.panelView?.webContents === event.sender) {
        entry.firstUseMode = mode
        if (!entry.titleBarView.webContents.isDestroyed()) {
          entry.titleBarView.webContents.send('comfy-titlebar:first-use-mode-changed', mode)
        }
        return
      }
    }
  },
)

/**
 * Install-update pill state. Reads the install record via
 * `getInstallation`, resolves its source via `sourceMap`, and
 * applies the same `getStatusTag()` rule the chooser cards / kebab
 * menu use (`statusTag.style === 'update'`). Returns
 * `{ available: false }` for install-less host windows or when the
 * install isn't found.
 *
 * Also surfaces the target `version` from the status tag so the
 * title bar's install-update pill can read "Update v{version}"
 * matching the app-update pill (rather than the generic "Update
 * available"). Source plugins populate `StatusTag.version` next to
 * the localised label.
 */
async function computeInstallUpdateAvailable(
  installationId: string,
): Promise<{ available: boolean; version?: string }> {
  if (!installationId) return { available: false }
  // Test-only override (E2E suite). Empty in production.
  const override = lookupInstallUpdateOverride(installationId)
  if (override) return override
  try {
    const inst = await getInstallation(installationId)
    if (!inst) return { available: false }
    const source = sourceMap[inst.sourceId]
    const tag = source?.getStatusTag ? source.getStatusTag(inst) : undefined
    if (tag?.style !== 'update') return { available: false }
    return { available: true, version: tag.version }
  } catch {
    return { available: false }
  }
}

/**
 * Fan out an updater state transition to every host
 * window's title-bar webContents. Registered once at startup via
 * `updater.onUpdateStateChanged`. The chooser-host title bar
 * receives the same payload as install-backed title bars; the pill
 * label / behaviour is the same regardless of the host kind.
 */
function _broadcastAppUpdateStateToTitleBars(state: updater.AppUpdateState): void {
  for (const entry of comfyWindows.values()) {
    const wc = entry.titleBarView.webContents
    if (wc.isDestroyed()) continue
    try {
      wc.send('comfy-titlebar:app-update-state-changed', state)
    } catch { }
  }
}

/**
 * Title-bar app-update pill click. Branches on the cached updater
 * state:
 *   - `'ready'` (auto-on or auto-off) → `app-update-restart-prompt`,
 *     panel renderer fires the "Desktop Update Ready" confirm modal
 *     ("Restart now?"). Confirm → `installUpdate()`.
 *   - `'available'` (auto-off only — main suppresses 'available' under
 *     auto-on) → `app-update-download-prompt`, renderer fires the
 *     "Desktop Update Available" confirm modal. Confirm →
 *     `downloadUpdate()`; the auto restart prompt fires once download
 *     finishes (see `_userInitiatedDownload` in updater.ts).
 *   - `null` → no-op (the pill is suppressed when there's no state).
 *
 * Modals fire via the panel renderer (which already owns `useModal`)
 * rather than the overlay system because `useModal` is process-global
 * and matches the spec's "modal" wording — overlays are a different
 * surface (Tier 1/2/3 popovers).
 */
ipcMain.on('comfy-window:click-app-update-pill', (event) => {
  const found = findEntryByTitleBarSender(event.sender)
  if (!found) return
  const { entry } = found
  if (entry.window.isDestroyed()) return
  const state = updater.getCurrentUpdateState()
  if (state.kind === null) return
  // While the download is in flight the pill click can't usefully
  // trigger anything — deep-link the user to Global Settings → Desktop
  // Updates instead. The renderer's deep-link router (`useDeepLinkRouter`)
  // handles `settingsTab: 'global'` by calling `openGlobalSettings()`.
  if (state.kind === 'downloading') {
    const panelView = entry.panelView
    if (!panelView) return
    sendToPanelDeferred(panelView, 'panel-trigger-overlay', {
      kind: 'open-settings',
      installationId: entry.installationId,
      settingsTab: 'global',
    })
    return
  }
  // The confirm modal renders on the dedicated system-modal popup
  // surface, which overlays the entire host window — independent of
  // which body view (comfy / panel / lifecycle) is currently active.
  // No panel switch is required, so the user stays on whatever they
  // were doing once they dismiss the prompt.
  const isReady = state.kind === 'ready'
  const version = state.version ?? i18n.t('appUpdate.fallbackVersion')
  const title = isReady
    ? i18n.t('appUpdate.readyTitle')
    : i18n.t('appUpdate.availableTitle')
  const message = isReady
    ? i18n.t('appUpdate.readyMessage', { version })
    : i18n.t('appUpdate.availableMessage', { version })
  const confirmLabel = isReady
    ? i18n.t('appUpdate.restartNow')
    : i18n.t('appUpdate.download')
  const cancelLabel = i18n.t('appUpdate.later')
  const theme = entry.lastTheme
  openSystemModal({
    parent: entry.window,
    spec: {
      id: `app-update-${state.kind}-${version}`,
      title,
      message,
      confirmLabel,
      cancelLabel,
      confirmStyle: 'primary',
      theme,
    },
    callback: (action) => {
      if (action !== 'confirm') return
      if (isReady) {
        updater.installUpdate()
      } else {
        void updater.downloadUpdate()
      }
    },
  })
})

/**
 * Title-bar install-update pill click. Refuses on install-less hosts.
 *
 * Forwards `panel-trigger-overlay { kind: 'install-update' }` to the panel
 * renderer; `useDeepLinkRouter` handles it by opening the instance picker
 * in expanded mode on the Update tab.
 *
 * When the user is on the ComfyUI body the panelView is lazily not-yet-
 * constructed, so we ensure it for the current body mode (without flipping
 * the visible body — the picker is a separate popup) and let
 * `sendToPanelDeferred` hold the IPC until `did-finish-load`. Mirrors the
 * Send Feedback handler; without this the click was a silent no-op whenever
 * the panel hadn't been built yet.
 */
ipcMain.on('comfy-window:click-install-update-pill', (event) => {
  const found = findEntryByTitleBarSender(event.sender)
  if (!found) return
  const { entry } = found
  const installationId = entry.installationId
  if (!installationId) return
  const panelView =
    entry.panelView ?? ensurePanelView(entry.windowKey, entry, computeBodyMode(entry))
  sendToPanelDeferred(panelView, 'panel-trigger-overlay', {
    kind: 'install-update',
    installationId,
  })
})

/**
 * Push the downloads-tray snapshot to a single title bar.
 * Used both for the initial state push on `onTitleBarReady` (slow path
 * — a title bar mounting AFTER an in-flight download started still
 * paints correctly) and from the broadcast helper below for live
 * updates. The payload shape is mirrored verbatim by the
 * `DownloadsTrayState` interface in `comfyTitleBarPreload.ts`.
 */
function notifyTitleBarDownloads(titleBarView: WebContentsView): void {
  if (titleBarView.webContents.isDestroyed()) return
  titleBarView.webContents.send('comfy-titlebar:downloads-changed', getDownloadsTrayState())
}

/**
 * Fan out a downloads-tray state change to every host
 * window's title-bar webContents. Subscribed once at startup to
 * `downloadEvents.on('tray-state-changed', ...)`. The chooser-host
 * title bar receives the same payload as install-backed title bars;
 * downloads are a global concern, not per-install.
 */
function _broadcastDownloadsToTitleBars(): void {
  for (const entry of comfyWindows.values()) {
    notifyTitleBarDownloads(entry.titleBarView)
  }
}

/**
 * Forward a Send Feedback request to the host's panel renderer.
 * Panel-side (`PanelApp.vue`) fires the `desktop2.feedback.opened`
 * telemetry action and opens the typeform support URL via
 * `openExternal`. The renderer is the natural home because
 * `buildSupportUrl()` reads `navigator.userAgent` and the telemetry
 * helpers live renderer-side. Used by both the file-menu "Send
 * Feedback" entry and the title-bar feedback button.
 *
 * `source` is forwarded into the renderer's telemetry context as
 * `desktop2.feedback.opened` `{ source }` so we can tell which
 * affordance the user reached for.
 *
 * In Comfy instance windows the panelView is constructed lazily on
 * the first non-comfy switch (Settings / Directories / lifecycle), so
 * a feedback click that arrives while the user is still on the
 * ComfyUI body would hit a `null` panelView and silently drop. Mirror
 * the `click-install-update-pill` pattern: ensure the panel exists
 * for the current body mode and defer the send until
 * `did-finish-load` if the bundle is still loading.
 */
function triggerOpenFeedback(entryId: number, source: 'titlebar' | 'menu'): void {
  const parentEntry = comfyWindows.get(entryId)
  if (!parentEntry || parentEntry.window.isDestroyed()) return
  // Flip into the 'feedback' overlay panel — same pattern as
  // 'downloads-v2'. setActivePanel lazily ensures the panel view,
  // makes it visible over comfyView, and broadcasts `panel-switch` to
  // the renderer. The IPC below carries the click `source` so the
  // renderer's telemetry payload can distinguish titlebar vs. menu.
  const panelView = parentEntry.panelView ?? ensurePanelView(entryId, parentEntry, 'feedback')
  setActivePanel(entryId, 'feedback')
  sendToPanelDeferred(panelView, 'comfy-panel:open-feedback', { source })
}

/** Title-bar Send Feedback button click. Resolves the host entry from
 *  the title-bar sender, then routes through `triggerOpenFeedback`. */
ipcMain.on('comfy-window:click-feedback', (event) => {
  const found = findEntryByTitleBarSender(event.sender)
  if (!found) return
  triggerOpenFeedback(found.entry.windowKey, 'titlebar')
})

/**
 * File menu → New Window. Always opens a fresh
 * install-less chooser host window — does NOT focus an existing one
 * (that's the tray-entry behaviour). The user explicitly asked for a
 * new window so they get one.
 */
ipcMain.on('comfy-window:new-chooser-window', () => {
  openChooserHostWindow()
})

ipcMain.handle('focus-comfy-window', (_event, installationId: string) => {
  recordIpcInvocation('focus-comfy-window', { installationId })
  const entry = getEntryByInstallationId(installationId)
  if (entry && !entry.window.isDestroyed()) {
    entry.window.show()
    entry.window.focus()
    return true
  }

  // For external processes (e.g. Desktop), bring the child process window to front
  const proc = ipc.getSessionProcess(installationId)
  if (proc?.pid) {
    focusExternalProcessWindow(proc.pid)
    return true
  }

  return false
})

/**
 * Open a new window showing the install backing `installationId`.
 * Used by ProgressModal after copy / copy-update / release-update so
 * the newly-created destination install gets focus without swapping
 * the source host out from under the user.
 *
 * If a window already backs the install (e.g. previous launch),
 * focuses it. Otherwise opens a fresh chooser host — A' renders in
 * the dashboard alongside other installs and the user picks it from
 * there. Future enhancement: auto-pick A' via a URL param on the
 * fresh chooser host so launch fires on its own.
 */
ipcMain.handle('open-install-window', (_event, installationId: string) => {
  recordIpcInvocation('open-install-window', { installationId })
  const existing = getEntryByInstallationId(installationId)
  if (existing && !existing.window.isDestroyed()) {
    existing.window.show()
    existing.window.focus()
    return true
  }
  openChooserHostWindow()
  return true
})

ipcMain.handle('close-comfy-window', (_event, installationId: string, opts?: { skipConfirm?: boolean }) => {
  const entry = getEntryByInstallationId(installationId)
  if (!entry || entry.window.isDestroyed()) return false
  // Caller has already confirmed (e.g. launch-guard "Close Running & Launch")
  // — skip the panel-renderer quit-confirm consult so the user isn't
  // prompted twice. The IPC returns synchronously rather than waiting on
  // 'closed': a concurrent close handler with an indefinitely-pending
  // user prompt would otherwise block this call. Callers that need a
  // port-free guarantee before relaunching should `stopComfyUI` first;
  // the close handler's `_installCleanup` re-invokes `ipc.stopRunning`
  // (idempotent) on top of that.
  if (opts?.skipConfirm) preClearedClose.add(entry.window)
  entry.window.close()
  return true
})

/**
 * Close the host window that contains the calling panel WebContents.
 *
 * Used by the chooser after a successful pick → launch hand-off:
 * once the install's own ComfyUI window has opened (via the existing
 * `onLaunch` flow), the install-less chooser host window is no
 * longer needed and closes itself. The renderer can't close its
 * parent BrowserWindow directly, so it asks main to do it.
 *
 * Safe on install-backed windows too — the install-settings panel's
 * navigate-list path already handles teardown via `closeComfyWindow`,
 * but if a future renderer surface needs the same "close my window"
 * hook this IPC can stand in for it.
 */
ipcMain.handle('close-host-window', (event) => {
  for (const [, entry] of comfyWindows) {
    if (entry.window.isDestroyed()) continue
    if (entry.panelView?.webContents === event.sender) {
      entry.window.close()
      return true
    }
  }
  return false
})

/**
 * Flip the install-backed host window that owns the calling panel
 * WebContents back to chooser mode in place (same window, same bounds).
 * Returns `true` when an install-backed entry was found and detached.
 *
 * Used by panel-side surfaces (ProgressModal Return-to-Dashboard,
 * ComfyLifecycleView, etc.) to send the user back to the dashboard
 * without closing the window.
 */
ipcMain.handle('return-to-dashboard', (event) => {
  for (const [, entry] of comfyWindows) {
    if (entry.window.isDestroyed()) continue
    if (!isInstallHost(entry)) continue
    if (entry.panelView?.webContents !== event.sender) continue
    entry.detachInstall()
    return true
  }
  return false
})

/**
 * Stake an in-place attach claim from a chooser-host renderer. When
 * the launch event subsequently lands in `onLaunch()`, the matching
 * `consumeAttachClaim()` call rebuilds the comfyView's partition if
 * needed and runs `attachInstall()` against THIS host window — the
 * user perceives the chooser tile they clicked transforming into the
 * install window without a flicker / window-swap.
 *
 * Rejected (returns `false`, renderer falls back to the
 * `transferHostBoundsToInstall` + close-on-instance-started swap)
 * when:
 *   - the calling sender isn't the panelView of any registered host,
 *   - that host is already install-backed (chooser-pick from an
 *     install-backed host wouldn't make semantic sense), or
 *   - the host's BrowserWindow is destroyed.
 */
ipcMain.handle('claim-attach-host', (event, installationId: string) => {
  for (const [, entry] of comfyWindows) {
    if (entry.window.isDestroyed()) continue
    if (isInstallHost(entry)) continue
    if (entry.panelView?.webContents !== event.sender) continue
    claimAttachHost(installationId, entry.windowKey)
    // Push the install's identity to the title bar immediately so the
    // user can see which install is being acted on while the op runs;
    // attachInstall later overwrites with the same values, so there's
    // no flicker on the happy path.
    void applyAttachHostPreview(entry, installationId)
    return true
  }
  return false
})

/**
 * Release the in-progress install identity preview on the calling
 * chooser host. Fired by the panel renderer when an overlay (progress
 * / takeover) closes without producing an attach — the op was
 * cancelled, errored, or the user backed out — so the title bar
 * reverts to the chooser-host identity.
 *
 * No-op when the calling sender isn't an install-less host's panel
 * webContents, or when no preview is currently active.
 */
ipcMain.handle('release-attach-host-preview', (event) => {
  for (const [, entry] of comfyWindows) {
    if (entry.window.isDestroyed()) continue
    if (isInstallHost(entry)) continue
    if (entry.panelView?.webContents !== event.sender) continue
    clearAttachHostPreview(entry)
    return true
  }
  return false
})

/**
 * Copy the calling chooser host window's current bounds into the
 * install's saved-bounds slot (visual continuity for chooser pick).
 *
 * The chooser pick flow currently closes the host and launches the
 * install in a fresh window. Without this transfer, the new install
 * window opens at the install's saved bounds (or the default
 * 1280x900), jumping visibly away from where the user just clicked.
 * Stamping the chooser's current bounds onto the install BEFORE the
 * launch makes the new window appear in the same spot — visually a
 * swap-in-place even though it's structurally close+open.
 *
 * No-op when the calling sender isn't the panel of an install-less host
 * window (so install-backed panels can't accidentally clobber another
 * install's bounds).
 */
ipcMain.handle('transfer-host-bounds-to-install', (event, installationId: string) => {
  for (const [, entry] of comfyWindows) {
    if (entry.window.isDestroyed()) continue
    if (isInstallHost(entry)) continue
    if (entry.panelView?.webContents !== event.sender) continue
    saveWindowBounds(installationId, entry.window)
    return true
  }
  return false
})

function findInstallationIdForWindow(win: BrowserWindow): string | undefined {
  for (const entry of comfyWindows.values()) {
    if (entry.window !== win) continue
    // Chooser hosts have no install id to return; treating that as
    // `undefined` keeps callers from resolving fake install ids.
    return entry.installationId ?? undefined
  }
  return undefined
}

if (app.isPackaged && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  if (app.isPackaged) {
    app.on('second-instance', () => {
      // OS-level "open another instance" attempt — focus an existing
      // host window (chooser or install-backed) instead of stacking
      // a duplicate.
      openOrFocusAnyHostWindow()
    })
  }

  app.whenReady().then(async () => {
    // Test-only hooks for the E2E suite. Registered before any host
    // opens so seeded state (downloads, install-update overrides,
    // app-update state) is visible to the very first title-bar paint.
    if (process.env['E2E'] === '1') {
      const { registerE2EHooks } = await import('./lib/e2eHooks')
      registerE2EHooks()
    }

    // Dev-only keyboard shortcuts for driving title-bar pill state by
    // hand on an unpackaged build. Cmd/Ctrl+Alt+U cycles the app-update
    // pill; Cmd/Ctrl+Alt+I toggles the install-update override.
    if (!app.isPackaged) {
      const { registerDevShortcuts } = await import('./lib/devShortcuts')
      registerDevShortcuts({ computeInstallUpdateAvailable })
    }

    // Wire late-bound host factories before any openOrFocus* runs (the
    // tray menu, activate / second-instance handlers, and the startup
    // picker all flow through the registry).
    setHostWindowFactories({
      consultPanelRendererClose,
      confirmCloseInstanceWindow,
      detachInstallImpl: _detachInstallImpl,
      preClearedClose,
      computeInstallUpdateAvailable,
    })
    setAttachFactories({
      comfyFailRetryTimerCancels,
      relaunchStates,
      computeInstallUpdateAvailable,
    })
    setHostFactories({ createChooser: openChooserHostWindow })
    registerPanelViewIpc()

    migrateXdgPaths()
    registerProcessErrorHandlers()

    // Strip Electron's default menu before any BrowserWindow opens so
    // OAuth / cloud-login popups (and every other window) can't reach
    // destructive items like "Close All Windows" that bypass our
    // managed shutdown. See `installAppMenu` for the per-platform
    // template.
    installAppMenu()

    // Bring up main-process telemetry as early as possible so install/migrate
    // sub-step events can fire even before the renderer mounts.
    const telemetryEnabled = settings.get('telemetryEnabled') !== false
    mainTelemetry.setConsent(telemetryEnabled)
    mainTelemetry.initTelemetry({
      appVersion: APP_VERSION,
      appEnv: app.isPackaged ? 'prod-v2' : 'dev',
      isPackaged: app.isPackaged,
    })
    mainTelemetry.installAppHooks()
    mainTelemetry.identify(getDeviceId(), {
      app_version: APP_VERSION,
      platform: process.platform,
      arch: process.arch,
    })

    const locale = (settings.get('language') as string | undefined) || app.getLocale().split('-')[0]
    i18n.init(locale)
    registerTitleTooltipIpc({
      findParentByTitleBarSender: (wc) => findEntryByTitleBarSender(wc)?.entry.window ?? null,
    })
    registerSystemModalIpc()
    // Swap-in-place contract: when the user picks a different install
    // from a Comfy-instance window, the picked install replaces the
    // current install IN THE SAME WINDOW (workflow continuity from the
    // user's perspective — they stay in the window they were in). The
    // current install's session is stopped first; on confirm the
    // window detaches (flips to chooser-shape briefly) and then
    // re-attaches the picked install via the same in-place attach
    // claim path the dashboard chooser uses.
    //
    // Three exits short-circuit the swap:
    //   - Target already running in another window → focus that
    //     window. Avoids spawning a duplicate session of the same
    //     install and keeps the user's other window intact.
    //   - Target equals the host's own install → no-op. Picker already
    //     dismissed at the IPC boundary; refocusing the window would
    //     be redundant.
    //   - User cancels the swap-confirm dialog → no-op.
    //
    // The renderer-side `useLocalInstanceGuard` handles cross-window
    // local-instance conflicts (port collision on the same port) via
    // a modal that renders inside the panel — naturally visible after
    // the detach since the host is now chooser-shape with the panel
    // on top.
    const pickInstallFromPicker = async (
      installationId: string,
      parentEntryId: number,
    ): Promise<void> => {
      const existing = getEntryByInstallationId(installationId)
      if (existing && !existing.window.isDestroyed()) {
        existing.window.show()
        existing.window.focus()
        return
      }
      const parentEntry = comfyWindows.get(parentEntryId)
      if (!parentEntry || parentEntry.window.isDestroyed()) return

      // Picking the host's own install — picker already dismissed at
      // the IPC boundary, nothing more to do.
      if (parentEntry.installationId === installationId) return

      // Install-backed parent → confirm before swap (the user is
      // about to lose any unsaved work in the current install's
      // workflow). Chooser hosts skip the dialog because there's no
      // active workflow to lose — they're a launcher surface.
      if (parentEntry.installationId != null) {
        let targetName = installationId
        try {
          const target = await getInstallation(installationId)
          if (target?.name) targetName = target.name
        } catch {
          // Name lookup is cosmetic — fall through with the id as the label.
        }
        const confirmed = await openSystemModalAsync({
          parent: parentEntry.window,
          spec: {
            title: 'Switch instance?',
            message: `Switch to ${targetName}?`,
            details: [
              {
                label: 'Heads up',
                items: [
                  'The current instance will be stopped and replaced in this window.',
                  'Any unsaved work in the workflow will be lost.',
                ],
              },
            ],
            confirmLabel: 'Switch',
            cancelLabel: 'Cancel',
            confirmStyle: 'primary',
            theme: parentEntry.lastTheme,
          },
        })
        if (!confirmed) return
        // `entry.detachInstall()` runs the full symmetric undo of
        // `attachInstall`: stops the running session, releases the
        // comfyView URL, re-navigates the title-bar back to chooser
        // mode, destroys + remounts the panelView in chooser shape.
        // After this the entry is structurally identical to a fresh
        // chooser host (`isChooserHost(parentEntry) === true`).
        parentEntry.detachInstall()
      }

      // Route through the chooser-pick path. After the detach (or for
      // a parent that was already chooser-shape), the host is
      // chooser-shape; PanelApp's `useDeepLinkRouter` branches the
      // picker-pick-install payload to `handleChooserPick`, which
      // stakes an attach claim against this same window. `onLaunch`
      // consumes the claim and runs `attachInstall` against the
      // existing host — the user perceives one in-place swap, not a
      // detach + relaunch.
      //
      // The newly-remounted panel renderer takes a beat to load + ack
      // `did-finish-load`. `sendToPanelDeferred` queues the IPC until
      // that ack arrives so the listener has been registered by the
      // time the payload fires.
      const panelView = parentEntry.panelView
        ?? ensurePanelView(parentEntryId, parentEntry, computeBodyMode(parentEntry))
      if (panelView.webContents.isDestroyed()) return
      sendToPanelDeferred(panelView, 'panel-trigger-overlay', {
        kind: 'picker-pick-install',
        installationId,
      })
    }

    registerTitlePopupIpc({
      openChooserHostWindow,
      returnToDashboard,
      confirmAndCloseAllHostWindows: (parentWindow) =>
        confirmAndCloseAllHostWindows(parentWindow, quitApp),
      confirmAndCloseHostWindow,
      setActivePanel,
      triggerOpenFeedback,
      sendToPanelDeferred,
      ensurePanelViewForEntry: (entry) =>
        entry.panelView ?? ensurePanelView(entry.windowKey, entry, computeBodyMode(entry)),
      pickerRunBackgroundOp: ({ installationId, actionId, actionData, title, cancellable }) => {
        // Fire-and-forget: runs the action on main with a custom sendProgress
        // that feeds _activeOperationStatus so the picker snapshot loop
        // delivers live status to the inline progress view.
        void (async () => {
          const inst = await getInstallation(installationId)
          if (!inst) {
            _activeOperationStatus.set(installationId, {
              status: '', percent: -1, done: true, ok: false,
              error: 'Installation not found.', cancellable, title, actionId, actionData,
            })
            triggerPickerSnapshotBroadcast()
            return
          }

          // Guard: another op already running for this install.
          if (_operationAborts.has(installationId)) {
            _activeOperationStatus.set(installationId, {
              status: '', percent: -1, done: true, ok: false,
              error: 'Another operation is already running.', cancellable, title, actionId, actionData,
            })
            triggerPickerSnapshotBroadcast()
            return
          }

          // Stop the session if needed (REQUIRES_STOPPED).
          const wasRunning = _runningSessions.has(installationId)
          if (REQUIRES_STOPPED.has(actionId) && wasRunning) {
            _activeOperationStatus.set(installationId, {
              status: 'Stopping…', percent: -1, done: false, ok: null,
              error: null, cancellable, title, actionId, actionData,
            })
            triggerPickerSnapshotBroadcast()
            try {
              await stopRunning(installationId)
            } catch (err) {
              _activeOperationStatus.set(installationId, {
                status: '', percent: -1, done: true, ok: false,
                error: (err as Error).message ?? 'Stop failed.', cancellable, title, actionId, actionData,
              })
              triggerPickerSnapshotBroadcast()
              return
            }
          }

          // Seed the in-flight status.
          _activeOperationStatus.set(installationId, {
            status: '', percent: -1, done: false, ok: null,
            error: null, cancellable, title, actionId, actionData,
          })
          triggerPickerSnapshotBroadcast()

          // Build a stub event whose sender feeds _activeOperationStatus.
          // The action handlers route BOTH `install-progress` and raw
          // `comfy-output` chunks through this one sender. Only progress
          // drives the inline status line — output chunks are ignored, or
          // the channel name itself leaks in as the status text (the
          // literal "comfy-output" shown during a background update). The
          // real phase lives in the `install-progress` payload, not the
          // channel arg.
          const feedStatus = (channel: string, payload: Record<string, unknown>): void => {
            if (channel !== 'install-progress') return
            const cur = _activeOperationStatus.get(installationId)
            if (!cur || cur.done) return
            const status = typeof payload.status === 'string'
              ? payload.status
              : (typeof payload.phase === 'string' ? payload.phase : cur.status)
            const percent = typeof payload.percent === 'number' ? payload.percent : cur.percent
            const speedBytesPerSec = typeof payload.speedBytesPerSec === 'number' ? payload.speedBytesPerSec : cur.speedBytesPerSec
            _activeOperationStatus.set(installationId, { ...cur, status, percent, speedBytesPerSec })
            triggerPickerSnapshotBroadcast()
          }
          const stubSender = {
            isDestroyed: () => false,
            send: feedStatus as unknown as Electron.WebContents['send'],
          } as unknown as Electron.WebContents
          const stubEvent = { sender: stubSender } as unknown as Electron.IpcMainInvokeEvent

          let result: PickerOperationStatus
          try {
            const actionResult = await dispatchSessionAction(
              { event: stubEvent, installationId, inst, actionData },
              actionId,
            )
            const wantsRelaunch = wasRunning && IN_PLACE_RELAUNCH.has(actionId)
            if (actionResult.ok && wantsRelaunch) {
              // Re-fetch inst (may have changed version after update).
              const freshInst = await getInstallation(installationId) ?? inst
              await handleLaunch({ event: stubEvent, installationId, inst: freshInst, actionData: undefined })
            }
            // `actionResult.cancelled === true` is the user-cancel
            // signal from handlers that route through
            // `withAbortableSessionAction`. Map it to `MSG_CANCELLED`
            // (the single string the renderer's inline-picker progress
            // card matches on) so the user sees a "Cancelled" banner
            // instead of a misleading success state.
            const wasCancelled = actionResult.cancelled === true
            result = {
              status: '', percent: wasCancelled ? -1 : 100, done: true,
              ok: !wasCancelled && actionResult.ok !== false,
              error: wasCancelled
                ? MSG_CANCELLED
                : (actionResult.ok === false ? (actionResult.message ?? 'Failed.') : null),
              cancellable, title, actionId, actionData,
            }
          } catch (err) {
            const abort = _operationAborts.get(installationId)
            result = {
              status: '', percent: -1, done: true, ok: false,
              error: abort?.signal.aborted ? MSG_CANCELLED : ((err as Error).message ?? 'Failed.'),
              cancellable, title, actionId, actionData,
            }
          }
          _activeOperationStatus.set(installationId, result)
          triggerPickerSnapshotBroadcast()
          // Auto-purge the done entry after 15s so a picker re-opened
          // after the op completes shows the normal settings view again.
          setTimeout(() => {
            const cur = _activeOperationStatus.get(installationId)
            if (cur?.done) {
              _activeOperationStatus.delete(installationId)
              triggerPickerSnapshotBroadcast()
            }
          }, 15_000)
        })()
      },
      broadcastPickerSnapshot: () => triggerPickerSnapshotBroadcast(),
      getInstancePickerInstalls: async () => {
        // Same shape `get-installations` returns to the renderer-side
        // `installationStore` — sharing the enrichment helper means the
        // picker can't drift from the chooser tile's data layout.
        const all = await listInstallations()
        const { enriched } = enrichInstallationsForRenderer(all)
        return enriched as unknown as InstancePickerInstall[]
      },
      getRunningInstallationIds: () => Array.from(_runningSessions.keys()),
      // Per-install Settings + Snapshots payload for the picker's
      // right-pane accordions. Both reads route through the same
      // source helpers the unified Settings drawer uses
      // (`getDetailSections` + `getSnapshotListData`) so the picker
      // can't render data that diverges from the drawer's view.
      getPickerDetailsForInstall: async (installationId) => {
        const inst = await getInstallation(installationId)
        if (!inst) return { settings: null, snapshots: null }
        const source = sourceMap[inst.sourceId]
        const settings = source
          ? (source.getDetailSections(inst) as Record<string, unknown>[])
          : null
        let snapshots: Record<string, unknown> | null = null
        if (inst.installPath) {
          try {
            const data = await getSnapshotListData(inst.installPath)
            snapshots = { ...data, copyEvents: [] }
          } catch (err) {
            console.error(`Picker: snapshot read failed for ${installationId}:`, err)
            snapshots = null
          }
        }
        return { settings, snapshots }
      },
      pickerUpdateField: async (installationId, fieldId, value) => {
        // Single-field update routes through the existing
        // `update-installation` shape the drawer uses. The whitelist
        // there derives editable ids from each source's
        // `getDetailSections`, so a picker-side edit is automatically
        // rejected if the field isn't editable — no separate guard
        // needed.
        const inst = await getInstallation(installationId)
        if (!inst) return { ok: false, message: 'Installation not found.' }
        const source = sourceMap[inst.sourceId]
        if (!source) return { ok: false, message: 'Unknown source.' }
        const sections = source.getDetailSections(inst) as Record<string, unknown>[]
        const allowed = new Set<string>(['name', 'seen'])
        for (const section of sections) {
          const fields = section.fields as Record<string, unknown>[] | undefined
          if (!fields) continue
          for (const f of fields) {
            if (f.editable && typeof f.id === 'string') allowed.add(f.id)
          }
        }
        if (!allowed.has(fieldId)) {
          return { ok: false, message: `Field '${fieldId}' is not editable.` }
        }
        try {
          await updateInstallation(installationId, { [fieldId]: value })
          // Channel switch must kick a check-update; otherwise the new
          // channel's available-update tag never appears until the user
          // manually clicks "Check for updates".
          if (fieldId === 'updateChannel') {
            const next = await getInstallation(installationId)
            if (next) {
              const abort = new AbortController()
              source.handleAction('check-update', next, undefined, {
                update: (data) => updateInstallation(installationId, data).then(() => { }),
                sendProgress: () => { },
                sendOutput: () => { },
                signal: abort.signal,
              }).catch((err) => {
                console.error(`Picker: check-update after channel switch failed for ${installationId}:`, err)
              })
            }
          }
          return { ok: true }
        } catch (err) {
          return { ok: false, message: err instanceof Error ? err.message : 'Update failed.' }
        }
      },
      pickerRunAction: async (installationId, actionId, actionData) => {
        // Delegate to the same source-action dispatch the
        // `run-action` IPC uses. The action allowlist enforced one
        // layer up (`comfy-titlepopup:picker-run-action`) restricts
        // this to short snapshot-lifecycle actions that don't need
        // streaming progress UI, so we pass stub progress callbacks
        // rather than wiring a sender — the picker handles
        // success/failure via the awaited return.
        try {
          const inst = await getInstallation(installationId)
          if (!inst) return { ok: false, message: 'Installation not found.' }
          const source = sourceMap[inst.sourceId]
          if (!source) return { ok: false, message: 'Unknown source.' }
          const abort = new AbortController()
          const result = await source.handleAction(actionId, inst, actionData, {
            update: (data) => updateInstallation(installationId, data).then(() => { }),
            sendProgress: () => { },
            sendOutput: () => { },
            signal: abort.signal,
          })
          return {
            ok: result.ok !== false,
            message: typeof result.message === 'string' ? result.message : undefined,
          }
        } catch (err) {
          return { ok: false, message: err instanceof Error ? err.message : 'Action failed.' }
        }
      },
      pickInstallFromPicker,
      restartInstallFromPicker: async (installationId, parentEntryId) => {
        // Restart: same install, same window. The session is stopped
        // and a fresh launch is triggered; `onLaunch`'s existing-
        // window short-circuit reloads the comfyView URL in place
        // without re-creating the BrowserWindow or the entry.
        //
        // Confirm via the shell-level system-modal overlay parented to
        // the host so the prompt visually belongs to the window that
        // initiated the restart. Same primitive `confirmAndCloseAllHostWindows`
        // uses, so the launcher's confirm surface is consistent across
        // shell-level prompts (and Playwright-driveable end to end).
        const parentEntry = comfyWindows.get(parentEntryId)
        if (!parentEntry || parentEntry.window.isDestroyed()) return
        const confirmed = await openSystemModalAsync({
          parent: parentEntry.window,
          spec: {
            title: 'Restart instance?',
            message: 'Restart this instance?',
            details: [
              {
                label: 'Heads up',
                items: [
                  'Restarting will stop the running session.',
                  'Any unsaved work in the workflow will be lost.',
                ],
              },
            ],
            confirmLabel: 'Restart',
            cancelLabel: 'Cancel',
            confirmStyle: 'primary',
            theme: parentEntry.lastTheme,
          },
        })
        if (!confirmed) return
        // Stop is idempotent — awaiting ensures the process is fully
        // gone before the re-launch so the new session doesn't race a
        // port that's still bound.
        try {
          await ipc.stopRunning(installationId)
        } catch (err) {
          console.error(`Picker restart: stop failed for ${installationId}:`, err)
          return
        }
        // Direct-fire the launch action through the host's panel —
        // bypasses `pickInstallFromPicker`'s focus-existing short-
        // circuit (which would block re-launch because the host's
        // window is still alive and bound to this install). The panel's
        // `useDeepLinkRouter` routes `picker-pick-install` to
        // `performPickerLaunch`, which runs the launch action; the
        // existing-window onLaunch path handles the in-place URL
        // reload — no detach, no window churn.
        if (!parentEntry || parentEntry.window.isDestroyed()) return
        const panelView = parentEntry.panelView
          ?? ensurePanelView(parentEntryId, parentEntry, computeBodyMode(parentEntry))
        if (panelView.webContents.isDestroyed()) return
        sendToPanelDeferred(panelView, 'panel-trigger-overlay', {
          kind: 'picker-pick-install',
          installationId,
        })
      },
    })
    // Picker expanded-Manage IPC: thin pass-throughs from the popup
    // process to the existing panel-facing IPC handlers. Must register
    // AFTER `ipc.register()` (or anything else that mounts the panel-
    // facing channels we forward to) — `_invokeHandlers.get()` resolves
    // lazily on each invoke, but registering this side first wouldn't
    // change behaviour, only ordering. Place it next to the existing
    // popup IPC registration for grouping.
    registerPickerSettingsIpc()
    registerDownloadHandlers()
    registerAssetDownloadHandlers({ findInstallationIdForWindow })
    cleanupTempDownloads()
    ipc.register({
      onLaunch,
      onStop,
      onComfyExited,
      onComfyRestarted,
      onModelFolderRelaunch,
      onLocaleChanged: updateTrayMenu,
      // Repaint install-less host windows whenever the launcher theme
      // flips. Install-backed windows are driven by ComfyUI's in-page
      // theme observer (see `applyComfyTheme` in openComfyWindow), so
      // they don't need this hook.
      onThemeChanged: applyChooserHostThemeToAll,
    })
    updater.register()
    // Forward updater state transitions to every host window's
    // title-bar webContents. Subscribed once at startup; the helper
    // iterates `comfyWindows` so newly-opened windows pick up live
    // transitions automatically (initial state is pushed on
    // `comfy-window:title-bar-ready` for the slow path).
    updater.onUpdateStateChanged(_broadcastAppUpdateStateToTitleBars)
    // Fan out downloads-tray state changes to every host window's
    // title-bar. Drives the always-visible tray icon / badge; newly-
    // opened windows pick up live transitions automatically.
    downloadEvents.on('tray-state-changed', _broadcastDownloadsToTitleBars)
    // Tray / docking is disabled while the unified-window flow is being
    // rebuilt — closing the last window quits the app instead of
    // collapsing it into a hidden background process. The `onAppClose`
    // setting (settings.ts), the settings-UI field
    // (registerSettingsHandlers.ts), the `createTray()` startup call,
    // and the tray-aware `window-all-closed` gating will all come back
    // when the docked-app flow is reinstated. Until then, see git
    // history for the previous tray construction code.
    // The install-less chooser host is the primary surface. Each
    // install gets its own ComfyUI window via openComfyWindow()
    // when launched, and the chooser host is the entry-point for
    // picking / creating installs.
    openOrFocusChooserHostWindow()

    // Single subscription rebroadcasts every install-list mutation
    // (add/remove/update/markLaunched/reorder/...) to all renderers as
    // `installations-changed`, so the renderer-side installation store
    // can refetch without every IPC handler having to remember to call
    // _broadcastToRenderer itself. Lives at app level (not per-window)
    // so it survives chooser-host / comfy-window churn.
    installationEvents.on('changed', () => {
      _broadcastToRenderer('installations-changed', {})
    })

    // Auto-detach install-backed host windows whose install has been
    // removed from the registry (delete-action or untrack-action). Without
    // this, an install-backed host would keep rendering chrome / IPC
    // wiring for a non-existent install, leading to broken state on the
    // next reload and dangling references in the title-bar / panel. The
    // hook is generic — any future removal path is covered by the same
    // registry-membership check.
    installationEvents.on('changed', () => {
      void (async () => {
        const liveIds = new Set((await listInstallations()).map((i) => i.id))
        detachOrphanedInstallHosts(liveIds)
      })()
    })

    // Background poll: keep the shared ComfyUI release cache fresh so
    // dashboard / title-bar update pills surface upstream releases
    // within 15 minutes even when the user never opens the picker or
    // clicks "Check for Update". The timer is `unref()`-ed inside the
    // helper so it never blocks app quit; we still tear it down
    // explicitly in `before-quit` for cleanliness across `app.relaunch`.
    // Tests override the cadence via `E2E_PERIODIC_RECHECK_MS` so the
    // periodic-poll lifecycle assertion doesn't have to wait 15 wall-
    // clock minutes per run.
    const _periodicIntervalMs = process.env['E2E_PERIODIC_RECHECK_MS']
      ? Number(process.env['E2E_PERIODIC_RECHECK_MS'])
      : undefined
    _stopPeriodicReleaseChecks = startPeriodicReleaseChecks(listInstallations, {
      onRefreshed: () => _broadcastToRenderer('installations-changed', {}),
      ...(typeof _periodicIntervalMs === 'number' && Number.isFinite(_periodicIntervalMs)
        ? { intervalMs: _periodicIntervalMs }
        : {}),
    })
  })

  app.on('activate', () => {
    // macOS dock click — focus an existing host window before
    // spawning a fresh chooser host.
    openOrFocusAnyHostWindow()
  })

  app.on('before-quit', () => {
    if (!isQuitInProgress()) {
      setQuitReason('user-quit')
      ipc.cancelAll()
      for (const [, entry] of comfyWindows) {
        if (!entry.window.isDestroyed()) entry.window.destroy()
      }
      comfyWindows.clear()
      if (tray) {
        tray.destroy()
        tray = null
      }
    }
    if (_stopPeriodicReleaseChecks) {
      _stopPeriodicReleaseChecks()
      _stopPeriodicReleaseChecks = null
    }
    cleanupTempDownloads()
  })

  app.on('window-all-closed', () => {
    // With docking disabled (tray creation is currently a no-op), the
    // app should quit when the last window closes. The
    // `hasRunningSessions()` guard remains so an in-flight install /
    // running ComfyUI session keeps the process alive even if every
    // visible window happens to be closed momentarily — but in practice
    // closing a comfy window also stops its session, so this is mostly
    // a safety net. When docking comes back, restore the original
    // `if (!tray && !ipc.hasRunningSessions())` gating.
    if (!ipc.hasRunningSessions()) {
      app.quit()
    }
  })
}
