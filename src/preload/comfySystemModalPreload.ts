import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

/**
 * System-modal popup bridge.
 *
 * Hosts shell-level confirm modals (app-update prompts, etc.) inside a
 * dedicated transparent full-window `WebContentsView` per parent host
 * window. The view is reused across opens (created once per parent,
 * hidden between uses); main pushes a fresh `set-modal` payload on
 * every open. The renderer renders backdrop + modal box and posts back
 * the user's action.
 *
 * Mirrors the title-popup primitive (see `comfyTitlePopupPreload.ts`)
 * but sized to the full content area so the modal can dim the entire
 * window — making it visually distinct from in-canvas modals owned by
 * the comfyView (which dim only the canvas).
 */

export type SystemModalConfirmStyle = 'primary' | 'danger'

export interface SystemModalSpec {
  /** Unique identifier per open. Echoed back on action ack so main
   *  can route the result to the right callback. */
  id: string
  title: string
  message: string
  confirmLabel: string
  cancelLabel: string
  confirmStyle?: SystemModalConfirmStyle
  theme: { bg: string; text: string }
}

export type SystemModalAction = 'confirm' | 'cancel'

export interface SystemModalActionPayload {
  modalId: string
  action: SystemModalAction
}

export interface ComfySystemModalBridge {
  /** A button was clicked — `confirm` or `cancel`. Main resolves the
   *  associated callback and hides the view. */
  action(payload: SystemModalActionPayload): void
  /** Signal that the renderer is mounted and listening for modal
   *  pushes — main flushes any spec that was queued before the
   *  renderer was ready. */
  ready(): void
  /** Signal that the renderer applied a modal push and the new DOM
   *  has painted. Main waits for this before flipping the view
   *  visible so the user never sees a frame of the previous open's
   *  content on a fresh open. */
  notifyRendered(): void
  /** Subscribe to modal pushes (one fires for every open). */
  onModal(cb: (spec: SystemModalSpec) => void): () => void
}

function isModalSpec(value: unknown): value is SystemModalSpec {
  if (!value || typeof value !== 'object') return false
  const v = value as {
    id?: unknown
    title?: unknown
    message?: unknown
    confirmLabel?: unknown
    cancelLabel?: unknown
    theme?: unknown
  }
  if (typeof v.id !== 'string' || v.id.length === 0) return false
  if (typeof v.title !== 'string') return false
  if (typeof v.message !== 'string') return false
  if (typeof v.confirmLabel !== 'string') return false
  if (typeof v.cancelLabel !== 'string') return false
  if (!v.theme || typeof v.theme !== 'object') return false
  const theme = v.theme as { bg?: unknown; text?: unknown }
  if (typeof theme.bg !== 'string' || typeof theme.text !== 'string') return false
  return true
}

const bridge: ComfySystemModalBridge = {
  action: (payload) => {
    if (!payload || typeof payload.modalId !== 'string') return
    if (payload.action !== 'confirm' && payload.action !== 'cancel') return
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
