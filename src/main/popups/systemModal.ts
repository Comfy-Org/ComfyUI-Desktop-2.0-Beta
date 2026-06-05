import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { TITLEBAR_HEIGHT } from '../lib/titleBarOverlay'
import { EmbeddedPopupView } from './embeddedPopupView'

type SystemModalConfirmStyle = 'primary' | 'danger'
type SystemModalSecondaryStyle = 'primary' | 'danger' | 'default'

export interface SystemModalDetailGroup {
  label: string
  items: string[]
}

export interface SystemModalSpec {
  /** Stamped onto the action ack so a stale ack for a dismissed modal can be ignored. */
  id: string
  title: string
  message: string
  details?: SystemModalDetailGroup[]
  confirmLabel: string
  cancelLabel: string
  confirmStyle?: SystemModalConfirmStyle
  /** Optional middle action (rendered between Cancel and the primary). When set,
   *  the modal becomes a three-way choice and resolves `'secondary'`. */
  secondaryLabel?: string
  secondaryStyle?: SystemModalSecondaryStyle
  theme: { bg: string; text: string }
}

type SystemModalAction = 'confirm' | 'cancel' | 'secondary'

export type SystemModalCallback = (action: SystemModalAction) => void

export interface SystemModalEntry {
  view: EmbeddedPopupView
  currentSpec: SystemModalSpec | null
  currentCallback: SystemModalCallback | null
  /** Spec queued before the renderer was ready — flushed on `ready`. */
  pendingSpec: { spec: SystemModalSpec; callback: SystemModalCallback } | null
}

const systemModalsByParent = new Map<number, SystemModalEntry>()
const systemModalsByWebContents = new Map<number, SystemModalEntry>()

/** Settle any in-flight (current OR pending) modal as cancelled. Callback errors
 *  are swallowed so a buggy caller can't poison subsequent settlements. */
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

  // Forward-declared so teardowns can detach the resize listener; without this a
  // crash-and-recreate cycle leaks one resize listener per cycle on the parent.
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
      // Identity-check so we don't drop a fresher entry registered against the
      // same parent id between the popup crash and this teardown firing.
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

  // Cover the body area only (below the title bar); the uncovered title strip
  // signals the modal is a body-level overlay, not a full-window takeover.
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
  // Re-cover the body area on every show; the parent may have resized between opens.
  const b = entry.view.parentWindow.getContentBounds()
  const y = TITLEBAR_HEIGHT + 1
  const h = Math.max(1, b.height - y)
  entry.view.popup.setBounds({ x: 0, y, width: b.width, height: h })
  entry.view.showOnTop({ focus: true })
}

export interface OpenSystemModalOpts {
  parent: BrowserWindow
  spec: Omit<SystemModalSpec, 'id'> & { id?: string }
  callback?: SystemModalCallback
}

/**
 * Open a system-level confirm modal in the given host window. Replaces any modal
 * currently on the same surface (previous callback fires `'cancel'`). Returns the
 * resolved spec id for cross-referencing the action ack.
 */
export function openSystemModal(opts: OpenSystemModalOpts): string {
  const entry = ensureSystemModal(opts.parent)
  // Supersede any in-flight or queued modal so awaiters never hang.
  cancelEntry(entry)
  const id = opts.spec.id ?? `sysmodal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const spec: SystemModalSpec = { ...opts.spec, id }
  const callback: SystemModalCallback = opts.callback ?? (() => {})

  if (!entry.view.rendererReady) {
    entry.pendingSpec = { spec, callback }
    return id
  }

  entry.currentSpec = spec
  entry.currentCallback = callback
  if (!entry.view.popup.webContents.isDestroyed()) {
    entry.view.popup.webContents.send('comfy-systemmodal:set-modal', spec)
  }
  // Safety net: show anyway if the renderer's rendered ack never arrives.
  entry.view.scheduleShowFallback(200, () => showSystemModalNow(entry))
  return id
}

/** Promise wrapper around `openSystemModal`. Resolves `true` on confirm,
 *  `false` on cancel / superseded / parent destroyed. */
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

/** Three-way variant of `openSystemModalAsync`. Resolves the raw action so a
 *  caller offering a middle option (`secondaryLabel`) can branch on it. Cancel
 *  / superseded / parent-destroyed all resolve `'cancel'`. */
export function openSystemModalChoiceAsync(
  opts: OpenSystemModalOpts,
): Promise<'confirm' | 'cancel' | 'secondary'> {
  return new Promise((resolve) => {
    openSystemModal({
      parent: opts.parent,
      spec: opts.spec,
      callback: (action) => {
        if (opts.callback) {
          try { opts.callback(action) } catch {}
        }
        resolve(action)
      },
    })
  })
}

/** Wire the IPC handlers that drive the system-modal popup. Called once at app ready. */
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
      if (action !== 'confirm' && action !== 'cancel' && action !== 'secondary') return
      entry.currentSpec = null
      entry.currentCallback = null
      entry.view.hide({ focusParent: true })
      try { cb(action) } catch {}
    },
  )
}
