import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

/**
 * Title-bar dropdown popup bridge.
 *
 * All title-bar dropdowns (waffle menu, downloads tray, …) share a single
 * frameless transparent child `WebContentsView` per parent window. This
 * preload exposes the surface that popup needs to talk back to main:
 * activate an item (menu kind), ask to close, signal readiness, and
 * receive new configuration on each open.
 *
 * The popup view is reused across opens (created once per parent
 * window, hidden between uses) so opening feels instant after the first
 * paint — main pushes a fresh `set-config` payload (kind, items, theme)
 * each time before showing the view.
 */

export interface TitlePopupMenuItem {
  id?: string
  label?: string
  checked?: boolean
  kind?: 'separator'
}

export type TitlePopupConfig =
  | {
      kind: 'menu'
      items: TitlePopupMenuItem[]
      theme: { bg: string; text: string }
    }
  | {
      kind: 'downloads'
      theme: { bg: string; text: string }
    }

export interface ComfyTitlePopupBridge {
  /** A menu item was clicked — main routes by id and hides the popup. */
  activate(id: string): void
  /** Close the popup without activating anything (Escape key). */
  close(): void
  /** Signal that the renderer is mounted and listening for config
   *  updates — main flushes any pending config that was queued before
   *  the renderer was ready. */
  ready(): void
  /** Signal that the renderer has applied a config update and the new
   *  DOM has painted. Main waits for this before flipping opacity to
   *  1 so the user never sees a frame of the previous open's content
   *  on the new open. */
  notifyRendered(): void
  /** Subscribe to config pushes (one fires for every open). */
  onConfig(cb: (config: TitlePopupConfig) => void): () => void
}

function isPopupConfig(value: unknown): value is TitlePopupConfig {
  if (!value || typeof value !== 'object') return false
  const v = value as { kind?: unknown; items?: unknown; theme?: unknown }
  if (v.kind !== 'menu' && v.kind !== 'downloads') return false
  if (!v.theme || typeof v.theme !== 'object') return false
  const theme = v.theme as { bg?: unknown; text?: unknown }
  if (typeof theme.bg !== 'string' || typeof theme.text !== 'string') return false
  if (v.kind === 'menu' && !Array.isArray(v.items)) return false
  return true
}

const bridge: ComfyTitlePopupBridge = {
  activate: (id) => {
    ipcRenderer.send('comfy-titlepopup:item-activated', { id })
  },
  close: () => {
    ipcRenderer.send('comfy-titlepopup:close')
  },
  ready: () => {
    ipcRenderer.send('comfy-titlepopup:ready')
  },
  notifyRendered: () => {
    ipcRenderer.send('comfy-titlepopup:rendered')
  },
  onConfig: (cb) => {
    const handler = (_event: IpcRendererEvent, data: unknown): void => {
      if (isPopupConfig(data)) cb(data)
    }
    ipcRenderer.on('comfy-titlepopup:set-config', handler)
    return () => ipcRenderer.removeListener('comfy-titlepopup:set-config', handler)
  },
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('__comfyTitlePopup', bridge)
} else {
  ;(globalThis as Record<string, unknown>).__comfyTitlePopup = bridge
}
