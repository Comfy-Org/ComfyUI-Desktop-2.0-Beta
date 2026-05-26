import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { TITLEBAR_HEIGHT } from '../lib/titleBarOverlay'
import { EmbeddedPopupView } from './embeddedPopupView'

/**
 * Shell-level confirm modal rendered as a transparent WebContentsView
 * that overlays the host window's body so the user knows it's a shell
 * prompt rather than an in-canvas modal.
 */

type SystemModalConfirmStyle = 'primary' | 'danger'

/** Structured detail block — renders as `<label>` followed by a bulleted
 *  list of `items` beneath the main `message`. Multiple groups stack
 *  vertically. Mirrors the `messageDetails` shape `BaseAlert` already
 *  exposes via the confirm modal primitive — used by the close-all
 *  confirm to list open windows / running sessions / in-flight ops /
 *  active downloads without packing them into a flat `message` string. */
export interface SystemModalDetailGroup {
  label: string
  items: string[]
}

export interface SystemModalSpec {
  /** Unique per open. Stamped onto the action ack so a stale ack
   *  for a previously-dismissed modal can be ignored. */
  id: string
  title: string
  message: string
  /** Optional structured detail groups rendered beneath the message. */
  details?: SystemModalDetailGroup[]
  confirmLabel: string
  cancelLabel: string
  confirmStyle?: SystemModalConfirmStyle
  theme: { bg: string; text: string }
}

type SystemModalAction = 'confirm' | 'cancel'

export type SystemModalCallback = (action: SystemModalAction) => void

export interface SystemModalEntry {
  view: EmbeddedPopupView
  /** Spec the renderer is currently displaying (or about to display
   *  once the rendered ack arrives). */
  currentSpec: SystemModalSpec | null
  currentCallback: SystemModalCallback | null
  /** Spec queued before the renderer was ready — flushed on `ready`. */
  pendingSpec: { spec: SystemModalSpec; callback: SystemModalCallback } | null
}

const systemModalsByParent = new Map<number, SystemModalEntry>()
const systemModalsByWebContents = new Map<number, SystemModalEntry>()

/** Settle any in-flight (current OR pending) modal on this entry as
 *  cancelled. Callers can rely on `openSystemModalAsync` resolving
 *  `false` for every drop reason (supersession, parent close, popup
 *  crash). Errors thrown by user callbacks are swallowed so a buggy
 *  caller can't poison subsequent settlements. */
function cancelEntry(entry: SystemModalEntry): void {
  const current = entry.currentCallback
  const pending = entry.pendingSpec?.callback
  entry.currentSpec = null
  entry.currentCallback = null
  entry.pendingSpec = null
  try { current?.('cancel') } catch {}
  try { pending?.('cancel') } catch {}
}

export function ensureSystemModal(parent: BrowserWindow): SystemModalEntry {
  const existing = systemModalsByParent.get(parent.id)
  if (existing && !existing.view.isDestroyed()) return existing

  // Forward-declared so the popup-crash / parent-close teardowns can
  // detach the parent-window resize listener — without this, a
  // crash-and-recreate cycle accumulates one resize listener per cycle
  // on the parent BrowserWindow.
  let layoutBelowTitleBar: () => void = () => {}
  const detachResizeListener = (): void => {
    if (!parent.isDestroyed()) parent.removeListener('resize', layoutBelowTitleBar)
  }

  const view = new EmbeddedPopupView({
    parent,
    htmlName: 'comfySystemModal',
    preloadName: 'comfySystemModalPreload.js',
    initialBounds: { x: 0, y: 0, width: 1, height: 1 },
    onParentClosed: () => {
      detachResizeListener()
      const cur = systemModalsByParent.get(parent.id)
      if (cur && cur.view === view) cancelEntry(cur)
      systemModalsByParent.delete(parent.id)
      systemModalsByWebContents.delete(view.popupWebContentsId)
    },
    onDestroyed: () => {
      detachResizeListener()
      // Identity-check so we don't drop a fresher entry that may have
      // been registered against the same parent id between the popup
      // crash and this teardown firing.
      const cur = systemModalsByParent.get(parent.id)
      if (cur && cur.view === view) {
        cancelEntry(cur)
        systemModalsByParent.delete(parent.id)
      }
      systemModalsByWebContents.delete(view.popupWebContentsId)
    },
  })
  const entry: SystemModalEntry = {
    view,
    currentSpec: null,
    currentCallback: null,
    pendingSpec: null,
  }
  systemModalsByParent.set(view.parentWindowId, entry)
  systemModalsByWebContents.set(view.popupWebContentsId, entry)

  // Resize with the parent window so the modal-popup always covers the
  // body area (everything BELOW the title bar). Leaving the title-bar
  // strip uncovered keeps it visually unblurred so the user can tell
  // at a glance that the modal is a body-level overlay rather than a
  // full-window takeover.
  layoutBelowTitleBar = (): void => {
    if (view.popup.webContents.isDestroyed() || parent.isDestroyed()) return
    const b = parent.getContentBounds()
    const y = TITLEBAR_HEIGHT + 1
    const h = Math.max(1, b.height - y)
    view.popup.setBounds({ x: 0, y, width: b.width, height: h })
  }
  layoutBelowTitleBar()
  parent.on('resize', layoutBelowTitleBar)

  return entry
}

function showSystemModalNow(entry: SystemModalEntry): void {
  if (entry.view.isDestroyed()) return
  // Resize to cover the body area (below the title bar) on every show
  // — the parent may have been resized between opens.
  const b = entry.view.parentWindow.getContentBounds()
  const y = TITLEBAR_HEIGHT + 1
  const h = Math.max(1, b.height - y)
  entry.view.popup.setBounds({ x: 0, y, width: b.width, height: h })
  entry.view.showOnTop({ focus: true })
}

export interface OpenSystemModalOpts {
  parent: BrowserWindow
  spec: Omit<SystemModalSpec, 'id'> & { id?: string }
  /** Optional explicit callback. Required by the legacy `openSystemModal`
   *  call path; the Promise-shaped `openSystemModalAsync` wrapper supplies
   *  its own internal resolver, so callers using it can omit this. */
  callback?: SystemModalCallback
}

/**
 * Open a system-level confirm modal in the given host window. Replaces
 * any modal currently displayed on the same surface (the previous
 * callback is invoked with `'cancel'` so callers can tell their flow
 * was superseded). Returns the resolved spec id so the caller can
 * cross-reference the action ack if needed.
 */
export function openSystemModal(opts: OpenSystemModalOpts): string {
  const entry = ensureSystemModal(opts.parent)
  // Supersede any in-flight OR queued-but-not-yet-flushed modal — every
  // previous-open callback resolves cancelled so awaiters never hang.
  // Same helper the parent-close / popup-crash teardowns use, so all
  // four drop reasons share one settlement path.
  cancelEntry(entry)
  const id = opts.spec.id ?? `sysmodal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const spec: SystemModalSpec = { ...opts.spec, id }
  // `opts.callback` is optional on the public type so `openSystemModalAsync`
  // (which provides its own resolver) and fire-and-forget callers can both
  // use this entry point. Internally we always carry a callable.
  const callback: SystemModalCallback = opts.callback ?? (() => {})

  if (!entry.view.rendererReady) {
    // Queue until the renderer signals ready; on `ready` we'll flush
    // and push set-modal.
    entry.pendingSpec = { spec, callback }
    return id
  }

  entry.currentSpec = spec
  entry.currentCallback = callback
  if (!entry.view.popup.webContents.isDestroyed()) {
    entry.view.popup.webContents.send('comfy-systemmodal:set-modal', spec)
  }
  // Safety net — if the renderer's `notifyRendered` ack never arrives
  // (mid-load crash, etc.), still flip visible after a short timeout
  // so the user isn't stuck without UI.
  entry.view.scheduleShowFallback(200, () => showSystemModalNow(entry))
  return id
}

/** Promise-shaped wrapper around `openSystemModal` for callers that
 *  want to `await` a yes/no decision instead of plumbing a callback.
 *  Resolves `true` when the user clicks the confirm button, `false`
 *  for cancel / superseded / parent destroyed. */
export function openSystemModalAsync(opts: OpenSystemModalOpts): Promise<boolean> {
  return new Promise((resolve) => {
    openSystemModal({
      parent: opts.parent,
      spec: opts.spec,
      callback: (action) => {
        if (opts.callback) {
          try { opts.callback(action) } catch {}
        }
        resolve(action === 'confirm')
      },
    })
  })
}

/** Wire the IPC handlers that drive the system-modal popup. Called
 *  once at app `whenReady`. */
export function registerSystemModalIpc(): void {
  ipcMain.on('comfy-systemmodal:ready', (event) => {
    const entry = systemModalsByWebContents.get(event.sender.id)
    if (!entry) return
    entry.view.rendererReady = true
    if (entry.pendingSpec) {
      const { spec, callback } = entry.pendingSpec
      entry.pendingSpec = null
      entry.currentSpec = spec
      entry.currentCallback = callback
      if (!entry.view.popup.webContents.isDestroyed()) {
        entry.view.popup.webContents.send('comfy-systemmodal:set-modal', spec)
      }
      entry.view.scheduleShowFallback(200, () => showSystemModalNow(entry))
    }
  })

  ipcMain.on('comfy-systemmodal:rendered', (event) => {
    const entry = systemModalsByWebContents.get(event.sender.id)
    if (!entry) return
    showSystemModalNow(entry)
  })

  ipcMain.on(
    'comfy-systemmodal:action',
    (event, payload: { modalId?: unknown; action?: unknown }) => {
      const entry = systemModalsByWebContents.get(event.sender.id)
      if (!entry) return
      const spec = entry.currentSpec
      const cb = entry.currentCallback
      if (!spec || !cb) return
      // Stale ack — the modal was already replaced by a newer open.
      if (payload?.modalId !== spec.id) return
      const action = payload?.action
      if (action !== 'confirm' && action !== 'cancel') return
      entry.currentSpec = null
      entry.currentCallback = null
      entry.view.hide({ focusParent: true })
      try { cb(action) } catch {}
    },
  )
}
