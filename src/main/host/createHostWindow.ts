import { BrowserWindow, WebContentsView, ipcMain, shell } from 'electron'
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
import { isLikelyDownloadUrl, shouldOpenInPopup } from '../lib/allowedPopups'
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
import { hideTitlePopupForParent, prewarmTitlePopup } from '../popups/titlePopup'
import { destroyPanelView, ensurePanelView } from './panelView'
import {
  bringToFront,
  comfyWindows,
  computeBodyMode,
  dropAttachClaimsForWindow,
  isChooserHost,
  isInstallHost,
  nextWindowKey,
  registerHostEntry,
  setLastFocusedInstallationId,
  unregisterHostEntry,
} from './registry'
import type { ComfyWindowEntry } from './registry'

/** Default size for a freshly-spawned host window when an existing
 *  host of the same identity is already open. Matches the
 *  no-saved-bounds default in `getWindowOptions()` so File → New
 *  Window opens at a clean canonical size instead of inheriting the
 *  drift of whichever window happened to be the most recent. */
const DEFAULT_HOST_WIDTH = 1280
const DEFAULT_HOST_HEIGHT = 900

/** Constants reused by both host modes. Defined here because they only
 *  matter in the context of host-window construction. */
const APP_ICON = path.join(__dirname, '..', '..', 'assets', 'Comfy_Logo_x256.png')
const APP_VERSION = getAppVersion()

/** Center pill text for install-less host windows (chooser/dashboard). */
export const CHOOSER_HOST_TITLE_TEXT = 'Desktop 2.0 Beta'
/** OS-level window title for install-less host windows. */
export const CHOOSER_HOST_WINDOW_TITLE = `${CHOOSER_HOST_TITLE_TEXT} — v${APP_VERSION}`

/** Bounds-persistence key for install-less host windows. All chooser
 *  hosts share the same key so the JSON cache holds at most one
 *  chooser bounds entry, and bounds restore works across sessions
 *  for chooser hosts. */
const CHOOSER_HOST_BOUNDS_KEY = 'chooser'

/** Late-bound dependencies on host machinery that still lives in
 *  `index.ts` (or other modules pending later extractions). Set once
 *  at the top of `whenReady` via `setHostWindowFactories(...)`. */
export interface HostWindowFactories {
  /** Async beforeunload-style consult through the panel renderer. */
  consultPanelRendererClose: (panelView: WebContentsView | null | undefined) => Promise<boolean>
  /** Detach the install currently bound to a host entry (in-place flip). */
  detachInstallImpl: (entry: ComfyWindowEntry) => void
  /** WeakSet of host windows whose close was pre-cleared by the
   *  consult-once-and-confirm path. */
  preClearedClose: WeakSet<BrowserWindow>
  /** Compute whether an install has a pending in-app update. */
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
export interface CreateHostWindowOpts {
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

/** Per-step cascade in screen pixels — matches the macOS / Windows
 *  default for OS-level "open new window" cascading. */
const CASCADE_STEP_PX = 30

/** Offset `windowOptions` by `(CASCADE_STEP_PX, CASCADE_STEP_PX)` for every
 *  live host window already at the same x/y, so a freshly-spawned host
 *  doesn't land directly on top of an existing one (which made the new
 *  window look like the old one had simply re-rendered).
 *
 *  Only applies when `getWindowOptions()` returned an explicit (x, y) — i.e.
 *  there were saved bounds. Without saved bounds Electron centers the
 *  window itself, and we leave that path alone.
 */
export function cascadeOffsetForCollisions(
  windowOptions: Partial<Electron.BrowserWindowConstructorOptions>,
  existingOrigins: ReadonlyArray<{ x: number; y: number }>,
): Partial<Electron.BrowserWindowConstructorOptions> {
  if (typeof windowOptions.x !== 'number' || typeof windowOptions.y !== 'number') {
    return windowOptions
  }
  let { x, y } = windowOptions
  // Walk the existing-windows list: each live host whose origin matches
  // our current target bumps us by one cascade step. Re-checking after
  // each bump catches chains (windows already cascaded from each other)
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

/** Snapshot the origins of every live host window, for the cascade
 *  collision check. Excludes destroyed windows so a not-yet-GC'd
 *  closed entry doesn't cause a phantom offset. */
function liveHostOrigins(): { x: number; y: number }[] {
  const origins: { x: number; y: number }[] = []
  for (const [, entry] of comfyWindows) {
    if (entry.window.isDestroyed()) continue
    const { x, y } = entry.window.getBounds()
    origins.push({ x, y })
  }
  return origins
}

/** Identity-driven bounds-persistence key for an entry — `'chooser'`
 *  for install-less hosts, the `installationId` for install-backed
 *  hosts. Used by the resize/move save listeners so a host that
 *  flips identity (chooser → install via in-place attach, or back
 *  via Return to Dashboard) saves its bounds under the slot that
 *  matches what it currently IS, not the slot it was constructed as. */
function liveBoundsKeyFor(entry: ComfyWindowEntry): string {
  return entry.installationId ?? CHOOSER_HOST_BOUNDS_KEY
}

/** Find the origin of a live host whose runtime identity matches
 *  `boundsKey` — used to decide that a freshly-spawned host should
 *  open at a clean default size rather than inheriting the saved
 *  bounds (which may have drifted from another session). Returns the
 *  first matching live host's bounds origin, or `null` when none
 *  exists. */
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
  // Chooser hosts always open at the canonical default size: the
  // dashboard isn't a workspace the user customizes — it's a launcher
  // surface, so persisting last-session bounds across cold starts
  // (and especially across in-place flips that drifted the slot)
  // makes the dashboard feel like it inherited an unrelated window's
  // shape. Install-backed hosts still restore their saved bounds on
  // first spawn so users keep the size they prefer for that install.
  const saved = isChooserKey ? undefined : getSavedBounds(opts.boundsKey)
  // Sibling-aware initial bounds: if a live host of the same identity
  // already exists (e.g. File → New Window with a chooser already open),
  // open at the canonical default size offset from the sibling's origin
  // instead of restoring the saved bounds — saved bounds inheritance
  // there would size + place the new window identically to the live
  // one, making it look like the existing window had simply re-rendered.
  // For install-backed first-spawn (no sibling), restore saved bounds
  // so app relaunches land at the user's preferred size for that install.
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

  // Pre-warm the title-bar dropdown popup (file menu / downloads tray /
  // instance picker) as early as possible — fired here rather than from
  // the `title-bar-ready` handler so the popup's WebContentsView + HTML/JS
  // bundle starts loading in parallel with the title-bar renderer rather
  // than after it. Cold-start cost is ~150-200ms; the user can click the
  // pill before the title-bar even finishes painting, so every millisecond
  // of head-start matters. `ensureTitlePopup` is idempotent so any later
  // accidental call from the same parent is a no-op.
  prewarmTitlePopup(comfyWindow)

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
  loadTitleBarUrl(titleBarView, opts.titleBarInstallationIdParam)
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

    // Read comfyView off the live entry — `rebuildComfyViewIfNeeded`
    // swaps it during the chooser-pick in-place attach onto a unique-
    // partition install (Standalone / Portable). The captured `comfyView`
    // would point at an already-destroyed view, leaving the freshly-built
    // one with default bounds and invisible — ComfyUI loads but never paints.
    const activeComfyView = entry?.comfyView ?? comfyView

    // The Comfy pill maps to the live ComfyUI view *or* a panel
    // (lifecycle / chooser / settings / etc.) depending on mode.
    // `computeBodyMode` already returns `'chooser'` for install-less
    // hosts, so the install-backed visibility branch handles both.
    const mode = entry ? computeBodyMode(entry) : 'comfy'
    const showPanel = mode !== 'comfy'
    // `'downloads-v2'` and `'feedback'` are overlay modes — their modal
    // mounts over the live ComfyUI canvas, so unlike other panel modes
    // we keep `comfyView` visible underneath at full bodyRect. The
    // panel renderer paints itself transparent (see `PanelApp.vue`'s
    // `panel-overlay-mode` body class) except for the modal + dim
    // backdrop, so the canvas composites through on macOS CALayers.
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

  // Save under the LIVE identity, not the construction-time `opts.boundsKey`.
  // A chooser host that flips to install-backed in place via the chooser-pick
  // claim path needs to save its bounds under the install id from then on,
  // and back to skipping persistence if detached via Return to Dashboard.
  // Using the captured construction key would persist the install-mode user
  // adjustments under the chooser slot (and vice versa).
  //
  // Chooser hosts skip persistence entirely: the dashboard always opens at
  // the canonical default size, so there's nothing to remember.
  const persistBounds = (): void => {
    const live = comfyWindows.get(windowKey)
    if (!live || isChooserHost(live)) return
    saveWindowBounds(liveBoundsKeyFor(live), comfyWindow)
  }
  comfyWindow.on('resize', persistBounds)
  comfyWindow.on('move', persistBounds)

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
      // Authoritative installation-id push — the title bar is now a
      // long-lived view that doesn't reload across attach / detach
      // (see `loadTitleBarUrl` callers); the URL `installationId`
      // query param is only a cold-boot seed for the renderer's
      // initial `isInstallLess` paint.
      titleBarView.webContents.send(
        'comfy-titlebar:installation-id-changed',
        entry.installationId,
      )
      // Replay preview-mode so a re-mount during an in-progress preview
      // keeps showing the install-type icon next to the previewed name
      // instead of the bare chooser-host identity.
      titleBarView.webContents.send(
        'comfy-titlebar:preview-mode-changed',
        entry.previewInstallationId !== null,
      )
    }
    // Both modes get the app-update pill and the downloads tray.
    // The install-update pill is install-backed only — chooser hosts
    // (and detached install-backed hosts) skip it cleanly.
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
    // Pre-warm the system-modal popup so the user's first app-update
    // pill click (or any other shell-modal trigger) doesn't pay the
    // load cost — the modal needs to feel as instant as the pill click.
    // (Title-popup prewarm runs earlier, right after BrowserWindow
    // construction, so the popup webContents has the longest possible
    // head start before the user's first click.)
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
        const skipConsult = fx.preClearedClose.has(comfyWindow)
        // Hide any open title-bar popup before the panel-side
        // quit-confirm fires. The popup is a sibling WebContentsView
        // stacked above the panel view in the same BrowserWindow, so
        // a panel-rendered `modal.confirm()` would otherwise sit
        // behind the (visually opaque) popup and be unreachable.
        if (!skipConsult) hideTitlePopupForParent(comfyWindow)
        const cleared = skipConsult ? true : await fx.consultPanelRendererClose(entry?.panelView)
        if (!cleared) return
        fx.preClearedClose.delete(comfyWindow)
        if (comfyWindow.isDestroyed()) return
        // Each cleanup step is wrapped via `safeTeardown` so a single
        // throw can't skip the BrowserWindow.destroy() at the end.
        // Without this, an exception in (e.g.) the comfy webContents
        // close — observed in the in-place attach path where the
        // chooser's reused comfyView's `.webContents` can come back
        // undefined after the install's navigation churn — left the
        // host window alive forever, with ComfyUI still loaded.
        // Errors are forwarded to Datadog so silent teardown failures
        // stay visible in telemetry instead of being swallowed by the
        // safety net.
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
        // Re-read the entry from the live registry: rebuildComfyViewIfNeeded
        // can have swapped `entry.comfyView` since the closure was captured
        // (in-place attach onto a chooser host with a different partition),
        // so the captured `comfyView` would point at an already-destroyed
        // WebContentsView and `.webContents.close()` would throw.
        const liveEntry = comfyWindows.get(windowKey)
        const activeComfyView = liveEntry?.comfyView ?? comfyView
        if (liveEntry) {
          safeTeardown('host-window-close-destroy-panel-view', () => destroyPanelView(liveEntry))
        }
        safeTeardown('host-window-close-title-bar-webcontents-close',
          () => titleBarView.webContents.close())
        safeTeardown('host-window-close-comfy-webcontents-close', () => {
          // `webContents` can come back undefined on a reused chooser
          // comfyView after the install's navigation churn — the optional
          // chain avoids a TypeError that would needlessly spam Datadog
          // during otherwise expected teardowns.
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
    // Unregister via the primary windowKey AND the secondary
    // install-id index.
    const closedEntry = comfyWindows.get(windowKey)
    if (closedEntry) unregisterHostEntry(closedEntry)
    // Drop any pending attach claim whose target is THIS window.
    // Without this, stale entries pile up over the app's lifetime
    // AND can be silently consumed by an unrelated future
    // `onLaunch()` (the consumer's destroyed-window check rejects
    // them, but the side-effect `delete` still fires).
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
    previewInstallationId: null,
    coldStartPendingReveal: false,
    _installCleanup: null,
    // Bound below so it can self-reference the freshly-created entry.
    detachInstall: () => {},
  }
  // Bind the detach method to the freestanding impl. Done
  // post-literal so the closure captures the registered entry by
  // reference, not by a copy at literal-build time.
  entry.detachInstall = () => fx.detachInstallImpl(entry)
  registerHostEntry(entry)

  return { windowKey, comfyWindow, titleBarView, comfyView, entry, layoutViews }
}

/**
 * (Re)load the title-bar webContents at the URL for `installationId`
 * (empty string for chooser hosts). Used by `createHostWindow()`
 * for the initial mount and by `attachInstall` / `_detachInstallImpl`
 * to swap the URL in place when a host flips between chooser and
 * install-backed mode — re-mounting the Vue app is what flips
 * `isInstallLess` and the install-pill identity (the title-bar
 * renderer reads `installationId` once at startup from the URL).
 *
 * The `comfy-window:title-bar-ready` handshake re-fires after the
 * navigation lands and re-pushes title text, source category, theme,
 * panel state, and the install-update pill from `entry.*` — so
 * callers don't need to re-emit those events themselves.
 *
 * IMPORTANT: any new piece of title-bar renderer state must also be
 * re-pushed by the `onTitleBarReadyHandler` in `createHostWindow()`
 * — the navigation here drops every cached message the renderer was
 * holding. The current contract covers: panel-changed,
 * theme-changed, title-changed, source-category-changed,
 * fullscreen-changed (macOS), app-update-state-changed,
 * downloads-changed, install-update-changed (install-backed only).
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
 * Resolve the comfyView session partition an install must be loaded
 * into. Unique-partition installs (`browserPartition === 'unique'`)
 * get their own `persist:${id}` bucket so cookies / IndexedDB /
 * Service Workers don't leak across sibling installs; everything
 * else shares `persist:shared`. Used by both the install-backed
 * wrapper (constructing a fresh comfyView) and `rebuildComfyViewIfNeeded`
 * to flip a chooser host's view onto a partition that matches the
 * install being attached in place.
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
  const comfyView = new WebContentsView({ webPreferences })
  comfyView.setBackgroundColor(COMFY_BG)

  const comfyContents = comfyView.webContents
  // Eagerly attach the will-download handler to the comfy view's
  // session so any `session.downloadURL(...)` call below — or a server-
  // initiated `Content-Disposition: attachment` response — flows
  // through the launcher's downloads tray instead of falling back to
  // the browser. `attachSessionDownloadHandler` is idempotent.
  attachSessionDownloadHandler(comfyContents.session)

  comfyContents.on('did-create-window', (childWindow) => {
    childWindow.setIcon(APP_ICON)
    if (process.platform !== 'darwin') childWindow.removeMenu()
    injectMacPasskeyWarning(childWindow)
  })
  comfyContents.setWindowOpenHandler(({ url: childUrl }) => {
    // Intercept Firebase auth popups (`<authDomain>/__/auth/handler?...`)
    // and reroute sign-in through the user's system browser so passkeys
    // and saved-password autofill work. The bridge picks a per-provider
    // flow: Google takes a server-side raw-OAuth path (zero clicks),
    // GitHub takes a client-side popup-bridge path (1-2 clicks) because
    // its OAuth App allows only a single Authorization Callback URL.
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
    if (shouldOpenInPopup(childUrl)) {
      // preload: undefined strips our title-bar bridge so OAuth/cloud-login
      // popups can't reach the file menu IPCs.
      return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { preload: undefined } } }
    }
    // Capture downloads that the previous unconditional
    // `shell.openExternal` branch was leaking to the system browser.
    // The cloud "Download zip" button renders as a `window.open(zipUrl)`
    // (no `<a download>` attribute), so Electron reports disposition
    // `'foreground-tab'` — indistinguishable from a normal external
    // link by disposition alone. We match on the URL's pathname
    // extension via `isLikelyDownloadUrl` (archive / installer / model
    // weights) and route the request through `session.downloadURL`,
    // which fires the `will-download` listener attached above and
    // surfaces the download in the launcher's downloads tray.
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

/** Resolve the launcher-theme-driven background + symbol colours used
 *  by install-less host windows. Install-less hosts have no ComfyUI
 *  frontend feeding their theme so the title-bar Vue header and the
 *  OS-level window-controls overlay both track `--titlebar-bg` from
 *  main.css. `titleBarOverlayForTheme` returns the matching
 *  `--titlebar-bg` values (#171718 dark / #e9e9e9 light) so this helper
 *  is a thin wrapper that maps them to the `comfy-titlebar:theme-changed`
 *  `{ bg, text }` shape consumed by TitleBarApp.vue. */
export function getChooserHostTheme(): { bg: string; text: string } {
  const overlay = titleBarOverlayForTheme(resolveTheme() === 'dark')
  return { bg: overlay.color ?? TITLEBAR_BG, text: overlay.symbolColor ?? '#dddddd' }
}

/** Repaint a single install-less host window's title bar + OS overlay
 *  to match the current launcher theme. Mirrors `applyComfyTheme` for
 *  install-backed windows, but driven by the launcher setting (or
 *  OS-level dark-mode flip on `'system'`) rather than ComfyUI's
 *  in-page theme observer — install-less hosts have no ComfyUI
 *  frontend feeding them. */
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
export function applyChooserHostThemeToAll(): void {
  for (const [, entry] of comfyWindows) {
    if (isChooserHost(entry)) {
      applyChooserHostTheme(entry)
    }
  }
}

/** Open a fresh install-less host window. Same shape as an install-
 *  backed comfy window — title bar pills + body area — but with no
 *  installation backing the entry. The Comfy pill resolves to the
 *  chooser body via `computeBodyMode()`; the user picks an install
 *  from there. Skips the install-backed extras (comfy URL load, theme
 *  observer, download wiring, failure retry) since none of them apply.
 *  The comfyView still exists so `layoutViews` doesn't have to
 *  special-case its absence, but is sized to zero and never made
 *  visible. */
export function openChooserHostWindow(): BrowserWindow {
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
      // Every host — install-less chooser AND install-backed instance —
      // uses the same `titleBarOverlayForTheme` (TITLEBAR_BG) for the OS
      // overlay so the close/min/max region matches the Vue title bar
      // above it. The overlay never adapts to ComfyUI's in-page theme.
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
    initiallyHidden: true,
  })

  entry.coldStartPendingReveal = true

  ensurePanelView(entry.windowKey, entry, 'chooser')

  entry.layoutViews()

  const revealKey = entry.windowKey
  setTimeout(() => {
    const live = comfyWindows.get(revealKey)
    if (!live?.coldStartPendingReveal || live.window.isDestroyed()) return
    live.coldStartPendingReveal = false
    live.layoutViews()
    bringToFront(live.window)
  }, 10_000)

  return comfyWindow
}
