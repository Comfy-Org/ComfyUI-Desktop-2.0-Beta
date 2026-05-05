import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

/**
 * Title-menu popup bridge.
 *
 * The title-bar dropdowns (File / Install) are HTML-rendered inside a
 * frameless transparent child BrowserWindow (Phase 3 §14 — replaces the
 * previous native `Menu.popup()` flow). This preload exposes the minimal
 * surface that popup needs to talk back to main: activate an item, ask to
 * close, signal readiness, and receive new menu configuration on each
 * open.
 *
 * The popup window is reused across opens (created once per parent
 * window, hidden between uses) so opening feels instant after the first
 * paint — main pushes a fresh `set-config` payload (kind, items, theme)
 * each time before showing the window.
 */
export interface TitleMenuConfig {
  kind: 'file' | 'install'
  items: Array<{
    id?: string
    label?: string
    checked?: boolean
    kind?: 'separator'
  }>
  theme: { bg: string; text: string }
}

export interface ComfyTitleMenuBridge {
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
  onConfig(cb: (config: TitleMenuConfig) => void): () => void
}

function isMenuConfig(value: unknown): value is TitleMenuConfig {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<TitleMenuConfig>
  if (v.kind !== 'file' && v.kind !== 'install') return false
  if (!Array.isArray(v.items)) return false
  if (!v.theme || typeof v.theme !== 'object') return false
  if (typeof v.theme.bg !== 'string' || typeof v.theme.text !== 'string') return false
  return true
}

const bridge: ComfyTitleMenuBridge = {
  activate: (id) => {
    ipcRenderer.send('comfy-titlemenu:item-activated', { id })
  },
  close: () => {
    ipcRenderer.send('comfy-titlemenu:close')
  },
  ready: () => {
    ipcRenderer.send('comfy-titlemenu:ready')
  },
  notifyRendered: () => {
    ipcRenderer.send('comfy-titlemenu:rendered')
  },
  onConfig: (cb) => {
    const handler = (_event: IpcRendererEvent, data: unknown): void => {
      if (isMenuConfig(data)) cb(data)
    }
    ipcRenderer.on('comfy-titlemenu:set-config', handler)
    return () => ipcRenderer.removeListener('comfy-titlemenu:set-config', handler)
  },
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('__comfyTitleMenu', bridge)
} else {
  ;(globalThis as Record<string, unknown>).__comfyTitleMenu = bridge
}
