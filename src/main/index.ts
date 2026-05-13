import { app, BrowserWindow, Menu, ipcMain, dialog, shell, net, WebContentsView } from 'electron'
// Type-only while docking-to-tray is disabled.
import type { Tray } from 'electron'
import path from 'path'
import fs from 'fs'
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
import { attachContextMenu } from './lib/contextMenu'
import { getSavedBounds, getWindowOptions, saveWindowBounds } from './lib/windowState'
import { forwardDatadogError, registerProcessErrorHandlers } from './lib/processErrorHandlers'
import {
  registerTitleTooltipIpc,
} from './popups/titleTooltip'
import {
  ensureSystemModal,
  openSystemModal,
  registerSystemModalIpc,
} from './popups/systemModal'
import { prewarmTitlePopup, registerTitlePopupIpc } from './popups/titlePopup'
import { waitForPort, COMFY_BOOT_TIMEOUT_MS } from './lib/process'
import { isQuitInProgress, setQuitReason } from './lib/quit-state'
import type { InstallationRecord } from './installations'
import {
  attachSessionDownloadHandler,
  cleanupTempDownloads,
  detachWindowDownloads,
  downloadEvents,
  getDownloadsTrayState,
  registerDownloadIpc,
} from './lib/comfyDownloadManager'
import { registerAssetDownloadHandlers } from './lib/ipc/registerAssetDownloadHandlers'
import { get as getInstallation, installationEvents } from './installations'
import { getModelDownloadContentScript } from './lib/comfyContentScript'
import { shouldOpenInPopup } from './lib/allowedPopups'
import { showModelFolderRelaunchPage } from './lib/relaunchPage'
import { COMFY_BG, SPLASH_DARK, TITLEBAR_BG, type SplashTheme } from './lib/theme'
import { TITLEBAR_HEIGHT, TRAFFIC_LIGHT_POSITION, comfyTitleBarOverlay, titleBarOverlayForTheme } from './lib/titleBarOverlay'
import { resolveTheme, sourceMap, _registerExtraBroadcastTarget, _unregisterExtraBroadcastTarget, _broadcastToRenderer, _operationAborts } from './lib/ipc/shared'
import * as mainTelemetry from './lib/telemetry'
import { getDeviceId } from './lib/deviceId'

import {
  bringToFront,
  comfyWindows,
  computeBodyMode,
  dropInstallationIndex,
  findEntryByTitleBarSender,
  getEntryByInstallationId,
  indexInstallationId,
  nextWindowKey,
  openOrFocusAnyHostWindow,
  openOrFocusChooserHostWindow,
  pendingAttachClaims,
  registerHostEntry,
  setHostFactories,
  setLastFocusedInstallationId,
  unregisterHostEntry,
  VALID_PANELS,
} from './host/registry'
import type { BodyMode, ComfyPanelKey, ComfyWindowEntry } from './host/registry'

export type { ComfyPanelKey } from './host/registry'

todesktop.init({ autoUpdater: false })

const APP_ICON = path.join(__dirname, '..', '..', 'assets', 'Comfy_Logo_x256.png')
const APP_VERSION = getAppVersion()

/** Center pill text for install-less host windows (chooser/dashboard). */
const CHOOSER_HOST_TITLE_TEXT = 'Desktop 2.0 Beta'
/** OS-level window title for install-less host windows. */
const CHOOSER_HOST_WINDOW_TITLE = `${CHOOSER_HOST_TITLE_TEXT} — v${APP_VERSION}`

// The chooser host window plus per-install ComfyUI windows are the
// only top-level surfaces.
let tray: Tray | null = null

/**
 * Re-evaluate the body mode for a comfy window after a session-state
 * transition (instance launched / stopped / crashed) and reflect it in the
 * layout. When the body mode is `'comfy-lifecycle'`, the panelView is created
 * (if needed) and asked to render the lifecycle UI; the title-bar pill stays
 * on `'comfy'` either way.
 */
function refreshComfyTabBody(installationId: string): void {
  const entry = getEntryByInstallationId(installationId)
  if (!entry || entry.window.isDestroyed()) return
  if (entry.activePanel !== 'comfy') return

  const mode = computeBodyMode(entry)
  if (mode === 'comfy-lifecycle') {
    const panelView = ensurePanelView(entry.windowKey, entry, 'comfy-lifecycle')
    if (!panelView.webContents.isDestroyed() && !panelView.webContents.isLoadingMainFrame()) {
      panelView.webContents.send('panel-switch', { panel: 'comfy-lifecycle', installationId })
    }
  }
  entry.layoutViews()
  focusActiveBody(entry)
}

function focusExternalProcessWindow(pid: number): void {
  if (process.platform === 'win32') {
    // AppActivate accepts a numeric PID to bring the process window to the foreground.
    // wscript is near-instant compared to PowerShell.
    const vbsPath = path.join(app.getPath('temp'), `comfy-focus-${pid}.vbs`)
    fs.writeFileSync(vbsPath, `CreateObject("WScript.Shell").AppActivate ${pid}`)
    execFile('wscript.exe', ['//Nologo', '//B', vbsPath], { windowsHide: true }, () => {
      fs.unlink(vbsPath, () => {})
    })
  } else if (process.platform === 'darwin') {
    execFile('osascript', ['-e',
      `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`,
    ], () => {})
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

/**
 * Pre-cleared close set. Marks a window as having already passed
 * the panel renderer's tier-aware consult so the subsequent `close`
 * event handler can skip the consult and tear down immediately.
 * Used by `confirmAndCloseAllHostWindows` (the global confirm
 * dialog already lists in-progress operations / sessions /
 * downloads, so the per-window prompt would be redundant noise
 * after the user confirmed the bulk close).
 */
const preClearedClose = new WeakSet<BrowserWindow>()

/**
 * Main consults the panel renderer before tearing down a host
 * window so a Tier 2 progress / Tier 3 takeover overlay can
 * prompt the user to confirm cancellation via the standardised
 * cancel-prompt copy. Returns true when the renderer cleared the
 * close (no overlay open, or the user confirmed cancellation),
 * false when the renderer aborted (user dismissed the prompt).
 *
 * Falls back to "cleared" when the panelView is missing (no panel
 * has been mounted yet — nothing to lose), the webContents is
 * destroyed (already torn down), the renderer doesn't ack receipt
 * of the request within 2s (hung renderer), or the underlying
 * webContents goes away (render-process-gone / destroyed).
 *
 * Important: once the renderer acks receipt we wait INDEFINITELY for
 * the actual response. The renderer might be showing a confirmation
 * modal that the user takes their time on; an extra fixed timeout
 * here would force-close the window out from under that prompt
 * (which was the bug observed when a sub-5s prompt-response window
 * triggered an unconfirmed close).
 */
async function consultPanelRendererClose(panelView: WebContentsView | null | undefined): Promise<boolean> {
  if (!panelView || panelView.webContents.isDestroyed()) return true
  return new Promise<boolean>((resolve) => {
    const requestId = `close-${Date.now()}-${Math.random().toString(36).slice(2)}`
    let settled = false
    let acked = false
    const cleanup = (): void => {
      ipcMain.off('comfy-window:request-close-ack', onAck)
      ipcMain.off('comfy-window:request-close-response', onResponse)
      if (!panelView.webContents.isDestroyed()) {
        panelView.webContents.off('render-process-gone', onCrash)
        panelView.webContents.off('destroyed', onCrash)
      }
    }
    const onAck = (
      event: Electron.IpcMainEvent,
      payload: { requestId?: string } | undefined,
    ): void => {
      if (event.sender !== panelView.webContents) return
      if (payload?.requestId !== requestId) return
      acked = true
    }
    const onResponse = (
      event: Electron.IpcMainEvent,
      payload: { requestId?: string; cleared?: boolean } | undefined,
    ): void => {
      if (event.sender !== panelView.webContents) return
      if (payload?.requestId !== requestId) return
      if (settled) return
      settled = true
      cleanup()
      resolve(!!payload?.cleared)
    }
    const onCrash = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(true)
    }
    ipcMain.on('comfy-window:request-close-ack', onAck)
    ipcMain.on('comfy-window:request-close-response', onResponse)
    panelView.webContents.on('render-process-gone', onCrash)
    panelView.webContents.on('destroyed', onCrash)
    try {
      panelView.webContents.send('comfy-window:request-close', { requestId })
    } catch {
      settled = true
      cleanup()
      resolve(true)
      return
    }
    // Hung-renderer safety: only fires if we never got the ack. Once
    // the renderer acks receipt we trust it to either reply or have
    // its webContents torn down (render-process-gone covers that).
    setTimeout(() => {
      if (settled || acked) return
      settled = true
      cleanup()
      resolve(true)
    }, 2000)
  })
}

/**
 * Close every host window (install-backed and chooser hosts alike) but
 * leave the app / tray alive. Bound to the File menu's "Close All
 * Windows" entry. Each window's existing `close` handler runs the
 * full teardown (`stopRunning` + webContents close + window.destroy),
 * so we just dispatch `close()` and let those handlers do the work
 * — the handlers also consult the panel renderer unless the window
 * is already in `preClearedClose`. Snapshot the entry list
 * first so the iteration isn't affected by `closed` callbacks that
 * delete from the `comfyWindows` map mid-loop.
 */
function closeAllHostWindows(): void {
  const entries = Array.from(comfyWindows.values())
  for (const entry of entries) {
    if (!entry.window.isDestroyed()) entry.window.close()
  }
}

/**
 * File menu's "Return to Dashboard" entry. Closes the install-backed
 * host window and opens a chooser host window at the same bounds.
 *
 * In-place flip via `entry.detachInstall()` is currently disabled
 * — too many edge-case bugs around the in-place swap. The close+open
 * swap pays a visible flicker but exercises the same close-handler
 * teardown that production has used since main, which is the
 * codepath we trust right now. See
 * docs/window-mode-unification-revert.md.
 */
async function returnToDashboard(parentEntryId: number): Promise<void> {
  const entry = comfyWindows.get(parentEntryId)
  if (!entry || entry.installationId === null || entry.window.isDestroyed()) return
  const cleared = await consultPanelRendererClose(entry.panelView)
  if (!cleared) return
  if (entry.window.isDestroyed()) return
  preClearedClose.add(entry.window)
  const bounds = entry.window.getBounds()
  const wasMaximized = entry.window.isMaximized()
  const chooserWindow = openChooserHostWindow()
  if (!chooserWindow.isDestroyed()) {
    if (wasMaximized) {
      chooserWindow.maximize()
    } else {
      chooserWindow.setBounds(bounds)
    }
  }
  entry.window.close()
}

/**
 * Confirm a `closeAllHostWindows()` dispatch when more than one host
 * window is open. The dialog lists the open windows by title (so the
 * user can see what's about to close) and any active operations that
 * will be cancelled — running ComfyUI sessions, in-progress
 * installs / updates, active model downloads — pulled from the same
 * `getActiveDetails()` helper. With one or zero windows the close
 * happens straight through with no prompt.
 */
async function confirmAndCloseAllHostWindows(parentWindow: BrowserWindow | null): Promise<void> {
  const entries = Array.from(comfyWindows.values()).filter((e) => !e.window.isDestroyed())
  if (entries.length <= 1) {
    closeAllHostWindows()
    return
  }
  const titles = entries.map((e) => e.window.getTitle() || 'Untitled window')
  const detailLines: string[] = ['Open windows:', ...titles.map((t) => `  • ${t}`)]
  if (ipc.hasActiveOperations()) {
    try {
      const items = await ipc.getActiveDetails()
      const sessions = items.filter((i) => i.type === 'session').map((i) => i.name)
      const operations = items.filter((i) => i.type === 'operation').map((i) => i.name)
      const downloads = items.filter((i) => i.type === 'download').map((i) => i.name)
      if (sessions.length > 0) {
        detailLines.push('', 'Running ComfyUI:', ...sessions.map((n) => `  • ${n}`))
      }
      if (operations.length > 0) {
        detailLines.push('', 'In-progress operations:', ...operations.map((n) => `  • ${n}`))
      }
      if (downloads.length > 0) {
        detailLines.push('', 'Active downloads:', ...downloads.map((n) => `  • ${n}`))
      }
    } catch {
      // If active-detail collection ever throws, fall back to just the
      // window list — the user still sees what's about to close.
    }
  }
  const opts: Electron.MessageBoxOptions = {
    type: 'question',
    buttons: ['Close All', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Close All Windows',
    message: `Close ${entries.length} open windows?`,
    detail: detailLines.join('\n'),
  }
  const result = parentWindow && !parentWindow.isDestroyed()
    ? await dialog.showMessageBox(parentWindow, opts)
    : await dialog.showMessageBox(opts)
  if (result.response === 0) {
    // The global dialog already lists in-progress ops / sessions /
    // downloads, so the per-window tier-aware prompt would be
    // redundant after the user confirmed the bulk close. Pre-clear
    // every entry so each window's `close` handler skips its own
    // consult and tears down immediately.
    for (const entry of entries) preClearedClose.add(entry.window)
    closeAllHostWindows()
  }
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
    // Refresh every install-backed entry's comfy tab. Install-less
    // host windows (entry.
    // installationId === null) have no comfy lifecycle to refresh,
    // so they're skipped naturally.
    for (const entry of comfyWindows.values()) {
      if (entry.installationId !== null) {
        refreshComfyTabBody(entry.installationId)
      }
    }
  }
}

/**
 * On macOS, Electron's WebAuthn/passkey support is broken (electron#24573).
 * Inject a fixed warning banner into auth popups (Google, GitHub) so users
 * know to use password + OTP instead of passkeys.
 */
const PASSKEY_BANNER_PREFIXES = [
  'https://accounts.google.com/',
  'https://github.com/login',
]

const PASSKEY_BANNER_CSS =
  `#comfy-passkey-banner{position:fixed;top:0;left:0;right:0;z-index:999999;` +
  `background:#eff6ff;color:#1e40af;font:13px/1.4 system-ui,sans-serif;` +
  `padding:8px 12px;text-align:center;border-bottom:1px solid #93c5fd;box-sizing:border-box;}`

const PASSKEY_BANNER_JS =
  `(function(){` +
    `if(document.getElementById('comfy-passkey-banner'))return;` +
    `const b=document.createElement('div');b.id='comfy-passkey-banner';` +
    `b.textContent='\\u24d8 Passkeys are not supported in Desktop 2.0 on macOS. Please use your password or verification code to sign in.';` +
    `document.body.prepend(b);` +
    `document.body.style.paddingTop=(b.offsetHeight)+'px';` +
    `new MutationObserver(function(){` +
      `if(!document.getElementById('comfy-passkey-banner')){` +
        `document.body.prepend(b);document.body.style.paddingTop=(b.offsetHeight)+'px'` +
      `}` +
    `}).observe(document.body,{childList:true});` +
  `})()`

function injectMacPasskeyWarning(childWindow: BrowserWindow): void {
  if (process.platform !== 'darwin') return

  const inject = (): void => {
    const url = childWindow.webContents.getURL()
    if (!PASSKEY_BANNER_PREFIXES.some((prefix) => url.startsWith(prefix))) return
    childWindow.webContents
      .insertCSS(PASSKEY_BANNER_CSS)
      .then(() => childWindow.webContents.executeJavaScript(PASSKEY_BANNER_JS))
      .catch(() => {})
  }

  childWindow.webContents.on('dom-ready', inject)
  childWindow.webContents.on('did-navigate-in-page', inject)
}

/**
 * Single shared constructor for host windows (install-backed and
 * install-less). Builds the BrowserWindow + titleBarView +
 * comfyView, wires `layoutViews` + macOS fullscreen forwarding +
 * bounds-save listeners + the close / closed handlers + the
 * title-bar-ready handshake, and registers the entry into the
 * `comfyWindows` map.
 *
 * Mode-specific wiring is layered on AFTER this returns by the two
 * thin wrapper paths (`onLaunch` for install-backed; the body of
 * `openChooserHostWindow` for install-less) — comfyContents
 * listeners (theme observer, content script, fail-retry,
 * render-process-gone), `attachSessionDownloadHandler`, the
 * install-record `'updated'` handler, and the chooser-only eager
 * `ensurePanelView('chooser')` all live in the wrappers.
 */
interface CreateHostWindowOpts {
  /** Initial OS-level window title (full string, including app-version suffix). */
  windowTitle: string
  /** Bounds-persistence cache key. */
  boundsKey: string
  /** Initial entry theme — title-bar background + descrip text colour. */
  initialTheme: { bg: string; text: string }
  /**
   * Per-platform `titleBarOverlay` constructor option. Pass `undefined`
   * on darwin (we use `trafficLightPosition` instead).
   */
  titleBarOverlay: Electron.TitleBarOverlay | undefined
  /**
   * comfyView WebPreferences. Install-backed gets the comfyPreload +
   * per-install browser partition; install-less gets minimal prefs (no
   * preload, default partition — the dummy view never loads a URL).
   */
  comfyWebPreferences: Electron.WebPreferences
  /** Background colour to pre-paint the title-bar view with (avoids first-paint flash). */
  titleBarBackground: string
  /** `installationId` query param for the title-bar HTML load (empty string for chooser hosts). */
  titleBarInstallationIdParam: string
  /**
   * Initial title-bar pill label. Install-backed wrappers pass the
   * install name; chooser hosts pass `'Desktop 2.0 Beta'`. Stored on
   * `entry.titleBarText` so the unified `title-bar-ready` handshake
   * can re-push it without a per-mode callback.
   */
  initialTitleBarText: string
  /**
   * Initial install-type icon category. Install-backed wrappers pass
   * the resolved `sourceMap[].category`; chooser hosts pass `null`
   * (no icon).
   */
  initialSourceCategory: string | null
}

interface CreateHostWindowResult {
  windowKey: number
  comfyWindow: BrowserWindow
  titleBarView: WebContentsView
  comfyView: WebContentsView
  entry: ComfyWindowEntry
  /** Bound `layoutViews` for the new entry; the wrapper calls this once after wiring. */
  layoutViews: () => void
}

function createHostWindow(opts: CreateHostWindowOpts): CreateHostWindowResult {
  const windowKey = nextWindowKey()
  const saved = getSavedBounds(opts.boundsKey)
  const windowOptions = getWindowOptions(opts.boundsKey)
  const comfyWindow = new BrowserWindow({
    ...windowOptions,
    minWidth: 800,
    minHeight: 600,
    icon: APP_ICON,
    title: opts.windowTitle,
    backgroundColor: COMFY_BG,
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: TRAFFIC_LIGHT_POSITION }
      : { titleBarOverlay: opts.titleBarOverlay }),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })
  comfyWindow.setMenuBarVisibility(false)

  // Title bar view — bounded to TITLEBAR_HEIGHT, isolated from the body.
  // Uses the comfyTitleBarPreload bridge regardless of mode (panel switch
  // buttons, theme updates, downloads tray, etc.).
  const titleBarView = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // sandbox: false — comfyTitleBarPreload imports the shared
      // src/preload/api.ts (window.api bridge), which Rollup emits as a
      // separate chunk under out/preload/chunks/. Sandboxed preloads can
      // only require() from electron/events/timers/url, so the chunk
      // require would fail silently and leave window.api undefined,
      // which historically blanked the title-bar renderer and broke
      // renderer-side telemetry. contextIsolation + nodeIntegration:false
      // remain on, so renderer JS still has no Node access.
      // Tracked: issue #521 (build-time chunk inlining to re-enable sandbox).
      sandbox: false,
      preload: path.join(__dirname, '../preload/comfyTitleBarPreload.js'),
    },
  })
  titleBarView.setBackgroundColor(opts.titleBarBackground)
  {
    const isDev = !!process.env['ELECTRON_RENDERER_URL']
    const tbLoad = isDev
      ? titleBarView.webContents.loadURL(
          `${(process.env['ELECTRON_RENDERER_URL'] as string).replace(/\/$/, '')}/comfyTitleBar.html?installationId=${encodeURIComponent(opts.titleBarInstallationIdParam)}`,
        )
      : titleBarView.webContents.loadFile(
          path.join(__dirname, '../renderer/comfyTitleBar.html'),
          { query: { installationId: opts.titleBarInstallationIdParam } },
        )
    void tbLoad.catch(() => {})
  }
  comfyWindow.contentView.addChildView(titleBarView)
  _registerExtraBroadcastTarget(titleBarView.webContents)
  // Title bar is the always-alive renderer per host window — register it as
  // the canonical telemetry relay target so main-emitted events reach
  // Datadog RUM regardless of whether the panelView is currently mounted
  // (steady-state `comfy` mode tears the panel down). Exactly one relay
  // target per host window prevents Datadog double-counting; PostHog is
  // already captured by the Node SDK in main and suppressed in the relay
  // payload (`mainAlreadyCaptured: true`).
  mainTelemetry.registerTelemetryRelayTarget(titleBarView.webContents)

  // Body view. Install-less leaves it dummy and zero-sized; install-backed
  // loads the URL via attachInstall.
  const comfyView = buildComfyView(comfyWindow, opts.comfyWebPreferences, windowKey)
  comfyWindow.contentView.addChildView(comfyView)

  // Title bar is 1px taller than the overlay so a CSS border-bottom in
  // comfyTitleBar.html sits below the native buttons.
  const titleBarTotal = TITLEBAR_HEIGHT + 1
  const layoutViews = (): void => {
    if (comfyWindow.isDestroyed()) return
    const entry = comfyWindows.get(windowKey)
    const [width, height] = comfyWindow.getContentSize() as [number, number]
    const bodyHeight = Math.max(0, height - titleBarTotal)
    const bodyRect = { x: 0, y: titleBarTotal, width, height: bodyHeight }
    titleBarView.setBounds({ x: 0, y: 0, width, height: titleBarTotal })

    // The Comfy pill maps to the live ComfyUI view *or* a panel
    // (lifecycle / chooser / settings / etc.) depending on mode.
    // `computeBodyMode` already returns `'chooser'` for install-less
    // hosts, so the install-backed visibility branch handles both.
    const mode = entry ? computeBodyMode(entry) : 'comfy'
    const showPanel = mode !== 'comfy'
    if (showPanel && entry?.panelView) {
      entry.panelView.setBounds(bodyRect)
      entry.panelView.setVisible(true)
      // Keep ComfyUI alive but collapsed so it can't intercept input.
      comfyView.setBounds({ x: 0, y: titleBarTotal, width: 0, height: 0 })
      comfyView.setVisible(false)
    } else {
      comfyView.setBounds(bodyRect)
      comfyView.setVisible(true)
      if (entry?.panelView) {
        entry.panelView.setBounds({ x: 0, y: titleBarTotal, width: 0, height: 0 })
        entry.panelView.setVisible(false)
      }
    }
  }
  comfyWindow.on('resize', layoutViews)

  if (saved?.maximized) comfyWindow.maximize()

  // On macOS fullscreen the traffic-light buttons disappear, so the title bar
  // should drop its 78px left padding for that period.
  if (process.platform === 'darwin') {
    const sendFullscreen = (fullscreen: boolean): void => {
      if (titleBarView.webContents.isDestroyed()) return
      titleBarView.webContents.send('comfy-titlebar:fullscreen-changed', fullscreen)
    }
    comfyWindow.on('enter-full-screen', () => sendFullscreen(true))
    comfyWindow.on('leave-full-screen', () => sendFullscreen(false))
  }

  comfyWindow.on('resize', () => saveWindowBounds(opts.boundsKey, comfyWindow))
  comfyWindow.on('move', () => saveWindowBounds(opts.boundsKey, comfyWindow))

  // Track the most recently focused install id so the dock-icon /
  // second-instance re-launch hooks can pick that install over an
  // arbitrary insertion-order pick when several are open. Tracking by
  // id (not by windowKey) survives a detach + re-launch into a fresh
  // host window. Chooser hosts are excluded — they have their own
  // selection path via findPreferredChooserHostWindow().
  comfyWindow.on('focus', () => {
    const entry = comfyWindows.get(windowKey)
    if (entry?.installationId) {
      setLastFocusedInstallationId(entry.installationId)
    }
  })

  // Push the initial state once the title bar's preload signals readiness.
  // Filter to this title bar's WebContents to avoid cross-talk between windows.
  //
  // The install-update pill + source-category icon are resolved off
  // the entry: the title text and source-category come from
  // `entry.titleBarText` / `entry.sourceCategory` (set by
  // `attachInstall()` for install-backed, by the chooser-host
  // wrapper for install-less); the install-update pill is computed
  // from `entry.installationId` when non-null.
  const onTitleBarReadyHandler = (event: Electron.IpcMainEvent): void => {
    if (event.sender !== titleBarView.webContents) return
    if (titleBarView.webContents.isDestroyed()) return
    const entry = comfyWindows.get(windowKey)
    titleBarView.webContents.send('comfy-titlebar:panel-changed', entry?.activePanel ?? 'comfy')
    if (entry) {
      titleBarView.webContents.send('comfy-titlebar:theme-changed', entry.lastTheme)
      titleBarView.webContents.send('comfy-titlebar:title-changed', entry.titleBarText)
      titleBarView.webContents.send('comfy-titlebar:source-category-changed', entry.sourceCategory)
    }
    // Both modes get the app-update pill and the downloads tray.
    // The install-update pill is install-backed only: gated on
    // `entry.installationId !== null` so a chooser host (or a
    // detached install-backed host) skips it cleanly.
    titleBarView.webContents.send(
      'comfy-titlebar:app-update-state-changed',
      updater.getCurrentUpdateState(),
    )
    notifyTitleBarDownloads(titleBarView)
    const installId = entry?.installationId ?? null
    if (installId !== null) {
      void computeInstallUpdateAvailable(installId).then((state) => {
        if (titleBarView.webContents.isDestroyed()) return
        titleBarView.webContents.send('comfy-titlebar:install-update-changed', state)
      })
    }
    // Pre-warm the title-menu popup so the user's first File / Install
    // click doesn't pay the BrowserWindow construction + HTML/JS load
    // cost (~100ms).
    prewarmTitlePopup(comfyWindow)
    // Pre-warm the system-modal popup so the user's first app-update
    // pill click (or any other shell-modal trigger) doesn't pay the
    // load cost — the modal needs to feel as instant as the pill click.
    ensureSystemModal(comfyWindow)
  }
  ipcMain.on('comfy-window:title-bar-ready', onTitleBarReadyHandler)

  // Close handler is async: preventDefault, consult the panel
  // renderer (so a Tier 2/3 op can prompt the user), run the
  // attached install's symmetric cleanup if any, and only then
  // destroy. The `closingInFlight` guard prevents re-entry on rapid
  // clicks of the OS close button while the consult is pending.
  //
  // Pre-teardown work (detachWindowDownloads + ipc.stopRunning +
  // install-keyed map cleanup + installationEvents unsubscribe) is
  // consolidated on `entry._installCleanup`, which `attachInstall()`
  // sets and `detachInstall()` / window close both invoke.
  // Per-window cleanup (`detachWindowDownloads`) lives outside
  // `_installCleanup` because it survives mode flips — the
  // per-window download routing is attached at session level when
  // the install does, and only needs to be torn down when the
  // BrowserWindow itself goes away.
  let closingInFlight = false
  comfyWindow.on('close', (e) => {
    e.preventDefault()
    if (closingInFlight) return
    closingInFlight = true
    void (async () => {
      try {
        const entry = comfyWindows.get(windowKey)
        const skipConsult = preClearedClose.has(comfyWindow)
        const cleared = skipConsult ? true : await consultPanelRendererClose(entry?.panelView)
        if (!cleared) return
        preClearedClose.delete(comfyWindow)
        if (comfyWindow.isDestroyed()) return
        if (entry?._installCleanup) entry._installCleanup()
        detachWindowDownloads(comfyWindow)
        _unregisterExtraBroadcastTarget(titleBarView.webContents)
        mainTelemetry.unregisterTelemetryRelayTarget(titleBarView.webContents)
        const liveEntry = comfyWindows.get(windowKey)
        if (liveEntry?.panelView) {
          _unregisterExtraBroadcastTarget(liveEntry.panelView.webContents)
          liveEntry.panelView.webContents.close()
        }
        titleBarView.webContents.close()
        comfyView.webContents.close()
        comfyWindow.destroy()
      } finally {
        closingInFlight = false
      }
    })()
  })

  comfyWindow.on('closed', () => {
    ipcMain.off('comfy-window:title-bar-ready', onTitleBarReadyHandler)
    // Unregister via the primary windowKey AND the secondary
    // install-id index.
    const closedEntry = comfyWindows.get(windowKey)
    if (closedEntry) unregisterHostEntry(closedEntry)
    // Drop any pending attach claim whose target is THIS window.
    // Without this, stale entries pile up over the app's lifetime
    // AND can be silently consumed by an unrelated future
    // `onLaunch()` (the consumer's destroyed-window check rejects
    // them, but the side-effect `delete` still fires).
    for (const [installationId, claimedKey] of pendingAttachClaims) {
      if (claimedKey === windowKey) pendingAttachClaims.delete(installationId)
    }
  })

  const entry: ComfyWindowEntry = {
    windowKey,
    window: comfyWindow,
    comfyView,
    titleBarView,
    panelView: null,
    activePanel: 'comfy',
    lastTheme: opts.initialTheme,
    layoutViews,
    comfyUrl: '',
    // ALWAYS install-less at construction. The install-backed wrapper
    // calls `attachInstall()` immediately after this returns, which is
    // the only place that populates `installationId` (and the secondary
    // index). Pre-fix this field was seeded from `opts.installationId`,
    // which made `attachInstall()` throw on its already-attached guard
    // for every install-backed launch that fell past the existing-entry
    // and claim branches in `onLaunch()` — broken for unique-partition
    // installs (Standalone / Portable) launched from a chooser host.
    installationId: null,
    constructedPartition:
      typeof opts.comfyWebPreferences.partition === 'string'
        ? opts.comfyWebPreferences.partition
        : null,
    firstUseMode: 'none',
    titleBarText: opts.initialTitleBarText,
    sourceCategory: opts.initialSourceCategory,
    _installCleanup: null,
    // Bound below so it can self-reference the freshly-created entry.
    detachInstall: () => {},
  }
  // Bind the detach method to the freestanding impl. Done
  // post-literal so the closure captures the registered entry by
  // reference, not by a copy at literal-build time.
  entry.detachInstall = () => _detachInstallImpl(entry)
  registerHostEntry(entry)

  return { windowKey, comfyWindow, titleBarView, comfyView, entry, layoutViews }
}

/**
 * Resolve the comfyView session partition an install must be loaded
 * into. Unique-partition installs (`browserPartition === 'unique'`)
 * get their own `persist:${id}` bucket so cookies / IndexedDB /
 * Service Workers don't leak across sibling installs; everything
 * else shares `persist:shared`. Used by both the install-backed
 * wrapper (constructing a fresh comfyView) and the chooser-pick
 * claim acceptance check (rejecting claims where the host's pinned
 * partition doesn't match what the new install needs).
 */
function expectedPartitionFor(installation: InstallationRecord): string {
  return (installation.browserPartition as string | undefined) === 'unique'
    ? `persist:${installation.id}`
    : 'persist:shared'
}

/**
 * Construct a comfyView with the mode-agnostic listeners attached.
 * Extracted so rebuildComfyViewIfNeeded() can swap the view's pinned
 * partition (Electron has no API to change it post-construction).
 */
function buildComfyView(
  comfyWindow: BrowserWindow,
  webPreferences: Electron.WebPreferences,
  windowKey: number,
): WebContentsView {
  const comfyView = new WebContentsView({ webPreferences })
  comfyView.setBackgroundColor(COMFY_BG)

  const comfyContents = comfyView.webContents
  comfyContents.on('did-create-window', (childWindow) => {
    childWindow.setIcon(APP_ICON)
    if (process.platform !== 'darwin') childWindow.removeMenu()
    injectMacPasskeyWarning(childWindow)
  })
  comfyContents.setWindowOpenHandler(({ url: childUrl }) => {
    if (shouldOpenInPopup(childUrl)) {
      // preload: undefined strips our title-bar bridge so OAuth/cloud-login
      // popups can't reach the file menu IPCs.
      return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { preload: undefined } } }
    }
    shell.openExternal(childUrl)
    return { action: 'deny' }
  })
  comfyContents.on('will-prevent-unload', (e) => {
    // Only suppress beforeunload while an install actually backs the view.
    const liveEntry = comfyWindows.get(windowKey)
    if (!liveEntry || liveEntry.installationId === null) return
    e.preventDefault()
  })
  attachContextMenu(comfyWindow, comfyContents)
  return comfyView
}

/**
 * Swap the entry's comfyView for a fresh one with the install's expected
 * partition. No-op when already correct.
 */
function rebuildComfyViewIfNeeded(entry: ComfyWindowEntry, installation: InstallationRecord): void {
  const expectedPartition = expectedPartitionFor(installation)
  if (entry.constructedPartition === expectedPartition) return
  if (entry.window.isDestroyed()) return

  const oldView = entry.comfyView
  const newView = buildComfyView(
    entry.window,
    {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/comfyPreload.js'),
      partition: expectedPartition,
    },
    entry.windowKey,
  )
  entry.window.contentView.addChildView(newView)
  oldView.setVisible(false)
  entry.window.contentView.removeChildView(oldView)
  if (!oldView.webContents.isDestroyed()) oldView.webContents.close()
  entry.comfyView = newView
  entry.constructedPartition = expectedPartition
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
    existing.comfyUrl = comfyUrl
    if (!existing.comfyView.webContents.isDestroyed()) {
      existing.comfyView.setBackgroundColor(COMFY_BG)
      void existing.comfyView.webContents.loadURL(comfyUrl).catch(() => {})
    }
    // A relaunch implicitly means "land me in the live ComfyUI view",
    // so force the host's activePanel back to `'comfy'`. Without this, a
    // launch kicked off from a non-comfy panel (e.g. the install-settings
    // DetailModal) would leave the body stranded on the lifecycle /
    // settings panel — `refreshComfyTabBody` early-returns on
    // `activePanel !== 'comfy'`. The trailing `refreshComfyTabBody`
    // still handles the comfy-lifecycle → comfy body-mode swap when the
    // entry was already on `'comfy'` (setActivePanel early-returns there).
    setActivePanel(existing.windowKey, 'comfy')
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
  const claimedKey = pendingAttachClaims.get(installationId)
  if (claimedKey !== undefined) {
    pendingAttachClaims.delete(installationId)
    const claimed = comfyWindows.get(claimedKey)
    if (
      claimed &&
      !claimed.window.isDestroyed() &&
      claimed.installationId === null
    ) {
      rebuildComfyViewIfNeeded(claimed, installation)
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
      // gates on installationId === null but the boolean return
      // keeps us from blowing up if a future caller forgets). Fall
      // through to the fresh-window path below so the user still
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
    titleBarOverlay: process.platform === 'darwin' ? undefined : comfyTitleBarOverlay(),
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

/**
 * Bind a host-window entry to an installation. Layered on top of
 * `createHostWindow()` (the mode-agnostic skeleton), this is the
 * install-only wiring:
 *
 *   - mutates `entry.installationId` + `entry.comfyUrl` +
 *     `entry.titleBarText` + `entry.sourceCategory`
 *   - registers the entry into the `installationIdToWindowKey`
 *     secondary index so `getEntryByInstallationId(id)` resolves
 *   - subscribes to `installationEvents` for live rename / source
 *     mutation push to the title bar
 *   - attaches the per-install download manager session handler
 *   - wires the comfyContents listeners that depend on the install
 *     (theme report, page title, fail-retry, render-process-gone,
 *     before-input keystrokes for F5/Ctrl+R reload, dom-ready
 *     theme-observer + content-script injection)
 *   - stashes `entry._installCleanup` — the symmetric undo invoked
 *     by the close handler before view teardown AND by
 *     `detachInstall()` when the host flips back to install-less
 *     mode in place
 *   - calls `comfyContents.loadURL(comfyUrl)` to start the load
 *
 * Calling on an already-attached entry throws — callers must detach
 * first or construct a fresh window. The cleanup is idempotent
 * (calling it twice is a no-op the second time) so the close
 * handler is free to invoke it without checking detach state.
 */
interface AttachInstallOpts {
  installation: InstallationRecord
  comfyUrl: string
  /**
   * `true` for locally-launched installs (no `url` arg); `false` for
   * remote / cloud installs. Drives the `__comfyDesktop2Remote` flag
   * the content script reads at top-of-page so remote-only behaviours
   * (e.g. cloud-storage prompts) gate correctly.
   */
  isLocal: boolean
}

function attachInstall(entry: ComfyWindowEntry, opts: AttachInstallOpts): boolean {
  if (entry.installationId !== null) {
    // Defensive — every current call site gates on
    // `entry.installationId === null`, but a future caller that
    // forgets the guard would otherwise take down the entire
    // launch flow with an uncaught exception in main. Surface
    // the violation to telemetry and let the caller fall back
    // (the install-backed wrapper destroys the just-created
    // host; the claim path skips the in-place attach and the
    // wrapper recovers).
    const message =
      `attachInstall: entry windowKey=${entry.windowKey} is already attached to ` +
      `installationId=${entry.installationId}; detach first`
    console.error(message)
    forwardDatadogError({
      source: 'attach-install-already-attached',
      message,
      level: 'error',
      context: {
        origin: 'main-process',
        windowKey: String(entry.windowKey),
        existingInstallationId: entry.installationId,
        attemptedInstallationId: opts.installation.id,
      },
    })
    return false
  }
  const { installation, comfyUrl, isLocal } = opts
  const installationId = installation.id
  const comfyContents = entry.comfyView.webContents
  const comfyWindow = entry.window
  const titleBarView = entry.titleBarView

  // Seed entry install state. The secondary index is the source of
  // truth for `getEntryByInstallationId(id)` — keep it in lockstep
  // with `entry.installationId` (detach symmetrically clears both).
  entry.installationId = installationId
  entry.comfyUrl = comfyUrl
  entry.titleBarText = installation.name
  entry.sourceCategory = sourceMap[installation.sourceId]?.category ?? null
  indexInstallationId(installationId, entry.windowKey)

  // Seed the MRU tracker if this in-place attach happens on the
  // already-focused host: no fresh OS `'focus'` event would fire to
  // catch it otherwise, leaving the tracker pointing at a stale (or
  // null) install on the next dock-icon click.
  if (comfyWindow.isFocused()) {
    setLastFocusedInstallationId(installationId)
  }

  // OS-level window title is rebuilt whenever the page title or the
  // install name changes. Closures over the install lifetime — reset
  // by `_installCleanup` below.
  let currentInstallName = installation.name
  let currentPageTitle = ''
  const refreshOsWindowTitle = (): void => {
    if (comfyWindow.isDestroyed()) return
    const suffix = currentPageTitle ? ` — ${currentPageTitle}` : ''
    comfyWindow.setTitle(`${currentInstallName}${suffix} — Desktop 2.0 v${APP_VERSION}`)
  }
  refreshOsWindowTitle()

  // Push install-derived initial state — the title bar may already
  // be mounted (re-attach case). The shared title-bar-ready handshake
  // re-pushes from entry.* on a fresh mount, but the eager push covers
  // the in-place transform path.
  if (!titleBarView.webContents.isDestroyed()) {
    titleBarView.webContents.send('comfy-titlebar:title-changed', entry.titleBarText)
    titleBarView.webContents.send('comfy-titlebar:source-category-changed', entry.sourceCategory)
    void computeInstallUpdateAvailable(installationId).then((state) => {
      if (titleBarView.webContents.isDestroyed()) return
      titleBarView.webContents.send('comfy-titlebar:install-update-changed', state)
    })
  }

  // Reflect rename / source change in both the comfy tab and the
  // OS-level window title as the install record mutates. Also
  // recompute the install-update pill state (the install's source
  // may have flipped its statusTag between releases as the
  // release-cache resolves in the background).
  const onInstallationUpdated = (updated: InstallationRecord): void => {
    if (updated.id !== entry.installationId) return
    const nextTabText = updated.name
    if (nextTabText !== entry.titleBarText) {
      entry.titleBarText = nextTabText
      if (!titleBarView.webContents.isDestroyed()) {
        titleBarView.webContents.send('comfy-titlebar:title-changed', nextTabText)
      }
    }
    const nextCategory = sourceMap[updated.sourceId]?.category ?? null
    if (nextCategory !== entry.sourceCategory) {
      entry.sourceCategory = nextCategory
      if (!titleBarView.webContents.isDestroyed()) {
        titleBarView.webContents.send('comfy-titlebar:source-category-changed', nextCategory)
      }
    }
    if (updated.name !== currentInstallName) {
      currentInstallName = updated.name
      refreshOsWindowTitle()
    }
    void computeInstallUpdateAvailable(updated.id).then((state) => {
      if (titleBarView.webContents.isDestroyed()) return
      titleBarView.webContents.send('comfy-titlebar:install-update-changed', state)
    })
  }
  installationEvents.on('updated', onInstallationUpdated)

  // Sync the title bar and overlay colors with the ComfyUI frontend's theme.
  const applyComfyTheme = (bg: string, text: string): void => {
    if (comfyWindow.isDestroyed()) return
    const theme = { bg, text }
    entry.lastTheme = theme
    if (!titleBarView.webContents.isDestroyed()) {
      titleBarView.webContents.send('comfy-titlebar:theme-changed', theme)
    }
    if (process.platform !== 'darwin') {
      try { comfyWindow.setTitleBarOverlay({ color: bg, symbolColor: text }) } catch {}
    }
  }
  const onIpcMessage = (_event: Electron.IpcMainEvent, channel: string, ...args: unknown[]): void => {
    if (channel === 'desktop2-theme-report') {
      const { bg, text } = (args[0] || {}) as { bg?: string; text?: string }
      if (bg) applyComfyTheme(bg, text || '#ddd')
    }
  }
  comfyContents.on('ipc-message', onIpcMessage)

  const onPageTitleUpdated = (e: Electron.Event, title: string): void => {
    e.preventDefault()
    currentPageTitle = title
    refreshOsWindowTitle()
  }
  comfyContents.on('page-title-updated', onPageTitleUpdated)

  const COMFY_THEME_OBSERVER_JS =
    `(function(){` +
      `let last='';` +
      `function read(){` +
        `const s=getComputedStyle(document.body);` +
        `const bg=s.getPropertyValue('--comfy-menu-bg').trim();` +
        `const text=s.getPropertyValue('--descrip-text').trim();` +
        `const key=bg+'|'+text;` +
        `if(key!==last&&bg){last=key;window.__comfyDesktop2?.reportTheme?.(bg,text)}` +
      `}` +
      `new MutationObserver(()=>setTimeout(read,50)).observe(document.documentElement,{attributes:true,attributeFilter:['class','data-theme','style']});` +
      `read();` +
    `})()`

  const onDomReady = (): void => {
    comfyContents.executeJavaScript(COMFY_THEME_OBSERVER_JS).catch(() => {})
    const preamble = isLocal ? '' : 'window.__comfyDesktop2Remote = true;\n'
    comfyContents
      .executeJavaScript(preamble + getModelDownloadContentScript())
      .catch(() => {})
  }
  comfyContents.on('dom-ready', onDomReady)

  // F5 / Ctrl+R reload — gated on the entry having an install backing
  // it (a detached host returns early so the dummy view can't reload
  // a stale URL).
  const currentComfyUrl = (): string => entry.comfyUrl || comfyUrl
  const reloadComfy = (): void => {
    if (comfyWindow.isDestroyed()) return
    const id = entry.installationId
    if (id === null) return
    if (relaunchStates.has(id)) return
    comfyContents.stop()
    comfyContents.loadURL(currentComfyUrl())
  }
  const onBeforeInputEvent = (e: Electron.Event, input: Electron.Input): void => {
    if (input.type !== 'keyDown') return
    const mod = input.control || input.meta
    if (mod && input.key.toLowerCase() === 'w') {
      e.preventDefault()
      return
    }
    if (input.key === 'F5' || (input.key.toLowerCase() === 'r' && mod)) {
      e.preventDefault()
      reloadComfy()
      return
    }
    // Restore Ctrl/Cmd + =/+/-/0 zoom on the comfy WebContentsView. The default
    // accelerators target BrowserWindow.webContents (empty since #414) and the
    // app menu has no View > Zoom roles, so we wire it explicitly here. Step
    // 0.5 mirrors Electron's standard zoomLevel granularity (~91% / 110% / ...).
    // Exclude Alt to avoid AltGr / Ctrl+Alt collisions on non-US layouts.
    //
    // NOTE on view hot-swapping: this handler closes over `comfyContents`
    // captured at attach time. Today, comfyView swaps happen only before
    // attachInstall runs, so the listener always lives on the active view and
    // `_installCleanup` removes it symmetrically. If we later hot-swap
    // entry.comfyView mid-attach (e.g. to reuse a host window without tearing
    // down install state), this binding goes stale and zoom shortcuts will
    // silently stop working until the next attach. The Reset Zoom menu item
    // re-reads parentEntry.comfyView at click time, so it stays correct.
    if (mod && !input.alt && (input.key === '=' || input.key === '+' || input.key === '-' || input.key === '0')) {
      e.preventDefault()
      if (comfyContents.isDestroyed()) return
      if (input.key === '0') {
        const previousLevel = comfyContents.getZoomLevel()
        comfyContents.setZoomLevel(0)
        // Only emit when this was a real reset (skip no-op presses at 1x)
        // so the event count tracks actual recovery actions, not key-spam.
        if (previousLevel !== 0) {
          mainTelemetry.emit('desktop2.zoom.reset', {
            source: 'shortcut',
            parent_entry_id: entry.windowKey,
            installation_id: entry.installationId,
            previous_zoom_level: previousLevel,
            previous_zoom_percent: Math.round(Math.pow(1.2, previousLevel) * 100),
          })
        }
        return
      }
      const step = input.key === '-' ? -0.5 : 0.5
      comfyContents.setZoomLevel(comfyContents.getZoomLevel() + step)
    }
  }
  comfyContents.on('before-input-event', onBeforeInputEvent)

  // Failure retry — backoff on did-fail-load that isn't aborted /
  // mid-relaunch. Per-install timer cancel registered into the
  // shared map so onModelFolderRelaunch can interrupt a pending
  // retry that would otherwise navigate away from the splash page.
  let failRetryTimer: ReturnType<typeof setTimeout> | null = null
  const cancelFailRetry = (): void => {
    if (failRetryTimer) { clearTimeout(failRetryTimer); failRetryTimer = null }
  }
  comfyFailRetryTimerCancels.set(installationId, cancelFailRetry)
  const onDidFailLoad = (
    _e: Electron.Event,
    code: number,
    _desc: string,
    _failUrl: string,
    isMainFrame: boolean,
  ): void => {
    if (!isMainFrame || code === -3 || failRetryTimer) return
    const id = entry.installationId
    if (id === null) return
    if (relaunchStates.has(id)) return
    failRetryTimer = setTimeout(() => {
      failRetryTimer = null
      const currentId = entry.installationId
      if (currentId === null) return
      if (relaunchStates.has(currentId)) return
      if (!comfyWindow.isDestroyed()) {
        comfyContents.loadURL(currentComfyUrl())
      }
    }, 2000)
  }
  comfyContents.on('did-fail-load', onDidFailLoad)

  const onRenderProcessGone = (
    _event: Electron.Event,
    details: Electron.RenderProcessGoneDetails,
  ): void => {
    forwardDatadogError({
      source: 'comfy-window-render-process-gone',
      message: `Comfy window renderer process exited (${details.reason})`,
      level: 'error',
      context: {
        origin: 'main-process',
        installationId: entry.installationId ?? '(detached)',
        reason: details.reason,
        exitCode: details.exitCode,
      },
    })
    reloadComfy()
  }
  comfyContents.on('render-process-gone', onRenderProcessGone)

  // Per-window download routing — attached at session level so a
  // download dispatched from the comfyContents lands in this
  // window's download tray. `detachWindowDownloads` is per-window
  // and survives mode flips (it lives in the createHostWindow close
  // handler, not in `_installCleanup`).
  attachSessionDownloadHandler(comfyContents.session)

  comfyContents.loadURL(comfyUrl)

  // Symmetric undo. Called by the close handler (always) and by
  // `detachInstall()` when the host flips back to chooser mode in
  // place. Idempotent — sets `_installCleanup = null` on first call
  // so subsequent calls are no-ops.
  entry._installCleanup = (): void => {
    if (entry._installCleanup === null) return
    entry._installCleanup = null
    installationEvents.off('updated', onInstallationUpdated)
    cancelFailRetry()
    if (!comfyContents.isDestroyed()) {
      comfyContents.off('ipc-message', onIpcMessage)
      comfyContents.off('page-title-updated', onPageTitleUpdated)
      comfyContents.off('dom-ready', onDomReady)
      comfyContents.off('did-fail-load', onDidFailLoad)
      comfyContents.off('render-process-gone', onRenderProcessGone)
      comfyContents.off('before-input-event', onBeforeInputEvent)
    }
    const id = entry.installationId
    if (id !== null) {
      // Abort any in-flight install / migrate / quick-install /
      // update-while-running op for this install BEFORE killing the
      // running session. Renderer-side overlay `onCancel` is the
      // happy-path rollback prompt; this is the safety net that
      // fires when the renderer side has no overlay mounted (e.g.
      // window-close consult returns `cleared: true` immediately
      // because the panel state is empty). Without it, in-flight
      // operations continued running orphaned in main after window teardown.
      const inFlight = _operationAborts.get(id)
      if (inFlight) {
        inFlight.abort()
        _operationAborts.delete(id)
      }
      // Detach the relaunch will-navigate blocker before clearing the
      // map slot — without `comfyContents.off(...)`, a re-attach would
      // inherit a still-active blocker that preventDefaults every
      // navigation until the comfyContents itself is destroyed.
      const relaunch = relaunchStates.get(id)
      if (relaunch && !comfyContents.isDestroyed()) {
        comfyContents.off('will-navigate', relaunch.navBlocker)
      }
      ipc.stopRunning(id)
      comfyFailRetryTimerCancels.delete(id)
      relaunchStates.delete(id)
      dropInstallationIndex(id)
      entry.installationId = null
    }
    entry.comfyUrl = ''
  }
  return true
}

/**
 * Flip an install-backed host window in place to install-less
 * (chooser) mode. The symmetric undo to `attachInstall()`. Bound
 * onto `entry.detachInstall` by `createHostWindow()`; the
 * underscore-prefixed name signals that callers should invoke
 * `entry.detachInstall()` rather than this freestanding helper
 * directly.
 *
 * Steps:
 *   1. Runs `entry._installCleanup()` — `attachInstall()`'s stashed
 *      undo: off all install-bound comfyContents listeners, cancel
 *      the fail-retry timer, ipc.stopRunning the running session,
 *      clear the install-keyed maps + the secondary index, and reset
 *      `entry.installationId` / `entry.comfyUrl`.
 *   2. Navigates the comfyView to `about:blank` so the loaded
 *      ComfyUI page is unloaded (releases its renderer process). The
 *      comfyView is kept alive (not destroyed) so the host can be
 *      re-attached later without rebuilding.
 *   3. Resets the title-bar identity (`titleBarText` →
 *      `'Desktop 2.0 Beta'`, `sourceCategory` → `null`) and pushes
 *      to the live title-bar.
 *   4. Resets the OS-level window title.
 *   5. Re-paints the title bar to the launcher-theme surface
 *      (chooser hosts derive their theme from the launcher setting,
 *      not from a ComfyUI frontend).
 *   6. Resets `entry.activePanel` to `'comfy'` (which now resolves
 *      to the chooser body via `computeBodyMode`) and ensures a
 *      panelView with the chooser body exists.
 *   7. Calls `entry.layoutViews()` so the chooser body becomes
 *      visible immediately.
 *
 * No-op when the entry is already install-less (no install backing
 * to detach). Does not destroy the comfyView or the BrowserWindow
 * — see the close handler in `createHostWindow()` for the destroy
 * path.
 */
function _detachInstallImpl(entry: ComfyWindowEntry): void {
  if (entry.installationId === null) return
  if (entry.window.isDestroyed()) return

  // Symmetric undo of attachInstall (listeners, maps, stopRunning, etc).
  entry._installCleanup?.()

  // Release the ComfyUI page; the view is kept alive for re-attach.
  if (!entry.comfyView.webContents.isDestroyed()) {
    void entry.comfyView.webContents.loadURL('about:blank').catch(() => {})
    entry.comfyView.setBackgroundColor(COMFY_BG)
  }

  // Flip title-bar identity back to chooser-host shape.
  entry.titleBarText = CHOOSER_HOST_TITLE_TEXT
  entry.sourceCategory = null
  if (!entry.titleBarView.webContents.isDestroyed()) {
    entry.titleBarView.webContents.send('comfy-titlebar:title-changed', entry.titleBarText)
    entry.titleBarView.webContents.send('comfy-titlebar:source-category-changed', null)
  }
  entry.window.setTitle(CHOOSER_HOST_WINDOW_TITLE)
  applyChooserHostTheme(entry)

  // Reset nav state to the comfy pill (chooser body for install-less hosts).
  entry.activePanel = 'comfy'
  if (!entry.titleBarView.webContents.isDestroyed()) {
    entry.titleBarView.webContents.send('comfy-titlebar:panel-changed', 'comfy')
  }

  // Tear down the install-backed PanelApp and remount fresh in chooser mode.
  // Preserves no per-install state (overlays, activePanel, installationId
  // URL param) across the detach.
  if (entry.panelView) {
    const oldPanel = entry.panelView
    entry.panelView = null
    if (!oldPanel.webContents.isDestroyed()) {
      _unregisterExtraBroadcastTarget(oldPanel.webContents)
      oldPanel.webContents.close()
    }
    if (!entry.window.isDestroyed()) {
      try { entry.window.contentView.removeChildView(oldPanel) } catch {}
    }
  }
  ensurePanelView(entry.windowKey, entry, 'chooser')
  entry.layoutViews()
}

/** Resolve the title-bar / window-controls theme for install-less host
 *  windows. The chooser's panel body lives in the launcher renderer
 *  (which uses `--surface` from main.css), so the title-bar Vue header
 *  and the OS-level window-controls overlay both need to track that
 *  same colour. `titleBarOverlayForTheme` already returns the matching
 *  `--surface` values (#262729 dark / #e9e9e9 light) so this helper is
 *  a thin wrapper that just maps that to the
 *  `comfy-titlebar:theme-changed` `{ bg, text }` shape consumed by
 *  TitleBarApp.vue. */
function getChooserHostTheme(): { bg: string; text: string } {
  const overlay = titleBarOverlayForTheme(resolveTheme() === 'dark')
  return { bg: overlay.color ?? TITLEBAR_BG, text: overlay.symbolColor ?? '#dddddd' }
}

/** Repaint a single install-less host window's title bar + OS overlay
 *  to match the current launcher theme. Mirrors `applyComfyTheme` for
 *  install-backed windows, but driven by the launcher setting (or
 *  OS-level dark-mode flip on `'system'`) rather than ComfyUI's
 *  in-page theme observer — install-less hosts have no ComfyUI
 *  frontend feeding them. */
function applyChooserHostTheme(entry: ComfyWindowEntry): void {
  if (entry.installationId !== null) return
  if (entry.window.isDestroyed()) return
  const theme = getChooserHostTheme()
  entry.lastTheme = theme
  if (!entry.titleBarView.webContents.isDestroyed()) {
    entry.titleBarView.webContents.send('comfy-titlebar:theme-changed', theme)
  }
  if (process.platform !== 'darwin') {
    try {
      entry.window.setTitleBarOverlay({ color: theme.bg, symbolColor: theme.text })
    } catch {
      // No-op — setTitleBarOverlay throws if the window was created
      // without `titleBarOverlay`, which install-less hosts always set.
    }
  }
}

/** Walk every install-less host window and repaint its title bar to
 *  the current launcher theme. Hooked into the settings handler's
 *  `onThemeChanged` callback so flipping the Theme setting (or the
 *  OS-level dark-mode preference while the setting is `'system'`)
 *  refreshes every open chooser host live, instead of only repainting
 *  the panel body inside it. */
function applyChooserHostThemeToAll(): void {
  for (const [, entry] of comfyWindows) {
    if (entry.installationId === null) {
      applyChooserHostTheme(entry)
    }
  }
}

/**
 * Bounds-persistence key for install-less host windows. All chooser
 * hosts share the same key so the JSON cache holds at most one
 * chooser bounds entry, and bounds restore works across sessions
 * for chooser hosts.
 */
const CHOOSER_HOST_BOUNDS_KEY = 'chooser'

/** Open a fresh install-less host window. Same shape as an install-
 *  backed comfy window — title bar pills + body area — but with no
 *  installation backing the entry. The Comfy pill resolves to the
 *  chooser body via `computeBodyMode()`; the user picks an install
 *  from there. Skips the install-backed extras (comfy URL load, theme
 *  observer, download wiring, failure retry) since none of them apply.
 *  The comfyView still exists so `layoutViews` doesn't have to
 *  special-case its absence, but is sized to zero and never made
 *  visible. */
function openChooserHostWindow(): BrowserWindow {
  // Install-less wrapper. The shared `createHostWindow()` builds
  // the BrowserWindow + 2 views skeleton, layoutViews, macOS
  // fullscreen, bounds-save listeners, close / closed handlers,
  // and title-bar-ready handshake. The chooser-only extras live
  // here: a title-bar header label override and an eager
  // `ensurePanelView('chooser')` so the panel body paints on the
  // first frame instead of after the next layout tick.
  //
  // Install-less host windows have no ComfyUI frontend feeding
  // their theme, so the chooser's title bar / overlay colors are
  // driven by the launcher theme (resolved here and refreshed via
  // `applyChooserHostTheme` when the theme setting or OS-level
  // dark-mode preference flips). Both the Vue `<header>` and the
  // OS overlay paint `getChooserHostTheme().bg` (the launcher
  // renderer's `--surface`) so the seam between them stays
  // invisible.
  const initialChooserTheme = getChooserHostTheme()

  const { comfyWindow, entry } = createHostWindow({
    windowTitle: CHOOSER_HOST_WINDOW_TITLE,
    boundsKey: CHOOSER_HOST_BOUNDS_KEY,
    initialTheme: initialChooserTheme,
    titleBarOverlay: process.platform === 'darwin'
      ? undefined
      // Install-less hosts use the launcher renderer's --surface
      // for the OS overlay so the close/min/max region matches the
      // Vue title bar above it. Install-backed windows still use
      // `comfyTitleBarOverlay()` (ComfyUI brand --comfy-menu-bg).
      : titleBarOverlayForTheme(resolveTheme() === 'dark'),
    // Dummy comfyView. Kept so layoutViews doesn't have to special-
    // case the install-less branch — its body always resolves to
    // the panelView. Uses the same comfy preload + `persist:shared`
    // partition the install-backed default uses, so a chooser-pick
    // `attachInstall()` can navigate this view in place to the
    // install's URL without rebuilding the WebContentsView. The
    // preload + partition are no-ops on the idle view (nothing
    // loads it before attach). Unique-partition installs
    // (`browserPartition === 'unique'`) still need a fresh window —
    // the in-place attach falls through to `createHostWindow()`
    // for that case.
    comfyWebPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/comfyPreload.js'),
      partition: 'persist:shared',
    },
    titleBarBackground: initialChooserTheme.bg,
    // Empty installationId URL param tells the title-bar Vue to enter
    // install-less mode (no install-type icon, dashboard pill label).
    titleBarInstallationIdParam: '',
    // Initial title-bar pill text + source-category are stored on
    // the entry; the unified title-bar-ready handshake re-pushes
    // from the entry. Install-less hosts have no install backing
    // so the source-category icon stays unset.
    initialTitleBarText: CHOOSER_HOST_TITLE_TEXT,
    initialSourceCategory: null,
  })

  // Force-create the panel WebContentsView with the chooser body —
  // install-less windows always need a panel, and creating it eagerly
  // avoids the empty body flash that would happen on the next
  // layoutViews tick.
  ensurePanelView(entry.windowKey, entry, 'chooser')

  entry.layoutViews()
  // Explicitly bring the new chooser host to the foreground.
  // Without this, the freshly created window can stay behind
  // whatever app the user launched Desktop 2.0 from (Windows
  // focus-theft prevention is the usual culprit). `bringToFront`
  // uses the always-on-top toggle trick on Windows.
  bringToFront(comfyWindow)
  return comfyWindow
}

ipcMain.handle('quit-app', () => quitApp())

// `reset-zoom` has no callers; per-install ComfyUI windows manage
// their own zoom independently. Kept as a stubbed handler so any
// straggling renderer still bound to the channel doesn't reject.
ipcMain.handle('reset-zoom', () => {
  // no-op
})

/**
 * Lazily create the panel WebContentsView for a comfy window. Adds it as a
 * sibling of comfyView, registers it for broadcasts, and loads panel.html
 * with the installation context as URL parameters.
 *
 * The URL params are only an initial hint — `did-finish-load` always re-pushes
 * the current `activePanel` so a user who clicks Install Settings then
 * Launcher Settings before the first load completes still ends up on the
 * latter. This guards against the mid-load race.
 */
function ensurePanelView(windowKey: number, entry: ComfyWindowEntry, initialPanel: BodyMode): WebContentsView {
  if (entry.panelView) return entry.panelView

  const panelView = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // sandbox: false — preload/index.js imports the shared
      // src/preload/api.ts chunk, same as the title-bar preload.
      // Sandboxed preloads can't require() relative chunks, so leaving
      // sandbox on would silently break window.api in the panel and
      // take renderer-side telemetry with it. See issue #521 for the
      // build-time inlining plugin that will let us turn sandbox back on.
      sandbox: false,
      // Reuse the launcher preload — panel UI uses window.api like the main launcher window.
      preload: path.join(__dirname, '../preload/index.js'),
      // Default session (no partition) — keeps the panel isolated from the
      // ComfyUI frontend's storage even though it runs in the same window.
    },
  })
  panelView.setBackgroundColor(resolveTheme() === 'dark' ? '#202020' : '#ffffff')
  entry.window.contentView.addChildView(panelView)
  // Insert at zero size, behind the comfy view; layoutViews handles positioning.
  panelView.setBounds({ x: 0, y: TITLEBAR_HEIGHT + 1, width: 0, height: 0 })
  panelView.setVisible(false)

  // Push the *latest* body mode (may differ from initialPanel if the user
  // clicked between buttons during the first load, or the running state
  // changed) and steal focus if the window is focused.
  panelView.webContents.once('did-finish-load', () => {
    const latest = comfyWindows.get(windowKey)
    if (!latest || latest.window.isDestroyed() || panelView.webContents.isDestroyed()) return
    const mode = computeBodyMode(latest)
    if (mode !== 'comfy') {
      panelView.webContents.send('panel-switch', { panel: mode, installationId: latest.installationId ?? '' })
      if (latest.window.isFocused()) panelView.webContents.focus()
    }
  })

  // Pass the entry's installationId (which is the empty string for
  // install-less host windows) to the panel renderer — the Map key is a
  // numeric windowKey that PanelApp.vue must not see.
  const panelInstallationId = entry.installationId ?? ''
  const isDev = !!process.env['ELECTRON_RENDERER_URL']
  const loadPromise = isDev
    ? panelView.webContents.loadURL(
        `${(process.env['ELECTRON_RENDERER_URL'] as string).replace(/\/$/, '')}/panel.html?installationId=${encodeURIComponent(panelInstallationId)}&panel=${encodeURIComponent(initialPanel)}`,
      )
    : panelView.webContents.loadFile(
        path.join(__dirname, '../renderer/panel.html'),
        { query: { installationId: panelInstallationId, panel: initialPanel } },
      )
  // Loads can reject if the window closes mid-load — swallow to avoid noisy
  // unhandledRejection forwarding from the main-process error handlers.
  void loadPromise.catch(() => {})

  _registerExtraBroadcastTarget(panelView.webContents)
  entry.panelView = panelView
  return panelView
}

/** Move OS focus to whichever body view is now active so keyboard input lands in the right place. */
function focusActiveBody(entry: ComfyWindowEntry): void {
  if (entry.window.isDestroyed() || !entry.window.isFocused()) return
  const mode = computeBodyMode(entry)
  if (mode === 'comfy') {
    if (!entry.comfyView.webContents.isDestroyed()) entry.comfyView.webContents.focus()
  } else if (entry.panelView && !entry.panelView.webContents.isDestroyed() && !entry.panelView.webContents.isLoadingMainFrame()) {
    // Panel exists and is loaded — focus immediately. If still loading, the
    // did-finish-load handler in ensurePanelView will focus it.
    entry.panelView.webContents.focus()
  }
}

function setActivePanel(windowKey: number, panel: ComfyPanelKey): void {
  const entry = comfyWindows.get(windowKey)
  if (!entry || entry.window.isDestroyed()) return
  // The unified Settings modal works in both install-backed and install-
  // less hosts (PanelApp picks the appropriate default tab — ComfyUI
  // Settings vs Global Settings — at mount time), so no install-less
  // gating is required here.

  if (entry.activePanel === panel) return

  entry.activePanel = panel
  // Resolve to the actual body mode (Comfy pill maps to lifecycle / chooser
  // depending on running state and whether the window is install-backed).
  const mode = computeBodyMode(entry)
  if (mode !== 'comfy') {
    const panelView = ensurePanelView(windowKey, entry, mode)
    // If panel view already loaded, push the switch immediately. If still
    // loading, the did-finish-load handler in ensurePanelView will push the
    // current body mode — guarding against rapid clicks during first load.
    if (!panelView.webContents.isDestroyed() && !panelView.webContents.isLoadingMainFrame()) {
      panelView.webContents.send('panel-switch', { panel: mode, installationId: entry.installationId ?? '' })
    }
  }
  entry.layoutViews()
  if (!entry.titleBarView.webContents.isDestroyed()) {
    // Title bar pill stays on the user-visible key — never reflects the
    // internal `'comfy-lifecycle'` body mode.
    entry.titleBarView.webContents.send('comfy-titlebar:panel-changed', panel)
  }
  focusActiveBody(entry)
}

ipcMain.on('comfy-window:set-panel', (event, payload: { panel: string }) => {
  const found = findEntryByTitleBarSender(event.sender)
  if (!found) return
  const panel = payload?.panel as ComfyPanelKey
  if (!VALID_PANELS.has(panel)) return
  setActivePanel(found.id, panel)
})

/**
 * Send a payload to a panelView, deferring until `did-finish-load` if
 * the bundle is still loading.
 *
 * Title-bar pill clicks and popup deep-links can land while the panel
 * renderer is still booting — the panelView is constructed lazily on
 * the first non-comfy switch, so its preload + Vue app aren't ready
 * yet on the very first click. A synchronous `send()` then arrives
 * before the renderer's `onPanelTriggerOverlay` (or other) listener
 * runs in `onMounted`, and the IPC is silently dropped. This helper
 * centralizes the deferral pattern used by every such handler.
 */
function sendToPanelDeferred(panelView: WebContentsView, channel: string, payload: unknown): void {
  if (panelView.webContents.isDestroyed()) return
  const send = (): void => {
    if (panelView.webContents.isDestroyed()) return
    panelView.webContents.send(channel, payload)
  }
  if (panelView.webContents.isLoadingMainFrame()) {
    panelView.webContents.once('did-finish-load', send)
  } else {
    send()
  }
}

/**
 * Page-level X close (rendered inside the panel WebContentsView, e.g.
 * Settings / Directories / Install Settings) — same effect as a pill
 * click: the body returns to the comfy/chooser root. The panel preload
 * exposes this as `closeCurrentPanel()`.
 *
 * We resolve the host window via the panel's WebContents sender. The
 * panelView is lazily created so we walk every entry instead of caching
 * a separate reverse-map.
 */
ipcMain.on('comfy-window:close-current-panel', (event) => {
  for (const [id, entry] of comfyWindows) {
    if (entry.panelView?.webContents === event.sender) {
      setActivePanel(id, 'comfy')
      return
    }
  }
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
  (event, payload: { mode: 'none' | 'consent-lockdown' | 'post-consent' }) => {
    const mode = payload?.mode === 'consent-lockdown' || payload?.mode === 'post-consent'
      ? payload.mode
      : 'none'
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
    } catch {}
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
  // trigger anything — instead, deep-link the user to Global Settings
  // → Desktop Updates so they can watch the progress bar and decide
  // whether to wait. Mirrors the install-update pill flow: bring the
  // panel view forward (lazily constructing it if needed) then send
  // `panel-trigger-overlay 'open-settings'` once the renderer is up.
  if (state.kind === 'downloading') {
    setActivePanel(found.id, 'settings')
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
 * Title-bar install-update pill click. Refuses on
 * install-less hosts (the pill is suppressed there but a defensive
 * guard keeps stray IPC from triggering anything).
 *
 * The handler does three things, in order:
 *   1. `setActivePanel(found.id, 'settings')` — bring the panel view
 *      forward when the user is currently on the ComfyUI view (the
 *      common case for this pill since it's only visible while an
 *      install is running). Without this, the unified Settings modal
 *      mounts on a hidden panel surface and the click appears to do
 *      nothing. `setActivePanel` also lazily creates the panelView
 *      on first non-comfy switch via `ensurePanelView`. It's a no-op
 *      when the entry is already on `'settings'` (i.e. the modal is
 *      already open), so we don't double-open it.
 *   2. Resolve the entry's `panelView` AFTER `setActivePanel` so we
 *      pick up any view that step 1 may have just constructed.
 *   3. `panel-trigger-overlay` with the installationId so the renderer
 *      can open the unified Settings modal deep-linked to the ComfyUI
 *      Settings tab → Update sub-tab — same surface the chooser kebab
 *      "Update…" entry routes to.
 *
 * Step 3 must be deferred until the panelView's renderer has finished
 * loading. When the panel was just constructed by step 1, its preload
 * + Vue app haven't mounted yet, so a synchronous `send()` would land
 * before `unsubPanelTriggerOverlay = window.api.onPanelTriggerOverlay
 * (...)` ran in `onMounted`, and the IPC would be silently dropped.
 * `did-finish-load` fires once the JS bundle has executed (which is
 * what Vue's `mount()` + `onMounted` ride on), so registering a
 * `once('did-finish-load', sendDeepLink)` is a reliable trigger.
 *
 * The renderer's existing `initialTab` / `initialDetailTab` watchers
 * (added in the unified-settings-modal branch) cover the
 * already-mounted-but-on-a-different-tab case — they snap the sidebar
 * back to "ComfyUI Settings" and the inner DetailModal to Update.
 */
ipcMain.on('comfy-window:click-install-update-pill', (event) => {
  const found = findEntryByTitleBarSender(event.sender)
  if (!found) return
  const { entry } = found
  const installationId = entry.installationId
  if (!installationId) return
  setActivePanel(found.id, 'settings')
  const panelView = entry.panelView
  if (!panelView) return
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
  const panelView = parentEntry.panelView ?? ensurePanelView(entryId, parentEntry, computeBodyMode(parentEntry))
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

ipcMain.handle('close-comfy-window', (_event, installationId: string) => {
  const entry = getEntryByInstallationId(installationId)
  if (!entry || entry.window.isDestroyed()) return false
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
 * In-place attach is currently disabled — too many edge-case bugs
 * (window destruction mid-attach, partition mismatches, missed
 * instance-started fallbacks closing the only remaining window).
 * Always return `false` so the renderer falls back to the
 * close-host + open-fresh-install-window swap, the path that's
 * been stable in production.
 *
 * The underlying machinery (`pendingAttachClaims`, `attachInstall`,
 * `detachInstall`, `comfyWindows` keyed by `windowKey`) is left in
 * place so this revert is a one-line tactical disable; removing the
 * infra entirely would be a much larger change. See
 * docs/window-mode-unification-revert.md.
 */
ipcMain.handle('claim-attach-host', (_event, _installationId: string) => {
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
    if (entry.installationId !== null) continue
    if (entry.panelView?.webContents !== event.sender) continue
    saveWindowBounds(installationId, entry.window)
    return true
  }
  return false
})

function findInstallationIdForWindow(win: BrowserWindow): string | undefined {
  for (const entry of comfyWindows.values()) {
    if (entry.window !== win) continue
    // Install-less host windows (entry.installationId === null)
    // have no install id to return; treating that case as
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
    // Wire late-bound host factories before any openOrFocus* runs (the
    // tray menu, activate / second-instance handlers, and the startup
    // picker all flow through the registry).
    setHostFactories({ createChooser: openChooserHostWindow })

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
    registerTitlePopupIpc({
      openChooserHostWindow,
      returnToDashboard,
      confirmAndCloseAllHostWindows,
      setActivePanel,
      triggerOpenFeedback,
      sendToPanelDeferred,
    })
    registerDownloadIpc()
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
