import { ipcMain, shell, WebContentsView } from 'electron'
import type { BrowserWindow } from 'electron'
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
import { installationEvents } from '../installations'
import * as mainTelemetry from '../lib/telemetry'
import {
  comfyWindows,
  findEntryByTitleBarSender,
  isChooserHost,
  isInstallHost,
} from '../host/registry'
import type { ComfyPanelKey, ComfyWindowEntry } from '../host/registry'
import {
  getTitleTooltipForParent,
  hideTitleTooltipPopup,
} from './titleTooltip'
import { EmbeddedPopupView } from './embeddedPopupView'

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

type TitlePopupKind = 'menu' | 'downloads' | 'instance-picker'

/** Single install row pushed to the instance-picker popup. Mirrors the
 *  renderer-side `Installation` shape returned by the `get-installations`
 *  IPC handler (extra fields like `version`, `statusTag`, `sourceLabel`
 *  are already attached there). The popup is read-only on this payload
 *  and renders it through the shared `useInstallList` composable, so the
 *  shape MUST stay in sync with `Installation` in `src/types/ipc.ts`. */
export interface InstancePickerInstall {
  id: string
  name: string
  sourceLabel: string
  sourceCategory: string
  version?: string
  statusTag?: { style: string; label: string }
  lastLaunchedAt?: number
  installPath?: string
  status?: string
  [key: string]: unknown
}

/** Snapshot pushed to the instance-picker popup on open and on every
 *  install-registry change. `activeInstallationId` lets the popup pre-
 *  select the host window's currently-attached install; `runningInstallationIds`
 *  drives the row-side "running" indicator and the focus-vs-launch
 *  decision in the click handler. */
export interface InstancePickerSnapshot {
  installs: InstancePickerInstall[]
  activeInstallationId: string | null
  runningInstallationIds: string[]
}

interface BuildInstancePickerSnapshotArgs {
  installs: InstancePickerInstall[]
  hostInstallationId: string | null
  runningInstallationIds: string[]
}

/**
 * Pure helper — produces the snapshot pushed to the instance-picker
 * popup. Kept separate from the IPC wiring so the shape contract can be
 * unit-tested without spinning up Electron.
 */
export function buildInstancePickerSnapshot(
  args: BuildInstancePickerSnapshotArgs,
): InstancePickerSnapshot {
  return {
    installs: args.installs,
    activeInstallationId: args.hostInstallationId,
    runningInstallationIds: args.runningInstallationIds,
  }
}

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
  | {
    kind: 'instance-picker'
    snapshot: InstancePickerSnapshot
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
  view: EmbeddedPopupView
  /** Numeric `windowKey` of the parent host entry, updated on every
   *  open. `0` is a sentinel for "no popup has been opened yet" since
   *  `nextWindowKey` always returns positive numbers. */
  parentEntryId: number
  /** Updated on every open. */
  kind: TitlePopupKind
  /** Updated on every open. */
  titleBarSender: Electron.WebContents
  /** Config queued before the renderer signalled ready — flushed on
   *  ready. Overwritten if multiple opens happen before ready. */
  pendingConfig: TitlePopupConfig | null
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

/* ----------------------------------------------------------------
 * Instance-picker backdrop
 * ----------------------------------------------------------------
 * A separate transparent `WebContentsView` rendered behind the picker
 * popup that dims the host window body (not the title bar). It only
 * shows while a picker popup is open; click anywhere on the dim
 * dismisses the picker, ESC handled by the popup itself.
 *
 * Kept independent from the picker `WebContentsView` so we don't have
 * to fight Electron's child-view bounds/z-order plumbing — the dim
 * view sits below the popup view in the parent's contentView stack,
 * and the popup keeps its normal centered-card sizing.
 */
interface PickerBackdropEntry {
  view: WebContentsView
  visible: boolean
}
const pickerBackdropsByParent = new Map<number, PickerBackdropEntry>()
const pickerBackdropsByWebContents = new Map<number, number /* parentId */>()

/** Inline HTML loaded into the backdrop view. Fixed `position: fixed`
 *  scrim with the figma spec (`background: #211927; opacity: 0.7;`).
 *  A click anywhere fires the dismiss IPC; main routes it through to
 *  hide the picker popup. */
const PICKER_BACKDROP_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden;-webkit-user-select:none;user-select:none}
  .scrim{position:fixed;inset:0;width:100%;height:100%;background:#211927;opacity:0.7;cursor:default;animation:f 180ms ease-out}
  @keyframes f{from{opacity:0}to{opacity:.7}}
  @media (prefers-reduced-motion:reduce){.scrim{animation:none}}
</style></head><body>
<div class="scrim" id="s"></div>
<script>
  const { ipcRenderer } = require('electron');
  document.getElementById('s').addEventListener('mousedown', () => {
    ipcRenderer.send('comfy-picker-backdrop:dismiss');
  });
</script>
</body></html>`

function ensurePickerBackdrop(parent: BrowserWindow): PickerBackdropEntry {
  const existing = pickerBackdropsByParent.get(parent.id)
  if (existing && !existing.view.webContents.isDestroyed()) return existing
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false,
    },
  })
  view.setBackgroundColor('#00000000')
  view.setVisible(false)
  view.setBounds({ x: 0, y: 0, width: 1, height: 1 })
  parent.contentView.addChildView(view)
  void view.webContents.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(PICKER_BACKDROP_HTML)}`,
  ).catch(() => {})
  const entry: PickerBackdropEntry = { view, visible: false }
  pickerBackdropsByParent.set(parent.id, entry)
  pickerBackdropsByWebContents.set(view.webContents.id, parent.id)
  const onParentClosed = (): void => {
    try { parent.contentView.removeChildView(view) } catch { /* noop */ }
    if (!view.webContents.isDestroyed()) view.webContents.close()
    pickerBackdropsByParent.delete(parent.id)
    pickerBackdropsByWebContents.delete(view.webContents.id)
  }
  parent.once('closed', onParentClosed)
  return entry
}

function showPickerBackdrop(parent: BrowserWindow): void {
  const entry = ensurePickerBackdrop(parent)
  const cb = parent.getContentBounds()
  // Cover everything except the title bar (where the trigger pill lives).
  entry.view.setBounds({
    x: 0,
    y: TITLEBAR_HEIGHT,
    width: cb.width,
    height: Math.max(0, cb.height - TITLEBAR_HEIGHT),
  })
  // Re-stack: backdrop first (lower), then re-stack the popup so it
  // sits above the backdrop. The popup itself is re-stacked in
  // `view.showOnTop()` right after this, so we just bring the
  // backdrop to the front of the contentView here, then the popup's
  // own re-stack lands on top.
  try {
    parent.contentView.removeChildView(entry.view)
    parent.contentView.addChildView(entry.view)
  } catch { /* noop */ }
  entry.view.setVisible(true)
  entry.visible = true
}

function hidePickerBackdrop(parent: BrowserWindow): void {
  const entry = pickerBackdropsByParent.get(parent.id)
  if (!entry || !entry.visible) return
  if (!entry.view.webContents.isDestroyed()) entry.view.setVisible(false)
  entry.visible = false
}

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
  if (isChooserHost(entry)) {
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
  if (isInstallHost(entry)) {
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
    notifyTitlePopupDownloads(entry.view.popup)
  }
}

/** Push an updated instance-picker snapshot to every popup whose
 *  current kind is `'instance-picker'`. Triggered by the
 *  `installationEvents.on('changed')` subscription wired in
 *  `registerTitlePopupIpc`, so installs that get added / removed /
 *  renamed / launched while the picker is open repaint live. */
async function broadcastInstancePickerSnapshotToTitlePopups(
  bindings: TitlePopupHostBindings,
): Promise<void> {
  const hasActivePicker = Array.from(titlePopupsByParent.values()).some(
    (entry) => entry.kind === 'instance-picker' && entry.view.isOpen,
  )
  if (!hasActivePicker) return
  // Resolve the install list once and reuse for every open picker —
  // typically there is only one, but reading the disk-backed list per
  // entry would waste IO on the rare multi-window case.
  const installs = await bindings.getInstancePickerInstalls()
  const runningInstallationIds = bindings.getRunningInstallationIds()
  for (const entry of titlePopupsByParent.values()) {
    if (entry.kind !== 'instance-picker' || !entry.view.isOpen) continue
    if (entry.view.popup.webContents.isDestroyed()) continue
    const parentEntry = comfyWindows.get(entry.parentEntryId)
    const snapshot = buildInstancePickerSnapshot({
      installs,
      hostInstallationId: parentEntry?.installationId ?? null,
      runningInstallationIds,
    })
    entry.view.popup.webContents.send('comfy-titlepopup:installs-changed', snapshot)
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
  if (existing && !existing.view.isDestroyed()) return existing

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
  const view = new EmbeddedPopupView({
    parent,
    htmlName: 'comfyTitlePopup',
    preloadName: 'comfyTitlePopupPreload.js',
    initialBounds: { x: 0, y: 0, width: POPUP_WIDTH, height: 100 },
    hideOnParentEvents: ['blur', 'will-move', 'move'],
    hideOnPopupBlur: true,
    onParentClosed: () => {
      titlePopupsByParent.delete(parent.id)
      titlePopupsByWebContents.delete(view.popupWebContentsId)
    },
    onDestroyed: () => {
      // Identity-check so we don't drop a fresher entry that may have
      // been registered against the same parent id between the popup
      // crash and this teardown firing.
      const cur = titlePopupsByParent.get(parent.id)
      if (cur && cur.view === view) {
        titlePopupsByParent.delete(parent.id)
      }
      titlePopupsByWebContents.delete(view.popupWebContentsId)
    },
    onHide: () => {
      // Always fires when the popup transitions out of open/pending —
      // including the blur / will-move / move / popup-blur auto-dismiss
      // paths. Without this notify, the title-bar renderer's
      // `isMenuOpen` flag stays stuck true and every subsequent click
      // on the trigger button is suppressed by the reopen guard.
      if (!entry.titleBarSender.isDestroyed()) {
        entry.titleBarSender.send('comfy-titlebar:menu-closed', { menu: entry.kind })
      }
      // Hide the picker backdrop on every dismiss path so the dim
      // never outlives the popup. Cheap no-op for non-picker kinds.
      if (entry.kind === 'instance-picker' && !view.parentWindow.isDestroyed()) {
        hidePickerBackdrop(view.parentWindow)
      }
    },
  })
  const entry: TitlePopupEntry = {
    view,
    parentEntryId: 0,
    kind: 'menu',
    titleBarSender: view.popup.webContents, // overwritten on first open
    pendingConfig: null,
    lastConfigJson: null,
    lastSyncedConfigJson: null,
  }
  titlePopupsByParent.set(view.parentWindowId, entry)
  titlePopupsByWebContents.set(view.popupWebContentsId, entry)
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
  const wasActive = entry.view.isOpen || entry.view.pendingShowTimer !== null
  // The view's `onHide` callback fires the `comfy-titlebar:menu-closed`
  // IPC, so dismissals via this wrapper and via the auto-dismiss
  // listeners both clear the title-bar's reopen-suppression guard.
  entry.view.hide()
  if (!wasActive) return
  if (
    opts.releaseFocusToParent
    && !entry.view.popup.webContents.isDestroyed()
    && !entry.view.parentWindow.isDestroyed()
  ) {
    // Embedded WebContentsView: `BrowserWindow.focus()` raises the host
    // window but doesn't deterministically land keyboard focus in any
    // child view. Push focus into the title bar (the button that
    // opened the popup) so subsequent keystrokes go somewhere
    // sensible. Falls back to a plain window focus if the title-bar
    // sender is no longer alive.
    if (!entry.titleBarSender.isDestroyed()) {
      entry.titleBarSender.focus()
    } else {
      entry.view.parentWindow.focus()
    }
  }
}

/** Make the popup view visible, focus it, and mark `isOpen`. Called
 *  when the renderer acks `comfy-titlepopup:rendered` — at that point
 *  the new config has been painted and showing is safe. */
function showTitlePopupNow(entry: TitlePopupEntry): void {
  if (entry.view.popup.webContents.isDestroyed()) return
  // Bring the picker backdrop up first so it sits BELOW the popup in
  // the parent's child-view stack — the popup's own re-stack inside
  // `showOnTop` lands on top.
  if (entry.kind === 'instance-picker' && !entry.view.parentWindow.isDestroyed()) {
    showPickerBackdrop(entry.view.parentWindow)
  }
  entry.view.showOnTop({ focus: true })
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
const DOWNLOADS_POPUP_WIDTH = 664
const DOWNLOADS_POPUP_MAX_HEIGHT_PX = 396
const DOWNLOADS_POPUP_MAX_HEIGHT_RATIO = 0.6

/** Instance-picker popup sizing — wider than downloads to fit the
 *  two-pane (recents list + selected-detail) layout from the Figma.
 *  Renderer measures + asks for natural height via `requestSize`, same
 *  pattern as downloads, clamped by the same window-ratio safety net. */
const INSTANCE_PICKER_POPUP_WIDTH = 720
const INSTANCE_PICKER_POPUP_MAX_HEIGHT_PX = 480
const INSTANCE_PICKER_POPUP_MAX_HEIGHT_RATIO = 0.7

/** Right-edge gutter when the popup gets shifted away from its
 *  anchor to fit inside the host window. Keeps a small breathing
 *  space between the card and the window edge so the rounded corner
 *  doesn't visually collide with the window chrome. */
const POPUP_EDGE_GUTTER = 8

/** Shift `x` left until `x + width` fits inside the host window's
 *  content area, leaving an 8px gutter. The renderer anchors at the
 *  trigger button's left edge — works for left-side triggers, but
 *  the downloads tray sits at the right edge of the title bar and
 *  would otherwise spill past the window. Clamps to 0 so popups
 *  wider than the window collapse against the left edge instead of
 *  rendering at negative x. */
function clampPopupX(x: number, width: number, parent: BrowserWindow): number {
  const contentWidth = parent.getContentBounds().width
  const maxX = Math.max(0, contentWidth - width - POPUP_EDGE_GUTTER)
  return Math.min(x, maxX)
}

type OpenTitlePopupOpts = {
  parent: BrowserWindow
  parentEntryId: number
  anchor: { x: number; y: number }
  theme: { bg: string; text: string }
  titleBarSender: Electron.WebContents
} & (
    | { kind: 'menu'; items: TitlePopupMenuItem[] }
    | { kind: 'downloads' }
    | { kind: 'instance-picker'; snapshot: InstancePickerSnapshot }
  )

function openTitlePopup(opts: OpenTitlePopupOpts): void {
  // Dismiss any in-flight title-bar tooltip — the popup will obscure
  // the same area, and the renderer's pointer-leave on the trigger
  // button (which would otherwise hide the tooltip) doesn't fire when
  // a click moves focus straight into the popup.
  hideTitleTooltipPopup(getTitleTooltipForParent(opts.parent.id))
  const entry = ensureTitlePopup(opts.parent)
  if (entry.view.popup.webContents.isDestroyed()) return

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
  const rawX = Math.round(Math.max(0, opts.anchor.x))
  const y = Math.round(Math.max(0, opts.anchor.y))

  let width: number
  let height: number
  if (opts.kind === 'menu') {
    width = POPUP_WIDTH
    height = computePopupHeight(opts.items)
  } else if (opts.kind === 'downloads') {
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
  } else {
    // instance-picker — fixed-width card sized to fit the two-pane
    // layout. Open at the ceiling cap (same downloads-style
    // renderer-driven sizing — picker measures and asks for its
    // natural height via `requestSize`, main clamps back into the
    // band).
    width = INSTANCE_PICKER_POPUP_WIDTH
    const contentHeight = opts.parent.getContentBounds().height
    height = Math.min(
      INSTANCE_PICKER_POPUP_MAX_HEIGHT_PX,
      Math.round(contentHeight * INSTANCE_PICKER_POPUP_MAX_HEIGHT_RATIO),
    )
  }

  // Horizontal position: most kinds anchor at the trigger button and
  // shift-left to fit the window. The instance picker centres on the
  // host window because its trigger (the centre pill) is optically
  // centred — anchoring at the pill's left edge would make the wide
  // card hang off to the right.
  let x: number
  if (opts.kind === 'instance-picker') {
    const contentWidth = opts.parent.getContentBounds().width
    x = Math.max(0, Math.round((contentWidth - width) / 2))
  } else {
    // Other kinds: shift left until the popup fits, with an 8px gutter
    // from the edge. Vertical clamping is unnecessary because `y` is
    // always under the title bar and the height stays inside the
    // window.
    x = clampPopupX(rawX, width, opts.parent)
  }

  // Update bounds while still hidden — the popup is flipped visible
  // only after the renderer acks the new content has painted, by
  // `showTitlePopupNow` → `view.showOnTop()` (which also re-stacks the
  // popup as the most recent child view so it paints above
  // `titleBarView` / `comfyView` / `panelView`). Re-stacking here too
  // would race with the renderer's `request-size` resize: re-attaching
  // the WebContentsView appears to reset bounds back to whatever was
  // last set before the attach, undoing the natural-height resize and
  // leaving the downloads popup stuck at the ceiling height.
  entry.view.popup.setBounds({ x, y, width, height })

  // Downloads popup feeds on a separate channel — push the latest
  // snapshot now so the first paint shows current state instead of
  // the empty-state placeholder. Subsequent updates arrive via the
  // tray-state-changed broadcast.
  if (opts.kind === 'downloads' && entry.view.rendererReady) {
    notifyTitlePopupDownloads(entry.view.popup)
  }

  // Push the new config and *wait* for the renderer to ack that the
  // new content has painted before flipping the view visible. Without
  // this the user sees a frame of the previous open's content while
  // Vue is still processing the config update.
  entry.view.cancelPendingShow()
  const config: TitlePopupConfig =
    opts.kind === 'menu'
      ? { kind: 'menu', items: opts.items, theme: opts.theme }
      : opts.kind === 'downloads'
        ? { kind: 'downloads', theme: opts.theme }
        : { kind: 'instance-picker', snapshot: opts.snapshot, theme: opts.theme }
  const configJson = JSON.stringify(config)

  // Fast path: the renderer's DOM already matches the config we want
  // to show (e.g. repeat open of the same menu with no item / theme
  // changes). Skip the set-config IPC + render-ack roundtrip and show
  // immediately — eliminates ~1 frame + 2 IPC hops of perceived
  // open latency on the common case.
  if (
    entry.lastSyncedConfigJson === configJson
    && !entry.view.popup.webContents.isDestroyed()
  ) {
    showTitlePopupNow(entry)
    return
  }

  entry.lastConfigJson = configJson
  if (entry.view.rendererReady && !entry.view.popup.webContents.isDestroyed()) {
    entry.view.popup.webContents.send('comfy-titlepopup:set-config', config)
  } else {
    // Renderer hasn't mounted yet on the very first open. Queue the
    // config; the `ready` IPC handler flushes it.
    entry.pendingConfig = config
  }
  entry.view.scheduleShowFallback(POPUP_RENDER_ACK_TIMEOUT_MS, () => {
    showTitlePopupNow(entry)
  })
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
  /** Build the same enriched installation list `get-installations`
   *  returns to renderer-side `installationStore`. Powers the instance-
   *  picker popup's list + detail pane. Async because the underlying
   *  `installations.list()` reads from disk. */
  getInstancePickerInstalls: () => Promise<InstancePickerInstall[]>
  /** Currently-running installation ids. Drives the picker's "running"
   *  row indicator and the focus-vs-launch decision in `pickInstall`. */
  getRunningInstallationIds: () => string[]
  /** Picker chose an install. The "from a Comfy window pick" contract:
   *  if the install is already running, focus its window; otherwise
   *  open a new Comfy window for it. NEVER swap the active install out
   *  of the host that opened the picker (that's the chooser-host path,
   *  not this one).
   *
   *  `parentEntryId` carries the picker's parent host so launches that
   *  need to route through a panel renderer land on the picker's own
   *  parent (not just any open Comfy window). Important when multiple
   *  Comfy windows are open. */
  pickInstallFromPicker: (
    installationId: string,
    parentEntryId: number,
  ) => Promise<void> | void
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
    if (parentEntry && isChooserHost(parentEntry)) {
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
    entry.view.rendererReady = true
    if (entry.pendingConfig && !entry.view.popup.webContents.isDestroyed()) {
      const flushed = entry.pendingConfig
      entry.lastConfigJson = JSON.stringify(flushed)
      entry.view.popup.webContents.send('comfy-titlepopup:set-config', flushed)
      entry.pendingConfig = null
      if (flushed.kind === 'downloads') {
        notifyTitlePopupDownloads(entry.view.popup)
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
    if (entry.view.pendingShowTimer === null) return
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

  // Click on the picker backdrop — dismiss the matching parent's
  // picker popup. The backdrop is keyed by the parent windowId so we
  // can route from any backdrop instance back to its popup.
  ipcMain.on('comfy-picker-backdrop:dismiss', (event) => {
    const parentId = pickerBackdropsByWebContents.get(event.sender.id)
    if (parentId === undefined) return
    const popup = titlePopupsByParent.get(parentId)
    if (!popup || popup.kind !== 'instance-picker') return
    hideTitlePopup(popup, { releaseFocusToParent: true })
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
      if (entry.kind !== 'downloads' && entry.kind !== 'instance-picker') return
      const requested = payload?.height
      if (typeof requested !== 'number' || !Number.isFinite(requested)) return
      const parent = comfyWindows.get(entry.parentEntryId)?.window
      if (!parent || parent.isDestroyed()) return
      const contentHeight = parent.getContentBounds().height
      const ceiling = entry.kind === 'downloads'
        ? Math.min(
            DOWNLOADS_POPUP_MAX_HEIGHT_PX,
            Math.round(contentHeight * DOWNLOADS_POPUP_MAX_HEIGHT_RATIO),
          )
        : Math.min(
            INSTANCE_PICKER_POPUP_MAX_HEIGHT_PX,
            Math.round(contentHeight * INSTANCE_PICKER_POPUP_MAX_HEIGHT_RATIO),
          )
      const next = Math.max(1, Math.min(ceiling, Math.ceil(requested)))
      const cur = entry.view.popup.getBounds()
      if (cur.height === next) return
      entry.view.popup.setBounds({ x: cur.x, y: cur.y, width: cur.width, height: next })
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

  // Title-bar centre-pill click. Opens the instance-picker popup
  // anchored under the pill. Skipped on install-less hosts — the
  // chooser-host pill is non-interactive (the chooser body already IS
  // the picker, so a smaller copy of itself would be redundant).
  ipcMain.on(
    'comfy-window:click-install-pill',
    async (event, payload: { anchor?: { x?: number; y?: number } } | undefined) => {
      const found = findEntryByTitleBarSender(event.sender)
      if (!found) return
      const { id: windowKey, entry } = found
      if (entry.window.isDestroyed()) return
      if (!isInstallHost(entry)) return
      const x = Math.max(0, Math.round(payload?.anchor?.x ?? 0))
      const y = Math.max(0, Math.round(payload?.anchor?.y ?? TITLEBAR_HEIGHT))
      const installs = await bindings.getInstancePickerInstalls()
      const runningInstallationIds = bindings.getRunningInstallationIds()
      const snapshot = buildInstancePickerSnapshot({
        installs,
        hostInstallationId: entry.installationId,
        runningInstallationIds,
      })
      openTitlePopup({
        parent: entry.window,
        parentEntryId: windowKey,
        kind: 'instance-picker',
        snapshot,
        anchor: { x, y },
        theme: entry.lastTheme,
        titleBarSender: entry.titleBarView.webContents,
      })
    },
  )

  // Picker → pick install. Focus-or-launch contract (see
  // `pickInstallFromPicker` doc): never swaps the active install out of
  // the host that opened the picker. Popup is dismissed before the
  // launch fires so the new window comes up unobstructed.
  //
  // `parentEntryId` lets main route the launch through the picker's
  // own parent host (not just any open Comfy window) so launches
  // initiated from window A don't accidentally route through window B.
  ipcMain.on(
    'comfy-titlepopup:pick-install',
    (event, payload: { installationId?: unknown }) => {
      const entry = titlePopupsByWebContents.get(event.sender.id)
      if (!entry) return
      const installationId = payload?.installationId
      if (typeof installationId !== 'string' || installationId.length === 0) return
      hideTitlePopup(entry, { releaseFocusToParent: false })
      void bindings.pickInstallFromPicker(installationId, entry.parentEntryId)
    },
  )

  // Picker → "+ New Install" row. Forwards to the host's panel
  // renderer via the same panel-trigger the file menu's New Install
  // entry uses on a chooser host. On an install-backed host, the
  // panel renderer is responsible for routing this to a fresh chooser
  // window — same UX as `new-window` then New Install.
  ipcMain.on('comfy-titlepopup:open-new-install', (event) => {
    const entry = titlePopupsByWebContents.get(event.sender.id)
    if (!entry) return
    const parentEntry = comfyWindows.get(entry.parentEntryId)
    if (!parentEntry) return
    hideTitlePopup(entry, { releaseFocusToParent: false })
    // Install-creation flows live on chooser hosts; on an install-
    // backed host (where the picker actually lives), open a fresh
    // chooser-host window for it instead. `openChooserHostWindow` is
    // the same path the file-menu New Window entry uses.
    if (isChooserHost(parentEntry)) {
      bindings.setActivePanel(entry.parentEntryId, 'new-install')
    } else {
      bindings.openChooserHostWindow()
    }
  })


  // Newly-opened windows pick up live transitions automatically; initial
  // state for a fresh popup is pushed in `openTitlePopup`.
  downloadEvents.on('tray-state-changed', broadcastDownloadsToTitlePopups)
  installationEvents.on('changed', () => {
    void broadcastInstancePickerSnapshotToTitlePopups(bindings)
  })
}

/**
 * Test-only: return the bounds + kind of the first currently-open
 * title-bar dropdown popup, or `null` when no popup is visible. The
 * downloads-shelf E2E tests use this to assert the popup sized
 * itself to its content (the regression that motivated the
 * `scrollHeight === clientHeight` fix). Only called from
 * `e2eHooks.ts` which is itself only loaded when
 * `process.env['E2E'] === '1'`.
 */
export function _test_getOpenTitlePopupBounds(): { kind: TitlePopupKind; bounds: Electron.Rectangle } | null {
  for (const entry of titlePopupsByParent.values()) {
    if (!entry.view.isOpen) continue
    if (entry.view.popup.webContents.isDestroyed()) continue
    return { kind: entry.kind, bounds: entry.view.popup.getBounds() }
  }
  return null
}
