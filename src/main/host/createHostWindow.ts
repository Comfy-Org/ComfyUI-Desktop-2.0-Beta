import { BrowserWindow, WebContentsView, ipcMain, screen, shell } from 'electron'
import path from 'path'
import type { InstallationRecord } from '../installations'
import { getAppVersion } from '../lib/ipc'
import { attachContextMenu } from '../lib/contextMenu'
import {
  attachSessionDownloadHandler,
  detachWindowDownloads,
  getDownloadsTrayState,
} from '../lib/comfyDownloadManager'
import { handleFirebasePopup, isFirebaseAuthHandlerUrl } from '../auth/firebaseBridge'
import {
  isCheckoutReturnUrl,
  isCheckoutUrl,
  isLikelyDownloadUrl,
  shouldOpenInPopup,
} from '../lib/allowedPopups'
import { COMFY_BG, TITLEBAR_BG } from '../lib/theme'
import {
  TITLEBAR_HEIGHT,
  TRAFFIC_LIGHT_POSITION,
  titleBarOverlayForTheme,
} from '../lib/titleBarOverlay'
import {
  _registerExtraBroadcastTarget,
  _unregisterExtraBroadcastTarget,
  resolveTheme,
} from '../lib/ipc/shared'
import * as mainTelemetry from '../lib/telemetry'
import { forwardDatadogError } from '../lib/processErrorHandlers'
import * as updater from '../lib/updater'
import { getSavedBounds, getWindowOptions, saveWindowBounds } from '../lib/windowState'
import { ensureSystemModal } from '../popups/systemModal'
import { hideCheckoutBackdrop, showCheckoutBackdrop } from '../popups/checkoutBackdrop'
import { hideTitlePopupForParent, prewarmTitlePopup } from '../popups/titlePopup'
import { destroyPanelView, ensurePanelView } from './panelView'
import {
  comfyWindows,
  computeBodyMode,
  dropAttachClaimsForWindow,
  isChooserHost,
  isInstallHost,
  nextWindowKey,
  registerHostEntry,
  revealColdStartHostIfPending,
  setLastFocusedInstallationId,
  shouldConfirmKillForEntry,
  unregisterHostEntry,
} from './registry'
import type { ComfyWindowEntry, ComfyPanelKey } from './registry'

/** Default size for a freshly-spawned host window when a sibling of the same
 *  identity is already open. Matches the no-saved-bounds default in `getWindowOptions()`. */
const DEFAULT_HOST_WIDTH = 1280
const DEFAULT_HOST_HEIGHT = 900

export type CloseConsultResult = 'cleared' | 'aborted' | 'defer'

/** A `forceClose` (caller pre-cleared) overrides a renderer-side cancel: launch-guard
 *  eviction and bulk Exit-All consent at a higher level and must not be stalled. */
export function shouldBailAfterConsult(consult: CloseConsultResult, forceClose: boolean): boolean {
  return consult === 'aborted' && !forceClose
}

/** Fires only when the renderer deferred, the host would kill a local process, and the
 *  caller hasn't pre-cleared. Cloud/remote-backed windows skip it (closing never kills
 *  a local ComfyUI); the entry-exists check is folded into `killsLocalSession`. */
export function shouldShowInstallCloseConfirm(
  consult: CloseConsultResult,
  killsLocalSession: boolean,
  forceClose: boolean,
): boolean {
  return consult === 'defer' && killsLocalSession && !forceClose
}

export function shouldBailAfterCloseConfirm(confirmed: boolean, forceClose: boolean): boolean {
  return !confirmed && !forceClose
}

/** The OS ✕ on the last install window flips to chooser mode in place so the app stays
 *  alive on the dashboard. Force-close skips the detach: the caller wants the window gone
 *  and a stray dashboard window after a swap-installs flow is noise. */
export function shouldDetachLastInstallWindowToDashboard(
  isInstallHostWindow: boolean,
  hasEntry: boolean,
  isLastWindow: boolean,
  forceClose: boolean,
): boolean {
  return isInstallHostWindow && hasEntry && isLastWindow && !forceClose
}

const APP_ICON = path.join(__dirname, '..', '..', 'assets', 'Comfy_Logo_x256.png')
const APP_VERSION = getAppVersion()

/** Center pill text for install-less host windows (chooser/dashboard). */
export const CHOOSER_HOST_TITLE_TEXT = 'Comfy Desktop'
export const CHOOSER_HOST_WINDOW_TITLE = `${CHOOSER_HOST_TITLE_TEXT} — v${APP_VERSION}`

/** Shared by all install-less hosts so the JSON cache holds at most one chooser entry. */
const CHOOSER_HOST_BOUNDS_KEY = 'chooser'

/** Late-bound dependencies on host machinery still living in `index.ts`. Set once
 *  at the top of `whenReady` via `setHostWindowFactories(...)`. */
export interface HostWindowFactories {
  /** Async beforeunload-style consult through the panel renderer:
   *    - `cleared`  — no overlay / user confirmed cancelling one → proceed
   *    - `aborted`  — user dismissed the cancel-prompt → keep window open
   *    - `defer`    — no overlay; main owns the close-window confirm */
  consultPanelRendererClose: (
    panelView: WebContentsView | null | undefined,
  ) => Promise<'cleared' | 'aborted' | 'defer'>
  /** Shell-level "Close Window" confirm, owned by main so a hidden panel
   *  renderer can't swallow it. Shared with the Close Window menu entry. */
  confirmCloseInstanceWindow: (
    window: BrowserWindow,
    isLastWindow: boolean,
    theme: { bg: string; text: string },
  ) => Promise<boolean>
  detachInstallImpl: (entry: ComfyWindowEntry) => void
  preClearedClose: WeakSet<BrowserWindow>
  computeInstallUpdateAvailable: (
    installationId: string,
  ) => Promise<{ available: boolean; version?: string }>
}

let factories: HostWindowFactories | null = null

export function setHostWindowFactories(opts: HostWindowFactories): void {
  factories = opts
}

function getFactories(): HostWindowFactories {
  if (!factories) {
    throw new Error('setHostWindowFactories must be called before host construction')
  }
  return factories
}

// Electron's macOS WebAuthn/passkey support is broken, so inject a banner into auth
// popups telling users to use password + OTP instead.
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
    `b.textContent='\\u24d8 Passkeys are not supported in Comfy Desktop on macOS. Please use your password or verification code to sign in.';` +
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

/** Credits-checkout popup sizing: a landscape rectangle scaled to the parent display's
 *  work area, clamped to a min/max band and a max aspect ratio. */
const CHECKOUT_MIN_WIDTH = 720
const CHECKOUT_MAX_WIDTH = 1280
const CHECKOUT_MIN_HEIGHT = 560
const CHECKOUT_MAX_HEIGHT = 860
const CHECKOUT_WIDTH_FRACTION = 0.82
const CHECKOUT_HEIGHT_FRACTION = 0.82
/** Keep it a horizontal rectangle: width is at least this × height. */
const CHECKOUT_MIN_ASPECT = 1.4

/**
 * Compute centered, work-area-fitted bounds for the checkout popup on the parent's
 * display. `screen.workArea` already excludes the macOS menu bar / Dock and the
 * Windows taskbar.
 */
function checkoutPopupBounds(parent: BrowserWindow): Electron.Rectangle {
  const parentBounds = parent.getBounds()
  const { workArea } = screen.getDisplayMatching(parentBounds)
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

  const height = clamp(
    Math.round(workArea.height * CHECKOUT_HEIGHT_FRACTION),
    CHECKOUT_MIN_HEIGHT,
    Math.min(CHECKOUT_MAX_HEIGHT, workArea.height),
  )
  const maxWidth = Math.min(CHECKOUT_MAX_WIDTH, workArea.width)
  const width = clamp(
    Math.max(Math.round(workArea.width * CHECKOUT_WIDTH_FRACTION), Math.round(height * CHECKOUT_MIN_ASPECT)),
    Math.min(CHECKOUT_MIN_WIDTH, maxWidth),
    maxWidth,
  )

  // Center over the parent, then nudge fully inside the work area.
  const cx = parentBounds.x + Math.round((parentBounds.width - width) / 2)
  const cy = parentBounds.y + Math.round((parentBounds.height - height) / 2)
  const x = clamp(cx, workArea.x, workArea.x + workArea.width - width)
  const y = clamp(cy, workArea.y, workArea.y + workArea.height - height)
  return { x, y, width, height }
}

/** Max wait for the host reload to paint before closing the popup anyway, so a
 *  stalled reload can't trap the user on checkout. */
const CHECKOUT_RELOAD_TIMEOUT_MS = 4000

/**
 * Wire the credits-checkout popup's lifecycle: dim backdrop, close affordances
 * (scrim click, Esc, ✕ overlay), and auto-close/return handling.
 */
function wireCheckoutPopup(
  childWindow: BrowserWindow,
  parent: BrowserWindow,
  hostContents: Electron.WebContents,
): void {
  const close = (): void => {
    if (!childWindow.isDestroyed()) childWindow.close()
  }
  // will-redirect and did-navigate both fire for the same return URL.
  let returning = false

  childWindow.once('ready-to-show', () => {
    childWindow.show()
    showCheckoutBackdrop(parent, close)
    attachCheckoutCloseButton(childWindow, close)
  })
  childWindow.once('closed', () => hideCheckoutBackdrop(parent))

  childWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') close()
  })

  const closeOnReturn = (_e: Electron.Event, targetUrl: string): void => {
    if (returning || childWindow.isDestroyed() || !isCheckoutReturnUrl(targetUrl)) return
    returning = true
    if (hostContents.isDestroyed()) {
      close()
      return
    }
    // Reload the host underneath the still-open popup to clear the cloud "Upgrade" modal
    // (lives in that page's DOM, out of reach) and refresh the balance, then close only
    // once the fresh frame paints so the stale modal is never flashed.
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      close()
    }
    hostContents.once('did-stop-loading', finish)
    setTimeout(finish, CHECKOUT_RELOAD_TIMEOUT_MS)
    hostContents.reload()
  }

  childWindow.webContents.on('will-redirect', closeOnReturn)
  childWindow.webContents.on('did-navigate', closeOnReturn)
}

/** Inline ✕ button overlaid on the frameless checkout popup, which has no OS close
 *  control. */
const CHECKOUT_CLOSE_BUTTON_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  /* Body ignores pointer events so only the button is clickable; the rest of the
     strip passes clicks through to the checkout page underneath. */
  html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden;pointer-events:none}
  /* Tuned for the checkout's white right pane: dark glyph on a faint chip. */
  button{position:fixed;top:10px;right:10px;width:28px;height:28px;border:0;border-radius:8px;cursor:pointer;
    pointer-events:auto;display:grid;place-items:center;color:rgba(0,0,0,0.55);background:rgba(0,0,0,0.06);font:16px/1 system-ui}
  button:hover{background:rgba(0,0,0,0.12);color:rgba(0,0,0,0.85)}
</style></head><body>
<button id="x" aria-label="Close">✕</button>
<script>
  const { ipcRenderer } = require('electron');
  document.getElementById('x').addEventListener('click', () => ipcRenderer.send('comfy-checkout:close'));
</script>
</body></html>`

const CHECKOUT_CLOSE_BUTTON_SIZE = 48

function attachCheckoutCloseButton(childWindow: BrowserWindow, onClose: () => void): void {
  const overlay = new WebContentsView({
    webPreferences: { contextIsolation: false, nodeIntegration: true, sandbox: false },
  })
  overlay.setBackgroundColor('#00000000')
  childWindow.contentView.addChildView(overlay)
  const place = (): void => {
    if (childWindow.isDestroyed()) return
    const { width } = childWindow.getContentBounds()
    overlay.setBounds({
      x: Math.max(0, width - CHECKOUT_CLOSE_BUTTON_SIZE),
      y: 0,
      width: CHECKOUT_CLOSE_BUTTON_SIZE,
      height: CHECKOUT_CLOSE_BUTTON_SIZE,
    })
  }
  place()
  childWindow.on('resize', place)
  void overlay.webContents
    .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(CHECKOUT_CLOSE_BUTTON_HTML)}`)
    .catch(() => {})

  const closeId = overlay.webContents.id
  const handler = (event: Electron.IpcMainEvent): void => {
    if (event.sender.id === closeId) onClose()
  }
  ipcMain.on('comfy-checkout:close', handler)
  childWindow.once('closed', () => ipcMain.removeListener('comfy-checkout:close', handler))
}

/**
 * Single shared constructor for host windows (install-backed and install-less).
 * Builds the BrowserWindow + titleBarView + comfyView, wires layoutViews, macOS
 * fullscreen forwarding, bounds-save, close/closed handlers, and the
 * title-bar-ready handshake, and registers the entry into `comfyWindows`.
 *
 * Mode-specific wiring (comfyContents listeners, download handler, install-record
 * `'updated'` handler, the chooser-only eager `ensurePanelView`) is layered on AFTER
 * this returns by the two wrapper paths.
 */
export interface CreateHostWindowOpts {
  windowTitle: string
  boundsKey: string
  initialTheme: { bg: string; text: string }
  /** Per-platform `titleBarOverlay`; `undefined` on darwin (uses `trafficLightPosition`). */
  titleBarOverlay: Electron.TitleBarOverlay | undefined
  /** Install-backed gets comfyPreload + per-install partition; install-less gets minimal
   *  prefs (the dummy view never loads a URL). */
  comfyWebPreferences: Electron.WebPreferences
  /** Pre-paint colour for the title-bar view, avoiding a first-paint flash. */
  titleBarBackground: string
  /** `installationId` query param for the title-bar HTML load (empty for chooser hosts). */
  titleBarInstallationIdParam: string
  /** Initial title-bar pill label, stored on `entry.titleBarText` for the handshake replay. */
  initialTitleBarText: string
  /** Initial install-type icon category; `null` for chooser hosts. */
  initialSourceCategory: string | null
  /** Construct hidden; caller owns the reveal (see `coldStartPendingReveal`). */
  initiallyHidden?: boolean
}

export interface CreateHostWindowResult {
  windowKey: number
  comfyWindow: BrowserWindow
  titleBarView: WebContentsView
  comfyView: WebContentsView
  entry: ComfyWindowEntry
  /** Bound `layoutViews` for the new entry; the wrapper calls this once after wiring. */
  layoutViews: () => void
}

const CASCADE_STEP_PX = 30

/** Offset by one cascade step per live host already at the same x/y, so a freshly-spawned
 *  host doesn't land directly on an existing one. Only applies with explicit (x, y) from
 *  saved bounds; without them Electron centers the window itself. */
export function cascadeOffsetForCollisions(
  windowOptions: Partial<Electron.BrowserWindowConstructorOptions>,
  existingOrigins: ReadonlyArray<{ x: number; y: number }>,
): Partial<Electron.BrowserWindowConstructorOptions> {
  if (typeof windowOptions.x !== 'number' || typeof windowOptions.y !== 'number') {
    return windowOptions
  }
  let { x, y } = windowOptions
  // Re-check after each bump to catch chains (windows already cascaded from each other)
  // so we land beyond the deepest overlap.
  let bumped = true
  while (bumped) {
    bumped = false
    for (const origin of existingOrigins) {
      if (origin.x === x && origin.y === y) {
        x += CASCADE_STEP_PX
        y += CASCADE_STEP_PX
        bumped = true
        break
      }
    }
  }
  return { ...windowOptions, x, y }
}

/** Snapshot the origins of every live host window for the cascade collision check.
 *  Excludes destroyed (not-yet-GC'd) windows so they don't cause a phantom offset. */
function liveHostOrigins(): { x: number; y: number }[] {
  const origins: { x: number; y: number }[] = []
  for (const [, entry] of comfyWindows) {
    if (entry.window.isDestroyed()) continue
    const { x, y } = entry.window.getBounds()
    origins.push({ x, y })
  }
  return origins
}

/** Identity-driven bounds-persistence key: `'chooser'` for install-less hosts, the
 *  `installationId` otherwise. A host that flips identity in place saves under the slot
 *  matching what it currently IS, not the slot it was constructed as. */
function liveBoundsKeyFor(entry: ComfyWindowEntry): string {
  return entry.installationId ?? CHOOSER_HOST_BOUNDS_KEY
}

/** Origin of the first live host whose runtime identity matches `boundsKey`, or `null`.
 *  A spawned host with a live sibling opens at a clean default size instead of
 *  inheriting possibly-drifted saved bounds. */
function findLiveSiblingOrigin(boundsKey: string): { x: number; y: number } | null {
  for (const [, entry] of comfyWindows) {
    if (entry.window.isDestroyed()) continue
    if (liveBoundsKeyFor(entry) !== boundsKey) continue
    const { x, y } = entry.window.getBounds()
    return { x, y }
  }
  return null
}

export function createHostWindow(opts: CreateHostWindowOpts): CreateHostWindowResult {
  const fx = getFactories()
  const windowKey = nextWindowKey()
  const isChooserKey = opts.boundsKey === CHOOSER_HOST_BOUNDS_KEY
  // Chooser hosts always open at the canonical default size (the dashboard is a launcher,
  // not a customized workspace). Install-backed hosts restore saved bounds on first spawn.
  const saved = isChooserKey ? undefined : getSavedBounds(opts.boundsKey)
  // With a live sibling of the same identity, open at the default size offset from the
  // sibling's origin rather than restoring saved bounds (which would size+place the new
  // window identically, making it look like the existing one re-rendered).
  const sibling = findLiveSiblingOrigin(opts.boundsKey)
  const initialOptions = sibling
    ? { x: sibling.x, y: sibling.y, width: DEFAULT_HOST_WIDTH, height: DEFAULT_HOST_HEIGHT }
    : isChooserKey
      ? { width: DEFAULT_HOST_WIDTH, height: DEFAULT_HOST_HEIGHT }
      : getWindowOptions(opts.boundsKey)
  const windowOptions = cascadeOffsetForCollisions(initialOptions, liveHostOrigins())
  const comfyWindow = new BrowserWindow({
    ...windowOptions,
    show: !opts.initiallyHidden,
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

  // Pre-warm the title-bar dropdown popup here (not from `title-bar-ready`) so its
  // WebContentsView + bundle load in parallel with the title-bar renderer; the user can
  // click the pill before the title-bar paints. Idempotent.
  prewarmTitlePopup(comfyWindow)

  const titleBarView = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // comfyTitleBarPreload imports the shared window.api bridge, which Rollup emits as
      // a separate chunk; a sandboxed preload can't require() it, leaving window.api
      // undefined and blanking the renderer. contextIsolation keeps renderer JS Node-free.
      sandbox: false,
      preload: path.join(__dirname, '../preload/comfyTitleBarPreload.js'),
    },
  })
  titleBarView.setBackgroundColor(opts.titleBarBackground)
  loadTitleBarUrl(titleBarView, opts.titleBarInstallationIdParam)
  comfyWindow.contentView.addChildView(titleBarView)
  _registerExtraBroadcastTarget(titleBarView.webContents)
  // Title bar is the always-alive renderer per host window, so it's the canonical telemetry
  // relay target (the panelView is torn down in steady-state `comfy` mode). Exactly one
  // relay target per window prevents Datadog double-counting.
  mainTelemetry.registerTelemetryRelayTarget(titleBarView.webContents)

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

    // Read comfyView off the live entry: rebuildComfyViewIfNeeded swaps it during the
    // chooser-pick in-place attach onto a unique-partition install, after which the
    // captured `comfyView` would point at a destroyed view.
    const activeComfyView = entry?.comfyView ?? comfyView

    const mode = entry ? computeBodyMode(entry) : 'comfy'
    const showPanel = mode !== 'comfy'
    // Overlay modes mount their modal over the live ComfyUI canvas, so comfyView stays
    // visible underneath at full bodyRect; the panel renderer paints itself transparent
    // except for the modal + backdrop.
    const isOverlayMode = mode === 'downloads-v2' || mode === 'feedback'
    if (showPanel && entry?.panelView) {
      entry.panelView.setBounds(bodyRect)
      entry.panelView.setVisible(true)
      if (isOverlayMode) {
        activeComfyView.setBounds(bodyRect)
        activeComfyView.setVisible(true)
      } else {
        // Keep ComfyUI alive but collapsed so it can't intercept input.
        activeComfyView.setBounds({ x: 0, y: titleBarTotal, width: 0, height: 0 })
        activeComfyView.setVisible(false)
      }
    } else {
      activeComfyView.setBounds(bodyRect)
      activeComfyView.setVisible(true)
      if (entry?.panelView) {
        entry.panelView.setBounds({ x: 0, y: titleBarTotal, width: 0, height: 0 })
        entry.panelView.setVisible(false)
      }
    }
  }
  comfyWindow.on('resize', layoutViews)

  if (saved?.maximized) comfyWindow.maximize()

  // On macOS fullscreen the traffic-light buttons vanish, so the title bar drops its
  // left padding for that period.
  if (process.platform === 'darwin') {
    const sendFullscreen = (fullscreen: boolean): void => {
      if (titleBarView.webContents.isDestroyed()) return
      titleBarView.webContents.send('comfy-titlebar:fullscreen-changed', fullscreen)
    }
    comfyWindow.on('enter-full-screen', () => sendFullscreen(true))
    comfyWindow.on('leave-full-screen', () => sendFullscreen(false))
  }

  // Save under the LIVE identity, not the construction-time key: a host that flips
  // identity in place must persist under the slot it currently IS. Chooser hosts skip
  // persistence entirely (the dashboard always opens at the default size).
  const persistBounds = (): void => {
    const live = comfyWindows.get(windowKey)
    if (!live || isChooserHost(live)) return
    saveWindowBounds(liveBoundsKeyFor(live), comfyWindow)
  }
  comfyWindow.on('resize', persistBounds)
  comfyWindow.on('move', persistBounds)

  // Track the most recently focused install id (by id, not windowKey, so it survives a
  // detach + re-launch) so the dock-icon / second-instance hooks prefer it over an
  // arbitrary pick. Chooser hosts have their own path via findPreferredChooserHostWindow().
  comfyWindow.on('focus', () => {
    const entry = comfyWindows.get(windowKey)
    if (entry?.installationId) {
      setLastFocusedInstallationId(entry.installationId)
    }
  })

  // Push the initial state once the title bar's preload signals readiness. Filter to
  // this title bar's WebContents to avoid cross-talk between windows.
  const onTitleBarReadyHandler = (event: Electron.IpcMainEvent): void => {
    if (event.sender !== titleBarView.webContents) return
    if (titleBarView.webContents.isDestroyed()) return
    const entry = comfyWindows.get(windowKey)
    titleBarView.webContents.send('comfy-titlebar:panel-changed', entry?.activePanel ?? 'comfy')
    if (entry) {
      titleBarView.webContents.send('comfy-titlebar:theme-changed', entry.lastTheme)
      titleBarView.webContents.send('comfy-titlebar:title-changed', entry.titleBarText)
      titleBarView.webContents.send('comfy-titlebar:source-category-changed', entry.sourceCategory)
      // Authoritative push: the title bar no longer reloads across attach/detach, so the
      // URL query param is only a cold-boot seed for the initial `isInstallLess` paint.
      titleBarView.webContents.send(
        'comfy-titlebar:installation-id-changed',
        entry.installationId,
      )
      // Replay preview-mode so a re-mount mid-preview keeps showing the previewed identity.
      titleBarView.webContents.send(
        'comfy-titlebar:preview-mode-changed',
        entry.previewInstallationId !== null,
      )
      if (!entry.comfyView.webContents.isDestroyed()) {
        titleBarView.webContents.send(
          'comfy-titlebar:zoom-changed',
          entry.comfyView.webContents.getZoomLevel(),
        )
      }
    }
    // Both modes get the app-update pill and downloads tray; the install-update pill is
    // install-backed only.
    titleBarView.webContents.send(
      'comfy-titlebar:app-update-state-changed',
      updater.getCurrentUpdateState(),
    )
    titleBarView.webContents.send('comfy-titlebar:downloads-changed', getDownloadsTrayState())
    const installId = entry?.installationId ?? null
    if (installId !== null) {
      void fx.computeInstallUpdateAvailable(installId).then((state) => {
        if (titleBarView.webContents.isDestroyed()) return
        titleBarView.webContents.send('comfy-titlebar:install-update-changed', state)
      })
    }
    // Pre-warm the system-modal popup so the first shell-modal trigger doesn't pay the
    // load cost.
    ensureSystemModal(comfyWindow)
  }
  ipcMain.on('comfy-window:title-bar-ready', onTitleBarReadyHandler)

  // Async close: preventDefault, consult the panel renderer, run the install's
  // `_installCleanup` if any, then destroy. `closingInFlight` guards re-entry on rapid
  // OS-close clicks while the consult is pending. detachWindowDownloads stays outside
  // `_installCleanup` because it survives mode flips and only dies with the BrowserWindow.
  let closingInFlight = false
  comfyWindow.on('close', (e) => {
    e.preventDefault()
    if (closingInFlight) return
    closingInFlight = true
    void (async () => {
      try {
        const entry = comfyWindows.get(windowKey)
        const skipConsult = fx.preClearedClose.has(comfyWindow)
        // The OS ✕ must never quit the app. As the last live window, an install-backed
        // host returns to the dashboard instead of being destroyed; a chooser host is
        // destroyed and the app quits via `window-all-closed` (the one sanctioned exit).
        const isLastWindow =
          Array.from(comfyWindows.values()).filter((e) => !e.window.isDestroyed()).length <= 1
        // Hide any open title-bar popup first: it's a sibling WebContentsView stacked above
        // the panel view, so a modal would otherwise sit behind the opaque popup.
        if (!skipConsult) hideTitlePopupForParent(comfyWindow)
        // Step 1: let the renderer handle any in-flight overlay cancel-prompt. With no
        // overlay it returns `defer` and main owns the confirm (a running instance's panel
        // view is hidden behind ComfyUI and can't surface a prompt). Every renderer-cancel
        // path below re-checks `preClearedClose` so a force-close landing mid-consult wins.
        const consult: CloseConsultResult = skipConsult
          ? 'cleared'
          : await fx.consultPanelRendererClose(entry?.panelView)
        if (shouldBailAfterConsult(consult, fx.preClearedClose.has(comfyWindow))) return
        // Step 2: for an install-backed host with no overlay, main shows the same Close
        // Window confirm as the menu item. The dashboard closes with no prompt.
        const entryForClose = comfyWindows.get(windowKey)
        const isInstallHostWindow = !!entryForClose && !isChooserHost(entryForClose)
        if (
          shouldShowInstallCloseConfirm(
            consult,
            shouldConfirmKillForEntry(entryForClose),
            fx.preClearedClose.has(comfyWindow),
          )
          && entryForClose
        ) {
          const confirmed = await fx.confirmCloseInstanceWindow(
            comfyWindow,
            isLastWindow,
            entryForClose.lastTheme,
          )
          if (shouldBailAfterCloseConfirm(confirmed, fx.preClearedClose.has(comfyWindow))) return
        }
        // Capture force-close intent before draining the flag: the initial snapshot or a
        // late-arriving pre-clear both mark this as caller-driven.
        const forceClose = skipConsult || fx.preClearedClose.has(comfyWindow)
        fx.preClearedClose.delete(comfyWindow)
        if (comfyWindow.isDestroyed()) return
        // Last install-backed window returns to the dashboard rather than tearing down.
        // `detachInstall` runs the same `_installCleanup` then flips to chooser mode in
        // place. Force-close skips this (the caller wants the window gone).
        if (
          shouldDetachLastInstallWindowToDashboard(
            isInstallHostWindow,
            !!entryForClose,
            isLastWindow,
            forceClose,
          )
          && entryForClose
        ) {
          entryForClose.detachInstall()
          return
        }
        // Wrap each cleanup step so a single throw can't skip the final destroy() and
        // leave the window alive forever (observed when a reused comfyView's webContents
        // came back undefined after navigation churn). Errors forward to Datadog.
        const safeTeardown = (source: string, fn: () => void): void => {
          try {
            fn()
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            const stack = err instanceof Error ? err.stack : undefined
            forwardDatadogError({
              source,
              message,
              stack,
              level: 'error',
              context: { origin: 'main-process', windowKey: String(windowKey) },
            })
          }
        }
        safeTeardown('host-window-close-install-cleanup', () => {
          if (entry?._installCleanup) entry._installCleanup()
        })
        safeTeardown('host-window-close-detach-downloads', () => detachWindowDownloads(comfyWindow))
        safeTeardown('host-window-close-unregister-broadcast-target',
          () => _unregisterExtraBroadcastTarget(titleBarView.webContents))
        safeTeardown('host-window-close-unregister-telemetry-relay',
          () => mainTelemetry.unregisterTelemetryRelayTarget(titleBarView.webContents))
        // Re-read from the live registry: rebuildComfyViewIfNeeded may have swapped
        // `entry.comfyView`, so the captured one could point at a destroyed view.
        const liveEntry = comfyWindows.get(windowKey)
        const activeComfyView = liveEntry?.comfyView ?? comfyView
        if (liveEntry) {
          safeTeardown('host-window-close-destroy-panel-view', () => destroyPanelView(liveEntry))
        }
        safeTeardown('host-window-close-title-bar-webcontents-close',
          () => titleBarView.webContents.close())
        safeTeardown('host-window-close-comfy-webcontents-close', () => {
          // `webContents` can come back undefined on a reused chooser comfyView after
          // navigation churn; the optional chain avoids a TypeError on expected teardowns.
          if (activeComfyView.webContents && !activeComfyView.webContents.isDestroyed()) {
            activeComfyView.webContents.close()
          }
        })
        comfyWindow.destroy()
      } finally {
        closingInFlight = false
      }
    })()
  })

  comfyWindow.on('closed', () => {
    ipcMain.off('comfy-window:title-bar-ready', onTitleBarReadyHandler)
    const closedEntry = comfyWindows.get(windowKey)
    if (closedEntry) unregisterHostEntry(closedEntry)
    // Drop any pending attach claim targeting THIS window, else stale entries pile up and
    // can be silently consumed by an unrelated future onLaunch().
    dropAttachClaimsForWindow(windowKey)
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
    // ALWAYS install-less at construction; `attachInstall()` (called right after) is the
    // only place that populates `installationId` and the secondary index.
    installationId: null,
    constructedPartition:
      typeof opts.comfyWebPreferences.partition === 'string'
        ? opts.comfyWebPreferences.partition
        : null,
    firstUseMode: 'none',
    titleBarText: opts.initialTitleBarText,
    sourceCategory: opts.initialSourceCategory,
    previewInstallationId: null,
    coldStartPendingReveal: false,
    _installCleanup: null,
    // Bound below so it can self-reference the freshly-created entry.
    detachInstall: () => {},
  }
  // Bound post-literal so the closure captures the registered entry by reference.
  entry.detachInstall = () => fx.detachInstallImpl(entry)
  registerHostEntry(entry)

  return { windowKey, comfyWindow, titleBarView, comfyView, entry, layoutViews }
}

/**
 * (Re)load the title-bar webContents at the URL for `installationId` (empty for chooser
 * hosts). Re-mounting the Vue app is what flips `isInstallLess` and the install-pill
 * identity (the renderer reads `installationId` once at startup from the URL).
 *
 * IMPORTANT: this navigation drops every cached renderer message, so any new piece of
 * title-bar state must also be re-pushed by `onTitleBarReadyHandler` in `createHostWindow()`.
 */
export function loadTitleBarUrl(
  titleBarView: WebContentsView,
  installationId: string,
): void {
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

/**
 * Resolve the comfyView session partition for an install. Unique-partition installs get
 * their own `persist:${id}` bucket so cookies / IndexedDB / Service Workers don't leak
 * across siblings; everything else shares `persist:shared`.
 */
export function expectedPartitionFor(installation: InstallationRecord): string {
  return (installation.browserPartition as string | undefined) === 'unique'
    ? `persist:${installation.id}`
    : 'persist:shared'
}

/**
 * Construct a comfyView with the mode-agnostic listeners attached.
 * Extracted so rebuildComfyViewIfNeeded() can swap the view's pinned
 * partition (Electron has no API to change it post-construction).
 */
export function buildComfyView(
  comfyWindow: BrowserWindow,
  webPreferences: Electron.WebPreferences,
  windowKey: number,
): WebContentsView {
  // Map the `monospace` generic to a real face; Electron leaves it unmapped, so ComfyUI's
  // prompt textarea would otherwise render proportional on Desktop.
  const defaultFontFamily: Electron.WebPreferences['defaultFontFamily'] = {
    ...webPreferences.defaultFontFamily,
    monospace:
      process.platform === 'darwin'
        ? 'Menlo'
        : process.platform === 'win32'
          ? 'Consolas'
          : 'monospace',
  }
  const comfyView = new WebContentsView({
    webPreferences: { ...webPreferences, defaultFontFamily },
  })
  comfyView.setBackgroundColor(COMFY_BG)

  const comfyContents = comfyView.webContents
  // Attach the will-download handler eagerly so downloads flow through the launcher's tray
  // instead of the browser. Idempotent.
  attachSessionDownloadHandler(comfyContents.session)

  // Set by the window-open handler immediately before the matching `did-create-window`
  // (synchronous pairing), then reset there so it can't leak to a later non-checkout popup.
  let nextPopupIsCheckout = false

  comfyContents.on('did-create-window', (childWindow) => {
    const isCheckout = nextPopupIsCheckout
    nextPopupIsCheckout = false
    childWindow.setIcon(APP_ICON)
    if (process.platform !== 'darwin') childWindow.removeMenu()
    injectMacPasskeyWarning(childWindow)
    if (isCheckout) wireCheckoutPopup(childWindow, comfyWindow, comfyContents)
  })
  comfyContents.setWindowOpenHandler(({ url: childUrl }) => {
    // Intercept Firebase auth popups and reroute sign-in through the bridge so passkeys
    // and saved-password autofill work.
    if (isFirebaseAuthHandlerUrl(childUrl)) {
      void handleFirebasePopup(childUrl, comfyContents, {
        parentWindow: comfyWindow,
        onError: (err) => {
          forwardDatadogError({
            source: 'firebase-bridge-failed',
            message: 'Firebase loopback bridge sign-in failed',
            level: 'warn',
            context: { origin: 'main-process', error: err.message },
          })
        },
      })
      return { action: 'deny' }
    }
    if (isCheckoutUrl(childUrl)) {
      // `checkout.comfy.org` forbids iframing, so checkout is a real popup styled to read
      // as in-app. Frameless on Windows/Linux only: a frameless macOS `window.open` child
      // can't be dragged/closed reliably, so it keeps its frame.
      nextPopupIsCheckout = true
      const bounds = checkoutPopupBounds(comfyWindow)
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          parent: comfyWindow,
          ...bounds,
          minWidth: CHECKOUT_MIN_WIDTH,
          minHeight: CHECKOUT_MIN_HEIGHT,
          frame: process.platform !== 'darwin' ? false : undefined,
          backgroundColor: COMFY_BG,
          title: 'Purchase Credits',
          show: false,
          webPreferences: { preload: undefined },
        },
      }
    }
    if (shouldOpenInPopup(childUrl)) {
      // preload: undefined strips the title-bar bridge so popups can't reach file-menu IPCs.
      return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { preload: undefined } } }
    }
    // The cloud "Download zip" button is a `window.open(zipUrl)` with no `<a download>`, so
    // Electron reports disposition `'foreground-tab'` (indistinguishable from a normal link).
    // Match on the pathname extension and route through `session.downloadURL` so it lands in
    // the downloads tray instead of leaking to the system browser.
    if (isLikelyDownloadUrl(childUrl)) {
      comfyContents.session.downloadURL(childUrl)
      return { action: 'deny' }
    }
    shell.openExternal(childUrl)
    return { action: 'deny' }
  })
  comfyContents.on('will-prevent-unload', (e) => {
    // Only suppress beforeunload while an install actually backs the view.
    const liveEntry = comfyWindows.get(windowKey)
    if (!liveEntry || isChooserHost(liveEntry)) return
    e.preventDefault()
  })
  attachContextMenu(comfyWindow, comfyContents)
  return comfyView
}

/**
 * Swap the entry's comfyView for a fresh one with the install's expected
 * partition. No-op when already correct.
 */
export function rebuildComfyViewIfNeeded(
  entry: ComfyWindowEntry,
  installation: InstallationRecord,
): void {
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

/** Launcher-theme background + symbol colours for install-less hosts, which have no
 *  ComfyUI frontend feeding their theme. Maps `titleBarOverlayForTheme` to the
 *  `{ bg, text }` shape TitleBarApp.vue consumes. */
export function getChooserHostTheme(): { bg: string; text: string } {
  const overlay = titleBarOverlayForTheme(resolveTheme() === 'dark')
  return { bg: overlay.color ?? TITLEBAR_BG, text: overlay.symbolColor ?? '#dddddd' }
}

/** Repaint a single install-less host's title bar + OS overlay to the current launcher
 *  theme. Driven by the launcher setting (or OS dark-mode flip on `'system'`) rather than
 *  ComfyUI's in-page theme observer. */
export function applyChooserHostTheme(entry: ComfyWindowEntry): void {
  if (isInstallHost(entry)) return
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
      // setTitleBarOverlay throws if the window was created without `titleBarOverlay`.
    }
  }
}

/** Repaint every install-less host's title bar to the current launcher theme, so flipping
 *  the Theme setting (or OS dark-mode on `'system'`) refreshes all chooser hosts live. */
export function applyChooserHostThemeToAll(): void {
  for (const [, entry] of comfyWindows) {
    if (isChooserHost(entry)) {
      applyChooserHostTheme(entry)
    }
  }
}

/** Open a fresh install-less host window: same shape as an install-backed comfy window
 *  but with no installation backing the entry. The Comfy pill resolves to the chooser body
 *  via `computeBodyMode()` and the user picks an install there. The comfyView still exists
 *  (so `layoutViews` needn't special-case its absence) but stays zero-sized and hidden. */
export function openChooserHostWindow(initialPanel: ComfyPanelKey = 'comfy'): BrowserWindow {
  // Chooser-only extras over `createHostWindow()`: a header label override and an eager
  // `ensurePanelView` so the panel body paints on the first frame. The title-bar / overlay
  // colors are driven by the launcher theme (refreshed via `applyChooserHostTheme`).
  const initialChooserTheme = getChooserHostTheme()

  const { comfyWindow, entry, titleBarView } = createHostWindow({
    windowTitle: CHOOSER_HOST_WINDOW_TITLE,
    boundsKey: CHOOSER_HOST_BOUNDS_KEY,
    initialTheme: initialChooserTheme,
    titleBarOverlay: process.platform === 'darwin'
      ? undefined
      // Every host uses the same overlay (TITLEBAR_BG) so the window-controls region
      // matches the Vue title bar above it; it never adapts to ComfyUI's in-page theme.
      : titleBarOverlayForTheme(resolveTheme() === 'dark'),
    // Dummy comfyView, kept so layoutViews needn't special-case the install-less branch.
    // Same preload + `persist:shared` partition as the install-backed default, so a
    // chooser-pick attach can navigate it in place. Unique-partition installs instead get
    // a fresh window via `createHostWindow()`.
    comfyWebPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/comfyPreload.js'),
      partition: 'persist:shared',
    },
    titleBarBackground: initialChooserTheme.bg,
    // Empty param puts the title-bar Vue in install-less mode (no icon, dashboard label).
    titleBarInstallationIdParam: '',
    initialTitleBarText: CHOOSER_HOST_TITLE_TEXT,
    initialSourceCategory: null,
    initiallyHidden: true,
  })

  entry.coldStartPendingReveal = true

  // "+ New Instance" passes 'new-install' so the window boots straight into the wizard.
  entry.activePanel = initialPanel
  ensurePanelView(entry.windowKey, entry, computeBodyMode(entry))

  entry.layoutViews()

  const revealKey = entry.windowKey

  // Reveal on the title-bar's `dom-ready` (its ~25 KB bundle paints far sooner than the
  // ~585 KB panel bundle) so the chrome shows fast; the panel body underneath paints its
  // background colour until Vue mounts. `ensurePanelView`'s `did-finish-load` is the
  // fallback if the title bar loads slower than the panel.
  titleBarView.webContents.once('dom-ready', () => revealColdStartHostIfPending(revealKey))

  // Backstop: if both views fail to load, force a reveal so the window isn't invisible
  // forever. Cleared on close so a fast-close window doesn't leave the closure pending.
  const backstopTimer = setTimeout(() => revealColdStartHostIfPending(revealKey), 2_000)
  comfyWindow.once('closed', () => clearTimeout(backstopTimer))

  return comfyWindow
}
