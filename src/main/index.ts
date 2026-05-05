import { app, BrowserWindow, Menu, ipcMain, shell, clipboard, screen, net, WebContentsView } from 'electron'
// `Tray` is referenced only as a type while docking-to-tray is disabled
// (see whenReady() — createTray() has been removed). When docking comes
// back, move this back into the runtime electron import alongside Menu.
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
import * as i18n from './lib/i18n'
import { configDir, migrateXdgPaths } from './lib/paths'
import { waitForPort, COMFY_BOOT_TIMEOUT_MS } from './lib/process'
import { isQuitInProgress, setQuitReason } from './lib/quit-state'
import type { InstallationRecord } from './installations'
import type { DatadogForwardedError } from '../types/ipc'
import {
  attachSessionDownloadHandler,
  cleanupTempDownloads,
  detachWindowDownloads,
  registerDownloadIpc,
  startAssetDownload,
} from './lib/comfyDownloadManager'
import { get as getInstallation, installationEvents } from './installations'
import { getModelDownloadContentScript } from './lib/comfyContentScript'
import { shouldOpenInPopup } from './lib/allowedPopups'
import { showModelFolderRelaunchPage } from './lib/relaunchPage'
import { COMFY_BG, SPLASH_DARK, TITLEBAR_BG, type SplashTheme } from './lib/theme'
import { TITLEBAR_HEIGHT, TRAFFIC_LIGHT_POSITION, comfyTitleBarOverlay, titleBarOverlayForTheme } from './lib/titleBarOverlay'
import { resolveTheme, sourceMap, _registerExtraBroadcastTarget, _unregisterExtraBroadcastTarget, _runningSessions, _broadcastToRenderer } from './lib/ipc/shared'
import * as mainTelemetry from './lib/telemetry'
import { getDeviceId } from './lib/deviceId'
import { scrubAll } from './lib/piiScrub'

/**
 * Title-bar pill key — one of the three user-visible navigation tabs.
 *
 * The Comfy pill maps to either the live ComfyUI WebContentsView (instance
 * running) or the lifecycle panel (instance stopped / launching / stopping).
 * The decision lives in `computeBodyMode()` and is internal to main.
 */
export type ComfyPanelKey =
  | 'comfy'
  | 'install-settings'
  | 'launcher-settings'
  | 'directories'
  | 'new-install'
  | 'track'
  | 'load-snapshot'
  | 'quick-install'
const VALID_PANELS: ReadonlySet<ComfyPanelKey> = new Set([
  'comfy',
  'install-settings',
  'launcher-settings',
  'directories',
  'new-install',
  'track',
  'load-snapshot',
  'quick-install',
])

/**
 * Internal body-mode for a comfy window.
 *
 * `'comfy-lifecycle'` is *not* a title-bar pill — it's the panel rendered
 * inside the Comfy tab when the install isn't running (no process up yet,
 * shutting down, or crashed). The title bar still highlights the Comfy pill;
 * the lifecycle view is just what fills the body in that state.
 *
 * `'chooser'` is also not a title-bar pill — it's the panel rendered inside
 * the Comfy tab of an install-less host window (one with no install backing
 * the entry yet). Picking an install in the chooser eventually swaps the
 * window in-place to a real install (Phase 3 step 2d).
 */
type BodyMode =
  | 'comfy'
  | 'comfy-lifecycle'
  | 'install-settings'
  | 'launcher-settings'
  | 'directories'
  | 'chooser'
  | 'new-install'
  | 'track'
  | 'load-snapshot'
  | 'quick-install'

todesktop.init({ autoUpdater: false })

const APP_ICON = path.join(__dirname, '..', '..', 'assets', 'Comfy_Logo_x256.png')
// TRAY_ICON has been removed alongside createTray() while docking-to-tray
// is disabled — see whenReady()'s comment about restoring docking. The
// 32px logo asset is still available under assets/ if it's reintroduced.
const APP_VERSION = getAppVersion()

interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

const windowStatePath = path.join(configDir(), 'window-state.json')
let windowStateCache: Record<string, WindowBounds> | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null

function getWindowStateCache(): Record<string, WindowBounds> {
  if (!windowStateCache) {
    try {
      windowStateCache = JSON.parse(fs.readFileSync(windowStatePath, 'utf-8'))
    } catch {
      windowStateCache = {}
    }
  }
  return windowStateCache!
}

async function flushWindowState(): Promise<void> {
  if (!windowStateCache) return
  try {
    await fs.promises.mkdir(path.dirname(windowStatePath), { recursive: true })
    await fs.promises.writeFile(windowStatePath, JSON.stringify(windowStateCache, null, 2))
  } catch {}
}

function saveWindowBounds(installationId: string, window: BrowserWindow): void {
  const state = getWindowStateCache()
  const maximized = window.isMaximized()
  const bounds = window.getBounds()
  state[installationId] = {
    ...(maximized ? (state[installationId] ?? bounds) : bounds),
    maximized,
  }
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(flushWindowState, 500)
}

function getSavedBounds(installationId: string): WindowBounds | undefined {
  return getWindowStateCache()[installationId]
}

function getWindowOptions(installationId: string): Partial<Electron.BrowserWindowConstructorOptions> {
  const saved = getSavedBounds(installationId)
  if (!saved) return { width: 1280, height: 900 }

  const savedRect = { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
  const display = screen.getDisplayMatching(savedRect)
  const { x: wx, y: wy, width: ww, height: wh } = display.workArea
  const width = Math.min(saved.width, ww)
  const height = Math.min(saved.height, wh)
  const x = Math.max(wx, Math.min(saved.x, wx + ww - width))
  const y = Math.max(wy, Math.min(saved.y, wy + wh - height))
  return { x, y, width, height }
}

function attachContextMenu(comfyWindow: BrowserWindow, webContents?: Electron.WebContents): void {
  (webContents || comfyWindow.webContents).on('context-menu', (_event, params) => {
    const { editFlags, isEditable, selectionText, linkURL } = params
    const hasSelection = selectionText.trim().length > 0
    const hasLink = linkURL.length > 0

    if (!isEditable && !hasSelection && !hasLink) return

    const menuItems: Electron.MenuItemConstructorOptions[] = []

    if (hasLink) {
      menuItems.push(
        { label: i18n.t('contextMenu.openLinkInBrowser'), click: () => shell.openExternal(linkURL) },
        { label: i18n.t('contextMenu.copyLinkAddress'), click: () => clipboard.writeText(linkURL) },
      )
    }

    if (hasLink && (isEditable || hasSelection)) {
      menuItems.push({ type: 'separator' })
    }

    if (isEditable) {
      menuItems.push(
        { label: i18n.t('contextMenu.cut'), role: 'cut', enabled: editFlags.canCut },
        { label: i18n.t('contextMenu.copy'), role: 'copy', enabled: editFlags.canCopy },
        { label: i18n.t('contextMenu.paste'), role: 'paste', enabled: editFlags.canPaste },
        { type: 'separator' },
        { label: i18n.t('contextMenu.selectAll'), role: 'selectAll', enabled: editFlags.canSelectAll },
      )
    } else if (hasSelection) {
      menuItems.push(
        { label: i18n.t('contextMenu.copy'), role: 'copy', enabled: editFlags.canCopy },
        { label: i18n.t('contextMenu.selectAll'), role: 'selectAll', enabled: editFlags.canSelectAll },
      )
    }

    Menu.buildFromTemplate(menuItems).popup({ window: comfyWindow })
  })
}

// Phase 3 — `mainWindow` (the launcher window) was retired and all of its
// historical guard branches have been scrubbed (Stage 4b). The chooser host
// window plus per-install ComfyUI windows are now the only top-level surfaces.
let tray: Tray | null = null

/**
 * Per-installation handle for a ComfyUI window.
 *
 * The ComfyUI window is split into a parent BrowserWindow plus two
 * WebContentsViews — a thin native title bar and the ComfyUI content view.
 * Most lifecycle code needs the BrowserWindow (show, focus, destroy, bounds)
 * but the navigation / restart / splash flows must target the ComfyUI
 * WebContents, which lives on `comfyView.webContents` — NOT on the parent
 * window's webContents (that is only used as a host for the views).
 */
interface ComfyWindowEntry {
  window: BrowserWindow
  comfyView: WebContentsView
  titleBarView: WebContentsView
  /**
   * Lazily-created on first non-comfy panel switch *or* when the comfy tab
   * needs to render the lifecycle body (install stopped / launching) *or*
   * the chooser body (install-less host window).
   */
  panelView: WebContentsView | null
  /**
   * Which panel is currently rendered (== `panelHistory[panelHistoryIndex]`).
   * Always one of the user-visible panel keys — never the internal
   * `'comfy-lifecycle'` / `'chooser'` body modes. For install-less host
   * windows only `'comfy'` and `'launcher-settings'` are reachable
   * (Install Settings / Directories are hidden).
   */
  activePanel: ComfyPanelKey
  /**
   * Browser-style navigation history for the title-bar Back / Forward
   * buttons. The pill is no longer treated as a tab indicator —
   * navigating between pages uses this stack instead.
   *
   * The "root" is `'comfy'` and is always at index 0. Opening a page
   * (Settings / Directories / Install Settings / a flow) truncates any
   * forward history and pushes the new key. Returning to the comfy
   * body via the pill or the page's X-close button resets the stack
   * to `['comfy']` (deliberate "I'm done with these pages" gesture
   * — clears forward history). Back / Forward only move the index.
   */
  panelHistory: ComfyPanelKey[]
  panelHistoryIndex: number
  /** Last known theme reported by the ComfyUI frontend, applied to the panel when it loads. */
  lastTheme: { bg: string; text: string }
  /** Layout function bound to this entry — updates view bounds for the current activePanel. */
  layoutViews: () => void
  /**
   * The current ComfyUI URL the comfyView should display. Updated on every
   * `onLaunch` so reload / did-fail-load handlers don't hold stale URLs
   * across stop+restart cycles (the window persists, the URL may change).
   * Empty string for install-less host windows where comfyView is collapsed.
   */
  comfyUrl: string
  /**
   * Installation backing this window, or null for install-less host
   * windows (chooser / file-menu flows in Phase 3 step 2c+). Centralises
   * the "is this entry install-backed?" decision so `computeBodyMode()`
   * can route the Comfy pill to the chooser without parallel branches in
   * every call site.
   */
  installationId: string | null
}
/**
 * All host windows (install-backed and install-less). Install-backed
 * entries are keyed by their installationId; install-less entries are
 * keyed by a synthetic `chooser:<n>` string (see `openChooserHostWindow`).
 * Lookups by installationId still hit only install-backed entries.
 */
const comfyWindows = new Map<string, ComfyWindowEntry>()
let _chooserWindowCounter = 0
function nextChooserKey(): string {
  return `chooser:${++_chooserWindowCounter}`
}

/**
 * Decide what should fill the body area of a comfy window right now.
 *
 * For install-backed windows, the Comfy pill resolves to either the live
 * ComfyUI WebContentsView (instance running) or the lifecycle panel
 * (instance stopped / launching / stopping). The other two pills always
 * map directly to themselves.
 *
 * For install-less host windows (entry.installationId === null), the Comfy
 * pill resolves to the chooser body; only the Comfy and Launcher Settings
 * pills are reachable in this mode.
 *
 * Centralising this so layout decisions and event-driven body swaps can't
 * disagree about which view should be visible.
 */
function computeBodyMode(entry: ComfyWindowEntry): BodyMode {
  if (entry.installationId === null) {
    // Install-less host window. Comfy pill → chooser; everything else
    // (in practice only Launcher Settings) maps to itself.
    return entry.activePanel === 'comfy' ? 'chooser' : entry.activePanel
  }
  if (entry.activePanel !== 'comfy') return entry.activePanel
  return _runningSessions.has(entry.installationId) ? 'comfy' : 'comfy-lifecycle'
}

/**
 * Re-evaluate the body mode for a comfy window after a session-state
 * transition (instance launched / stopped / crashed) and reflect it in the
 * layout. When the body mode is `'comfy-lifecycle'`, the panelView is created
 * (if needed) and asked to render the lifecycle UI; the title-bar pill stays
 * on `'comfy'` either way.
 */
function refreshComfyTabBody(installationId: string): void {
  const entry = comfyWindows.get(installationId)
  if (!entry || entry.window.isDestroyed()) return
  if (entry.activePanel !== 'comfy') return

  const mode = computeBodyMode(entry)
  if (mode === 'comfy-lifecycle') {
    const panelView = ensurePanelView(installationId, entry, 'comfy-lifecycle')
    if (!panelView.webContents.isDestroyed() && !panelView.webContents.isLoadingMainFrame()) {
      panelView.webContents.send('panel-switch', { panel: 'comfy-lifecycle', installationId })
    }
  }
  entry.layoutViews()
  focusActiveBody(entry)
}

function findEntryByTitleBarSender(wc: Electron.WebContents): { id: string; entry: ComfyWindowEntry } | null {
  for (const [id, entry] of comfyWindows) {
    if (entry.titleBarView.webContents === wc) return { id, entry }
  }
  return null
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
let processErrorHandlersRegistered = false

function serializeUnknownError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message || error.name || 'Error',
      stack: error.stack,
    }
  }
  if (typeof error === 'string') {
    return { message: error }
  }
  if (error === null || error === undefined) {
    return { message: 'Unknown error' }
  }
  try {
    return { message: JSON.stringify(error) }
  } catch {
    return { message: String(error) }
  }
}

function forwardDatadogError(payload: DatadogForwardedError): void {
  const scrubbed: DatadogForwardedError = {
    ...payload,
    message: scrubAll(payload.message),
    stack: payload.stack ? scrubAll(payload.stack) : undefined,
    // Mark this error as already captured by main-process PostHog so the
    // renderer's `onDatadogError` listener routes it to Datadog only and
    // we don't double-count exceptions in PostHog.
    skipPostHog: true,
  }
  // The launcher window was retired in Phase 3 — broadcast to any open panel
  // renderer instead so its `onDatadogError` listener can forward the error
  // to Datadog RUM (the panel renderer hosts the same telemetry bootstrap
  // the launcher renderer used to). When no panel is open the broadcast is a
  // no-op and we still capture below via PostHog Node.
  try {
    _broadcastToRenderer('dd-error', scrubbed)
  } catch {}
  // Also surface to PostHog Node so we don't lose the error if no renderer is
  // listening (render-process-gone, before-quit shutdown, no panel open yet).
  try {
    const err = new Error(scrubbed.message)
    if (scrubbed.stack) err.stack = scrubbed.stack
    mainTelemetry.captureException(err, {
      origin: 'main-process',
      source: scrubbed.source,
      level: scrubbed.level ?? null,
    })
  } catch {}
}

function registerProcessErrorHandlers(): void {
  if (processErrorHandlersRegistered) return
  processErrorHandlersRegistered = true

  process.on('uncaughtExceptionMonitor', (error) => {
    const serialized = serializeUnknownError(error)
    forwardDatadogError({
      source: 'main-uncaught-exception',
      message: serialized.message,
      stack: serialized.stack,
      level: 'critical',
      context: { origin: 'main-process' },
    })
  })

  process.on('unhandledRejection', (reason) => {
    const serialized = serializeUnknownError(reason)
    forwardDatadogError({
      source: 'main-unhandled-rejection',
      message: serialized.message,
      stack: serialized.stack,
      level: 'error',
      context: { origin: 'main-process' },
    })
  })

  app.on('child-process-gone', (_event, details) => {
    const extra = details as unknown as Record<string, unknown>
    forwardDatadogError({
      source: 'main-child-process-gone',
      message: `Child process ${details.type} exited: ${details.reason}`,
      level: 'error',
      context: {
        origin: 'main-process',
        type: details.type,
        reason: details.reason,
        exitCode: details.exitCode,
        name: extra['name'],
        serviceName: extra['serviceName'],
      },
    })
  })
}

// Phase 3 — `createMainWindow()` was removed. The launcher window is
// retired; the install-less chooser host (`openChooserHostWindow`) is
// the entry-point surface and per-install ComfyUI windows
// (`openComfyWindow`) host install-scoped panels.

function updateTrayMenu(): void {
  if (!tray) return
  // Phase 3 — the launcher window is retired; the install-less chooser
  // host is the primary surface. "Show App" and the previous separate
  // "Choose an Install" entry now collapse into a single chooser-host
  // focus action.
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

/** Show a window and bring it to the front, working around Windows focus-theft prevention. */
function bringToFront(win: BrowserWindow): void {
  if (process.platform === 'win32') {
    win.setAlwaysOnTop(true)
    win.show()
    win.focus()
    win.setAlwaysOnTop(false)
  } else {
    win.show()
    win.focus()
  }
}

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
  const entry = comfyWindows.get(installationId)
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
  const entry = comfyWindows.get(installationId)
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
      // The historical `comfy-output` broadcast to mainWindow was retired
      // alongside the launcher window in Phase 3 — the install's own window
      // is the right surface for restart-failure UX, but its comfyView is
      // mid-load here so an inline message would be racy. Logging + the
      // existing splash error path are sufficient for now.
      console.error(`ComfyUI restart failed for ${installationId}:`, err)
    })
}

function onStop({ installationId }: { installationId?: string } = {}): void {
  // Stopping the process no longer destroys the window — the window stays
  // open so the user can re-launch, view logs, or run install-settings
  // actions. Window destruction stays bound to explicit close paths
  // (user closes window, app quits, install deleted via close-comfy-window).
  if (installationId) {
    refreshComfyTabBody(installationId)
  } else {
    for (const id of comfyWindows.keys()) {
      refreshComfyTabBody(id)
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
  const existing = comfyWindows.get(installationId)
  if (existing && !existing.window.isDestroyed()) {
    existing.comfyUrl = comfyUrl
    if (!existing.comfyView.webContents.isDestroyed()) {
      existing.comfyView.setBackgroundColor(COMFY_BG)
      void existing.comfyView.webContents.loadURL(comfyUrl).catch(() => {})
    }
    refreshComfyTabBody(installationId)
    if (proc) {
      proc.on('exit', () => {
        // Session registry handles state cleanup
      })
    }
    return
  }

  const saved = getSavedBounds(installationId)
  const windowOptions = getWindowOptions(installationId)
  const comfyWindow = new BrowserWindow({
    ...windowOptions,
    minWidth: 800,
    minHeight: 600,
    icon: APP_ICON,
    title: `${installation.name} — Desktop 2.0 v${APP_VERSION}`,
    backgroundColor: COMFY_BG,
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: TRAFFIC_LIGHT_POSITION }
      : { titleBarOverlay: comfyTitleBarOverlay() }),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })
  comfyWindow.setMenuBarVisibility(false)

  // Title bar view — bounded to TITLEBAR_HEIGHT, isolated from ComfyUI.
  // Uses the comfyTitleBarPreload bridge (panel switch buttons, theme updates, etc.).
  const titleBarView = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/comfyTitleBarPreload.js'),
    },
  })
  // Paint the title bar's dark background before its HTML loads to avoid a white flash on window show.
  titleBarView.setBackgroundColor(TITLEBAR_BG)
  // The title bar is a Vite-built renderer entry so it shares the Inter font
  // + design tokens with the launcher and panel renderers. Pass installationId
  // via the URL so the preload can expose it to the page.
  {
    const isDev = !!process.env['ELECTRON_RENDERER_URL']
    const tbLoad = isDev
      ? titleBarView.webContents.loadURL(
          `${(process.env['ELECTRON_RENDERER_URL'] as string).replace(/\/$/, '')}/comfyTitleBar.html?installationId=${encodeURIComponent(installationId)}`,
        )
      : titleBarView.webContents.loadFile(
          path.join(__dirname, '../renderer/comfyTitleBar.html'),
          { query: { installationId } },
        )
    void tbLoad.catch(() => {})
  }
  /** Format the install identity for the comfy tab in the title bar. */
  function computeTitleBarText(inst: InstallationRecord): string {
    const label = sourceMap[inst.sourceId]?.label
    return label ? `${inst.name} — ${label}` : inst.name
  }
  let titleBarText = computeTitleBarText(installation)
  /** Mirrored install fields used by the OS-level window title (which is
   *  rebuilt whenever the page title or the install name changes). */
  let currentInstallName = installation.name
  let currentPageTitle = ''
  function refreshOsWindowTitle(): void {
    if (comfyWindow.isDestroyed()) return
    const suffix = currentPageTitle ? ` — ${currentPageTitle}` : ''
    comfyWindow.setTitle(`${currentInstallName}${suffix} — Desktop 2.0 v${APP_VERSION}`)
  }
  comfyWindow.contentView.addChildView(titleBarView)
  _registerExtraBroadcastTarget(titleBarView.webContents)

  // ComfyUI content view — completely isolated from the title bar
  const comfyView = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/comfyPreload.js'),
      partition: (installation.browserPartition as string | undefined) === 'unique'
        ? `persist:${installation.id}`
        : 'persist:shared',
    },
  })
  // Paint the ComfyUI view's dark background before any URL loads to avoid a white flash
  // on window show. The parent BrowserWindow's backgroundColor never shows because the
  // WebContentsViews cover its entire content area.
  comfyView.setBackgroundColor(COMFY_BG)
  comfyWindow.contentView.addChildView(comfyView)

  // Title bar is 1px taller than the overlay so a CSS border-bottom in
  // comfyTitleBar.html sits below the native buttons.
  const titleBarTotal = TITLEBAR_HEIGHT + 1
  const layoutViews = (): void => {
    if (comfyWindow.isDestroyed()) return
    const entry = comfyWindows.get(installationId)
    const [width, height] = comfyWindow.getContentSize() as [number, number]
    const bodyHeight = Math.max(0, height - titleBarTotal)
    const bodyRect = { x: 0, y: titleBarTotal, width, height: bodyHeight }
    titleBarView.setBounds({ x: 0, y: 0, width, height: titleBarTotal })

    // The Comfy pill maps to the live ComfyUI view *or* the lifecycle panel
    // depending on whether the install is currently running.
    const mode = entry ? computeBodyMode(entry) : 'comfy'
    const showPanel = mode !== 'comfy'
    if (showPanel && entry?.panelView) {
      // Panel covers the body; ComfyUI is hidden but kept alive so its state is preserved.
      entry.panelView.setBounds(bodyRect)
      entry.panelView.setVisible(true)
      // Collapse the comfy view to zero so it can't intercept input, but keep it loaded.
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

  // Alias for the ComfyUI webContents (all handlers use this)
  const comfyContents = comfyView.webContents

  if (saved?.maximized) comfyWindow.maximize()

  // On macOS fullscreen the traffic-light buttons disappear, so the title bar
  // should drop its 78px left padding for that period. Push the state via IPC
  // so the Vue component can toggle a class instead of mutating the DOM directly.
  if (process.platform === 'darwin') {
    const sendFullscreen = (fullscreen: boolean): void => {
      if (titleBarView.webContents.isDestroyed()) return
      titleBarView.webContents.send('comfy-titlebar:fullscreen-changed', fullscreen)
    }
    comfyWindow.on('enter-full-screen', () => sendFullscreen(true))
    comfyWindow.on('leave-full-screen', () => sendFullscreen(false))
  }

  /** Send the active panel down to the title bar so it can highlight the right button. */
  function notifyTitleBarPanel(panel: ComfyPanelKey): void {
    if (titleBarView.webContents.isDestroyed()) return
    titleBarView.webContents.send('comfy-titlebar:panel-changed', panel)
  }

  /** Send the title text to the title bar (replaces inline executeJavaScript). */
  function notifyTitleBarTitle(text: string): void {
    if (titleBarView.webContents.isDestroyed()) return
    titleBarView.webContents.send('comfy-titlebar:title-changed', text)
  }

  // Push the initial state once the title bar's preload signals readiness.
  // Using ipcMain.on (not handle) since the title bar uses ipcRenderer.send.
  // Filter to this title bar's WebContents to avoid cross-talk between windows.
  const onTitleBarReady = (event: Electron.IpcMainEvent): void => {
    if (event.sender !== titleBarView.webContents) return
    notifyTitleBarTitle(titleBarText)
    const entry = comfyWindows.get(installationId)
    notifyTitleBarPanel(entry?.activePanel ?? 'comfy')
    if (entry && !titleBarView.webContents.isDestroyed()) {
      titleBarView.webContents.send('comfy-titlebar:theme-changed', entry.lastTheme)
      _notifyTitleBarNavState(entry)
    }
    // Pre-warm the title-menu popup so the user's first File / Install
    // click doesn't pay the BrowserWindow construction + HTML/JS load
    // cost (~100ms). The popup is created hidden, kept alive across
    // opens, and torn down when this window is.
    ensureTitleMenuPopup(comfyWindow)
  }
  ipcMain.on('comfy-window:title-bar-ready', onTitleBarReady)

  // Reflect rename / source change in both the comfy tab and the OS-level
  // window title as the install record mutates.
  const onInstallationUpdated = (updated: InstallationRecord): void => {
    if (updated.id !== installationId) return
    const nextTabText = computeTitleBarText(updated)
    if (nextTabText !== titleBarText) {
      titleBarText = nextTabText
      notifyTitleBarTitle(titleBarText)
    }
    if (updated.name !== currentInstallName) {
      currentInstallName = updated.name
      refreshOsWindowTitle()
    }
  }
  installationEvents.on('updated', onInstallationUpdated)

  comfyWindow.on('closed', () => {
    ipcMain.off('comfy-window:title-bar-ready', onTitleBarReady)
    installationEvents.off('updated', onInstallationUpdated)
  })

  comfyWindow.on('resize', () => saveWindowBounds(installationId, comfyWindow))
  comfyWindow.on('move', () => saveWindowBounds(installationId, comfyWindow))
  comfyContents.on('did-create-window', (childWindow) => {
    childWindow.setIcon(APP_ICON)
    if (process.platform !== 'darwin') childWindow.removeMenu()
    injectMacPasskeyWarning(childWindow)
  })
  comfyContents.on('page-title-updated', (e, title) => {
    e.preventDefault()
    currentPageTitle = title
    refreshOsWindowTitle()
  })
  comfyContents.setWindowOpenHandler(({ url }) => {
    if (shouldOpenInPopup(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { preload: undefined } } }
    }
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Sync the title bar and overlay colors with the ComfyUI frontend's theme
  const applyComfyTheme = (bg: string, text: string): void => {
    if (comfyWindow.isDestroyed()) return
    const theme = { bg, text }
    const entry = comfyWindows.get(installationId)
    if (entry) entry.lastTheme = theme
    if (!titleBarView.webContents.isDestroyed()) {
      titleBarView.webContents.send('comfy-titlebar:theme-changed', theme)
    }
    if (process.platform !== 'darwin') {
      try { comfyWindow.setTitleBarOverlay({ color: bg, symbolColor: text }) } catch {}
    }
  }

  comfyContents.on('ipc-message', (_event, channel, ...args) => {
    if (channel === 'desktop2-theme-report') {
      const { bg, text } = (args[0] || {}) as { bg?: string; text?: string }
      if (bg) applyComfyTheme(bg, text || '#ddd')
    }
  })

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

  // Download management: attach session handler and inject content script
  const isLocal = !url
  attachSessionDownloadHandler(comfyContents.session)
  comfyContents.on('dom-ready', () => {
    comfyContents.executeJavaScript(COMFY_THEME_OBSERVER_JS).catch(() => {})

    const preamble = isLocal ? '' : 'window.__comfyDesktop2Remote = true;\n'
    comfyContents
      .executeJavaScript(preamble + getModelDownloadContentScript())
      .catch(() => {})
  })

  attachContextMenu(comfyWindow, comfyContents)

  comfyContents.loadURL(comfyUrl)

  /** Read the current target URL from the entry; falls back to the launch
   *  URL during the brief window before the entry is registered. */
  const currentComfyUrl = (): string => comfyWindows.get(installationId)?.comfyUrl ?? comfyUrl

  const reloadComfy = (): void => {
    if (comfyWindow.isDestroyed()) return
    if (relaunchStates.has(installationId)) return
    comfyContents.stop()
    comfyContents.loadURL(currentComfyUrl())
  }

  comfyContents.on('will-prevent-unload', (e) => {
    e.preventDefault()
  })

  comfyContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return
    const mod = input.control || input.meta
    if (mod && input.key.toLowerCase() === 'w') {
      e.preventDefault()
      return
    }
    if (input.key === 'F5' || (input.key.toLowerCase() === 'r' && mod)) {
      e.preventDefault()
      reloadComfy()
    }
  })

  let failRetryTimer: ReturnType<typeof setTimeout> | null = null
  const cancelFailRetry = (): void => {
    if (failRetryTimer) { clearTimeout(failRetryTimer); failRetryTimer = null }
  }
  comfyFailRetryTimerCancels.set(installationId, cancelFailRetry)
  comfyContents.on('did-fail-load', (_e, code, _desc, _failUrl, isMainFrame) => {
    if (!isMainFrame || code === -3 || failRetryTimer) return
    // During a model-folder relaunch, onComfyRestarted handles retry logic.
    if (relaunchStates.has(installationId)) return
    failRetryTimer = setTimeout(() => {
      failRetryTimer = null
      if (relaunchStates.has(installationId)) return
      if (!comfyWindow.isDestroyed()) {
        comfyContents.loadURL(currentComfyUrl())
      }
    }, 2000)
  })

  comfyContents.on('render-process-gone', (_event, details) => {
    forwardDatadogError({
      source: 'comfy-window-render-process-gone',
      message: `Comfy window renderer process exited (${details.reason})`,
      level: 'error',
      context: {
        origin: 'main-process',
        installationId,
        reason: details.reason,
        exitCode: details.exitCode,
      },
    })
    reloadComfy()
  })

  comfyWindow.on('close', (e) => {
    e.preventDefault()
    detachWindowDownloads(comfyWindow)
    ipc.stopRunning(installationId)
    _unregisterExtraBroadcastTarget(titleBarView.webContents)
    const entry = comfyWindows.get(installationId)
    if (entry?.panelView) {
      _unregisterExtraBroadcastTarget(entry.panelView.webContents)
      entry.panelView.webContents.close()
    }
    titleBarView.webContents.close()
    comfyView.webContents.close()
    comfyWindow.destroy()
  })

  comfyWindow.on('closed', () => {
    comfyWindows.delete(installationId)
    comfyFailRetryTimerCancels.delete(installationId)
    relaunchStates.delete(installationId)
  })

  comfyWindows.set(installationId, {
    window: comfyWindow,
    comfyView,
    titleBarView,
    panelView: null,
    activePanel: 'comfy',
    panelHistory: ['comfy'],
    panelHistoryIndex: 0,
    lastTheme: { bg: COMFY_BG, text: '#dddddd' },
    layoutViews,
    comfyUrl,
    installationId,
  })

  // Now that the entry exists, layout for the first time.
  layoutViews()

  if (proc) {
    proc.on('exit', () => {
      // Session registry handles state cleanup
    })
  }
}

/**
 * Open an install-less host window (Phase 3 step 2c).
 *
 * Same window shape as a comfy window — title bar pills + a body area —
 * but with no installation backing the entry. The Comfy pill resolves to
 * the chooser body via `computeBodyMode()`; the user picks an install
 * from there.
 *
 * Lean version of the install-backed `onLaunch()` flow: no comfy URL load,
 * no theme observer, no download wiring, no failure retry — those are all
 * comfy-specific and would do nothing useful in install-less mode. The
 * comfyView still exists (so `layoutViews` doesn't have to special-case
 * its absence) but is sized to zero and never made visible.
 */
/**
 * Find the first install-less host window (chooser / file-menu mode) so
 * the startup picker / tray entry can focus an existing one instead of
 * stacking duplicates. Step 5's "File → New Window" entry-point will
 * always create a fresh one regardless.
 */
function findFirstChooserHostWindow(): BrowserWindow | null {
  for (const [, entry] of comfyWindows) {
    if (entry.installationId === null && !entry.window.isDestroyed()) {
      return entry.window
    }
  }
  return null
}

/** Focus an existing chooser host window if one is open, otherwise create one. */
function openOrFocusChooserHostWindow(): BrowserWindow {
  const existing = findFirstChooserHostWindow()
  if (existing) {
    bringToFront(existing)
    return existing
  }
  return openChooserHostWindow()
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

function openChooserHostWindow(): BrowserWindow {
  const windowKey = nextChooserKey()

  const initialChooserTheme = getChooserHostTheme()

  const windowOptions = getWindowOptions(windowKey)
  const comfyWindow = new BrowserWindow({
    ...windowOptions,
    minWidth: 800,
    minHeight: 600,
    icon: APP_ICON,
    title: `Choose an install — Desktop 2.0 v${APP_VERSION}`,
    backgroundColor: COMFY_BG,
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: TRAFFIC_LIGHT_POSITION }
      // Install-less hosts use the launcher renderer's --surface for
      // the OS overlay so the close/min/max region matches the Vue
      // title bar above it. Install-backed windows still use
      // `comfyTitleBarOverlay()` (ComfyUI brand --comfy-menu-bg).
      : { titleBarOverlay: titleBarOverlayForTheme(resolveTheme() === 'dark') }),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })
  comfyWindow.setMenuBarVisibility(false)

  // Title bar — same renderer as install-backed windows. The empty
  // `installationId` URL param is what the title-bar Vue uses to enter
  // install-less mode (hide Install Settings pill, accept the fallback
  // label).
  const titleBarView = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/comfyTitleBarPreload.js'),
    },
  })
  // Pre-paint the title-bar WebContentsView with the launcher-theme
  // surface colour so it doesn't flash `TITLEBAR_BG` (#353535) before
  // the Vue header mounts and applies `themeBg` on `theme-changed`.
  titleBarView.setBackgroundColor(initialChooserTheme.bg)
  {
    const isDev = !!process.env['ELECTRON_RENDERER_URL']
    const tbLoad = isDev
      ? titleBarView.webContents.loadURL(
          `${(process.env['ELECTRON_RENDERER_URL'] as string).replace(/\/$/, '')}/comfyTitleBar.html?installationId=`,
        )
      : titleBarView.webContents.loadFile(
          path.join(__dirname, '../renderer/comfyTitleBar.html'),
          { query: { installationId: '' } },
        )
    void tbLoad.catch(() => {})
  }
  comfyWindow.contentView.addChildView(titleBarView)
  _registerExtraBroadcastTarget(titleBarView.webContents)

  // Dummy comfyView. Kept so `layoutViews` doesn't have to special-case the
  // install-less branch — its body always resolves to the panelView.
  const comfyView = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })
  comfyView.setBackgroundColor(COMFY_BG)
  comfyWindow.contentView.addChildView(comfyView)

  const titleBarTotal = TITLEBAR_HEIGHT + 1
  const layoutViews = (): void => {
    if (comfyWindow.isDestroyed()) return
    const entry = comfyWindows.get(windowKey)
    const [width, height] = comfyWindow.getContentSize() as [number, number]
    const bodyHeight = Math.max(0, height - titleBarTotal)
    const bodyRect = { x: 0, y: titleBarTotal, width, height: bodyHeight }
    titleBarView.setBounds({ x: 0, y: 0, width, height: titleBarTotal })
    // Install-less windows always resolve to a panel body (chooser or
    // launcher-settings). If the panelView isn't created yet, collapse
    // the comfy view rather than show it — the dummy comfyView has no
    // useful URL.
    if (entry?.panelView) {
      entry.panelView.setBounds(bodyRect)
      entry.panelView.setVisible(true)
    }
    comfyView.setBounds({ x: 0, y: titleBarTotal, width: 0, height: 0 })
    comfyView.setVisible(false)
  }
  comfyWindow.on('resize', layoutViews)

  // macOS fullscreen — keep the title-bar padding in sync just like the
  // install-backed flow.
  if (process.platform === 'darwin') {
    const sendFullscreen = (fullscreen: boolean): void => {
      if (titleBarView.webContents.isDestroyed()) return
      titleBarView.webContents.send('comfy-titlebar:fullscreen-changed', fullscreen)
    }
    comfyWindow.on('enter-full-screen', () => sendFullscreen(true))
    comfyWindow.on('leave-full-screen', () => sendFullscreen(false))
  }

  // Push initial state once the title bar's preload signals readiness.
  // Filtered to this window's title-bar webContents to avoid cross-talk.
  const onTitleBarReady = (event: Electron.IpcMainEvent): void => {
    if (event.sender !== titleBarView.webContents) return
    if (!titleBarView.webContents.isDestroyed()) {
      // Fallback label — install-backed windows use the install name.
      titleBarView.webContents.send('comfy-titlebar:title-changed', 'Choose an install')
      const entry = comfyWindows.get(windowKey)
      titleBarView.webContents.send('comfy-titlebar:panel-changed', entry?.activePanel ?? 'comfy')
      if (entry) {
        titleBarView.webContents.send('comfy-titlebar:theme-changed', entry.lastTheme)
        _notifyTitleBarNavState(entry)
      }
    }
    // Pre-warm the title-menu popup so the user's first File click
    // doesn't pay the BrowserWindow construction + HTML/JS load cost.
    // Install-less hosts only expose the File menu (no Install menu),
    // so the warmed popup still pays off on every File-menu open.
    ensureTitleMenuPopup(comfyWindow)
  }
  ipcMain.on('comfy-window:title-bar-ready', onTitleBarReady)

  comfyWindow.on('close', () => {
    _unregisterExtraBroadcastTarget(titleBarView.webContents)
    const entry = comfyWindows.get(windowKey)
    if (entry?.panelView) {
      _unregisterExtraBroadcastTarget(entry.panelView.webContents)
      entry.panelView.webContents.close()
    }
    titleBarView.webContents.close()
    comfyView.webContents.close()
  })

  comfyWindow.on('closed', () => {
    ipcMain.off('comfy-window:title-bar-ready', onTitleBarReady)
    comfyWindows.delete(windowKey)
  })

  comfyWindow.on('resize', () => saveWindowBounds(windowKey, comfyWindow))
  comfyWindow.on('move', () => saveWindowBounds(windowKey, comfyWindow))

  // Phase 3 — install-less host windows have no ComfyUI frontend to
  // pull theme from, so the chooser's title bar / overlay colors are
  // driven by the launcher theme (resolved at construction time and
  // refreshed via `applyChooserHostTheme` when the theme setting or
  // OS-level dark-mode preference flips). Both the Vue `<header>` and
  // the OS overlay paint `getChooserHostTheme().bg` (i.e. the launcher
  // renderer's `--surface`) so the seam between them stays invisible.
  comfyWindows.set(windowKey, {
    window: comfyWindow,
    comfyView,
    titleBarView,
    panelView: null,
    activePanel: 'comfy',
    panelHistory: ['comfy'],
    panelHistoryIndex: 0,
    lastTheme: initialChooserTheme,
    layoutViews,
    comfyUrl: '',
    installationId: null,
  })

  // Force-create the panel WebContentsView with the chooser body — install-
  // less windows always need a panel, and creating it eagerly avoids the
  // empty body flash that would happen on the next layoutViews tick.
  const entry = comfyWindows.get(windowKey)
  if (entry) {
    ensurePanelView(windowKey, entry, 'chooser')
  }

  layoutViews()
  // Phase 3 — explicitly bring the new chooser host to the foreground.
  // Without this, the freshly created window can stay behind whatever
  // app the user launched Desktop 2.0 from (Windows focus-theft
  // prevention is the usual culprit). The legacy launcher window had
  // its own `ready-to-show` → `focus()` path; the chooser host needs
  // the same treatment via `bringToFront`, which uses the always-on-top
  // toggle trick on Windows.
  bringToFront(comfyWindow)
  return comfyWindow
}

ipcMain.handle('quit-app', () => quitApp())

// Phase 3 — `reset-zoom` was launcher-window-only (the launcher's
// ProgressModal exposed a Reset-Zoom shortcut). With the launcher
// retired, this IPC has no callers; the per-install ComfyUI windows
// manage their own zoom independently. Kept as a stubbed handler so
// any straggling renderer still bound to the channel doesn't reject
// — a follow-up cleanup commit will scrub the preload binding too.
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
function ensurePanelView(installationId: string, entry: ComfyWindowEntry, initialPanel: BodyMode): WebContentsView {
  if (entry.panelView) return entry.panelView

  const panelView = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
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
    const latest = comfyWindows.get(installationId)
    if (!latest || latest.window.isDestroyed() || panelView.webContents.isDestroyed()) return
    const mode = computeBodyMode(latest)
    if (mode !== 'comfy') {
      panelView.webContents.send('panel-switch', { panel: mode, installationId: latest.installationId ?? '' })
      if (latest.window.isFocused()) panelView.webContents.focus()
    }
  })

  // Pass the entry's installationId (which is the empty string for
  // install-less host windows) to the panel renderer — the Map key may be
  // a synthetic `chooser:<n>` string that PanelApp.vue must not see.
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

/**
 * How a panel switch is being requested. Drives the navigation-history
 * book-keeping so the title bar's Back / Forward buttons behave like a
 * browser tab rather than a page swap:
 *   - `'navigate'`: opening a page from a menu / dropdown / chooser →
 *     truncate forward history and push the new key.
 *   - `'back'` / `'forward'`: only move the history index. The caller
 *     resolves the destination key from the stack, this function just
 *     applies it.
 *   - `'reset'`: pill click or X-close → wipe history back to `['comfy']`
 *     and land on index 0. A deliberate "I'm done with these pages"
 *     gesture, so forward history is intentionally cleared.
 */
type PanelNavSource = 'navigate' | 'back' | 'forward' | 'reset'

/** Push `key` onto the history, truncating any forward entries first.
 *  No-op when `key` is already the current panel. */
function _pushPanelHistory(entry: ComfyWindowEntry, key: ComfyPanelKey): void {
  // Drop everything strictly after the current index — the user is
  // forking history from where they currently are.
  entry.panelHistory = entry.panelHistory.slice(0, entry.panelHistoryIndex + 1)
  if (entry.panelHistory[entry.panelHistoryIndex] === key) return
  entry.panelHistory.push(key)
  entry.panelHistoryIndex = entry.panelHistory.length - 1
}

/** Send the current Back/Forward enabled state to the title bar so it can
 *  enable / disable the arrow buttons. */
function _notifyTitleBarNavState(entry: ComfyWindowEntry): void {
  if (entry.titleBarView.webContents.isDestroyed()) return
  entry.titleBarView.webContents.send('comfy-titlebar:nav-state-changed', {
    canBack: entry.panelHistoryIndex > 0,
    canForward: entry.panelHistoryIndex < entry.panelHistory.length - 1,
  })
}

function setActivePanel(
  windowKey: string,
  panel: ComfyPanelKey,
  source: PanelNavSource = 'navigate',
): void {
  const entry = comfyWindows.get(windowKey)
  if (!entry || entry.window.isDestroyed()) return
  // Install Settings + Directories are install-scoped (the install caret
  // menu in the title bar is hidden in install-less host windows). Refuse
  // to switch to either from anywhere when there's no install backing the
  // window — a stray IPC payload must not be able to wedge the window
  // into a body mode that has no install to render.
  if (entry.installationId === null && (panel === 'install-settings' || panel === 'directories')) return

  // Update navigation history per source. The history mutation happens
  // BEFORE the early-return for "same panel" because a `'reset'` from a
  // page back to `'comfy'` still has work to do (clear forward) even
  // when the panel is already comfy by some other accident.
  if (source === 'reset') {
    entry.panelHistory = ['comfy']
    entry.panelHistoryIndex = 0
    panel = 'comfy'
  } else if (source === 'navigate') {
    _pushPanelHistory(entry, panel)
  }
  // For 'back' / 'forward' the caller has already moved
  // panelHistoryIndex; we only apply the panel switch here.

  if (entry.activePanel === panel) {
    // Even when the panel didn't change (e.g. menu re-pick of the
    // current page), nav state may have shifted (forward truncated)
    // — push the latest state so the title bar arrows reflect reality.
    _notifyTitleBarNavState(entry)
    return
  }

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
  _notifyTitleBarNavState(entry)
  focusActiveBody(entry)
}

ipcMain.on('comfy-window:set-panel', (event, payload: { panel: string }) => {
  const found = findEntryByTitleBarSender(event.sender)
  if (!found) return
  const panel = payload?.panel as ComfyPanelKey
  if (!VALID_PANELS.has(panel)) return
  // Pill clicks always send `'comfy'` from the title bar — treat as a
  // history reset (the pill is no longer a tab indicator, so going
  // home should clear the breadcrumb of pages the user was browsing).
  // Other panel keys from the title bar come from the File / Install
  // dropdowns and are 'navigate'.
  setActivePanel(found.id, panel, panel === 'comfy' ? 'reset' : 'navigate')
})

/** Title bar Back arrow → step one entry backward in history. */
ipcMain.on('comfy-window:go-back', (event) => {
  const found = findEntryByTitleBarSender(event.sender)
  if (!found) return
  const { id, entry } = found
  if (entry.panelHistoryIndex <= 0) return
  entry.panelHistoryIndex -= 1
  const target = entry.panelHistory[entry.panelHistoryIndex]
  if (!target) return
  setActivePanel(id, target, 'back')
})

/** Title bar Forward arrow → step one entry forward in history. */
ipcMain.on('comfy-window:go-forward', (event) => {
  const found = findEntryByTitleBarSender(event.sender)
  if (!found) return
  const { id, entry } = found
  if (entry.panelHistoryIndex >= entry.panelHistory.length - 1) return
  entry.panelHistoryIndex += 1
  const target = entry.panelHistory[entry.panelHistoryIndex]
  if (!target) return
  setActivePanel(id, target, 'forward')
})

/**
 * Page-level X close (rendered inside the panel WebContentsView, e.g.
 * Settings / Directories / Install Settings) — same effect as a pill
 * click: history is reset and the body returns to the comfy/chooser
 * root. The panel preload exposes this as `closeCurrentPanel()`.
 *
 * We resolve the host window via the panel's WebContents sender. The
 * panelView is lazily created so we walk every entry instead of caching
 * a separate reverse-map.
 */
ipcMain.on('comfy-window:close-current-panel', (event) => {
  for (const [id, entry] of comfyWindows) {
    if (entry.panelView?.webContents === event.sender) {
      setActivePanel(id, 'comfy', 'reset')
      return
    }
  }
})

/**
 * File menu → New Window (Phase 3 title bar v2). Always opens a fresh
 * install-less chooser host window — does NOT focus an existing one
 * (that's the tray-entry behaviour). The user explicitly asked for a
 * new window so they get one.
 */
ipcMain.on('comfy-window:new-chooser-window', () => {
  openChooserHostWindow()
})

/**
 * Install-pill caret → Check for Updates (Phase 3 title bar v2).
 * Triggers a manual update check via the updater module. The result
 * flows through the existing broadcast pipeline (`update-available`
 * / `update-error`) so the UpdateBanner in any subscribed renderer
 * surface (today the launcher window's App.vue; in step 4 also the
 * host window's panel) updates without further wiring.
 *
 * Errors are caught here so a failing check can never crash the main
 * process — the broadcast pipeline already surfaces an `update-error`
 * payload to the renderer for that case.
 */
ipcMain.on('comfy-window:check-for-updates', () => {
  void updater.runCheck('title-bar-check').catch(() => {
    // runCheck already broadcasts an `update-error` for any failure
    // path; the catch is just to mark the floating Promise rejection
    // as handled so it doesn't surface as an unhandledRejection.
  })
})

// =====================================================================
// Title-menu popups (Phase 3 §14 — replaces native Menu.popup()).
//
// The File / Install dropdowns are now HTML rendered inside a frameless
// transparent child BrowserWindow, mirroring the pattern Chrome / Discord /
// VS Code use for their title-bar menus. Compared to `Menu.popup()` this
// gives us:
//   - native OS shadow + theme-matched chrome (no clipping by the title-bar
//     WebContentsView's 37px bounds, no z-order gymnastics);
//   - free click-outside dismissal via the popup's own blur event;
//   - styling consistent with the Vue title bar above it (Inter + design
//     tokens) instead of the platform's default native menu look.
//
// The renderer-side bridge (`openFileMenu` / `openInstallMenu` →
// `comfy-window:open-title-menu`) is unchanged. The popup webContents
// posts `comfy-titlemenu:item-activated` for clicks and
// `comfy-titlemenu:close` for Escape; main routes activations to the
// existing handlers (set-panel / new-chooser-window / runCheck) and closes
// the popup. On close, main re-emits `comfy-titlebar:menu-closed` to the
// title-bar webContents so the existing 100ms reopen-suppression guard
// keeps working.
// =====================================================================

interface TitleMenuItem {
  /** Item id — main routes activation by this. Omitted for separators. */
  id?: string
  /** Visible label. */
  label?: string
  /** Render a checkmark glyph beside the label when true. */
  checked?: boolean
  /** Marks a separator row instead of an interactive item. */
  kind?: 'separator'
}

interface TitleMenuPopupConfig {
  kind: 'file' | 'install'
  items: TitleMenuItem[]
  theme: { bg: string; text: string }
}

/**
 * One reusable popup window per parent BrowserWindow.
 *
 * Recreating a `BrowserWindow` on every menu open meant ~100ms of
 * construction + HTML/JS load time before the popup appeared, which
 * the user noticed as a click-to-paint delay. Instead we lazily
 * create one popup the first time the user opens a menu on a given
 * parent, hide it on close (rather than destroying), and push fresh
 * config via `comfy-titlemenu:set-config` IPC on every subsequent
 * open. The window is destroyed when its parent is closed.
 *
 * Latest values for the *current* open are tracked here too so
 * `activate` (item click) and the `closed` callback (re-emits
 * `comfy-titlebar:menu-closed` for the reopen-suppression guard)
 * can route without their own per-open context.
 */
interface TitleMenuPopupEntry {
  popup: BrowserWindow
  parentWindow: BrowserWindow
  /** Snapshotted at construction so we don't touch `popup.webContents`
   *  in the destroyed-window handlers. */
  popupWebContentsId: number
  parentWindowId: number
  /** Updated on every open. */
  parentEntryId: string
  /** Updated on every open. */
  kind: 'file' | 'install'
  /** Updated on every open. */
  titleBarSender: Electron.WebContents
  /** True once the renderer has signalled `comfy-titlemenu:ready`.
   *  Until then, config pushes are queued in `pendingConfig`. */
  rendererReady: boolean
  /** Config queued before the renderer signalled ready — flushed on
   *  ready. Overwritten if multiple opens happen before ready. */
  pendingConfig: TitleMenuPopupConfig | null
  /** True between `setOpacity(0)`+park (hide) and `setOpacity(1)`
   *  (show) — the blur handler ignores spurious blurs while we're
   *  already hidden. */
  isOpen: boolean
  /** Set to a non-null timer when an open is in flight, waiting for
   *  the renderer's `comfy-titlemenu:rendered` ack before flipping
   *  opacity to 1. The timer is the fallback that flips anyway after
   *  a short window (in case the renderer is unusually slow). */
  pendingShowTimer: NodeJS.Timeout | null
}

/** Active popup keyed by parent BrowserWindow id (one popup per parent,
 *  cached for reuse). The webContents-id index lets
 *  `comfy-titlemenu:item-activated` / `:close` / `:ready` route by
 *  `event.sender`. */
const titleMenuPopupsByParent = new Map<number, TitleMenuPopupEntry>()
const titleMenuPopupsByWebContents = new Map<number, TitleMenuPopupEntry>()

const POPUP_WIDTH = 220
const POPUP_ITEM_HEIGHT = 28
const POPUP_SEPARATOR_HEIGHT = 9
const POPUP_VPADDING = 8 // 4px top + 4px bottom on the <ul>
const POPUP_VBORDER = 2 // 1px top + 1px bottom from the .popup card

/** Off-screen parking position for a "hidden" popup. We keep the window
 *  permanently `show()`n (never hide/show) so the OS compositor doesn't
 *  re-warm a transparent window on every open — that re-warm is what
 *  caused the visible flicker on first show. -32000 sits beyond every
 *  Win32 display origin so the parked window is invisible regardless
 *  of multi-monitor layout. */
const POPUP_PARK_X = -32000
const POPUP_PARK_Y = -32000

function computePopupHeight(items: readonly TitleMenuItem[]): number {
  const content = items.reduce(
    (sum, item) => sum + (item.kind === 'separator' ? POPUP_SEPARATOR_HEIGHT : POPUP_ITEM_HEIGHT),
    0,
  )
  return content + POPUP_VPADDING + POPUP_VBORDER
}

function buildTitleMenuItems(kind: 'file' | 'install', entry: ComfyWindowEntry): TitleMenuItem[] {
  if (kind === 'file') {
    return [
      { id: 'new-window', label: 'New Window' },
      { id: 'launcher-settings', label: 'Desktop 2 Settings' },
    ]
  }
  return [
    { id: 'install-settings', label: 'Install Settings', checked: entry.activePanel === 'install-settings' },
    { id: 'directories', label: 'Directories', checked: entry.activePanel === 'directories' },
    { kind: 'separator' },
    { id: 'check-for-updates', label: 'Check for Updates' },
  ]
}

/** Lazily create the reusable popup BrowserWindow for the given parent.
 *  Subsequent opens for the same parent reuse the same window — the
 *  renderer is loaded once, then we just push fresh config + reposition
 *  + show on every open. The popup is destroyed when its parent is. */
function ensureTitleMenuPopup(parent: BrowserWindow): TitleMenuPopupEntry {
  const existing = titleMenuPopupsByParent.get(parent.id)
  if (existing && !existing.popup.isDestroyed()) return existing

  const popup = new BrowserWindow({
    parent,
    // Constructed parked off-screen with opacity 0 — we
    // `showInactive()` it after first paint so the OS compositor
    // commits the transparent surface once, then flip opacity / move
    // on every open. Never `hide()`/`show()` again — that path is what
    // caused the first-show flicker.
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: true,
    focusable: true,
    opacity: 0,
    width: POPUP_WIDTH,
    // Initial height is overwritten by `setBounds` on every open, so the
    // value here just has to be non-zero — Electron rejects `width: 0`
    // / `height: 0` BrowserWindows on Windows.
    height: 100,
    x: POPUP_PARK_X,
    y: POPUP_PARK_Y,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/comfyTitleMenuPreload.js'),
    },
  })
  popup.setMenuBarVisibility(false)

  const isDev = !!process.env['ELECTRON_RENDERER_URL']
  const loadPromise = isDev
    ? popup.loadURL(
        `${(process.env['ELECTRON_RENDERER_URL'] as string).replace(/\/$/, '')}/comfyTitleMenu.html`,
      )
    : popup.loadFile(path.join(__dirname, '../renderer/comfyTitleMenu.html'))
  void loadPromise.catch(() => {})

  // Once the renderer paints, flip the window into its "parked &
  // primed" state: parked off-screen, opacity 0, but `show()`n so the
  // compositor has fully composited the transparent surface. From this
  // point on, opens just `setBounds` + `setOpacity(1)` + `focus()`.
  popup.once('ready-to-show', () => {
    if (popup.isDestroyed()) return
    popup.showInactive()
  })

  // Capture ids up-front. The `closed` event fires *after* the
  // BrowserWindow + its webContents are destroyed, so accessing
  // `popup.webContents.id` there would throw "Object has been destroyed".
  const entry: TitleMenuPopupEntry = {
    popup,
    parentWindow: parent,
    popupWebContentsId: popup.webContents.id,
    parentWindowId: parent.id,
    parentEntryId: '',
    kind: 'file',
    titleBarSender: popup.webContents, // overwritten on first open
    rendererReady: false,
    pendingConfig: null,
    isOpen: false,
    pendingShowTimer: null,
  }
  titleMenuPopupsByParent.set(entry.parentWindowId, entry)
  titleMenuPopupsByWebContents.set(entry.popupWebContentsId, entry)

  // Click-outside dismissal: when the popup loses focus (any other
  // window steals it — including the parent title-bar button) hide
  // ourselves. Item clicks inside the popup do NOT trigger blur —
  // focus stays in the popup webContents until we explicitly hide
  // it on item-activated, so item activations always reach main.
  popup.on('blur', () => {
    if (!entry.isOpen) return
    hideTitleMenuPopup(entry)
  })

  // Popup is destroyed only when its parent is destroyed. Clean up
  // the maps so a fresh parent with the same numeric id (vanishingly
  // unlikely but possible) doesn't pick up a stale entry.
  popup.on('closed', () => {
    titleMenuPopupsByParent.delete(entry.parentWindowId)
    titleMenuPopupsByWebContents.delete(entry.popupWebContentsId)
  })

  // Tear down with the parent. Without this, the popup would survive
  // its parent and reuse the wrong context on the next click in a
  // different window.
  parent.once('closed', () => {
    if (!popup.isDestroyed()) popup.destroy()
  })

  return entry
}

/** Fallback timeout (ms) — if the renderer's
 *  `comfy-titlemenu:rendered` ack doesn't arrive within this window
 *  after `set-config`, flip opacity anyway so the popup never gets
 *  permanently stuck invisible. The renderer normally acks within one
 *  animation frame (~16ms). */
const POPUP_RENDER_ACK_TIMEOUT_MS = 80

/** Park the popup back off-screen and re-emit the
 *  `comfy-titlebar:menu-closed` event so the title-bar renderer's 100ms
 *  `MENU_REOPEN_GUARD_MS` suppression fires (mirrors the previous
 *  `Menu.popup()` callback path). The popup window itself stays
 *  permanently `show()`n — we just flip opacity to 0 and move it
 *  off-screen so the OS doesn't have to re-composite a transparent
 *  surface on the next open.
 *
 *  `releaseFocusToParent` controls whether to explicitly focus the parent
 *  window after parking. Use it when the popup is being dismissed *while*
 *  it still has focus (item click, Escape key) so keyboard input lands
 *  somewhere sensible. Skip it on the blur path — focus has already
 *  moved to wherever the user clicked, and stealing it back to the
 *  parent would yank focus out of whatever they targeted (another app
 *  window, the parent's body, etc.). */
function hideTitleMenuPopup(
  entry: TitleMenuPopupEntry,
  opts: { releaseFocusToParent?: boolean } = {},
): void {
  if (!entry.isOpen) return
  entry.isOpen = false
  // Cancel any in-flight render ack — if a hide arrives before the
  // ack, the popup is already on its way back to opacity 0 and we
  // shouldn't flip to 1 retroactively.
  if (entry.pendingShowTimer) {
    clearTimeout(entry.pendingShowTimer)
    entry.pendingShowTimer = null
  }
  if (!entry.popup.isDestroyed()) {
    entry.popup.setOpacity(0)
    entry.popup.setPosition(POPUP_PARK_X, POPUP_PARK_Y)
    if (opts.releaseFocusToParent && !entry.parentWindow.isDestroyed()) {
      entry.parentWindow.focus()
    }
  }
  if (!entry.titleBarSender.isDestroyed()) {
    entry.titleBarSender.send('comfy-titlebar:menu-closed', { menu: entry.kind })
  }
}

/** Flip the popup to opacity 1, focus it, and mark `isOpen`. Called
 *  when the renderer acks `comfy-titlemenu:rendered` — at that point the
 *  new config has been painted and showing is safe. */
function showTitleMenuPopupNow(entry: TitleMenuPopupEntry): void {
  if (entry.pendingShowTimer) {
    clearTimeout(entry.pendingShowTimer)
    entry.pendingShowTimer = null
  }
  if (entry.popup.isDestroyed()) return
  entry.popup.setOpacity(1)
  entry.popup.focus()
  entry.isOpen = true
}

function openTitleMenuPopup(opts: {
  parent: BrowserWindow
  parentEntryId: string
  kind: 'file' | 'install'
  items: TitleMenuItem[]
  anchor: { x: number; y: number }
  theme: { bg: string; text: string }
  titleBarSender: Electron.WebContents
}): void {
  const entry = ensureTitleMenuPopup(opts.parent)
  if (entry.popup.isDestroyed()) return

  // Refresh the per-open routing context. `kind` + `parentEntryId` +
  // `titleBarSender` only matter for the *current* open, so we
  // overwrite on every open instead of allocating a new context object.
  entry.parentEntryId = opts.parentEntryId
  entry.kind = opts.kind
  entry.titleBarSender = opts.titleBarSender

  // Anchor coords are title-bar-local; the title-bar view sits at
  // content (0,0) so they map to content coordinates. `getContentBounds`
  // returns screen-relative coords, so adding gives the popup's screen
  // origin.
  const contentBounds = opts.parent.getContentBounds()
  const screenX = Math.round(contentBounds.x + Math.max(0, opts.anchor.x))
  const screenY = Math.round(contentBounds.y + Math.max(0, opts.anchor.y))
  const height = computePopupHeight(opts.items)

  // Move + resize while invisible. On the very first open the renderer
  // may not have had its `ready-to-show` yet (which calls
  // `showInactive`) — fall back to a regular `showInactive()` here.
  entry.popup.setBounds({ x: screenX, y: screenY, width: POPUP_WIDTH, height })
  if (!entry.popup.isVisible()) entry.popup.showInactive()

  // Push the new config and *wait* for the renderer to ack that the
  // new content has painted before flipping opacity. Without this the
  // user sees a frame of the previous open's content while Vue is
  // still processing the config update.
  if (entry.pendingShowTimer) {
    clearTimeout(entry.pendingShowTimer)
    entry.pendingShowTimer = null
  }
  const config: TitleMenuPopupConfig = { kind: opts.kind, items: opts.items, theme: opts.theme }
  if (entry.rendererReady && !entry.popup.webContents.isDestroyed()) {
    entry.popup.webContents.send('comfy-titlemenu:set-config', config)
  } else {
    // Renderer hasn't mounted yet on the very first open. Queue the
    // config; the `ready` IPC handler flushes it.
    entry.pendingConfig = config
  }
  entry.pendingShowTimer = setTimeout(() => {
    if (entry.pendingShowTimer === null) return
    showTitleMenuPopupNow(entry)
  }, POPUP_RENDER_ACK_TIMEOUT_MS)
}

function activateTitleMenuItem(entry: TitleMenuPopupEntry, id: string): void {
  if (entry.kind === 'file') {
    if (id === 'new-window') openChooserHostWindow()
    else if (id === 'launcher-settings') setActivePanel(entry.parentEntryId, 'launcher-settings')
  } else {
    if (id === 'install-settings') setActivePanel(entry.parentEntryId, 'install-settings')
    else if (id === 'directories') setActivePanel(entry.parentEntryId, 'directories')
    else if (id === 'check-for-updates') {
      void updater.runCheck('title-bar-check').catch(() => {
        // runCheck already broadcasts an `update-error` for any failure;
        // the catch is just to mark the floating Promise rejection as
        // handled so it doesn't surface as an unhandledRejection.
      })
    }
  }
  // Item click — popup still has focus, so push it back to the parent.
  hideTitleMenuPopup(entry, { releaseFocusToParent: true })
}

ipcMain.on('comfy-titlemenu:ready', (event) => {
  const entry = titleMenuPopupsByWebContents.get(event.sender.id)
  if (!entry) return
  entry.rendererReady = true
  if (entry.pendingConfig && !entry.popup.webContents.isDestroyed()) {
    entry.popup.webContents.send('comfy-titlemenu:set-config', entry.pendingConfig)
    entry.pendingConfig = null
  }
})

// Renderer signals that it has applied the latest config and the new
// DOM has painted. Flip opacity to 1 and focus — the user only ever
// sees the popup once it's showing the right content.
ipcMain.on('comfy-titlemenu:rendered', (event) => {
  const entry = titleMenuPopupsByWebContents.get(event.sender.id)
  if (!entry) return
  if (entry.pendingShowTimer === null) return
  showTitleMenuPopupNow(entry)
})

ipcMain.on('comfy-titlemenu:item-activated', (event, payload: { id?: unknown }) => {
  const entry = titleMenuPopupsByWebContents.get(event.sender.id)
  if (!entry) return
  const id = payload?.id
  if (typeof id !== 'string') return
  activateTitleMenuItem(entry, id)
})

ipcMain.on('comfy-titlemenu:close', (event) => {
  const entry = titleMenuPopupsByWebContents.get(event.sender.id)
  if (!entry) return
  // Escape key — popup still has focus, so push it back to the parent.
  hideTitleMenuPopup(entry, { releaseFocusToParent: true })
})

/**
 * Title-bar dropdown popups (Phase 3 title bar v2 → §14 popup rewrite).
 *
 * The title bar lives in its own WebContentsView with `height: TITLEBAR_HEIGHT`,
 * so HTML popups rendered inside it would be clipped by the view's bounds.
 * Instead of the previous native `Menu.popup()` we open a child BrowserWindow
 * (see `openTitleMenuPopup` above) that floats above all views with no
 * clipping or z-order issues.
 *
 * The renderer sends the button's bottom-left corner in title-bar-local
 * pixels; the title bar view sits at window y=0, so those coordinates
 * translate directly to window content coordinates.
 */
ipcMain.on(
  'comfy-window:open-title-menu',
  (event, payload: { menu?: 'file' | 'install'; anchor?: { x?: number; y?: number } }) => {
    const found = findEntryByTitleBarSender(event.sender)
    if (!found) return
    const { id: windowKey, entry } = found
    if (entry.window.isDestroyed()) return
    const menuKind = payload?.menu
    if (menuKind !== 'file' && menuKind !== 'install') return
    // Install menu is install-scoped — refuse for install-less host windows.
    if (menuKind === 'install' && entry.installationId === null) return

    const x = Math.max(0, Math.round(payload?.anchor?.x ?? 0))
    const y = Math.max(0, Math.round(payload?.anchor?.y ?? TITLEBAR_HEIGHT))

    openTitleMenuPopup({
      parent: entry.window,
      parentEntryId: windowKey,
      kind: menuKind,
      items: buildTitleMenuItems(menuKind, entry),
      anchor: { x, y },
      theme: entry.lastTheme,
      titleBarSender: entry.titleBarView.webContents,
    })
  },
)

ipcMain.handle('focus-comfy-window', (_event, installationId: string) => {
  const entry = comfyWindows.get(installationId)
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
  const entry = comfyWindows.get(installationId)
  if (!entry || entry.window.isDestroyed()) return false
  entry.window.close()
  return true
})

/**
 * Close the host window that contains the calling panel WebContents
 * (Phase 3 step 2d).
 *
 * Used by the chooser after a successful pick → launch hand-off: once the
 * install's own ComfyUI window has opened (via the existing `onLaunch`
 * flow), the install-less chooser host window is no longer needed and
 * closes itself. The renderer can't close its parent BrowserWindow
 * directly, so it asks main to do it.
 *
 * Safe on install-backed windows too — the install-settings panel's
 * navigate-list path already handles teardown via `closeComfyWindow`, but
 * if a future renderer surface needs the same "close my window" hook this
 * IPC can stand in for it.
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
 * Copy the calling chooser host window's current bounds into the install's
 * saved-bounds slot (Phase 3 visual continuity for chooser pick).
 *
 * The chooser pick flow currently closes the host and launches the install
 * in a fresh window. Without this transfer, the new install window opens
 * at the install's previously-saved bounds (or the default 1280x900),
 * jumping visibly away from where the user just clicked. Stamping the
 * chooser's current bounds onto the install BEFORE the launch makes the
 * new window appear in the same spot — visually a swap-in-place even
 * though it's structurally close+open.
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

function resolveOutputDir(inst: InstallationRecord): string | null {
  if ((inst.autoDownloadOutputs as boolean | undefined) === false) return null
  if ((inst.useSharedOutputDir as boolean | undefined) !== false) {
    return (settings.get('outputDir') as string | undefined) || settings.defaults.outputDir
  }
  const custom = inst.outputDir as string | undefined
  return custom && custom.trim() !== '' ? custom : (settings.get('outputDir') as string | undefined) || settings.defaults.outputDir
}

function findInstallationIdForWindow(win: BrowserWindow): string | undefined {
  for (const [id, entry] of comfyWindows) {
    if (entry.window === win) return id
  }
  return undefined
}

function registerAssetDownloadIpc(): void {
  ipcMain.handle(
    'desktop2-download-asset',
    async (event, { url, filename, authToken }: { url: string; filename: string; authToken?: string }) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return false
      const installationId = findInstallationIdForWindow(win)
      if (!installationId) return false
      const inst = await getInstallation(installationId)
      if (!inst) return false
      const outputDir = resolveOutputDir(inst)
      if (!outputDir) return false
      return startAssetDownload(win, url, filename, outputDir, authToken, event.sender)
    },
  )
}

if (app.isPackaged && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  if (app.isPackaged) {
    app.on('second-instance', () => {
      // Phase 3 — the launcher window is gone; route the OS-level
      // "open another instance" attempt to the chooser host instead.
      // Restores any minimised chooser host before focusing it.
      const chooser = findFirstChooserHostWindow()
      if (chooser) {
        if (chooser.isMinimized()) chooser.restore()
        bringToFront(chooser)
        return
      }
      openChooserHostWindow()
    })
  }

  app.whenReady().then(async () => {
    migrateXdgPaths()
    registerProcessErrorHandlers()

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
    registerDownloadIpc()
    registerAssetDownloadIpc()
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
    // Tray / docking is disabled while the unified-window flow is being
    // rebuilt — closing the last window quits the app instead of
    // collapsing it into a hidden background process. The `onAppClose`
    // setting (settings.ts), the settings-UI field
    // (registerSettingsHandlers.ts), the `createTray()` startup call,
    // and the tray-aware `window-all-closed` gating will all come back
    // when the docked-app flow is reinstated. Until then, see git
    // history for the previous tray construction code.
    // Phase 3 — the install-less chooser host is the primary surface;
    // the launcher window is retired. createMainWindow() is no longer
    // called here. Each install gets its own ComfyUI window via
    // openComfyWindow() when launched, and the chooser host is the
    // entry-point for picking / creating installs.
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
    // macOS dock click. Focus an existing chooser host if open,
    // otherwise spawn a fresh one. With the launcher window retired
    // (Phase 3), the chooser host is the only fallback surface — any
    // running install windows already accept their own focus events.
    const chooser = findFirstChooserHostWindow()
    if (chooser) {
      bringToFront(chooser)
      return
    }
    openChooserHostWindow()
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
