import { ipcMain } from 'electron'
import type { BrowserWindow, WebContents } from 'electron'
import { TITLEBAR_HEIGHT } from '../lib/titleBarOverlay'
import { EmbeddedPopupView } from './embeddedPopupView'

/**
 * Hover tooltip popup attached as a transparent sibling WebContentsView
 * so title-bar tooltip text can escape the title-bar view's pixel clip.
 */

/** Initial dimensions before the renderer reports its measured size. */
const TOOLTIP_POPUP_INITIAL_WIDTH = 280
const TOOLTIP_POPUP_INITIAL_HEIGHT = 36
/** Gap (px) below the trigger; matches the 6px offset `useTooltip.ts` uses. */
const TOOLTIP_VERTICAL_GAP = 6
/** Gutter (px) reserved for the bubble's box-shadow so it isn't clipped. */
const TOOLTIP_POPUP_SHADOW_GUTTER = 16
/** Fallback show timeout (ms) if the rendered ack is slow. */
const TOOLTIP_RENDER_ACK_TIMEOUT_MS = 80

interface TitleTooltipConfig {
  text: string
  theme: { bg: string; text: string; border: string }
  /** Echoed back in `notifyRendered` so main can discard acks for stale configs. */
  configToken: string
}

let _titleTooltipTokenSeq = 0
function nextTitleTooltipToken(): string {
  _titleTooltipTokenSeq = (_titleTooltipTokenSeq + 1) >>> 0
  return `tt-${_titleTooltipTokenSeq}`
}

export interface TitleTooltipPopupEntry {
  view: EmbeddedPopupView
  /** Config queued before `ready` (first open only). */
  pendingConfig: TitleTooltipConfig | null
  /** Anchor for the last open; `leftX`/`rightX` bracket the trigger and main prefers
   *  anchoring the bubble's left edge to `leftX`, falling back to right-align on overflow. */
  pendingAnchor: { leftX: number; rightX: number; bottomY: number } | null
  /** JSON of the in-flight config awaiting ack; promoted to `lastSyncedConfigJson` on ack. */
  pendingConfigJson: string | null
  /** Token of the in-flight config; only acks with this token show the popup. */
  pendingConfigToken: string | null
  /** JSON of the last acked config; fast-path for a repeat open with the same text + theme. */
  lastSyncedConfigJson: string | null
}

const titleTooltipPopupsByParent = new Map<number, TitleTooltipPopupEntry>()
const titleTooltipPopupsByWebContents = new Map<number, TitleTooltipPopupEntry>()

/** Read-only accessor used by the title-menu popup to dismiss any
 *  active tooltip when a click opens a menu in the same area. */
export function getTitleTooltipForParent(parentId: number): TitleTooltipPopupEntry | undefined {
  return titleTooltipPopupsByParent.get(parentId)
}

/** Hardcoded mirror of the `--tooltip-*` tokens so the title-bar tooltip matches the
 *  in-renderer bubbles. Theme-agnostic until light brand parity ships. */
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
    // Belt-and-braces dismiss for cases the renderer can't observe (drag-region
    // drags, OS focus changes); the renderer already hides on pointerleave / blur.
    hideOnParentEvents: ['blur', 'will-move', 'move', 'resize'],
    onParentClosed: () => {
      titleTooltipPopupsByParent.delete(parent.id)
      titleTooltipPopupsByWebContents.delete(view.popupWebContentsId)
    },
    onDestroyed: () => {
      // Identity-check so we don't drop a fresher entry for the same parent id.
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

/** Position and size the tooltip view around its `pendingAnchor`, given the measured
 *  bubble size. Anchors the bubble's left edge to the trigger (extends rightward),
 *  falling back to right-align on overflow. The view is grown by the shadow gutter on
 *  each side (bubble centered inside) and clamped to the parent content bounds. */
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
  // Preferred: extend rightward from the trigger's left edge.
  let x = Math.round(anchor.leftX - TOOLTIP_POPUP_SHADOW_GUTTER)
  // On right-edge overflow, fall back to extending leftward from the right edge.
  if (x + viewWidth > parentBounds.width) {
    x = Math.round(anchor.rightX + TOOLTIP_POPUP_SHADOW_GUTTER - viewWidth)
  }
  let y = Math.round(anchor.bottomY + TOOLTIP_VERTICAL_GAP - TOOLTIP_POPUP_SHADOW_GUTTER / 2)
  // Final clamp for when neither alignment fits (bubble wider than the parent).
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

/** Show or update the title-bar hover tooltip popup (created on first call per parent). */
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

  // Build the body WITHOUT the token so the fast-path comparison is text+theme only
  // (tokens always differ and would defeat the identity check).
  const tooltipBody = { text: opts.text, theme: resolveTooltipTheme() }
  const configBodyJson = JSON.stringify(tooltipBody)

  // Fast path: same text + theme as the last acked config and nothing in flight
  // (else the renderer may be mid-paint with different text). Reposition + show cached.
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
    // Renderer not mounted yet (first show); the `ready` handler flushes this.
    entry.pendingConfig = config
  }
  entry.view.scheduleShowFallback(TOOLTIP_RENDER_ACK_TIMEOUT_MS, () => {
    // Show with current bounds if the ack times out.
    const bounds = entry.view.popup.getBounds()
    positionTooltipPopup(entry, {
      width: Math.max(0, bounds.width - TOOLTIP_POPUP_SHADOW_GUTTER * 2),
      height: Math.max(0, bounds.height - TOOLTIP_POPUP_SHADOW_GUTTER),
    })
    entry.view.showOnTop()
  })
}

/** Wire the title-tooltip popup IPC. Called once at app ready. */
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
      // Drop stale acks; a newer open may have superseded this config mid-paint.
      if (!ackToken || ackToken !== entry.pendingConfigToken) return
      const width = typeof payload?.width === 'number' && payload.width > 0 ? payload.width : 0
      const height = typeof payload?.height === 'number' && payload.height > 0 ? payload.height : 0
      if (entry.pendingAnchor) {
        positionTooltipPopup(entry, { width, height })
      }
      // Promote to synced so a repeat open with the same text + theme fast-paths.
      if (entry.pendingConfigJson) {
        entry.lastSyncedConfigJson = entry.pendingConfigJson
        entry.pendingConfigJson = null
        entry.pendingConfigToken = null
      }
      // No-op if the timer fallback already showed it; otherwise show now.
      if (entry.view.pendingShowTimer === null) return
      entry.view.showOnTop()
    },
  )

  // Title bar asks main to show a hover tooltip. Position is title-bar-local pixels
  // that map directly to parent content coords (the title-bar view sits at (0,0)).
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
      // Fall back to leftX when rightX is missing so the overflow branch stays left-anchored.
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
