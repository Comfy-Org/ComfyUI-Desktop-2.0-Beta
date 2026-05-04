import { app, BrowserWindow, Tray, Menu, ipcMain, shell, clipboard, screen, net, nativeTheme, WebContentsView } from 'electron'
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
  setMainWindow,
  startAssetDownload,
} from './lib/comfyDownloadManager'
import { get as getInstallation, installationEvents } from './installations'
import { getModelDownloadContentScript } from './lib/comfyContentScript'
import { shouldOpenInPopup } from './lib/allowedPopups'
import { showModelFolderRelaunchPage } from './lib/relaunchPage'
import { COMFY_BG, SPLASH_DARK, TITLEBAR_BG, type SplashTheme } from './lib/theme'
import { TITLEBAR_HEIGHT, TRAFFIC_LIGHT_POSITION, titleBarOverlayForTheme, comfyTitleBarOverlay, updateTitleBarOverlay, setMainWindowId } from './lib/titleBarOverlay'
import { resolveTheme, sourceMap, _registerExtraBroadcastTarget, _unregisterExtraBroadcastTarget } from './lib/ipc/shared'
import * as mainTelemetry from './lib/telemetry'
import { getDeviceId } from './lib/deviceId'
import { scrubAll } from './lib/piiScrub'

export type ComfyPanelKey = 'comfy' | 'install-settings' | 'launcher-settings'
const VALID_PANELS: ReadonlySet<ComfyPanelKey> = new Set(['comfy', 'install-settings', 'launcher-settings'])

todesktop.init({ autoUpdater: false })

const APP_ICON = path.join(__dirname, '..', '..', 'assets', 'Comfy_Logo_x256.png')
const TRAY_ICON = path.join(__dirname, '..', '..', 'assets', 'Comfy_Logo_x32.png')
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

let mainWindow: BrowserWindow | null = null
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
  /** Lazily-created on first non-comfy panel switch. */
  panelView: WebContentsView | null
  /** Which view is currently visible below the title bar. */
  activePanel: ComfyPanelKey
  /** Last known theme reported by the ComfyUI frontend, applied to the panel when it loads. */
  lastTheme: { bg: string; text: string }
  /** Layout function bound to this entry — updates view bounds for the current activePanel. */
  layoutViews: () => void
}
const comfyWindows = new Map<string, ComfyWindowEntry>()

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
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send('dd-error', scrubbed)
    } catch {}
  }
  // Also surface to PostHog Node so we don't lose the error if the renderer
  // is gone (render-process-gone, before-quit shutdown, etc.).
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

function createMainWindow(): void {
  const isDark = resolveTheme() === 'dark'
  mainWindow = new BrowserWindow({
    width: 1470,
    height: 880,
    minWidth: 650,
    minHeight: 500,
    icon: APP_ICON,
    title: `ComfyUI Desktop 2.0 v${APP_VERSION}`,
    backgroundColor: '#202020',
    show: false,
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: TRAFFIC_LIGHT_POSITION }
      : { titleBarOverlay: titleBarOverlayForTheme(isDark) }),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/index.js'),
    },
  })
  setMainWindowId(mainWindow.id)
  const isDev = !!process.env['ELECTRON_RENDERER_URL']
  const loadTarget = process.env['ELECTRON_RENDERER_URL'] || 'index.html (file)'

  if (isDev) {
    console.log(`[main] dev mode — loading renderer from ${loadTarget}`)
    console.log(`[main] platform=${process.platform} electron=${process.versions.electron} chrome=${process.versions.chrome}`)
  }

  mainWindow.once('ready-to-show', () => {
    if (isDev) console.log('[main] ready-to-show fired')
    if (mainWindow) bringToFront(mainWindow)
    createTray()

    // Suggest Chinese mirrors on first startup if system locale is Chinese
    const effectiveLocale = (settings.get('language') as string | undefined) || app.getLocale()
    if (
      effectiveLocale.startsWith('zh') &&
      settings.get('useChineseMirrors') === undefined &&
      settings.get('chineseMirrorsPrompted') !== true
    ) {
      // Small delay so the renderer has time to mount
      setTimeout(() => {
        mainWindow?.webContents.send('suggest-chinese-mirrors')
      }, 1500)
    }
  })

  attachContextMenu(mainWindow)
  mainWindow.setMenuBarVisibility(false)

  // Sync title bar overlay colors when the OS theme changes (Windows/Linux only)
  if (process.platform !== 'darwin') {
    nativeTheme.on('updated', updateTitleBarOverlay)
  }

  mainWindow.webContents.on('did-finish-load', () => {
    if (isDev) console.log(`[main] did-finish-load — url=${mainWindow?.webContents.getURL()}`)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.setZoomLevel(0)
    }
  })

  mainWindow.webContents.on('did-fail-load', (_e, code, description, failUrl, isMainFrame) => {
    if (!isMainFrame) return
    console.error(`[main] did-fail-load: code=${code} desc="${description}" url=${failUrl}`)
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    forwardDatadogError({
      source: 'main-render-process-gone',
      message: `Main renderer process exited (${details.reason})`,
      level: 'critical',
      context: {
        origin: 'main-process',
        reason: details.reason,
        exitCode: details.exitCode,
      },
    })
  })

  function notifyZoomLevel(): void {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const level = mainWindow.webContents.getZoomLevel()
      mainWindow.webContents.send('zoom-changed', level)
    }
  }

  // Pinch-to-zoom
  mainWindow.webContents.on('zoom-changed', () => notifyZoomLevel())

  // Keyboard zoom (Ctrl/Cmd + =/-/0) and block Ctrl+W from closing the window
  mainWindow.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return
    const mod = input.control || input.meta
    if (mod && input.key.toLowerCase() === 'w') {
      e.preventDefault()
      return
    }
    if (mod && (input.key === '=' || input.key === '+' || input.key === '-' || input.key === '0')) {
      setTimeout(notifyZoomLevel, 50)
    }
  })

  setMainWindow(mainWindow)

  mainWindow.on('closed', () => {
    mainWindow = null
    setMainWindow(null)
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('close', (e) => {
    if (isQuitInProgress()) return

    const onClose = (settings.get('onAppClose') as string | undefined) || 'tray'
    if (onClose === 'tray') {
      e.preventDefault()
      mainWindow!.hide()
      createTray()
      return
    }
    if (ipc.hasActiveOperations()) {
      e.preventDefault()
      ipc.getActiveDetails()
        .catch(() => [] as Awaited<ReturnType<typeof ipc.getActiveDetails>>)
        .then((details) => {
          if (mainWindow!.isDestroyed()) return
          if (details.length === 0) { quitApp(); return }
          mainWindow!.webContents.send('confirm-quit', details)
        })
      return
    }
    quitApp()
  })
}

function updateTrayMenu(): void {
  if (!tray) return
  const contextMenu = Menu.buildFromTemplate([
    { label: i18n.t('tray.showApp'), click: () => showMainWindow() },
    { type: 'separator' },
    { label: i18n.t('tray.quit'), click: () => quitApp() },
  ])
  tray.setContextMenu(contextMenu)
}

function createTray(): void {
  if (tray) return

  tray = new Tray(TRAY_ICON)
  tray.setToolTip('ComfyUI Desktop 2.0')
  updateTrayMenu()
  tray.on('double-click', () => showMainWindow())
}

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

function showMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    bringToFront(mainWindow)
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
  if (installationId) {
    const entry = comfyWindows.get(installationId)
    if (entry && !entry.window.isDestroyed()) entry.window.destroy()
    comfyWindows.delete(installationId)
  }
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
      console.error(`ComfyUI restart failed for ${installationId}:`, err)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('comfy-output', {
          installationId,
          text: `\n--- Restart failed: ${err.message || err} ---\n`,
        })
      }
    })
}

function onStop({ installationId }: { installationId?: string } = {}): void {
  if (installationId) {
    const entry = comfyWindows.get(installationId)
    if (entry && !entry.window.isDestroyed()) entry.window.destroy()
    comfyWindows.delete(installationId)
  } else {
    for (const [, entry] of comfyWindows) {
      if (!entry.window.isDestroyed()) entry.window.destroy()
    }
    comfyWindows.clear()
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

    const panelActive = entry?.activePanel && entry.activePanel !== 'comfy'
    if (panelActive && entry?.panelView) {
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
    }
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

  const reloadComfy = (): void => {
    if (comfyWindow.isDestroyed()) return
    if (relaunchStates.has(installationId)) return
    comfyContents.stop()
    comfyContents.loadURL(comfyUrl)
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
        comfyContents.loadURL(comfyUrl)
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
    lastTheme: { bg: COMFY_BG, text: '#dddddd' },
    layoutViews,
  })

  // Now that the entry exists, layout for the first time.
  layoutViews()

  if (proc) {
    proc.on('exit', () => {
      // Session registry handles state cleanup
    })
  }
}

ipcMain.handle('quit-app', () => quitApp())

ipcMain.handle('reset-zoom', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.setZoomLevel(0)
  }
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
function ensurePanelView(installationId: string, entry: ComfyWindowEntry, initialPanel: ComfyPanelKey): WebContentsView {
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

  // Push the *latest* active panel (may differ from initialPanel if the user
  // clicked between buttons during the first load) and steal focus if the
  // window is focused.
  panelView.webContents.once('did-finish-load', () => {
    const latest = comfyWindows.get(installationId)
    if (!latest || latest.window.isDestroyed() || panelView.webContents.isDestroyed()) return
    if (latest.activePanel !== 'comfy') {
      panelView.webContents.send('panel-switch', { panel: latest.activePanel, installationId })
      if (latest.window.isFocused()) panelView.webContents.focus()
    }
  })

  const isDev = !!process.env['ELECTRON_RENDERER_URL']
  const loadPromise = isDev
    ? panelView.webContents.loadURL(
        `${(process.env['ELECTRON_RENDERER_URL'] as string).replace(/\/$/, '')}/panel.html?installationId=${encodeURIComponent(installationId)}&panel=${encodeURIComponent(initialPanel)}`,
      )
    : panelView.webContents.loadFile(
        path.join(__dirname, '../renderer/panel.html'),
        { query: { installationId, panel: initialPanel } },
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
  if (entry.activePanel === 'comfy') {
    if (!entry.comfyView.webContents.isDestroyed()) entry.comfyView.webContents.focus()
  } else if (entry.panelView && !entry.panelView.webContents.isDestroyed() && !entry.panelView.webContents.isLoadingMainFrame()) {
    // Panel exists and is loaded — focus immediately. If still loading, the
    // did-finish-load handler in ensurePanelView will focus it.
    entry.panelView.webContents.focus()
  }
}

function setActivePanel(installationId: string, panel: ComfyPanelKey): void {
  const entry = comfyWindows.get(installationId)
  if (!entry || entry.window.isDestroyed()) return
  if (entry.activePanel === panel) return

  entry.activePanel = panel
  if (panel !== 'comfy') {
    const panelView = ensurePanelView(installationId, entry, panel)
    // If panel view already loaded, push the switch immediately. If still
    // loading, the did-finish-load handler in ensurePanelView will push the
    // current activePanel — guarding against rapid clicks during first load.
    if (!panelView.webContents.isDestroyed() && !panelView.webContents.isLoadingMainFrame()) {
      panelView.webContents.send('panel-switch', { panel, installationId })
    }
  }
  entry.layoutViews()
  if (!entry.titleBarView.webContents.isDestroyed()) {
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
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        bringToFront(mainWindow)
      }
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
    ipc.register({ onLaunch, onStop, onComfyExited, onComfyRestarted, onModelFolderRelaunch, onLocaleChanged: updateTrayMenu })
    updater.register()
    createMainWindow()
  })

  app.on('activate', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
    }
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
    if (!tray && !ipc.hasRunningSessions()) {
      app.quit()
    }
  })
}
