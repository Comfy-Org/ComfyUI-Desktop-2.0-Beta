import { WebContentsView, ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import path from 'path'
import { TITLEBAR_HEIGHT } from '../lib/titleBarOverlay'

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
  popup: WebContentsView
  parentWindow: BrowserWindow
  popupWebContentsId: number
  parentWindowId: number
  /** True once the renderer has signalled `comfy-systemmodal:ready`. */
  rendererReady: boolean
  /** Spec the renderer is currently displaying (or about to display
   *  once the rendered ack arrives). */
  currentSpec: SystemModalSpec | null
  currentCallback: SystemModalCallback | null
  /** Spec queued before the renderer was ready — flushed on `ready`. */
  pendingSpec: { spec: SystemModalSpec; callback: SystemModalCallback } | null
  isOpen: boolean
  pendingShowTimer: NodeJS.Timeout | null
}

const systemModalsByParent = new Map<number, SystemModalEntry>()
const systemModalsByWebContents = new Map<number, SystemModalEntry>()

export function ensureSystemModal(parent: BrowserWindow): SystemModalEntry {
  const existing = systemModalsByParent.get(parent.id)
  if (existing && !existing.popup.webContents.isDestroyed()) return existing

  const popup = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/comfySystemModalPreload.js'),
    },
  })
  // Per-pixel transparency so the backdrop's `rgba(...)` can dim what
  // lies beneath. Like the title-popup, this is a plain WebContentsView
  // attached to the host BrowserWindow's content area.
  popup.setBackgroundColor('#00000000')
  popup.setVisible(false)
  popup.setBounds({ x: 0, y: 0, width: 1, height: 1 })
  parent.contentView.addChildView(popup)

  const isDev = !!process.env['ELECTRON_RENDERER_URL']
  const loadPromise = isDev
    ? popup.webContents.loadURL(
        `${(process.env['ELECTRON_RENDERER_URL'] as string).replace(/\/$/, '')}/comfySystemModal.html`,
      )
    : popup.webContents.loadFile(path.join(__dirname, '../renderer/comfySystemModal.html'))
  void loadPromise.catch(() => {})

  const entry: SystemModalEntry = {
    popup,
    parentWindow: parent,
    popupWebContentsId: popup.webContents.id,
    parentWindowId: parent.id,
    rendererReady: false,
    currentSpec: null,
    currentCallback: null,
    pendingSpec: null,
    isOpen: false,
    pendingShowTimer: null,
  }
  systemModalsByParent.set(entry.parentWindowId, entry)
  systemModalsByWebContents.set(entry.popupWebContentsId, entry)

  // Tear down with the parent.
  const onParentClosed = (): void => {
    systemModalsByParent.delete(entry.parentWindowId)
    systemModalsByWebContents.delete(entry.popupWebContentsId)
    try { parent.contentView.removeChildView(popup) } catch {}
    if (!popup.webContents.isDestroyed()) popup.webContents.close()
  }
  parent.once('closed', onParentClosed)

  popup.webContents.once('destroyed', () => {
    if (!parent.isDestroyed()) {
      parent.removeListener('closed', onParentClosed)
    }
    if (systemModalsByParent.get(entry.parentWindowId) === entry) {
      systemModalsByParent.delete(entry.parentWindowId)
    }
    systemModalsByWebContents.delete(entry.popupWebContentsId)
  })

  // Resize with the parent window so the modal-popup always covers the
  // body area (everything BELOW the title bar). Leaving the title-bar
  // strip uncovered keeps it visually unblurred so the user can tell
  // at a glance that the modal is a body-level overlay rather than a
  // full-window takeover.
  const layoutBelowTitleBar = (): void => {
    if (popup.webContents.isDestroyed() || parent.isDestroyed()) return
    const b = parent.getContentBounds()
    const y = TITLEBAR_HEIGHT + 1
    const h = Math.max(1, b.height - y)
    popup.setBounds({ x: 0, y, width: b.width, height: h })
  }
  layoutBelowTitleBar()
  parent.on('resize', layoutBelowTitleBar)
  parent.once('closed', () => parent.removeListener('resize', layoutBelowTitleBar))

  return entry
}

function hideSystemModal(
  entry: SystemModalEntry,
  opts: { releaseFocusToParent?: boolean } = {},
): void {
  if (!entry.isOpen && !entry.pendingShowTimer) return
  entry.isOpen = false
  if (entry.pendingShowTimer) {
    clearTimeout(entry.pendingShowTimer)
    entry.pendingShowTimer = null
  }
  if (!entry.popup.webContents.isDestroyed()) {
    entry.popup.setVisible(false)
    if (opts.releaseFocusToParent && !entry.parentWindow.isDestroyed()) {
      entry.parentWindow.focus()
    }
  }
}

function showSystemModalNow(entry: SystemModalEntry): void {
  if (entry.pendingShowTimer) {
    clearTimeout(entry.pendingShowTimer)
    entry.pendingShowTimer = null
  }
  if (entry.popup.webContents.isDestroyed() || entry.parentWindow.isDestroyed()) return
  // Resize to cover the body area (below the title bar) on every show
  // — the parent may have been resized between opens.
  const b = entry.parentWindow.getContentBounds()
  const y = TITLEBAR_HEIGHT + 1
  const h = Math.max(1, b.height - y)
  entry.popup.setBounds({ x: 0, y, width: b.width, height: h })
  // Re-add to the top of the child-view stack so the modal paints
  // above the comfy / panel views (but the title bar still sits
  // above visually because the modal popup leaves its strip
  // uncovered).
  try { entry.parentWindow.contentView.removeChildView(entry.popup) } catch {}
  entry.parentWindow.contentView.addChildView(entry.popup)
  entry.popup.setVisible(true)
  entry.popup.webContents.focus()
  entry.isOpen = true
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

  if (!entry.rendererReady) {
    // Queue until the renderer signals ready; on `ready` we'll flush
    // and push set-modal.
    entry.pendingSpec = { spec, callback: opts.callback }
    return id
  }

  entry.currentSpec = spec
  entry.currentCallback = opts.callback
  if (!entry.popup.webContents.isDestroyed()) {
    entry.popup.webContents.send('comfy-systemmodal:set-modal', spec)
  }
  // Safety net — if the renderer's `notifyRendered` ack never arrives
  // (mid-load crash, etc.), still flip visible after a short timeout
  // so the user isn't stuck without UI.
  if (!entry.pendingShowTimer) {
    entry.pendingShowTimer = setTimeout(() => {
      entry.pendingShowTimer = null
      showSystemModalNow(entry)
    }, 200)
  }
  return id
}

/** Wire the IPC handlers that drive the system-modal popup. Called
 *  once at app `whenReady`. */
export function registerSystemModalIpc(): void {
  ipcMain.on('comfy-systemmodal:ready', (event) => {
    const entry = systemModalsByWebContents.get(event.sender.id)
    if (!entry) return
    entry.rendererReady = true
    if (entry.pendingSpec) {
      const { spec, callback } = entry.pendingSpec
      entry.pendingSpec = null
      entry.currentSpec = spec
      entry.currentCallback = callback
      if (!entry.popup.webContents.isDestroyed()) {
        entry.popup.webContents.send('comfy-systemmodal:set-modal', spec)
      }
      if (!entry.pendingShowTimer) {
        entry.pendingShowTimer = setTimeout(() => {
          entry.pendingShowTimer = null
          showSystemModalNow(entry)
        }, 200)
      }
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
      hideSystemModal(entry, { releaseFocusToParent: true })
      try { cb(action) } catch {}
    },
  )
}
