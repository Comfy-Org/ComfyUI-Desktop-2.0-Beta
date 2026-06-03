import { ipcMain } from 'electron'
import type { BrowserWindow, WebContents } from 'electron'
import { TITLEBAR_HEIGHT } from '../lib/titleBarOverlay'
import { EmbeddedPopupView } from './embeddedPopupView'

/**
 * First-instance onboarding coachmark popup (issue #701). A sticky card
 * with an upward beak pointing at the centre title-bar pill.
 *
 * Reuses the `comfyTitleTooltip` popup renderer (same clip-escaping
 * `WebContentsView` and render-ack protocol — issue #514); the
 * `variant: 'coachmark'` config switches the renderer to the beak +
 * accent + dismiss-button card. Owns a popup view separate from the
 * hover tooltip's so its sticky lifecycle (no auto-hide on blur — the
 * dismiss button needs focus) doesn't fight the tooltip's auto-dismiss.
 */

const COACHMARK_POPUP_INITIAL_WIDTH = 300
const COACHMARK_POPUP_INITIAL_HEIGHT = 96
/** Vertical gap (px) between the pill's bottom edge and the card's top
 *  edge — leaves room for the beak. */
export const COACHMARK_VERTICAL_GAP = 10
/** Side/top gutter (px) reserved for the card's box-shadow + beak so
 *  neither gets clipped against the popup view's bounds. */
export const COACHMARK_SHADOW_GUTTER = 18
/** Fallback render-ack timeout (ms) — show at last-known size if the
 *  renderer's `:rendered` ack is slow, so the coachmark never sticks
 *  invisible. */
const COACHMARK_RENDER_ACK_TIMEOUT_MS = 120

export interface CoachmarkTheme {
  bg: string
  text: string
  border: string
  /** Brand-yellow accent for the beak + title — what visually marks
   *  this as onboarding rather than a neutral tooltip. */
  accent: string
}

export interface CoachmarkConfig {
  variant: 'coachmark'
  title: string
  body: string
  dismissLabel: string
  theme: CoachmarkTheme
  configToken: string
}

/** Hardcoded mirror of the brand tokens (`--brand-accent` neutral ramp)
 *  so the popup renderer — which has no app stylesheet — matches the
 *  in-app coachmark accent. */
function resolveCoachmarkTheme(): CoachmarkTheme {
  return { bg: '#211927', text: '#ffffff', border: '#38303d', accent: '#e3ff3c' }
}

/** Pure: assemble the coachmark config the renderer paints. Extracted so
 *  the variant stamp + copy wiring is unit-testable without a window. */
export function buildCoachmarkConfig(opts: {
  title: string
  body: string
  dismissLabel: string
  token: string
}): CoachmarkConfig {
  return {
    variant: 'coachmark',
    title: opts.title,
    body: opts.body,
    dismissLabel: opts.dismissLabel,
    theme: resolveCoachmarkTheme(),
    configToken: opts.token
  }
}

/** Pure: compute the popup view bounds that center the card under the
 *  pill and offset it below, clamped to the parent content area.
 *  Extracted for unit testing. */
export function positionCoachmark(opts: {
  anchor: { leftX: number; rightX: number; bottomY: number }
  bubble: { width: number; height: number }
  parentBounds: { width: number; height: number }
}): { x: number; y: number; width: number; height: number } {
  const viewWidth = Math.max(
    opts.bubble.width + COACHMARK_SHADOW_GUTTER * 2,
    COACHMARK_SHADOW_GUTTER * 2 + 1
  )
  const viewHeight = Math.max(
    opts.bubble.height + COACHMARK_SHADOW_GUTTER,
    COACHMARK_SHADOW_GUTTER + 1
  )
  const pillCenter = (opts.anchor.leftX + opts.anchor.rightX) / 2
  let x = Math.round(pillCenter - viewWidth / 2)
  let y = Math.round(opts.anchor.bottomY + COACHMARK_VERTICAL_GAP - COACHMARK_SHADOW_GUTTER / 2)
  if (x < 0) x = 0
  if (x + viewWidth > opts.parentBounds.width) {
    x = Math.max(0, opts.parentBounds.width - viewWidth)
  }
  if (y < 0) y = 0
  if (y + viewHeight > opts.parentBounds.height) {
    y = Math.max(0, opts.parentBounds.height - viewHeight)
  }
  return { x, y, width: viewWidth, height: viewHeight }
}

let _coachmarkTokenSeq = 0
function nextCoachmarkToken(): string {
  _coachmarkTokenSeq = (_coachmarkTokenSeq + 1) >>> 0
  return `cm-${_coachmarkTokenSeq}`
}

interface CoachmarkPopupEntry {
  view: EmbeddedPopupView
  pendingConfig: CoachmarkConfig | null
  pendingAnchor: { leftX: number; rightX: number; bottomY: number } | null
  pendingConfigToken: string | null
}

const coachmarkPopupsByParent = new Map<number, CoachmarkPopupEntry>()
const coachmarkPopupsByWebContents = new Map<number, CoachmarkPopupEntry>()

function ensureCoachmarkPopup(parent: BrowserWindow): CoachmarkPopupEntry {
  const existing = coachmarkPopupsByParent.get(parent.id)
  if (existing && !existing.view.isDestroyed()) return existing

  const view = new EmbeddedPopupView({
    parent,
    htmlName: 'comfyTitleTooltip',
    preloadName: 'comfyTitleTooltipPreload.js',
    initialBounds: {
      x: 0,
      y: 0,
      width: COACHMARK_POPUP_INITIAL_WIDTH,
      height: COACHMARK_POPUP_INITIAL_HEIGHT
    },
    // Sticky: hide only when the host window moves/resizes (stale anchor).
    // Not on blur — the dismiss button needs focus.
    hideOnParentEvents: ['will-move', 'move', 'resize'],
    onParentClosed: () => {
      coachmarkPopupsByParent.delete(parent.id)
      coachmarkPopupsByWebContents.delete(view.popupWebContentsId)
    },
    onDestroyed: () => {
      const cur = coachmarkPopupsByParent.get(parent.id)
      if (cur && cur.view === view) coachmarkPopupsByParent.delete(parent.id)
      coachmarkPopupsByWebContents.delete(view.popupWebContentsId)
    }
  })
  const entry: CoachmarkPopupEntry = {
    view,
    pendingConfig: null,
    pendingAnchor: null,
    pendingConfigToken: null
  }
  coachmarkPopupsByParent.set(view.parentWindowId, entry)
  coachmarkPopupsByWebContents.set(view.popupWebContentsId, entry)
  return entry
}

function repositionAndShow(
  entry: CoachmarkPopupEntry,
  bubble: { width: number; height: number }
): void {
  if (!entry.pendingAnchor || entry.view.isDestroyed()) return
  const parentBounds = entry.view.parentWindow.getContentBounds()
  const bounds = positionCoachmark({ anchor: entry.pendingAnchor, bubble, parentBounds })
  entry.view.popup.setBounds(bounds)
  // Focus so the dismiss button is keyboard-reachable.
  entry.view.showOnTop({ focus: true })
}

export function hideCoachmarkPopup(entry: CoachmarkPopupEntry | undefined): void {
  if (!entry) return
  entry.view.hide()
}

export function openCoachmarkPopup(opts: {
  parent: BrowserWindow
  title: string
  body: string
  dismissLabel: string
  leftX: number
  rightX: number
  bottomY: number
}): void {
  const entry = ensureCoachmarkPopup(opts.parent)
  if (entry.view.isDestroyed()) return

  entry.pendingAnchor = { leftX: opts.leftX, rightX: opts.rightX, bottomY: opts.bottomY }
  const token = nextCoachmarkToken()
  const config = buildCoachmarkConfig({
    title: opts.title,
    body: opts.body,
    dismissLabel: opts.dismissLabel,
    token
  })
  entry.pendingConfigToken = token
  if (entry.view.rendererReady) {
    entry.view.popup.webContents.send('comfy-titletooltip:set-config', config)
  } else {
    entry.pendingConfig = config
  }
  entry.view.scheduleShowFallback(COACHMARK_RENDER_ACK_TIMEOUT_MS, () => {
    const bounds = entry.view.popup.getBounds()
    repositionAndShow(entry, {
      width: Math.max(0, bounds.width - COACHMARK_SHADOW_GUTTER * 2),
      height: Math.max(0, bounds.height - COACHMARK_SHADOW_GUTTER)
    })
  })
}

/** Wire the coachmark IPC. Shares the tooltip's `:ready` / `:rendered`
 *  channels (same renderer entry), disambiguated by webContents id so
 *  only acks from a coachmark popup view land here. */
export function registerTitleCoachmarkIpc(opts: {
  findParentByTitleBarSender: (wc: WebContents) => BrowserWindow | null
  /** Resolve a host BrowserWindow back to its title-bar webContents so
   *  the popup's dismiss button can tell the title-bar renderer to flip
   *  the once-ever flag. `null` if the window has no live title bar. */
  findTitleBarByParent: (parent: BrowserWindow) => WebContents | null
}): void {
  ipcMain.on('comfy-titletooltip:ready', (event) => {
    const entry = coachmarkPopupsByWebContents.get(event.sender.id)
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
      const entry = coachmarkPopupsByWebContents.get(event.sender.id)
      if (!entry) return
      const ackToken = typeof payload?.configToken === 'string' ? payload.configToken : ''
      if (!ackToken || ackToken !== entry.pendingConfigToken) return
      const width = typeof payload?.width === 'number' && payload.width > 0 ? payload.width : 0
      const height = typeof payload?.height === 'number' && payload.height > 0 ? payload.height : 0
      if (entry.pendingAnchor) repositionAndShow(entry, { width, height })
    }
  )

  ipcMain.on(
    'comfy-window:show-titlebar-coachmark',
    (
      event,
      payload: {
        title?: unknown
        body?: unknown
        dismissLabel?: unknown
        leftX?: unknown
        rightX?: unknown
        bottomY?: unknown
      }
    ) => {
      const parent = opts.findParentByTitleBarSender(event.sender)
      if (!parent || parent.isDestroyed()) return
      const title = typeof payload?.title === 'string' ? payload.title : ''
      const body = typeof payload?.body === 'string' ? payload.body : ''
      if (!title && !body) return
      // Renderer supplies the i18n label; main only forwards it (the
      // renderer's own `cmDismissLabel` default covers an empty value).
      const dismissLabel = typeof payload?.dismissLabel === 'string' ? payload.dismissLabel : ''
      const leftX = typeof payload?.leftX === 'number' ? payload.leftX : 0
      const rightX = typeof payload?.rightX === 'number' ? payload.rightX : leftX
      const bottomY = typeof payload?.bottomY === 'number' ? payload.bottomY : TITLEBAR_HEIGHT
      openCoachmarkPopup({
        parent,
        title,
        body,
        dismissLabel,
        leftX: Math.round(leftX),
        rightX: Math.round(rightX),
        bottomY: Math.round(bottomY)
      })
    }
  )

  ipcMain.on('comfy-window:hide-titlebar-coachmark', (event) => {
    const parent = opts.findParentByTitleBarSender(event.sender)
    if (!parent) return
    hideCoachmarkPopup(coachmarkPopupsByParent.get(parent.id))
  })

  // Dismiss fires from the popup's own webContents: hide it and tell the
  // title-bar renderer to flip the once-ever flag (it owns persistence).
  ipcMain.on('comfy-titlecoachmark:dismiss', (event) => {
    const entry = coachmarkPopupsByWebContents.get(event.sender.id)
    if (!entry) return
    entry.view.hide()
    const parent = entry.view.parentWindow
    if (parent && !parent.isDestroyed()) {
      const tb = opts.findTitleBarByParent(parent)
      if (tb && !tb.isDestroyed()) tb.send('comfy-titlebar:coachmark-dismissed')
    }
  })
}
