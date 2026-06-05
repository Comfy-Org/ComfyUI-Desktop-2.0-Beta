import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

/**
 * System-modal popup bridge. Hosts shell-level confirm modals in a transparent
 * full-window WebContentsView per host (reused across opens, fed `set-modal` pushes).
 * Full-window sizing dims the whole window, distinguishing it from in-canvas modals.
 */

export type SystemModalConfirmStyle = 'primary' | 'danger'
export type SystemModalSecondaryStyle = 'primary' | 'danger' | 'default'

export interface SystemModalDetailGroup {
  label: string
  items: string[]
}

export interface SystemModalSpec {
  /** Echoed back on action ack so main routes the result to the right callback. */
  id: string
  title: string
  message: string
  details?: SystemModalDetailGroup[]
  confirmLabel: string
  cancelLabel: string
  confirmStyle?: SystemModalConfirmStyle
  /** Optional middle action; when present the modal renders a third button. */
  secondaryLabel?: string
  secondaryStyle?: SystemModalSecondaryStyle
  theme: { bg: string; text: string }
}

export type SystemModalAction = 'confirm' | 'cancel' | 'secondary'

export interface SystemModalActionPayload {
  modalId: string
  action: SystemModalAction
}

export interface ComfySystemModalBridge {
  /** A confirm/cancel button was clicked; main resolves the callback and hides the view. */
  action(payload: SystemModalActionPayload): void
  /** Renderer is mounted; main flushes any spec queued before ready. */
  ready(): void
  /** Renderer painted the latest push. Main waits for this before showing. */
  notifyRendered(): void
  onModal(cb: (spec: SystemModalSpec) => void): () => void
}

function isDetailGroup(value: unknown): value is SystemModalDetailGroup {
  if (!value || typeof value !== 'object') return false
  const g = value as { label?: unknown; items?: unknown }
  if (typeof g.label !== 'string') return false
  if (!Array.isArray(g.items)) return false
  return g.items.every((it) => typeof it === 'string')
}

function isModalSpec(value: unknown): value is SystemModalSpec {
  if (!value || typeof value !== 'object') return false
  const v = value as {
    id?: unknown
    title?: unknown
    message?: unknown
    details?: unknown
    confirmLabel?: unknown
    cancelLabel?: unknown
    theme?: unknown
  }
  if (typeof v.id !== 'string' || v.id.length === 0) return false
  if (typeof v.title !== 'string') return false
  if (typeof v.message !== 'string') return false
  if (typeof v.confirmLabel !== 'string') return false
  if (typeof v.cancelLabel !== 'string') return false
  if (v.details !== undefined) {
    if (!Array.isArray(v.details)) return false
    if (!v.details.every(isDetailGroup)) return false
  }
  if (!v.theme || typeof v.theme !== 'object') return false
  const theme = v.theme as { bg?: unknown; text?: unknown }
  if (typeof theme.bg !== 'string' || typeof theme.text !== 'string') return false
  return true
}

const bridge: ComfySystemModalBridge = {
  action: (payload) => {
    if (!payload || typeof payload.modalId !== 'string') return
    if (
      payload.action !== 'confirm' &&
      payload.action !== 'cancel' &&
      payload.action !== 'secondary'
    ) {
      return
    }
    ipcRenderer.send('comfy-systemmodal:action', payload)
  },
  ready: () => {
    ipcRenderer.send('comfy-systemmodal:ready')
  },
  notifyRendered: () => {
    ipcRenderer.send('comfy-systemmodal:rendered')
  },
  onModal: (cb) => {
    const handler = (_event: IpcRendererEvent, data: unknown): void => {
      if (isModalSpec(data)) cb(data)
    }
    ipcRenderer.on('comfy-systemmodal:set-modal', handler)
    return () => ipcRenderer.removeListener('comfy-systemmodal:set-modal', handler)
  },
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('__comfySystemModal', bridge)
} else {
  ;(globalThis as Record<string, unknown>).__comfySystemModal = bridge
}
