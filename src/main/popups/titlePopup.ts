import { WebContentsView, ipcMain, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import path from 'path'
import { TITLEBAR_HEIGHT } from '../lib/titleBarOverlay'
import {
  cancelModelDownload,
  clearFinishedDownloads,
  dismissRecentDownload,
  downloadEvents,
  getDownloadsTrayState,
  pauseModelDownload,
  resumeModelDownload,
} from '../lib/comfyDownloadManager'
import * as mainTelemetry from '../lib/telemetry'
import {
  comfyWindows,
  findEntryByTitleBarSender,
} from '../host/registry'
import type { ComfyPanelKey, ComfyWindowEntry } from '../host/registry'
import {
  getTitleTooltipForParent,
  hideTitleTooltipPopup,
} from './titleTooltip'

/**
 * Title-bar dropdown popups (waffle menu, downloads tray). All title-bar
 * dropdowns share one HTML popup rendered inside a transparent child
 * WebContentsView per parent window — gives native shadow + theme-matched
 * chrome (no clipping by the title-bar view's bounds), free click-outside
 * dismissal via the popup's own blur event, and consistent styling with
 * the Vue title bar.
 */

interface TitlePopupMenuItem {
  /** Item id — main routes activation by this. Omitted for separators. */
  id?: string
  /** Visible label. Treated as the English fallback when `labelKey`
   *  is set; otherwise rendered verbatim by the popup view. */
  label?: string
  /** Optional vue-i18n key the popup view resolves against its own
   *  message catalog (`lib/i18nMessages.ts`). Lets the renderer
   *  translate menu items even though the labels are built main-side
   *  where vue-i18n isn't available. Falls back to `label` if the key
   *  isn't in the catalog. */
  labelKey?: string
  /** Render a checkmark glyph beside the label when true. */
  checked?: boolean
  /** Marks a separator row instead of an interactive item. */
  kind?: 'separator'
}

type TitlePopupKind = 'menu' | 'downloads'

type TitlePopupConfig =
  | {
      kind: 'menu'
      items: TitlePopupMenuItem[]
      theme: { bg: string; text: string }
    }
  | {
      kind: 'downloads'
      theme: { bg: string; text: string }
    }

/**
 * One reusable popup `WebContentsView` per parent BrowserWindow.
 *
 * The popup is attached as a child view of the parent window (rather
 * than its own top-level / child BrowserWindow) so it always shares
 * the parent's window coordinate space. That is what makes it behave
 * like an in-window popup on Wayland, where detached popup windows
 * can render as separate top-level surfaces.
 *
 * Constructing the WebContentsView + loading the renderer on every
 * open would cost ~100ms of click-to-paint delay, so we lazily create
 * one popup per parent, hide it between uses, and push fresh config
 * via `comfy-titlepopup:set-config` IPC on every subsequent open. The
 * popup webContents is closed when its parent BrowserWindow closes.
 *
 * Latest values for the *current* open are tracked here too so
 * `activate` (item click) and the dismiss path (re-emits
 * `comfy-titlebar:menu-closed` for the reopen-suppression guard)
 * can route without their own per-open context.
 */
interface TitlePopupEntry {
  popup: WebContentsView
  parentWindow: BrowserWindow
  /** Snapshotted at construction so we don't touch `popup.webContents`
   *  in the destroyed-window handlers. */
  popupWebContentsId: number
  parentWindowId: number
  /** Numeric `windowKey` of the parent host entry, updated on every
   *  open. `0` is a sentinel for "no popup has been opened yet" since
   *  `nextWindowKey` always returns positive numbers. */
  parentEntryId: number
  /** Updated on every open. */
  kind: TitlePopupKind
  /** Updated on every open. */
  titleBarSender: Electron.WebContents
  /** True once the renderer has signalled `comfy-titlepopup:ready`.
   *  Until then, config pushes are queued in `pendingConfig`. */
  rendererReady: boolean
  /** Config queued before the renderer signalled ready — flushed on
   *  ready. Overwritten if multiple opens happen before ready. */
  pendingConfig: TitlePopupConfig | null
  /** True between `setVisible(true)` (show) and `setVisible(false)`
   *  (hide) — the blur handler ignores spurious blurs while we're
   *  already hidden. */
  isOpen: boolean
  /** Set to a non-null timer when an open is in flight, waiting for
   *  the renderer's `comfy-titlepopup:rendered` ack before flipping
   *  to visible. The timer is the fallback that shows anyway after
   *  a short window (in case the renderer is unusually slow). */
  pendingShowTimer: NodeJS.Timeout | null
  /** JSON of the most recently sent `comfy-titlepopup:set-config`
   *  payload — used to compare against the next open's config to skip
   *  the renderer roundtrip when the DOM is already correct. */
  lastConfigJson: string | null
  /** JSON of the config the renderer has acked via
   *  `comfy-titlepopup:rendered`. When equal to the next open's
   *  config, the popup view's DOM matches what we want to show, so
   *  we can `setVisible(true)` immediately without resending the
   *  config or waiting for an ack — saves one frame + two IPC hops
   *  per open (the common case for repeated opens of the same menu
   *  in the same window). */
  lastSyncedConfigJson: string | null
}

/** Active popup keyed by parent BrowserWindow id (one popup per parent,
 *  cached for reuse). The webContents-id index lets
 *  `comfy-titlepopup:item-activated` / `:close` / `:ready` route by
 *  `event.sender`. */
const titlePopupsByParent = new Map<number, TitlePopupEntry>()
const titlePopupsByWebContents = new Map<number, TitlePopupEntry>()

const POPUP_WIDTH = 220
const POPUP_ITEM_HEIGHT = 28
const POPUP_SEPARATOR_HEIGHT = 9
const POPUP_VPADDING = 8 // 4px top + 4px bottom on the <ul>
const POPUP_VBORDER = 2 // 1px top + 1px bottom from the .popup card

export function computePopupHeight(items: readonly TitlePopupMenuItem[]): number {
  const content = items.reduce(
    (sum, item) => sum + (item.kind === 'separator' ? POPUP_SEPARATOR_HEIGHT : POPUP_ITEM_HEIGHT),
    0,
  )
  return content + POPUP_VPADDING + POPUP_VBORDER
}

/** Build the file-menu items for a host entry. The waffle/file menu
 *  shape changes with `firstUseMode`, install-backed vs install-less
 *  (chooser) host, current panel, and zoom level — so the items are
 *  recomputed on every open rather than cached. */
export function buildTitlePopupMenuItems(entry: ComfyWindowEntry): TitlePopupMenuItem[] {
  // First-use post-consent — the takeover is mounted (or chained into
  // new-install / migrate / install-progress), and the only file-menu
  // entry that should be reachable is the explicit escape hatch.
  // Surfacing New Install / Settings here would let the user wander out
  // of the bootstrap UX into surfaces that aren't ready for it. Skip
  // Onboarding marks completion + clears the chain state and dismisses
  // the takeover.
  if (entry.firstUseMode === 'post-consent') {
    return [
      {
        id: 'skip-onboarding',
        label: 'Skip Onboarding',
        labelKey: 'fileMenu.skipOnboarding',
      },
    ]
  }
  // Issue #497 — file-menu order:
  //   New Window
  //   ── separator ──
  //   (install-less only) New Install / Track / Load Snapshot
  //   ── separator ──
  //   Settings (unified — ComfyUI Settings on install-backed hosts,
  //             Global Settings on install-less; PanelApp picks the
  //             default tab at mount time)
  //   Send Feedback
  //   ── separator ──
  //   (install-backed only) Return to Dashboard
  //   Close All Windows
  //
  // Notes:
  //   - "Close Window" is intentionally absent — the OS-X / native
  //     close button already covers single-window dismissal; the menu
  //     only surfaces the cross-window kill switch.
  //   - Install-creation / import flows (New Install / Track / Load
  //     Snapshot) live ONLY on the dashboard (install-less host)
  //     waffle menu. Inside a Comfy Instance window the only escape
  //     hatch back to the dashboard is "Return to Dashboard" — the
  //     in-Comfy chrome stays closed-off per the design doc's
  //     "Comfy Instance is closed-off" rule.
  //   - "Return to Dashboard" is install-backed-only; install-less
  //     host windows are already on the chooser body so the entry
  //     would be a no-op there.
  const items: TitlePopupMenuItem[] = [
    { id: 'new-window', label: 'New Window', labelKey: 'fileMenu.newWindow' },
    { kind: 'separator' },
  ]
  if (entry.installationId === null) {
    items.push(
      { id: 'new-install', label: 'New Install', labelKey: 'fileMenu.newInstall' },
      {
        id: 'track',
        label: 'Add Existing Install',
        labelKey: 'fileMenu.addExistingInstall',
      },
      { id: 'load-snapshot', label: 'Load Snapshot', labelKey: 'fileMenu.loadSnapshot' },
      { kind: 'separator' },
    )
  }
  items.push(
    {
      id: 'settings',
      label: 'Settings',
      labelKey: 'fileMenu.settings',
      checked: entry.activePanel === 'settings',
    },
    // Send Feedback (#493). The renderer-side handler resolves the
    // support URL and emits the `desktop2.feedback.opened`
    // telemetry action with `source: 'menu'`.
    { id: 'feedback', label: 'Send Beta Feedback', labelKey: 'fileMenu.sendFeedback' },
    { kind: 'separator' },
  )
  if (entry.installationId !== null) {
    items.push({
      id: 'return-to-dashboard',
      label: 'Return to Dashboard',
      labelKey: 'fileMenu.returnToDashboard',
    })
  }
  // Reset Zoom — discoverable recovery path for users who zoom the Comfy
  // view too far to read. Only surfaced when zoom is actually non-default,
  // and the label includes the current percent so the menu also doubles
  // as a status indicator. The Ctrl/Cmd + 0 shortcut wired in `onLaunch`
  // does the same thing for users who know it.
  if (!entry.comfyView.webContents.isDestroyed()) {
    const level = entry.comfyView.webContents.getZoomLevel()
    if (level !== 0) {
      const percent = Math.round(Math.pow(1.2, level) * 100)
      items.push({ id: 'reset-zoom', label: `Reset Zoom (${percent}%)` })
    }
  }
  items.push({
    id: 'close-all-windows',
    label: 'Close All Windows',
    labelKey: 'fileMenu.closeAllWindows',
  })
  return items
}

/** Push the downloads-tray snapshot to a single popup webContents. */
function notifyTitlePopupDownloads(popup: WebContentsView): void {
  if (popup.webContents.isDestroyed()) return
  popup.webContents.send('comfy-titlepopup:downloads-changed', getDownloadsTrayState())
}

/** Fan out tray-state changes to every cached title-bar dropdown popup
 *  so the downloads view repaints live while open. */
function broadcastDownloadsToTitlePopups(): void {
  for (const entry of titlePopupsByParent.values()) {
    notifyTitlePopupDownloads(entry.popup)
  }
}

/** Pre-warm the title-bar popup for a host window so the user's first
 *  click doesn't pay the WebContentsView + HTML/JS load cost (~100ms). */
export function prewarmTitlePopup(parent: BrowserWindow): void {
  ensureTitlePopup(parent)
}

/** Lazily create the reusable popup `WebContentsView` for the given
 *  parent BrowserWindow. Subsequent opens for the same parent reuse
 *  the same view — the renderer is loaded once, then we just push fresh
 *  config + reposition + show on every open. The popup is closed when
 *  its parent is. */
function ensureTitlePopup(parent: BrowserWindow): TitlePopupEntry {
  const existing = titlePopupsByParent.get(parent.id)
  if (existing && !existing.popup.webContents.isDestroyed()) return existing

  const popup = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/comfyTitlePopupPreload.js'),
    },
  })
  // Transparent so the empty area around the rounded card lets the
  // body view show through. WebContentsView per-pixel transparency
  // works inside a parent BrowserWindow's opaque surface (it just
  // alpha-blends into the parent), unlike a child BrowserWindow which
  // would need OS-level transparency on the parent.
  popup.setBackgroundColor('#00000000')
  popup.setVisible(false)
  // Bounds in window-content-local pixels. Initial values are
  // overwritten by `setBounds` on every open; keep them small so the
  // hidden view doesn't squat on real estate during the construction
  // race before the first open.
  popup.setBounds({ x: 0, y: 0, width: POPUP_WIDTH, height: 100 })
  parent.contentView.addChildView(popup)

  const isDev = !!process.env['ELECTRON_RENDERER_URL']
  const loadPromise = isDev
    ? popup.webContents.loadURL(
        `${(process.env['ELECTRON_RENDERER_URL'] as string).replace(/\/$/, '')}/comfyTitlePopup.html`,
      )
    : popup.webContents.loadFile(path.join(__dirname, '../renderer/comfyTitlePopup.html'))
  void loadPromise.catch(() => {})

  // Capture ids up-front. The parent's `closed` event fires *after*
  // the BrowserWindow + its child WebContentsViews' webContents are
  // destroyed, so accessing `popup.webContents.id` there would throw
  // "Object has been destroyed".
  const entry: TitlePopupEntry = {
    popup,
    parentWindow: parent,
    popupWebContentsId: popup.webContents.id,
    parentWindowId: parent.id,
    parentEntryId: 0,
    kind: 'menu',
    titleBarSender: popup.webContents, // overwritten on first open
    rendererReady: false,
    pendingConfig: null,
    isOpen: false,
    pendingShowTimer: null,
    lastConfigJson: null,
    lastSyncedConfigJson: null,
  }
  titlePopupsByParent.set(entry.parentWindowId, entry)
  titlePopupsByWebContents.set(entry.popupWebContentsId, entry)

  // Click-outside dismissal. Item clicks inside the popup do NOT trigger
  // blur — focus stays in the popup webContents until we explicitly hide
  // it on item-activated, so item activations always reach main.
  //
  // We listen on the popup webContents (for focus moves to *another*
  // view inside the same parent window — e.g. clicking the title-bar
  // button or the comfy body) and on the parent BrowserWindow (for focus
  // moves *out* of the parent window — e.g. clicking another app or
  // another desktop window). The webContents blur alone is not reliable
  // for cross-window focus changes on macOS.
  //
  // The title-bar root is `-webkit-app-region: drag`, so a click on its
  // empty area is consumed by the OS for window dragging and never
  // reaches the title-bar webContents — neither `popup.webContents`'s
  // blur nor `parent`'s blur fires. `will-move` / `move` cover that
  // path: any title-bar drag dismisses the popup as soon as the window
  // begins to move.
  const dismissOnBlur = (): void => {
    hideTitlePopup(entry)
  }
  popup.webContents.on('blur', dismissOnBlur)
  parent.on('blur', dismissOnBlur)
  parent.on('will-move', dismissOnBlur)
  parent.on('move', dismissOnBlur)

  // Tear down with the parent. Without this, the popup would survive
  // its parent and reuse the wrong context on the next click in a
  // different window.
  const onParentClosed = (): void => {
    titlePopupsByParent.delete(entry.parentWindowId)
    titlePopupsByWebContents.delete(entry.popupWebContentsId)
    try { parent.contentView.removeChildView(popup) } catch {}
    if (!popup.webContents.isDestroyed()) popup.webContents.close()
  }
  parent.once('closed', onParentClosed)

  // If the popup webContents is destroyed independently (renderer
  // crash, manual close), drop the parent-window listeners so they
  // don't accumulate when `ensureTitlePopup` constructs a fresh
  // entry on the next open.
  popup.webContents.once('destroyed', () => {
    if (!parent.isDestroyed()) {
      parent.removeListener('blur', dismissOnBlur)
      parent.removeListener('will-move', dismissOnBlur)
      parent.removeListener('move', dismissOnBlur)
      parent.removeListener('closed', onParentClosed)
    }
    if (titlePopupsByParent.get(entry.parentWindowId) === entry) {
      titlePopupsByParent.delete(entry.parentWindowId)
    }
    titlePopupsByWebContents.delete(entry.popupWebContentsId)
  })

  return entry
}

/** Fallback timeout (ms) — if the renderer's
 *  `comfy-titlepopup:rendered` ack doesn't arrive within this window
 *  after `set-config`, show the popup anyway so it never gets
 *  permanently stuck invisible. The renderer normally acks within one
 *  animation frame (~16ms). */
const POPUP_RENDER_ACK_TIMEOUT_MS = 80

/** Hide the popup view and re-emit the `comfy-titlebar:menu-closed`
 *  event so the title-bar renderer's 100ms `MENU_REOPEN_GUARD_MS`
 *  suppression fires.
 *
 *  `releaseFocusToParent` controls whether to explicitly hand focus
 *  back to the title-bar webContents after hiding. Use it when the
 *  popup is being dismissed *while* it still has focus (item click,
 *  Escape key) so keyboard input lands somewhere sensible. Skip it on
 *  the blur path — focus has already moved to wherever the user
 *  clicked, and stealing it back to the title bar would yank focus
 *  out of whatever they targeted (another app window, the parent's
 *  body, etc.). Also skip it when the activated item handed focus to
 *  a *different* window (e.g. `new-window` opens and `bringToFront`s
 *  a fresh chooser host) — re-focusing the title bar here races
 *  against and defeats that hand-off. */
function hideTitlePopup(
  entry: TitlePopupEntry,
  opts: { releaseFocusToParent?: boolean } = {},
): void {
  // Proceed if a show is in flight even when not yet visible — otherwise
  // the pendingShowTimer would fire after this dismissal and pop the
  // menu open unexpectedly.
  if (!entry.isOpen && !entry.pendingShowTimer) return
  entry.isOpen = false
  // Cancel any in-flight render ack — if a hide arrives before the
  // ack, the popup is already on its way back to hidden and we
  // shouldn't flip it visible retroactively.
  if (entry.pendingShowTimer) {
    clearTimeout(entry.pendingShowTimer)
    entry.pendingShowTimer = null
  }
  if (!entry.popup.webContents.isDestroyed()) {
    entry.popup.setVisible(false)
    if (opts.releaseFocusToParent && !entry.parentWindow.isDestroyed()) {
      // Embedded WebContentsView: `BrowserWindow.focus()` raises the host
      // window but doesn't deterministically land keyboard focus in any
      // child view. Push focus into the title bar (the button that
      // opened the popup) so subsequent keystrokes go somewhere
      // sensible. Falls back to a plain window focus if the title-bar
      // sender is no longer alive.
      if (!entry.titleBarSender.isDestroyed()) {
        entry.titleBarSender.focus()
      } else {
        entry.parentWindow.focus()
      }
    }
  }
  if (!entry.titleBarSender.isDestroyed()) {
    entry.titleBarSender.send('comfy-titlebar:menu-closed', { menu: entry.kind })
  }
}

/** Make the popup view visible, focus it, and mark `isOpen`. Called
 *  when the renderer acks `comfy-titlepopup:rendered` — at that point
 *  the new config has been painted and showing is safe. */
function showTitlePopupNow(entry: TitlePopupEntry): void {
  if (entry.pendingShowTimer) {
    clearTimeout(entry.pendingShowTimer)
    entry.pendingShowTimer = null
  }
  if (entry.popup.webContents.isDestroyed()) return
  entry.popup.setVisible(true)
  entry.popup.webContents.focus()
  entry.isOpen = true
  // Notify the title bar so it can suppress the next click on the
  // menu button. Without this, on macOS the click event can fire
  // before the blur-driven dismiss propagates back, causing the
  // popup to reopen instead of close on a reclick.
  if (!entry.titleBarSender.isDestroyed()) {
    entry.titleBarSender.send('comfy-titlebar:menu-opened', { menu: entry.kind })
  }
}

/** Downloads popup sizing — fixed width and a fixed pixel cap on
 *  height. The popup view content scrolls internally past the cap so
 *  the dropdown stays compact even with a full recent buffer. The
 *  ratio cap is a safety net for very small windows where the fixed
 *  cap would push past the bottom of the host. The renderer measures
 *  its own natural height (empty placeholder + footer, or a list of
 *  entries) and asks for it via `requestSize`, so we don't impose a
 *  pixel floor — the empty placeholder's own padding already provides
 *  enough visual weight that the popup never reads as a sliver. */
const DOWNLOADS_POPUP_WIDTH = 360
const DOWNLOADS_POPUP_MAX_HEIGHT_PX = 360
const DOWNLOADS_POPUP_MAX_HEIGHT_RATIO = 0.6

type OpenTitlePopupOpts = {
  parent: BrowserWindow
  parentEntryId: number
  anchor: { x: number; y: number }
  theme: { bg: string; text: string }
  titleBarSender: Electron.WebContents
} & (
  | { kind: 'menu'; items: TitlePopupMenuItem[] }
  | { kind: 'downloads' }
)

function openTitlePopup(opts: OpenTitlePopupOpts): void {
  // Dismiss any in-flight title-bar tooltip — the popup will obscure
  // the same area, and the renderer's pointer-leave on the trigger
  // button (which would otherwise hide the tooltip) doesn't fire when
  // a click moves focus straight into the popup.
  hideTitleTooltipPopup(getTitleTooltipForParent(opts.parent.id))
  const entry = ensureTitlePopup(opts.parent)
  if (entry.popup.webContents.isDestroyed()) return

  // Refresh the per-open routing context. `kind` + `parentEntryId` +
  // `titleBarSender` only matter for the *current* open, so we
  // overwrite on every open instead of allocating a new context object.
  entry.parentEntryId = opts.parentEntryId
  entry.kind = opts.kind
  entry.titleBarSender = opts.titleBarSender

  // Anchor coords are title-bar-local; the title-bar view sits at
  // content (0,0) so they map directly to parent-window content
  // coordinates, which is exactly what `WebContentsView.setBounds`
  // expects.
  const x = Math.round(Math.max(0, opts.anchor.x))
  const y = Math.round(Math.max(0, opts.anchor.y))

  let width: number
  let height: number
  if (opts.kind === 'menu') {
    width = POPUP_WIDTH
    height = computePopupHeight(opts.items)
  } else {
    width = DOWNLOADS_POPUP_WIDTH
    const contentHeight = opts.parent.getContentBounds().height
    // Open at the ceiling (smaller of the fixed pixel cap or 60% of the
    // host window's content height, so the popup never overflows tiny
    // windows). The renderer immediately measures its natural content
    // height and asks for it via `requestSize`, which clamps back into
    // this band. The popup stays hidden until the renderer's
    // `notifyRendered` ack arrives, so the user never sees this
    // provisional size.
    height = Math.min(
      DOWNLOADS_POPUP_MAX_HEIGHT_PX,
      Math.round(contentHeight * DOWNLOADS_POPUP_MAX_HEIGHT_RATIO),
    )
  }

  // Re-add as the most recently attached child view so the popup paints
  // on top of `titleBarView` / `comfyView` / `panelView`. Then update
  // bounds while still hidden — the popup is flipped visible only after
  // the renderer acks the new content has painted.
  try {
    opts.parent.contentView.removeChildView(entry.popup)
  } catch {}
  opts.parent.contentView.addChildView(entry.popup)
  entry.popup.setBounds({ x, y, width, height })

  // Downloads popup feeds on a separate channel — push the latest
  // snapshot now so the first paint shows current state instead of
  // the empty-state placeholder. Subsequent updates arrive via the
  // tray-state-changed broadcast.
  if (opts.kind === 'downloads' && entry.rendererReady) {
    notifyTitlePopupDownloads(entry.popup)
  }

  // Push the new config and *wait* for the renderer to ack that the
  // new content has painted before flipping the view visible. Without
  // this the user sees a frame of the previous open's content while
  // Vue is still processing the config update.
  if (entry.pendingShowTimer) {
    clearTimeout(entry.pendingShowTimer)
    entry.pendingShowTimer = null
  }
  const config: TitlePopupConfig = opts.kind === 'menu'
    ? { kind: 'menu', items: opts.items, theme: opts.theme }
    : { kind: 'downloads', theme: opts.theme }
  const configJson = JSON.stringify(config)

  // Fast path: the renderer's DOM already matches the config we want
  // to show (e.g. repeat open of the same menu with no item / theme
  // changes). Skip the set-config IPC + render-ack roundtrip and show
  // immediately — eliminates ~1 frame + 2 IPC hops of perceived
  // open latency on the common case.
  if (
    entry.lastSyncedConfigJson === configJson
    && !entry.popup.webContents.isDestroyed()
  ) {
    showTitlePopupNow(entry)
    return
  }

  entry.lastConfigJson = configJson
  if (entry.rendererReady && !entry.popup.webContents.isDestroyed()) {
    entry.popup.webContents.send('comfy-titlepopup:set-config', config)
  } else {
    // Renderer hasn't mounted yet on the very first open. Queue the
    // config; the `ready` IPC handler flushes it.
    entry.pendingConfig = config
  }
  entry.pendingShowTimer = setTimeout(() => {
    if (entry.pendingShowTimer === null) return
    showTitlePopupNow(entry)
  }, POPUP_RENDER_ACK_TIMEOUT_MS)
}

export interface TitlePopupHostBindings {
  /** Open a fresh chooser host window. */
  openChooserHostWindow: () => void
  /** Flip an install-backed host window in place to chooser-host mode. */
  returnToDashboard: (parentEntryId: number) => Promise<void> | void
  /** Confirm + close all host windows. The parent window is the popup's
   *  host so the confirm dialog can be parented to it. */
  confirmAndCloseAllHostWindows: (parentWindow: BrowserWindow | null) => Promise<void> | void
  /** Switch the host's body to the named panel (settings, new-install, ...). */
  setActivePanel: (windowKey: number, panel: ComfyPanelKey) => void
  /** Forward a Send Feedback request to the host's panel renderer. */
  triggerOpenFeedback: (entryId: number, source: 'titlebar' | 'menu') => void
  /** Send an IPC to the host's panel webContents, deferring until
   *  `did-finish-load` if the bundle is still loading. */
  sendToPanelDeferred: (panelView: WebContentsView, channel: string, payload: unknown) => void
}

function activateTitlePopupMenuItem(
  entry: TitlePopupEntry,
  id: string,
  bindings: TitlePopupHostBindings,
): void {
  // Capture the click in main so the title-menu popup itself doesn't need
  // to bootstrap Datadog RUM / PostHog Browser (it's a transient view that
  // would mint a fresh session per open). PostHog Node captures here and
  // forwardToRenderer relays to the title-bar Datadog RUM session for the
  // parent host window — see `forwardToRenderer` + the relay-target
  // registry in `lib/telemetry.ts`.
  mainTelemetry.emit('desktop2.title_menu.item_clicked', {
    item_id: id,
    menu_kind: entry.kind,
    parent_entry_id: entry.parentEntryId,
  })
  // Default: re-focus the popup's parent on dismiss so keyboard input
  // lands somewhere sensible. Actions that hand focus to a *different*
  // window (e.g. `new-window` spawns a fresh chooser host and brings it
  // to the front) flip this off so the parent doesn't immediately yank
  // focus back from the new target.
  let releaseFocusToParent = true
  const parentEntry = comfyWindows.get(entry.parentEntryId)
  if (id === 'new-window') {
    bindings.openChooserHostWindow()
    releaseFocusToParent = false
  }
  else if (id === 'return-to-dashboard') {
    // Flip the install-backed host in place to chooser-host mode.
    // The same BrowserWindow stays alive; the file-menu popup is
    // parented to it so it stays valid through the in-place body
    // swap (no popup teardown).
    void bindings.returnToDashboard(entry.parentEntryId)
  } else if (id === 'close-all-windows') {
    // For two or more open windows we confirm via a native dialog
    // that lists the open windows + any active operations that
    // would be cancelled. With one or zero windows the close
    // happens straight through. The parent of this popup is among
    // the windows being closed; its popup is auto-destroyed, and
    // the trailing hideTitlePopup is guarded against an
    // already-destroyed popup.
    const parentWindow = parentEntry && !parentEntry.window.isDestroyed()
      ? parentEntry.window
      : null
    void bindings.confirmAndCloseAllHostWindows(parentWindow)
  } else if (id === 'settings') bindings.setActivePanel(entry.parentEntryId, 'settings')
  else if (id === 'skip-onboarding') {
    // Forward to the panel renderer so it runs the same
    // `markFirstUseCompleted` + dismiss sequence the Cloud-branch
    // pick uses (PanelApp owns the `firstUseCompleted` flip and the
    // overlay close — see `handleFirstUseComplete`).
    if (parentEntry?.panelView && !parentEntry.panelView.webContents.isDestroyed()) {
      parentEntry.panelView.webContents.send('comfy-panel:first-use-skip')
    }
  }
  else if (id === 'feedback') {
    // Forward to the panel renderer — see `triggerOpenFeedback`.
    // The title-bar Send Feedback button lands on the same helper
    // via `comfy-window:click-feedback`; `source` distinguishes the
    // two entry points in the telemetry payload.
    bindings.triggerOpenFeedback(entry.parentEntryId, 'menu')
  }
  else if (id === 'reset-zoom') {
    // Pair to the Ctrl/Cmd + 0 shortcut wired in `onLaunch`. The menu
    // entry is only built when zoom is non-zero (see `buildTitlePopupMenuItems`),
    // so this always corresponds to a visible state change.
    if (parentEntry && !parentEntry.comfyView.webContents.isDestroyed()) {
      const previousLevel = parentEntry.comfyView.webContents.getZoomLevel()
      parentEntry.comfyView.webContents.setZoomLevel(0)
      // Mirrors the Ctrl/Cmd + 0 shortcut emit in `attachInstall`.
      // Same event name + payload shape so dashboards can group on the
      // event and pivot on `source` to compare discoverability paths.
      // No previousLevel === 0 guard here: the menu item is only built
      // when zoom is non-zero (see `buildTitlePopupMenuItems`), so any click
      // is a real reset. The complementary `desktop2.title_menu.item_clicked`
      // emit at the top of this function still fires for menu-engagement
      // rollups; this one is the action-specific signal.
      mainTelemetry.emit('desktop2.zoom.reset', {
        source: 'menu',
        parent_entry_id: entry.parentEntryId,
        installation_id: parentEntry.installationId,
        previous_zoom_level: previousLevel,
        previous_zoom_percent: Math.round(Math.pow(1.2, previousLevel) * 100),
      })
    }
  }
  else if (id === 'new-install' || id === 'track' || id === 'load-snapshot' || id === 'quick-install') {
    // Install-creation / import flows are chooser-host-only.
    // `buildTitlePopupMenuItems` already filters them out of the
    // install-backed file menu; this guard is the belt-and-braces
    // so a stale popup or an out-of-order IPC can't navigate an
    // in-Comfy host into one of these panels.
    if (parentEntry?.installationId === null) {
      bindings.setActivePanel(entry.parentEntryId, id)
    }
  }
  // Item click — popup still has focus, so push it back to the parent
  // unless the action just handed focus to a different window.
  hideTitlePopup(entry, { releaseFocusToParent })
}

/**
 * Wire the IPC handlers that drive the title-bar dropdown popup
 * (waffle menu + downloads tray) and subscribe to download events for
 * live tray updates. Called once at app `whenReady`.
 *
 * The title bar lives in its own WebContentsView with `height:
 * TITLEBAR_HEIGHT`, so HTML popups rendered inside it would be clipped
 * by the view's bounds. We attach a sibling `WebContentsView` to the
 * host window's content view (see `openTitlePopup`); it re-orders to
 * the top of the view stack on each open so it paints above the title
 * bar / comfy / panel views without z-order issues.
 */
export function registerTitlePopupIpc(bindings: TitlePopupHostBindings): void {
  ipcMain.on('comfy-titlepopup:ready', (event) => {
    const entry = titlePopupsByWebContents.get(event.sender.id)
    if (!entry) return
    entry.rendererReady = true
    if (entry.pendingConfig && !entry.popup.webContents.isDestroyed()) {
      const flushed = entry.pendingConfig
      entry.lastConfigJson = JSON.stringify(flushed)
      entry.popup.webContents.send('comfy-titlepopup:set-config', flushed)
      entry.pendingConfig = null
      if (flushed.kind === 'downloads') {
        notifyTitlePopupDownloads(entry.popup)
      }
    }
  })

  // Renderer signals that it has applied the latest config and the new
  // DOM has painted. Show the popup view and focus it — the user only
  // ever sees the popup once it's showing the right content.
  ipcMain.on('comfy-titlepopup:rendered', (event) => {
    const entry = titlePopupsByWebContents.get(event.sender.id)
    if (!entry) return
    // Mark the renderer in sync with the most recently sent config so
    // the next open of the same content can take the fast path in
    // `openTitlePopup`.
    entry.lastSyncedConfigJson = entry.lastConfigJson
    if (entry.pendingShowTimer === null) return
    showTitlePopupNow(entry)
  })

  ipcMain.on('comfy-titlepopup:item-activated', (event, payload: { id?: unknown }) => {
    const entry = titlePopupsByWebContents.get(event.sender.id)
    if (!entry) return
    const id = payload?.id
    if (typeof id !== 'string') return
    activateTitlePopupMenuItem(entry, id, bindings)
  })

  ipcMain.on('comfy-titlepopup:close', (event) => {
    const entry = titlePopupsByWebContents.get(event.sender.id)
    if (!entry) return
    // Escape key — popup still has focus, so push it back to the parent.
    hideTitlePopup(entry, { releaseFocusToParent: true })
  })

  // Renderer-driven resize for the downloads popup. The downloads
  // shelf has highly variable natural height (empty placeholder vs. a
  // full recent buffer with a mix of active + terminal entries) and
  // predicting it main-side is brittle, so the popup measures itself
  // and asks for the bounds it wants. We cap at MAX_PX and re-floor by
  // the host window's contentHeight ratio so the popup never overflows
  // tiny windows; otherwise we trust the measured natural height (the
  // empty placeholder's own padding keeps the empty case from reading
  // as a sliver). Width and position are preserved.
  ipcMain.on(
    'comfy-titlepopup:request-size',
    (event, payload: { height?: unknown }) => {
      const entry = titlePopupsByWebContents.get(event.sender.id)
      if (!entry) return
      // Menu popups are sized deterministically by `computePopupHeight`
      // — ignore renderer requests to avoid fighting the source of truth.
      if (entry.kind !== 'downloads') return
      const requested = payload?.height
      if (typeof requested !== 'number' || !Number.isFinite(requested)) return
      const parent = comfyWindows.get(entry.parentEntryId)?.window
      if (!parent || parent.isDestroyed()) return
      const contentHeight = parent.getContentBounds().height
      const ceiling = Math.min(
        DOWNLOADS_POPUP_MAX_HEIGHT_PX,
        Math.round(contentHeight * DOWNLOADS_POPUP_MAX_HEIGHT_RATIO),
      )
      const next = Math.max(1, Math.min(ceiling, Math.ceil(requested)))
      const cur = entry.popup.getBounds()
      if (cur.height === next) return
      entry.popup.setBounds({ x: cur.x, y: cur.y, width: cur.width, height: next })
    },
  )

  // Per-entry download action dispatched from the popup's downloads view.
  // Routes pause / resume / cancel / dismiss through the existing
  // download-manager APIs and `show-in-folder` through Electron's shell.
  // `clear-finished` is the only action that doesn't carry a url.
  ipcMain.on(
    'comfy-titlepopup:downloads-action',
    (_event, payload: { action?: unknown; url?: unknown; savePath?: unknown }) => {
      const { action, url, savePath } = payload ?? {}
      if (action === 'clear-finished') {
        clearFinishedDownloads()
        return
      }
      if (typeof url !== 'string' || url.length === 0) return
      switch (action) {
        case 'pause':
          pauseModelDownload(url)
          return
        case 'resume':
          resumeModelDownload(url)
          return
        case 'cancel':
          cancelModelDownload(url)
          return
        case 'dismiss':
          dismissRecentDownload(url)
          return
        case 'show-in-folder':
          if (typeof savePath === 'string' && savePath.length > 0) {
            shell.showItemInFolder(savePath)
          }
          return
        default:
          return
      }
    },
  )

  // Popup → host deep-link to the unified Settings modal at a given
  // tab. Mirrors the `click-install-update-pill` flow: bring the panel
  // view forward (lazily constructing it if needed), then send the
  // `panel-trigger-overlay 'open-settings'` IPC after the renderer has
  // finished loading so the listener is registered. The popup itself
  // is dismissed first so the overlay surface comes up unobstructed.
  ipcMain.on(
    'comfy-titlepopup:open-settings-tab',
    (event, payload: { tab?: unknown }) => {
      const popupEntry = titlePopupsByWebContents.get(event.sender.id)
      if (!popupEntry) return
      const tab = payload?.tab
      if (
        tab !== 'comfy'
        && tab !== 'directories'
        && tab !== 'downloads'
        && tab !== 'global'
      ) return
      const parentEntry = comfyWindows.get(popupEntry.parentEntryId)
      if (!parentEntry) return
      hideTitlePopup(popupEntry, { releaseFocusToParent: false })
      bindings.setActivePanel(popupEntry.parentEntryId, 'settings')
      const panelView = parentEntry.panelView
      if (!panelView) return
      bindings.sendToPanelDeferred(panelView, 'panel-trigger-overlay', {
        kind: 'open-settings',
        installationId: parentEntry.installationId,
        settingsTab: tab,
      })
    },
  )

  // Title-bar downloads-tray click. Opens the title-bar dropdown popup
  // in `'downloads'` mode anchored under the tray button. The popup
  // subscribes to `comfy-titlepopup:downloads-changed` for live state
  // and dispatches per-entry actions back via
  // `comfy-titlepopup:downloads-action`.
  ipcMain.on(
    'comfy-window:click-downloads-tray',
    (event, payload: { anchor?: { x?: number; y?: number } } | undefined) => {
      const found = findEntryByTitleBarSender(event.sender)
      if (!found) return
      const { id: windowKey, entry } = found
      if (entry.window.isDestroyed()) return
      const x = Math.max(0, Math.round(payload?.anchor?.x ?? 0))
      const y = Math.max(0, Math.round(payload?.anchor?.y ?? TITLEBAR_HEIGHT))
      openTitlePopup({
        parent: entry.window,
        parentEntryId: windowKey,
        kind: 'downloads',
        anchor: { x, y },
        theme: entry.lastTheme,
        titleBarSender: entry.titleBarView.webContents,
      })
    },
  )

  // Title-bar waffle/file-menu click. Builds the menu items for the
  // host entry and opens the popup anchored under the button.
  ipcMain.on(
    'comfy-window:open-title-menu',
    (event, payload: { menu?: 'file'; anchor?: { x?: number; y?: number } }) => {
      const found = findEntryByTitleBarSender(event.sender)
      if (!found) return
      const { id: windowKey, entry } = found
      if (entry.window.isDestroyed()) return
      // Only the file/waffle menu is openable from the title bar.
      if (payload?.menu !== 'file') return

      const x = Math.max(0, Math.round(payload?.anchor?.x ?? 0))
      const y = Math.max(0, Math.round(payload?.anchor?.y ?? TITLEBAR_HEIGHT))

      openTitlePopup({
        parent: entry.window,
        parentEntryId: windowKey,
        kind: 'menu',
        items: buildTitlePopupMenuItems(entry),
        anchor: { x, y },
        theme: entry.lastTheme,
        titleBarSender: entry.titleBarView.webContents,
      })
    },
  )

  // Title bar asks main to dismiss the file-menu popup. Used when the
  // user reclicks the file button while the popup is open: on macOS
  // clicking a sibling WebContentsView in the same parent window
  // doesn't reliably trigger a `blur` on the popup webContents, so the
  // blur-driven dismiss path can't be relied on for the toggle case.
  ipcMain.on('comfy-window:dismiss-title-menu', (event) => {
    const found = findEntryByTitleBarSender(event.sender)
    if (!found) return
    const popup = titlePopupsByParent.get(found.entry.window.id)
    if (!popup) return
    hideTitlePopup(popup, { releaseFocusToParent: true })
  })

  // Newly-opened windows pick up live transitions automatically; initial
  // state for a fresh popup is pushed in `openTitlePopup`.
  downloadEvents.on('tray-state-changed', broadcastDownloadsToTitlePopups)
}
