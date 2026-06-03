import { ipcMain } from 'electron'
import type { BrowserWindow, WebContents } from 'electron'
import { TITLEBAR_HEIGHT } from '../lib/titleBarOverlay'
import { EmbeddedPopupView } from './embeddedPopupView'

/**
 * Hover tooltip popup attached as a transparent sibling WebContentsView
 * so title-bar tooltip text can escape the title-bar view's pixel clip.
 */

/** Initial popup dimensions before the renderer reports its measured
 *  size. Generous enough to hold the longest expected tooltip text
 *  (~"Desktop Update Ready (v123.456.789)") plus the bubble's
 *  border + box-shadow gutter; the actual size is overwritten by the
 *  render-ack on every show. */
const TOOLTIP_POPUP_INITIAL_WIDTH = 280
const TOOLTIP_POPUP_INITIAL_HEIGHT = 36
/** Vertical gap (px) between the trigger's bottom edge and the popup's
 *  top edge. Matches the 6px offset `useTooltip.ts` applies to the
 *  panel-side `InfoTooltip` bubble so the title-bar tooltip lines up
 *  visually with the rest of the app. */
const TOOLTIP_VERTICAL_GAP = 6
/** Side gutter (px) reserved for the bubble's box-shadow so it doesn't
 *  get clipped against the popup view's bounds. The bubble is centered
 *  inside the view and `box-shadow: 0 4px 12px` extends ~12px past its
 *  visible edge. */
const TOOLTIP_POPUP_SHADOW_GUTTER = 16
/** Fallback render-ack timeout (ms). If the renderer's
 *  `comfy-titletooltip:rendered` ack doesn't arrive within this window
 *  after `set-config`, show the popup at its last known size anyway so
 *  the tooltip never gets permanently stuck invisible. */
const TOOLTIP_RENDER_ACK_TIMEOUT_MS = 80

interface TitleTooltipConfig {
  text: string
  theme: { bg: string; text: string; border: string }
  /** Round-trip token. Echoed by the renderer in `notifyRendered` so
   *  main can discard render-acks for stale configs (e.g. when a
   *  rapid pointer move queued a new set-config before the previous
   *  one was painted). */
  configToken: string
}

let _titleTooltipTokenSeq = 0
function nextTitleTooltipToken(): string {
  _titleTooltipTokenSeq = (_titleTooltipTokenSeq + 1) >>> 0
  return `tt-${_titleTooltipTokenSeq}`
}

export interface TitleTooltipPopupEntry {
  view: EmbeddedPopupView
  /** Config queued before `ready` (only the very first open). */
  pendingConfig: TitleTooltipConfig | null
  /** Last anchor used for an `openTitleTooltipPopup` call — main keeps
   *  the popup positioned around this anchor when it learns the
   *  renderer's measured size in the render-ack. `leftX` / `rightX`
   *  bracket the trigger; main prefers to anchor the bubble's left
   *  edge to `leftX` (extending rightward) and falls back to right-
   *  aligning to `rightX` when growing rightward would overflow. */
  pendingAnchor: { leftX: number; rightX: number; bottomY: number } | null
  /** JSON of the config most recently pushed to the renderer (and
   *  awaiting render-ack). Promoted to `lastSyncedConfigJson` once the
   *  ack arrives. */
  pendingConfigJson: string | null
  /** Token of the in-flight config (matches `pendingConfigJson`).
   *  Only render-acks carrying this exact token cause the popup to
   *  show; stale acks for previously-superseded configs are dropped. */
  pendingConfigToken: string | null
  /** JSON of the most recently *acked* config. Used as a fast-path:
   *  if the next open carries the same config (same text + theme),
   *  we skip the IPC + render-ack roundtrip and reposition + show
   *  immediately. */
  lastSyncedConfigJson: string | null
}

const titleTooltipPopupsByParent = new Map<number, TitleTooltipPopupEntry>()
const titleTooltipPopupsByWebContents = new Map<number, TitleTooltipPopupEntry>()

/** Read-only accessor used by the title-menu popup to dismiss any
 *  active tooltip when a click opens a menu in the same area. */
export function getTitleTooltipForParent(parentId: number): TitleTooltipPopupEntry | undefined {
  return titleTooltipPopupsByParent.get(parentId)
}

/** Resolve the tooltip palette. Hardcoded mirror of the `--tooltip-*`
 *  primitive tokens (`main.css`) — `--tooltip-bg` / `--tooltip-fg` /
 *  `--tooltip-border` — so the title-bar tooltip looks identical to the
 *  in-renderer `Tooltip` / `InfoTooltip` bubbles. The renderer tokens
 *  carry the same value in both themes until light brand parity ships,
 *  so this is theme-agnostic to match. */
function resolveTooltipTheme(): { bg: string; text: string; border: string } {
  return { bg: '#211927', text: '#ffffff', border: '#38303d' }
}

/** Create (or reuse) a title-tooltip popup view for *parent*. */
function ensureTitleTooltipPopup(parent: BrowserWindow): TitleTooltipPopupEntry {
  const existing = titleTooltipPopupsByParent.get(parent.id)
  if (existing && !existing.view.isDestroyed()) return existing

  const view = new EmbeddedPopupView({
    parent,
    htmlName: 'comfyTitleTooltip',
    preloadName: 'comfyTitleTooltipPreload.js',
    initialBounds: {
      x: 0,
      y: 0,
      width: TOOLTIP_POPUP_INITIAL_WIDTH,
      height: TOOLTIP_POPUP_INITIAL_HEIGHT,
    },
    // Belt-and-braces dismiss for cases the title-bar renderer can't
    // observe (drag-region drags, OS-level focus changes). The renderer
    // already fires `hideTooltip()` from its own pointerleave / blur
    // paths.
    hideOnParentEvents: ['blur', 'will-move', 'move', 'resize'],
    onParentClosed: () => {
      titleTooltipPopupsByParent.delete(parent.id)
      titleTooltipPopupsByWebContents.delete(view.popupWebContentsId)
    },
    onDestroyed: () => {
      // Identity-check so we don't drop a fresher entry that may have
      // been registered against the same parent id between the popup
      // crash and this teardown firing.
      const cur = titleTooltipPopupsByParent.get(parent.id)
      if (cur && cur.view === view) {
        titleTooltipPopupsByParent.delete(parent.id)
      }
      titleTooltipPopupsByWebContents.delete(view.popupWebContentsId)
    },
  })
  const entry: TitleTooltipPopupEntry = {
    view,
    pendingConfig: null,
    pendingAnchor: null,
    pendingConfigJson: null,
    pendingConfigToken: null,
    lastSyncedConfigJson: null,
  }
  titleTooltipPopupsByParent.set(view.parentWindowId, entry)
  titleTooltipPopupsByWebContents.set(view.popupWebContentsId, entry)
  return entry
}

/** Position and size the tooltip popup view around its `pendingAnchor`,
 *  given the renderer's measured bubble dimensions. The bubble's left
 *  edge is anchored to the trigger's left edge by default, so the
 *  bubble extends rightward from the button (matches native macOS
 *  tooltip behaviour for icon buttons in the leading edge of a chrome
 *  bar — the longer the label, the more it grows toward the right).
 *  When that would overflow the parent's right edge we fall back to
 *  right-aligning the bubble's right edge to the trigger's right edge.
 *  The view is grown by `TOOLTIP_POPUP_SHADOW_GUTTER` on each side so
 *  the bubble's box-shadow has room to render without being clipped;
 *  the bubble itself is centered inside that view by the renderer's
 *  CSS, so anchoring the view at `leftX - SHADOW_GUTTER` puts the
 *  bubble's visible left edge at `leftX`. The result is clamped to
 *  the parent window's content bounds so the view never extends
 *  off-screen. */
function positionTooltipPopup(
  entry: TitleTooltipPopupEntry,
  bubbleSize: { width: number; height: number },
): void {
  const anchor = entry.pendingAnchor
  if (!anchor) return
  if (entry.view.isDestroyed()) return

  const viewWidth = Math.max(
    bubbleSize.width + TOOLTIP_POPUP_SHADOW_GUTTER * 2,
    TOOLTIP_POPUP_SHADOW_GUTTER * 2 + 1,
  )
  const viewHeight = Math.max(
    bubbleSize.height + TOOLTIP_POPUP_SHADOW_GUTTER,
    TOOLTIP_POPUP_SHADOW_GUTTER + 1,
  )

  const parentBounds = entry.view.parentWindow.getContentBounds()
  // Preferred: bubble.left == anchor.leftX → extends rightward.
  let x = Math.round(anchor.leftX - TOOLTIP_POPUP_SHADOW_GUTTER)
  // Right-edge overflow → fall back to bubble.right == anchor.rightX
  // so the bubble extends leftward from the trigger instead.
  if (x + viewWidth > parentBounds.width) {
    x = Math.round(anchor.rightX + TOOLTIP_POPUP_SHADOW_GUTTER - viewWidth)
  }
  let y = Math.round(anchor.bottomY + TOOLTIP_VERTICAL_GAP - TOOLTIP_POPUP_SHADOW_GUTTER / 2)
  // Final clamp — covers the corner case where neither alignment fits
  // (bubble wider than the entire parent content area). Vertical
  // overflow is unrealistic for a title-bar tooltip but clamped anyway
  // as a guard.
  if (x < 0) x = 0
  if (x + viewWidth > parentBounds.width) x = Math.max(0, parentBounds.width - viewWidth)
  if (y < 0) y = 0
  if (y + viewHeight > parentBounds.height) y = Math.max(0, parentBounds.height - viewHeight)

  entry.view.popup.setBounds({ x, y, width: viewWidth, height: viewHeight })
}

/** Hide the popup view. Safe to call when not currently visible. */
export function hideTitleTooltipPopup(entry: TitleTooltipPopupEntry | undefined): void {
  if (!entry) return
  entry.view.hide()
}

/** Show or update the title-bar hover tooltip popup. Constructs the
 *  popup view on first call per parent window; reuses it thereafter. */
export function openTitleTooltipPopup(opts: {
  parent: BrowserWindow
  text: string
  leftX: number
  rightX: number
  bottomY: number
}): void {
  const entry = ensureTitleTooltipPopup(opts.parent)
  if (entry.view.isDestroyed()) return

  entry.pendingAnchor = { leftX: opts.leftX, rightX: opts.rightX, bottomY: opts.bottomY }

  // Build the config WITHOUT the configToken first, so the JSON we
  // compare against the last-synced config is text+theme only —
  // tokens always differ between sends and would defeat the fast
  // path's identity check.
  const tooltipBody = { text: opts.text, theme: resolveTooltipTheme() }
  const configBodyJson = JSON.stringify(tooltipBody)

  // Fast path: same text + theme as the last *acked* config AND no
  // unsynced config in flight (the renderer's DOM might still be
  // mid-paint with a different config otherwise — showing now would
  // flash the wrong text). Skip the IPC + render-ack roundtrip and
  // reposition + show with the cached bubble size.
  if (entry.lastSyncedConfigJson === configBodyJson && entry.pendingConfigJson === null) {
    const bounds = entry.view.popup.getBounds()
    positionTooltipPopup(entry, {
      width: Math.max(0, bounds.width - TOOLTIP_POPUP_SHADOW_GUTTER * 2),
      height: Math.max(0, bounds.height - TOOLTIP_POPUP_SHADOW_GUTTER),
    })
    entry.view.showOnTop()
    return
  }

  const token = nextTitleTooltipToken()
  const config: TitleTooltipConfig = { ...tooltipBody, configToken: token }
  entry.pendingConfigJson = configBodyJson
  entry.pendingConfigToken = token
  if (entry.view.rendererReady) {
    entry.view.popup.webContents.send('comfy-titletooltip:set-config', config)
  } else {
    // Renderer hasn't mounted yet on the very first show. Queue the
    // config; the `ready` IPC handler flushes it.
    entry.pendingConfig = config
  }
  entry.view.scheduleShowFallback(TOOLTIP_RENDER_ACK_TIMEOUT_MS, () => {
    // Render-ack timed out — show with the current bounds anyway so
    // the tooltip never gets permanently stuck invisible.
    const bounds = entry.view.popup.getBounds()
    positionTooltipPopup(entry, {
      width: Math.max(0, bounds.width - TOOLTIP_POPUP_SHADOW_GUTTER * 2),
      height: Math.max(0, bounds.height - TOOLTIP_POPUP_SHADOW_GUTTER),
    })
    entry.view.showOnTop()
  })
}

/** Wire the IPC handlers that drive the title-tooltip popup. Called
 *  once at app `whenReady`. The `findParentByTitleBarSender` callback
 *  resolves a title-bar webContents back to its host BrowserWindow so
 *  the show / hide handlers can locate the right popup. */
export function registerTitleTooltipIpc(opts: {
  findParentByTitleBarSender: (wc: WebContents) => BrowserWindow | null
}): void {
  ipcMain.on('comfy-titletooltip:ready', (event) => {
    const entry = titleTooltipPopupsByWebContents.get(event.sender.id)
    if (!entry) return
    entry.view.rendererReady = true
    if (entry.pendingConfig) {
      entry.view.popup.webContents.send('comfy-titletooltip:set-config', entry.pendingConfig)
      entry.pendingConfig = null
    }
  })

  ipcMain.on(
    'comfy-titletooltip:rendered',
    (event, payload: { width?: unknown; height?: unknown; configToken?: unknown }) => {
      const entry = titleTooltipPopupsByWebContents.get(event.sender.id)
      if (!entry) return
      const ackToken = typeof payload?.configToken === 'string' ? payload.configToken : ''
      // Drop stale acks. A new openTitleTooltipPopup may have superseded
      // this config while the renderer was painting it; showing now would
      // flash the previous text at the new anchor.
      if (!ackToken || ackToken !== entry.pendingConfigToken) return
      const width = typeof payload?.width === 'number' && payload.width > 0 ? payload.width : 0
      const height = typeof payload?.height === 'number' && payload.height > 0 ? payload.height : 0
      if (entry.pendingAnchor) {
        positionTooltipPopup(entry, { width, height })
      }
      // Promote the pending config to "synced" so the next open with the
      // same text + theme can take the fast path.
      if (entry.pendingConfigJson) {
        entry.lastSyncedConfigJson = entry.pendingConfigJson
        entry.pendingConfigJson = null
        entry.pendingConfigToken = null
      }
      // If the timer fallback already showed the popup, no-op; otherwise
      // show it now that the new content has painted at the correct size.
      if (entry.view.pendingShowTimer === null) return
      entry.view.showOnTop()
    },
  )

  /** Title bar asks main to show a hover tooltip. Forwarded to the
   *  cached tooltip popup for the host window. Position is in title-bar-
   *  local pixels (`leftX` / `rightX` bracket the trigger's horizontal
   *  edges, `bottomY` = trigger bottom); the title-bar view sits at
   *  content (0,0) so these map directly to parent-window content
   *  coordinates. */
  ipcMain.on(
    'comfy-window:show-titlebar-tooltip',
    (
      event,
      payload: {
        text?: unknown
        leftX?: unknown
        rightX?: unknown
        bottomY?: unknown
      },
    ) => {
      const parent = opts.findParentByTitleBarSender(event.sender)
      if (!parent || parent.isDestroyed()) return
      const text = typeof payload?.text === 'string' ? payload.text : ''
      if (!text) return
      const leftX = typeof payload?.leftX === 'number' ? payload.leftX : 0
      // Fall back to leftX when rightX is missing — keeps the
      // preferred-rightward path well-defined; the right-overflow
      // branch then degenerates into "stay left-anchored".
      const rightX = typeof payload?.rightX === 'number' ? payload.rightX : leftX
      const bottomY = typeof payload?.bottomY === 'number' ? payload.bottomY : TITLEBAR_HEIGHT
      openTitleTooltipPopup({
        parent,
        text,
        leftX: Math.round(leftX),
        rightX: Math.round(rightX),
        bottomY: Math.round(bottomY),
      })
    },
  )

  ipcMain.on('comfy-window:hide-titlebar-tooltip', (event) => {
    const parent = opts.findParentByTitleBarSender(event.sender)
    if (!parent) return
    hideTitleTooltipPopup(titleTooltipPopupsByParent.get(parent.id))
  })
}
