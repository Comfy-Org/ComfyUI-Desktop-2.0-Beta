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

export interface SystemModalSpec {
  /** Unique per open. Stamped onto the action ack so a stale ack
   *  for a previously-dismissed modal can be ignored. */
  id: string
  title: string
  message: string
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

export function ensureSystemModal(parent: BrowserWindow): SystemModalEntry {
  const existing = systemModalsByParent.get(parent.id)
  if (existing && !existing.view.isDestroyed()) return existing

  const view = new EmbeddedPopupView({
    parent,
    htmlName: 'comfySystemModal',
    preloadName: 'comfySystemModalPreload.js',
    initialBounds: { x: 0, y: 0, width: 1, height: 1 },
    onParentClosed: () => {
      systemModalsByParent.delete(parent.id)
      systemModalsByWebContents.delete(view.popupWebContentsId)
    },
    onDestroyed: () => {
      // Identity-check so we don't drop a fresher entry that may have
      // been registered against the same parent id between the popup
      // crash and this teardown firing.
      const cur = systemModalsByParent.get(parent.id)
      if (cur && cur.view === view) {
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
  const layoutBelowTitleBar = (): void => {
    if (view.popup.webContents.isDestroyed() || parent.isDestroyed()) return
    const b = parent.getContentBounds()
    const y = TITLEBAR_HEIGHT + 1
    const h = Math.max(1, b.height - y)
    view.popup.setBounds({ x: 0, y, width: b.width, height: h })
  }
  layoutBelowTitleBar()
  parent.on('resize', layoutBelowTitleBar)
  parent.once('closed', () => parent.removeListener('resize', layoutBelowTitleBar))

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
  callback: SystemModalCallback
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
  // Supersede any in-flight modal — fire its callback as cancelled
  // so the previous flow can clean up rather than wait forever.
  if (entry.currentCallback) {
    try { entry.currentCallback('cancel') } catch {}
    entry.currentCallback = null
    entry.currentSpec = null
  }
  const id = opts.spec.id ?? `sysmodal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const spec: SystemModalSpec = { ...opts.spec, id }

  if (!entry.view.rendererReady) {
    // Queue until the renderer signals ready; on `ready` we'll flush
    // and push set-modal.
    entry.pendingSpec = { spec, callback: opts.callback }
    return id
  }

  entry.currentSpec = spec
  entry.currentCallback = opts.callback
  if (!entry.view.popup.webContents.isDestroyed()) {
    entry.view.popup.webContents.send('comfy-systemmodal:set-modal', spec)
  }
  // Safety net — if the renderer's `notifyRendered` ack never arrives
  // (mid-load crash, etc.), still flip visible after a short timeout
  // so the user isn't stuck without UI.
  entry.view.scheduleShowFallback(200, () => showSystemModalNow(entry))
  return id
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
