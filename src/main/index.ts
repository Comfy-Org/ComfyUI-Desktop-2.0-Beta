import { app, BrowserWindow, Menu, ipcMain, dialog, shell, clipboard, screen, net, WebContentsView } from 'electron'
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
  downloadEvents,
  getDownloadsTrayState,
  registerDownloadIpc,
  startAssetDownload,
} from './lib/comfyDownloadManager'
import { get as getInstallation, installationEvents } from './installations'
import { getModelDownloadContentScript } from './lib/comfyContentScript'
import { shouldOpenInPopup } from './lib/allowedPopups'
import { showModelFolderRelaunchPage } from './lib/relaunchPage'
import { COMFY_BG, SPLASH_DARK, TITLEBAR_BG, type SplashTheme } from './lib/theme'
import { TITLEBAR_HEIGHT, TRAFFIC_LIGHT_POSITION, comfyTitleBarOverlay, titleBarOverlayForTheme } from './lib/titleBarOverlay'
import { resolveTheme, sourceMap, _registerExtraBroadcastTarget, _unregisterExtraBroadcastTarget, _runningSessions, _broadcastToRenderer, _operationAborts } from './lib/ipc/shared'
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
// is disabled — see whenReady()'s comment about restoring docking. When
// reintroduced, use assets/Comfy_Logo_x64.png so Electron can downsample
// crisply on HiDPI trays.
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
  /**
   * Window-mode unification (Stage W-1) — stable monotonic numeric
   * identifier minted at construction. The PRIMARY key into the
   * `comfyWindows` map; survives attach/detach (W-2/W-3) so a host
   * window can flip between install-backed and chooser-host modes
   * without re-keying.
   *
   * Pre-W-1 the map was string-keyed by either `installationId`
   * (install-backed) or `chooser:N` (install-less). Both rotated
   * with the install identity, which is why the pre-W-4 swap-via-
   * close `returnToDashboard` had to construct a brand-new window:
   * the map key it lived under wasn't valid anymore. The numeric
   * key uncouples "which window is this" from "what install backs
   * it" — `returnToDashboard` is now an in-place flip via
   * `entry.detachInstall()` (W-4).
   *
   * Lookups by `installationId` route through
   * `getEntryByInstallationId(id)` (a `Map<string, number>`
   * secondary index) instead of `comfyWindows.get(id)`.
   */
  windowKey: number
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
   * windows only `'comfy'`, `'launcher-settings'`, and `'directories'`
   * are reachable (Install Settings is hidden — the install caret menu
   * is suppressed without an install backing the window).
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
   *
   * Window-mode unification: this is `null` at construction time for
   * EVERY host (createHostWindow always builds install-less); the
   * install-backed wrapper (and the W-4 chooser-pick claim path) call
   * `attachInstall()` immediately afterwards to populate it. Treating
   * the field as "set only by attachInstall, cleared only by
   * _installCleanup" is what lets `attachInstall`'s already-attached
   * guard work without a chicken-and-egg mismatch on first construction.
   */
  installationId: string | null
  /**
   * Window-mode unification — the partition string the comfyView was
   * constructed with. Pinned at construction (Electron has no API to
   * change a WebContentsView's partition without rebuilding it), so a
   * W-4 chooser-pick claim must reject any install whose partition
   * doesn't match this. Without this gate, attaching a non-unique
   * install (`persist:shared`) to a host that was previously install-
   * backed by a unique-partition install (`persist:${prevId}`) leaks
   * the new install's session data into the previous install's
   * partition bucket. See post-unification-code-review.md F1.
   */
  constructedPartition: string | null
  /**
   * Modal-unification (Track M-2.2) — current step of the first-use
   * takeover, cached on the entry so `buildTitleMenuItems` can read it
   * synchronously when the user opens the file menu (the menu builder
   * runs on click, after the popup config has already been chosen).
   *
   *   - `'none'`              — no first-use takeover mounted (default).
   *   - `'consent-lockdown'`  — consent step is on screen; the title bar
   *                             must be fully locked down (M-2.3).
   *   - `'post-consent'`      — consent accepted; later steps are on
   *                             screen. The waffle menu surfaces a
   *                             `Skip Onboarding` entry (M-2.2) but
   *                             stays otherwise normal.
   *
   * Cached here because `buildTitleMenuItems` (file-menu popup config
   * builder) reads it synchronously when the user clicks the waffle —
   * see the IPC handler comment.
   */
  firstUseMode: 'none' | 'consent-lockdown' | 'post-consent'
  /**
   * Window-mode unification (Stage W-3b) — current title-bar pill
   * label. Install-backed windows mirror the install name (and re-
   * push on rename); install-less hosts hold `'Choose an install'`.
   * Stored on the entry so the unified `title-bar-ready` handshake
   * in `createHostWindow()` can synthesize the initial push without
   * a per-mode callback closure, and so `attachInstall()` /
   * `detachInstall()` (W-3c) can swap it as the window flips modes.
   */
  titleBarText: string
  /**
   * Window-mode unification (Stage W-3b) — install-type icon
   * category string (`local` / `cloud` / `desktop` / …) consumed by
   * the title-bar renderer's `installTypeMetaFor()` helper. `null`
   * for install-less host windows (no icon shown). Mirrors the
   * `titleBarText` design: stored on the entry so the unified
   * `title-bar-ready` handler can re-push without closure capture.
   */
  sourceCategory: string | null
  /**
   * Window-mode unification (Stage W-3b) — symmetric undo for
   * `attachInstall()`. Set by attach (closes over every event listener
   * and map mutation it set up); called by the close handler before
   * view teardown AND by `detachInstall()` to flip the host back to
   * install-less mode in place. `null` whenever the entry is not
   * currently install-backed.
   */
  _installCleanup: (() => void) | null
  /**
   * Window-mode unification (Stage W-3c) — flip this host in place
   * from install-backed to install-less (chooser) mode. Delegates to
   * the freestanding `_detachInstallImpl(entry)` helper; exposed as a
   * method so callers (W-4: `returnToDashboard`, chooser-tile re-
   * attach) can invoke it without importing the helper. No-op when
   * the entry is already install-less. Always populated (set in
   * `createHostWindow()`).
   */
  detachInstall: () => void
}
/**
 * All host windows (install-backed and install-less). Window-mode
 * unification (Stage W-1) — keyed by a stable monotonic numeric
 * `windowKey` minted at construction. Pre-W-1 this was a `Map<string,
 * ...>` keyed by either `installationId` (install-backed) or
 * `chooser:<n>` (install-less); both varied with the install identity,
 * which is what blocked in-place transform between modes.
 *
 * Install-id → window-key lookups go through
 * `getEntryByInstallationId(id)` below (the `installationIdToWindowKey`
 * secondary index). Direct `comfyWindows.get(installationId)` calls
 * are gone post-W-1.
 */
const comfyWindows = new Map<number, ComfyWindowEntry>()
const installationIdToWindowKey = new Map<string, number>()

/**
 * Window-mode unification (Stage W-4) — pending in-place attach
 * claims, set by the chooser-host renderer right before it kicks
 * off a launch action. `onLaunch()` consumes the claim instead of
 * constructing a fresh BrowserWindow when the launch event arrives,
 * so the chooser host the user clicked from becomes the install's
 * own host in place. Keyed by installationId so a fast double-click
 * on the same tile resolves to the same target host.
 *
 * The claim is only honoured when the target window is still alive
 * and still install-less (the user may have closed the chooser host
 * while the install spin-up was running, or picked a second install
 * before the first one finished launching). Stale claims fall
 * through to the legacy "fresh window" path; the chooser-host
 * renderer keeps a fallback `closeHostWindow` wired for that case.
 */
const pendingAttachClaims = new Map<string, number>()
let _nextWindowKeyValue = 0
function nextWindowKey(): number {
  return ++_nextWindowKeyValue
}

/**
 * Window-mode unification (Stage W-1) — install-id → entry lookup,
 * routed through the `installationIdToWindowKey` secondary index.
 * Returns `undefined` if no install-backed entry currently carries
 * the id (install-less host windows never enter the index, and a
 * detached window — once W-3 lands — leaves the index too).
 */
function getEntryByInstallationId(installationId: string): ComfyWindowEntry | undefined {
  const key = installationIdToWindowKey.get(installationId)
  return key === undefined ? undefined : comfyWindows.get(key)
}

/**
 * Window-mode unification (Stage W-1) — register an entry into the
 * primary map AND (when install-backed) the secondary index. Use
 * this from constructors and (W-3) `attachInstall` instead of
 * touching `comfyWindows.set` directly.
 */
function registerHostEntry(entry: ComfyWindowEntry): void {
  comfyWindows.set(entry.windowKey, entry)
  if (entry.installationId !== null) {
    installationIdToWindowKey.set(entry.installationId, entry.windowKey)
  }
}

/**
 * Window-mode unification (Stage W-1) — unregister an entry from
 * BOTH the primary map AND the secondary index. Use this from the
 * `'closed'` handler and (W-3) `detachInstall` instead of touching
 * `comfyWindows.delete` directly.
 */
function unregisterHostEntry(entry: ComfyWindowEntry): void {
  comfyWindows.delete(entry.windowKey)
  if (entry.installationId !== null) {
    const indexed = installationIdToWindowKey.get(entry.installationId)
    if (indexed === entry.windowKey) {
      installationIdToWindowKey.delete(entry.installationId)
    }
  }
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

/**
 * Resolve an IPC `event.sender` to the comfy window entry whose title-bar
 * WebContentsView owns it, by strict reference equality.
 *
 * This is the single chokepoint every title-bar IPC must funnel through —
 * see `comfy-window:open-title-menu` / `comfy-window:set-panel` /
 * `comfy-window:go-back` / `comfy-window:go-forward` /
 * `comfy-window:click-app-update-pill` / `comfy-window:click-install-update-pill`.
 *
 * Aux windows are NEVER reachable through this lookup:
 *   - OAuth / cloud-login popups spawned via `comfyContents.setWindowOpenHandler`
 *     are unregistered loose `BrowserWindow`s with `preload: undefined`. They
 *     have no `ipcRenderer`, can't send these IPCs, and even if a future
 *     change re-introduced a preload they wouldn't be in `comfyWindows`.
 *   - The `comfyView` and `panelView` WebContentsViews of a registered
 *     entry are deliberately matched by separate predicates
 *     (`panelView?.webContents === event.sender`) — never by this helper —
 *     so the file/install menu can't be popped from inside ComfyUI's content
 *     surface or from a panel renderer.
 *
 * Returning `null` here causes every consuming IPC handler to no-op, which
 * is the desired behaviour for every off-path sender. Keep this contract
 * tight when adding new title-bar IPCs: prefer this helper over open-coding
 * a sender match.
 */
function findEntryByTitleBarSender(wc: Electron.WebContents): { id: number; entry: ComfyWindowEntry } | null {
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

/**
 * Step 5 §16 — pre-cleared close set. Marks a window as having
 * already passed the panel renderer's tier-aware consult so the
 * subsequent `close` event handler can skip the consult and tear
 * down immediately. Used by `confirmAndCloseAllHostWindows` (the
 * global confirm dialog already lists in-progress operations /
 * sessions / downloads, so the per-window prompt would be redundant
 * noise after the user confirmed the bulk close). Pre-W-4 also used
 * by `returnToDashboard` for its swap-via-close flow; W-4's in-place
 * detach no longer goes through the close handler.
 */
const preClearedClose = new WeakSet<BrowserWindow>()

/**
 * Step 5 §16 — main consults the panel renderer before tearing down
 * a host window so a Tier 2 progress / Tier 3 takeover overlay can
 * prompt the user to confirm cancellation via the standardised
 * cancel-prompt copy. Returns true when the renderer cleared the
 * close (no overlay open, or the user confirmed cancellation),
 * false when the renderer aborted (user dismissed the prompt).
 *
 * Falls back to "cleared" when the panelView is missing (no panel
 * has been mounted yet — nothing to lose), the webContents is
 * destroyed (already torn down), or the renderer doesn't reply
 * within 5s (a hung renderer shouldn't permanently wedge close).
 */
async function consultPanelRendererClose(panelView: WebContentsView | null | undefined): Promise<boolean> {
  if (!panelView || panelView.webContents.isDestroyed()) return true
  return new Promise<boolean>((resolve) => {
    const requestId = `close-${Date.now()}-${Math.random().toString(36).slice(2)}`
    let settled = false
    const onResponse = (
      event: Electron.IpcMainEvent,
      payload: { requestId?: string; cleared?: boolean } | undefined,
    ): void => {
      if (event.sender !== panelView.webContents) return
      if (payload?.requestId !== requestId) return
      if (settled) return
      settled = true
      ipcMain.off('comfy-window:request-close-response', onResponse)
      resolve(!!payload?.cleared)
    }
    ipcMain.on('comfy-window:request-close-response', onResponse)
    try {
      panelView.webContents.send('comfy-window:request-close', { requestId })
    } catch {
      settled = true
      ipcMain.off('comfy-window:request-close-response', onResponse)
      resolve(true)
      return
    }
    setTimeout(() => {
      if (settled) return
      settled = true
      ipcMain.off('comfy-window:request-close-response', onResponse)
      resolve(true)
    }, 5000)
  })
}

/**
 * Close every host window (install-backed and chooser hosts alike) but
 * leave the app / tray alive. Phase 3 §16 — File menu's "Close All
 * Windows" entry. Each window's existing `close` handler runs the full
 * teardown (`stopRunning` + webContents close + window.destroy), so we
 * just dispatch `close()` and let those handlers do the work — the
 * handlers also consult the panel renderer per Step 5 §16 unless the
 * window is already in `preClearedClose`. Snapshot the entry list
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
 * In-place flip via `entry.detachInstall()` (Stage W-4) is currently
 * disabled — too many edge-case bugs around the in-place swap. The
 * close+open swap pays a visible flicker but exercises the same
 * close-handler teardown that production has used since main, which
 * is the codepath we trust right now. See
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
 * `getActiveDetails()` helper that powered the legacy launcher's
 * quit-warning modal. With one or zero windows the close happens
 * straight through with no prompt.
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
    // Step 5 §16 — the global dialog already lists in-progress ops /
    // sessions / downloads, so the per-window tier-aware prompt would
    // be redundant after the user confirmed the bulk close. Pre-clear
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
    // Window-mode unification (Stage W-1) — refresh every install-
    // backed entry's comfy tab. Install-less host windows (entry.
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
 * Window-mode unification (Stage W-2) — single shared constructor for
 * host windows (install-backed and install-less). Builds the
 * BrowserWindow + titleBarView + comfyView, wires `layoutViews` +
 * macOS fullscreen forwarding + bounds-save listeners + the close /
 * closed handlers + the title-bar-ready handshake, and registers the
 * entry into the `comfyWindows` map.
 *
 * Mode-specific wiring is layered on AFTER this returns by the two
 * thin wrapper paths (`onLaunch` for install-backed; the body of
 * `openChooserHostWindow` for install-less) — comfyContents listeners
 * (theme observer, content script, fail-retry, render-process-gone),
 * `attachSessionDownloadHandler`, the install-record `'updated'`
 * handler, and the chooser-only eager `ensurePanelView('chooser')`
 * all live in the wrappers.
 *
 * Pre-W-2 the two constructors duplicated the BrowserWindow + views
 * skeleton, both close handlers, both closed handlers, both
 * `layoutViews`, both title-bar-ready broadcasts, and the macOS
 * fullscreen forwarding. Stage W-3 will move the comfyContents-bound
 * listeners and the install-record handler behind paired
 * `attachInstall(id)` / `detachInstall()` operations on the entry,
 * which is the slice that actually lets a window transform between
 * modes in place. W-2 is the structural prep — no behaviour change
 * apart from the side-effect of W-1's bounds unification (chooser
 * hosts now also restore `maximized` from the saved bounds, since
 * the bounds-key collapse made restoring meaningful for them).
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
   * install name; chooser hosts pass `'Choose an install'`. Stored on
   * `entry.titleBarText` so the unified `title-bar-ready` handshake
   * can re-push it without a per-mode callback (W-3b).
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

  // Push the initial state once the title bar's preload signals readiness.
  // Filter to this title bar's WebContents to avoid cross-talk between windows.
  //
  // Stage W-3b — the install-update pill + source-category icon
  // (previously install-backed-only via an `onTitleBarReady` callback)
  // are now resolved off the entry: the title text and source-category
  // come from `entry.titleBarText` / `entry.sourceCategory` (set by
  // `attachInstall()` for install-backed, by the chooser-host wrapper
  // for install-less); the install-update pill is computed from
  // `entry.installationId` when non-null.
  const onTitleBarReadyHandler = (event: Electron.IpcMainEvent): void => {
    if (event.sender !== titleBarView.webContents) return
    if (titleBarView.webContents.isDestroyed()) return
    const entry = comfyWindows.get(windowKey)
    titleBarView.webContents.send('comfy-titlebar:panel-changed', entry?.activePanel ?? 'comfy')
    if (entry) {
      titleBarView.webContents.send('comfy-titlebar:theme-changed', entry.lastTheme)
      titleBarView.webContents.send('comfy-titlebar:title-changed', entry.titleBarText)
      titleBarView.webContents.send('comfy-titlebar:source-category-changed', entry.sourceCategory)
      _notifyTitleBarNavState(entry)
    }
    // Phase 3 §18 — both modes get the app-update pill and the
    // downloads tray. The install-update pill is install-backed only:
    // gated on `entry.installationId !== null` so a chooser host (or
    // a detached install-backed host post-W-3c) skips it cleanly.
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
    ensureTitleMenuPopup(comfyWindow)
  }
  ipcMain.on('comfy-window:title-bar-ready', onTitleBarReadyHandler)

  // Step 5 §16 — close handler is async: preventDefault, consult the
  // panel renderer (so a Tier 2/3 op can prompt the user), run the
  // attached install's symmetric cleanup if any, and only then destroy.
  // The `closingInFlight` guard prevents re-entry on rapid clicks of
  // the OS close button while the consult is pending.
  //
  // Stage W-3b — pre-teardown work that used to live in a per-mode
  // `onBeforeTeardown` opts callback (detachWindowDownloads +
  // ipc.stopRunning + install-keyed map cleanup + installationEvents
  // unsubscribe) is now consolidated on `entry._installCleanup`,
  // which `attachInstall()` sets and `detachInstall()` (W-3c) /
  // window close both invoke. Per-window cleanup
  // (`detachWindowDownloads`) lives outside `_installCleanup` because
  // it survives mode flips — the per-window download routing is
  // attached at session level when the install does, and only needs
  // to be torn down when the BrowserWindow itself goes away.
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
    // Window-mode unification (Stage W-1) — unregister via the
    // primary windowKey AND the secondary install-id index.
    const closedEntry = comfyWindows.get(windowKey)
    if (closedEntry) unregisterHostEntry(closedEntry)
    // Window-mode unification — drop any pending W-4 attach claim
    // whose target is THIS window. Without this, stale entries pile
    // up over the app's lifetime AND can be silently consumed by an
    // unrelated future `onLaunch()` (the consumer's destroyed-window
    // check rejects them, but the side-effect `delete` still fires).
    // See post-unification-code-review.md F2.
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
    panelHistory: ['comfy'],
    panelHistoryIndex: 0,
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
  // Stage W-3c — bind the detach method to the freestanding impl.
  // Done post-literal so the closure captures the registered entry
  // by reference, not by a copy at literal-build time.
  entry.detachInstall = () => _detachInstallImpl(entry)
  registerHostEntry(entry)

  return { windowKey, comfyWindow, titleBarView, comfyView, entry, layoutViews }
}

/**
 * Window-mode unification — resolve the comfyView session partition
 * an install must be loaded into. Unique-partition installs
 * (`browserPartition === 'unique'`) get their own `persist:${id}`
 * bucket so cookies / IndexedDB / Service Workers don't leak across
 * sibling installs; everything else shares `persist:shared`. Used by
 * both the install-backed wrapper (constructing a fresh comfyView)
 * and the W-4 chooser-pick claim acceptance check (rejecting claims
 * where the host's pinned partition doesn't match what the new
 * install needs).
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
    // so force the host's activePanel back to `'comfy'` and clear any
    // breadcrumb history. Without this, a launch kicked off from a
    // non-comfy panel (e.g. the install-settings DetailModal) would
    // leave the body stranded on the lifecycle / settings panel —
    // `refreshComfyTabBody` early-returns on `activePanel !== 'comfy'`.
    // The trailing `refreshComfyTabBody` still handles the
    // comfy-lifecycle → comfy body-mode swap when the entry was
    // already on `'comfy'` (setActivePanel early-returns there).
    setActivePanel(existing.windowKey, 'comfy', 'reset')
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
      // through to the legacy fresh-window path below so the user
      // still gets the install they asked for.
    }
  }

  // Window-mode unification (Stage W-3b) — install-backed wrapper.
  // Construction is split in two:
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
  // invariant. See post-unification-code-review.md F11.
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
 * Window-mode unification (Stage W-3b) — bind a host-window entry to
 * an installation. Layered on top of `createHostWindow()` (the
 * mode-agnostic skeleton), this is the install-only wiring that used
 * to live inline in `onLaunch`'s post-construction code:
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
 *     by the close handler before view teardown AND (W-3c) by
 *     `detachInstall()` when the host flips back to install-less
 *     mode in place
 *   - calls `comfyContents.loadURL(comfyUrl)` to start the load
 *
 * Calling on an already-attached entry throws — callers must detach
 * first (W-3c) or construct a fresh window. The cleanup is
 * idempotent (calling it twice is a no-op the second time) so the
 * close handler is free to invoke it without checking detach state.
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
    // wrapper recovers). See post-unification-code-review.md F11.
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
  // with `entry.installationId` (W-3c's detach symmetrically clears
  // both).
  entry.installationId = installationId
  entry.comfyUrl = comfyUrl
  entry.titleBarText = installation.name
  entry.sourceCategory = sourceMap[installation.sourceId]?.category ?? null
  installationIdToWindowKey.set(installationId, entry.windowKey)

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
  // be mounted (re-attach case post-W-3c). The shared title-bar-ready
  // handshake re-pushes from entry.* on a fresh mount, but the eager
  // push covers the in-place transform path.
  if (!titleBarView.webContents.isDestroyed()) {
    titleBarView.webContents.send('comfy-titlebar:title-changed', entry.titleBarText)
    titleBarView.webContents.send('comfy-titlebar:source-category-changed', entry.sourceCategory)
    void computeInstallUpdateAvailable(installationId).then((state) => {
      if (titleBarView.webContents.isDestroyed()) return
      titleBarView.webContents.send('comfy-titlebar:install-update-changed', state)
    })
  }

  // Reflect rename / source change in both the comfy tab and the OS-level
  // window title as the install record mutates. Phase 3 §18 — also
  // recompute the install-update pill state (the install's source may
  // have flipped its statusTag between releases as the release-cache
  // resolves in the background).
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
      // operations continued running orphaned in main after window
      // teardown — the rollback hole called out in
      // post-unification-code-review.md F7.
      const inFlight = _operationAborts.get(id)
      if (inFlight) {
        inFlight.abort()
        _operationAborts.delete(id)
      }
      // Detach the relaunch will-navigate blocker before clearing the
      // map slot — without `comfyContents.off(...)`, a re-attach
      // (W-3c → W-4) would inherit a still-active blocker that
      // preventDefaults every navigation until the comfyContents
      // itself is destroyed. See post-unification-code-review.md F8.
      const relaunch = relaunchStates.get(id)
      if (relaunch && !comfyContents.isDestroyed()) {
        comfyContents.off('will-navigate', relaunch.navBlocker)
      }
      ipc.stopRunning(id)
      comfyFailRetryTimerCancels.delete(id)
      relaunchStates.delete(id)
      installationIdToWindowKey.delete(id)
      entry.installationId = null
    }
    entry.comfyUrl = ''
  }
  return true
}

/**
 * Window-mode unification (Stage W-3c) — flip an install-backed host
 * window in place to install-less (chooser) mode. The symmetric undo
 * to `attachInstall()`. Bound onto `entry.detachInstall` by
 * `createHostWindow()`; the underscore-prefixed name signals that
 * callers should invoke `entry.detachInstall()` rather than this
 * freestanding helper directly.
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
 *      `'Choose an install'`, `sourceCategory` → `null`) and pushes
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
 *
 * Stage W-3c only defines the operation; W-4 wires the call sites
 * (`returnToDashboard` and the chooser-tile re-attach flow).
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
  entry.titleBarText = 'Choose an install'
  entry.sourceCategory = null
  if (!entry.titleBarView.webContents.isDestroyed()) {
    entry.titleBarView.webContents.send('comfy-titlebar:title-changed', entry.titleBarText)
    entry.titleBarView.webContents.send('comfy-titlebar:source-category-changed', null)
  }
  entry.window.setTitle(`Choose an install — Desktop 2.0 v${APP_VERSION}`)
  applyChooserHostTheme(entry)

  // Reset nav state to the comfy pill (chooser body for install-less hosts).
  entry.activePanel = 'comfy'
  entry.panelHistory = ['comfy']
  entry.panelHistoryIndex = 0
  if (!entry.titleBarView.webContents.isDestroyed()) {
    entry.titleBarView.webContents.send('comfy-titlebar:panel-changed', 'comfy')
    _notifyTitleBarNavState(entry)
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

/**
 * Window-mode unification (Stage W-1) — bounds-persistence key for
 * install-less host windows. All chooser hosts share the same key so
 * the JSON cache holds at most one chooser bounds entry (pre-W-1
 * each chooser-host construction created a new `chooser:N` entry
 * that was never read again — a slow leak). Bounds restore now
 * works across sessions for chooser hosts as a side benefit.
 */
const CHOOSER_HOST_BOUNDS_KEY = 'chooser'

function openChooserHostWindow(): BrowserWindow {
  // Window-mode unification (Stage W-2) — install-less wrapper.
  // The shared `createHostWindow()` builds the BrowserWindow + 2
  // views skeleton, layoutViews, macOS fullscreen, bounds-save
  // listeners, close / closed handlers, and title-bar-ready
  // handshake. The chooser-only extras live here: a title-bar
  // header label override and an eager `ensurePanelView('chooser')`
  // so the panel body paints on the first frame instead of after
  // the next layout tick.
  //
  // Phase 3 — install-less host windows have no ComfyUI frontend
  // feeding their theme, so the chooser's title bar / overlay
  // colors are driven by the launcher theme (resolved here and
  // refreshed via `applyChooserHostTheme` when the theme setting
  // or OS-level dark-mode preference flips). Both the Vue
  // `<header>` and the OS overlay paint `getChooserHostTheme().bg`
  // (the launcher renderer's `--surface`) so the seam between
  // them stays invisible.
  const initialChooserTheme = getChooserHostTheme()

  const { comfyWindow, entry } = createHostWindow({
    windowTitle: `Choose an install — Desktop 2.0 v${APP_VERSION}`,
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
    // the panelView. Window-mode unification (Stage W-4) — uses the
    // same comfy preload + `persist:shared` partition the install-
    // backed default uses, so a chooser-pick `attachInstall()` can
    // navigate this view in place to the install's URL without
    // rebuilding the WebContentsView. The preload + partition are
    // no-ops on the idle view (nothing loads it before attach).
    // Unique-partition installs (`browserPartition === 'unique'`)
    // still need a fresh window — the in-place attach falls through
    // to `createHostWindow()` for that case.
    comfyWebPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/comfyPreload.js'),
      partition: 'persist:shared',
    },
    titleBarBackground: initialChooserTheme.bg,
    // Empty installationId URL param tells the title-bar Vue to enter
    // install-less mode (hide Install Settings pill, accept the
    // fallback label).
    titleBarInstallationIdParam: '',
    // Stage W-3b — initial title-bar pill text + source-category
    // are stored on the entry; the unified title-bar-ready handshake
    // re-pushes from the entry. Install-less hosts have no install
    // backing so the source-category icon stays unset.
    initialTitleBarText: 'Choose an install',
    initialSourceCategory: null,
  })

  // Force-create the panel WebContentsView with the chooser body —
  // install-less windows always need a panel, and creating it eagerly
  // avoids the empty body flash that would happen on the next
  // layoutViews tick.
  ensurePanelView(entry.windowKey, entry, 'chooser')

  entry.layoutViews()
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
function ensurePanelView(windowKey: number, entry: ComfyWindowEntry, initialPanel: BodyMode): WebContentsView {
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
  // numeric windowKey (Stage W-1) that PanelApp.vue must not see.
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
  windowKey: number,
  panel: ComfyPanelKey,
  source: PanelNavSource = 'navigate',
): void {
  const entry = comfyWindows.get(windowKey)
  if (!entry || entry.window.isDestroyed()) return
  // Install Settings is install-scoped (the install caret menu in the
  // title bar is hidden in install-less host windows). Refuse to switch
  // to it from anywhere when there's no install backing the window — a
  // stray IPC payload must not be able to wedge the window into a body
  // mode that has no install to render. Directories was previously
  // gated alongside Install Settings, but as of §15 it lives on the
  // global File / waffle menu and is install-agnostic — install-less
  // host windows are allowed to open it.
  if (entry.installationId === null && panel === 'install-settings') return

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
 * Modal-unification (Track M-2.2 / M-4) — first-use takeover step
 * plumbing.
 *
 * Forwards the panel renderer's `setFirstUseMode(mode)` push to the
 * host's title-bar WebContentsView (consumed by M-2.3's lockdown)
 * AND caches the value on the entry — `buildTitleMenuItems`
 * (file-menu popup config builder) reads `entry.firstUseMode`
 * synchronously when the user clicks the waffle, so the cached
 * value has to be ground-truth.
 *
 * Note: the M-4 retirement removed the `comfy-window:set-titlebar-
 * inert` sibling that previously sat above this handler (broad
 * "title bar disabled during Tier 3 takeover" gate). The
 * binding-modal chrome (M-3) plus the `consent-lockdown` waffle
 * hide (M-2.3) cover the cases that still need title-bar
 * interactivity gating; everything else stays live.
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
 * Phase 3 §18 — install-update pill state. Reads the install record
 * via `getInstallation`, resolves its source via `sourceMap`, and
 * applies the same `getStatusTag()` rule the chooser cards / kebab
 * menu use (`statusTag.style === 'update'`). Returns
 * `{ available: false }` for install-less host windows or when the
 * install isn't found.
 *
 * Track B item 1 — also surfaces the target `version` from the status
 * tag so the title bar's install-update pill can read
 * "Update v{version}" matching the app-update pill (rather than the
 * generic "Update available"). Source plugins populate
 * `StatusTag.version` next to the localised label.
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
 * Phase 3 §18 — fan out an updater state transition to every host
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
 * Phase 3 §18 — title-bar app-update pill click. Resolves the entry
 * via the title-bar webContents sender, then sends
 * `panel-trigger-overlay` to the panel renderer so it can mount the
 * Tier 1 app-update popover via `openOverlay`. The popover overlays
 * whatever the user is currently looking at; we don't switch panels
 * here.
 */
ipcMain.on('comfy-window:click-app-update-pill', (event) => {
  const found = findEntryByTitleBarSender(event.sender)
  if (!found) return
  const { entry } = found
  const panelView = entry.panelView
  if (!panelView || panelView.webContents.isDestroyed()) return
  panelView.webContents.send('panel-trigger-overlay', { kind: 'app-update' })
})

/**
 * Phase 3 §18 — title-bar install-update pill click. Refuses on
 * install-less hosts (the pill is suppressed there but a defensive
 * guard keeps stray IPC from triggering anything). Sends
 * `panel-trigger-overlay` with the entry's installationId so the
 * renderer can open the Manage overlay on the update tab — same
 * surface the chooser kebab "Update…" entry routes to.
 */
ipcMain.on('comfy-window:click-install-update-pill', (event) => {
  const found = findEntryByTitleBarSender(event.sender)
  if (!found) return
  const { entry } = found
  const installationId = entry.installationId
  if (!installationId) return
  const panelView = entry.panelView
  if (!panelView || panelView.webContents.isDestroyed()) return
  panelView.webContents.send('panel-trigger-overlay', {
    kind: 'install-update',
    installationId,
  })
})

/**
 * Track F — push the downloads-tray snapshot to a single title bar.
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
 * Track F — fan out a downloads-tray state change to every host
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
 * Track F — title-bar downloads-tray click. Routes through
 * `panel-trigger-overlay` so the panel renderer can mount the Tier 1
 * downloads popover via `openOverlay`. The popover reads its data
 * from the renderer's `downloadStore` (already wired via
 * `onModelDownloadProgress`) so the click does not need to ship any
 * additional payload.
 */
ipcMain.on('comfy-window:click-downloads-tray', (event) => {
  const found = findEntryByTitleBarSender(event.sender)
  if (!found) return
  const { entry } = found
  const panelView = entry.panelView
  if (!panelView || panelView.webContents.isDestroyed()) return
  panelView.webContents.send('panel-trigger-overlay', { kind: 'downloads' })
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
// existing handlers (set-panel / new-chooser-window) and closes the
// popup. On close, main re-emits `comfy-titlebar:menu-closed` to the
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
  /**
   *  Updated on every open. Window-mode unification (Stage W-1) — now
   *  the numeric `windowKey` of the parent host entry. `0` is a
   *  sentinel for "no popup has been opened yet" since `nextWindowKey`
   *  always returns positive numbers.
   */
  parentEntryId: number
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
    // §15 — Directories is a global / cross-install affordance (the
    // launcher's view of disk: models, outputs, inputs) and lives on
    // the File / waffle menu alongside the other app-level entries.
    // §16 — window-management entries (Return to Dashboard, Close
    // Window, Close All Windows) sit between the open-new gesture and
    // the page-nav affordances; the separator below them keeps the
    // two groups visually distinct. Return to Dashboard is install-
    // backed-only — install-less host windows are already on the
    // chooser body so the entry would be a no-op there.
    const items: TitleMenuItem[] = [
      { id: 'new-window', label: 'New Window' },
    ]
    if (entry.installationId !== null) {
      items.push({ id: 'return-to-dashboard', label: 'Return to Dashboard' })
    }
    items.push(
      { id: 'close-window', label: 'Close Window' },
      { id: 'close-all-windows', label: 'Close All Windows' },
      { kind: 'separator' },
    )
    // Track B item 3 — install-creation / import flows live ONLY on
    // the dashboard (chooser-host) waffle menu. Once the user is in
    // a Comfy Instance window the only Desktop-2 escape hatch is
    // "Return to Dashboard" — there is no silent overlap with another
    // running install. The install-backed branch must NOT reach these
    // panels (no setActivePanel('new-install') etc. via the file
    // menu) so the in-Comfy chrome stays closed-off, matching the
    // post-Phase-3 design doc's "Comfy Instance is closed-off" rule.
    if (entry.installationId === null) {
      // Modal-unification (Track M-2.2) — Skip Onboarding lives at the
      // top of the install-creation group when the first-use takeover
      // is past the consent step. We surface it ONLY in `post-consent`
      // (never during `consent-lockdown`, never when no takeover is
      // mounted) so the entry shows up exactly when the user has both
      // (a) accepted T&Cs and (b) is mid-onboarding — i.e. the moment
      // the menu's primary purpose is "let me out of this".
      if (entry.firstUseMode === 'post-consent') {
        items.push({ id: 'skip-onboarding', label: 'Skip Onboarding' })
      }
      items.push(
        { id: 'new-install', label: 'New Install' },
        { id: 'track', label: 'Track Existing Install' },
        { id: 'load-snapshot', label: 'Load Snapshot' },
        { kind: 'separator' },
      )
    }
    items.push(
      { id: 'directories', label: 'Directories', checked: entry.activePanel === 'directories' },
      { id: 'launcher-settings', label: 'App Settings' },
    )
    return items
  }
  return [
    { id: 'install-settings', label: 'Install Settings', checked: entry.activePanel === 'install-settings' },
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
    parentEntryId: 0,
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
  parentEntryId: number
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
    else if (id === 'return-to-dashboard') {
      // §16 — flip the install-backed host in place to chooser-host
      // mode (Stage W-4). The same BrowserWindow stays alive; the
      // file-menu popup is parented to it so it stays valid through
      // the in-place swap (no popup teardown, just a body swap
      // underneath the popup).
      void returnToDashboard(entry.parentEntryId)
    } else if (id === 'close-window') {
      // §16 — close just the parent host window. Each host window has
      // its own `close` handler that runs the teardown sequence
      // (`stopRunning` + webContents close + window.destroy), so we
      // just dispatch close() here. The popup is auto-destroyed when
      // its parent goes; the trailing hideTitleMenuPopup call below
      // is guarded against an already-destroyed popup.
      const parentEntry = comfyWindows.get(entry.parentEntryId)
      if (parentEntry && !parentEntry.window.isDestroyed()) {
        parentEntry.window.close()
      }
    } else if (id === 'close-all-windows') {
      // §16 — see `closeAllHostWindows` / `confirmAndCloseAllHostWindows`.
      // For two or more open windows we confirm via a native dialog
      // that lists the open windows + any active operations that
      // would be cancelled. With one or zero windows the close
      // happens straight through. The parent of this popup is among
      // the windows being closed; its popup is auto-destroyed, and
      // the trailing hideTitleMenuPopup is guarded against an
      // already-destroyed popup.
      const parentEntry = comfyWindows.get(entry.parentEntryId)
      const parentWindow = parentEntry && !parentEntry.window.isDestroyed()
        ? parentEntry.window
        : null
      void confirmAndCloseAllHostWindows(parentWindow)
    } else if (id === 'directories') setActivePanel(entry.parentEntryId, 'directories')
    else if (id === 'launcher-settings') setActivePanel(entry.parentEntryId, 'launcher-settings')
    else if (id === 'skip-onboarding') {
      // Modal-unification (Track M-2.2) — forward to the panel renderer
      // so it can run the same `markFirstUseCompleted` + dismiss
      // sequence the Cloud-branch pick uses (PanelApp owns the
      // `firstUseCompleted` flip and the overlay close — see
      // `handleFirstUseComplete`). Resolve the host entry the same way
      // the close-window branches above do.
      const parentEntry = comfyWindows.get(entry.parentEntryId)
      if (parentEntry?.panelView && !parentEntry.panelView.webContents.isDestroyed()) {
        parentEntry.panelView.webContents.send('comfy-panel:first-use-skip')
      }
    }
    else if (id === 'new-install' || id === 'track' || id === 'load-snapshot' || id === 'quick-install') {
      // Track B item 3 — install-creation / import flows are
      // chooser-host-only. `buildTitleMenuItems` already filters them
      // out of the install-backed file menu; this guard is the
      // belt-and-braces so a stale popup or an out-of-order IPC
      // can't navigate an in-Comfy host into one of these panels.
      const parentEntry = comfyWindows.get(entry.parentEntryId)
      if (parentEntry?.installationId === null) {
        setActivePanel(entry.parentEntryId, id)
      }
    }
  } else {
    if (id === 'install-settings') setActivePanel(entry.parentEntryId, 'install-settings')
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
 * In-place attach (Stage W-4) is currently disabled — too many edge-
 * case bugs (window destruction mid-attach, partition mismatches,
 * missed instance-started fallbacks closing the only remaining
 * window). Always return `false` so the renderer falls back to the
 * legacy close-host + open-fresh-install-window swap, which is the
 * pre-W-4 behaviour and the path that's been stable in production.
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
  for (const entry of comfyWindows.values()) {
    if (entry.window !== win) continue
    // Window-mode unification (Stage W-1) — install-less host
    // windows (entry.installationId === null) have no install id to
    // return; treating that case as `undefined` matches the pre-W-1
    // semantics where chooser-host map keys (`chooser:N`) leaked
    // through here as fake install ids that no caller could resolve.
    return entry.installationId ?? undefined
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
    // Phase 3 §18 — forward updater state transitions to every host
    // window's title-bar webContents. Subscribed once at startup;
    // the helper iterates `comfyWindows` so newly-opened windows
    // pick up live transitions automatically (initial state is
    // pushed on `comfy-window:title-bar-ready` for the slow path).
    updater.onUpdateStateChanged(_broadcastAppUpdateStateToTitleBars)
    // Track F — fan out downloads-tray state changes to every host
    // window's title-bar. Subscribed once at startup; the helper
    // iterates `comfyWindows` so newly-opened windows pick up live
    // transitions automatically (initial state is pushed on
    // `comfy-window:title-bar-ready` for the slow path).
    downloadEvents.on('tray-state-changed', _broadcastDownloadsToTitleBars)
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
