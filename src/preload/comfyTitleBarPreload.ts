import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

export type ComfyPanelKey = 'comfy' | 'install-settings' | 'launcher-settings'

export interface ComfyTitleBarBridge {
  /** The installation this title bar belongs to. */
  getInstallationId(): string | null
  /** Whether the host is macOS — controls left padding for traffic lights. */
  isMac(): boolean
  /** Request the main process to swap the active panel. */
  setPanel(panel: ComfyPanelKey): void
  /** Subscribe to panel-active changes coming from main. */
  onPanelChanged(cb: (panel: ComfyPanelKey) => void): () => void
  /** Subscribe to title text changes coming from main. */
  onTitleChanged(cb: (title: string) => void): () => void
  /** Subscribe to theme updates (background + symbol color). */
  onThemeChanged(cb: (theme: { bg: string; text: string }) => void): () => void
  /** Tell main this title bar is mounted; main responds with the initial state. */
  ready(): void
}

// `window` and `navigator` are available at preload time but the node tsconfig
// omits the DOM lib; access them via globalThis to keep the type-checker happy.
interface PreloadGlobals {
  location?: { href: string }
  navigator?: { userAgent: string }
}
const g = globalThis as unknown as PreloadGlobals

function readInstallationId(): string | null {
  try {
    const href = g.location?.href
    if (!href) return null
    return new URL(href).searchParams.get('installationId')
  } catch {
    return null
  }
}

const bridge: ComfyTitleBarBridge = {
  getInstallationId: () => readInstallationId(),
  isMac: () => (g.navigator?.userAgent ?? '').toLowerCase().includes('mac'),
  setPanel: (panel) => {
    ipcRenderer.send('comfy-window:set-panel', { panel })
  },
  onPanelChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, panel: unknown): void => {
      if (typeof panel === 'string') cb(panel as ComfyPanelKey)
    }
    ipcRenderer.on('comfy-titlebar:panel-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:panel-changed', handler)
  },
  onTitleChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, title: unknown): void => {
      if (typeof title === 'string') cb(title)
    }
    ipcRenderer.on('comfy-titlebar:title-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:title-changed', handler)
  },
  onThemeChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, data: unknown): void => {
      const { bg, text } = (data || {}) as { bg?: string; text?: string }
      if (typeof bg === 'string' && typeof text === 'string') cb({ bg, text })
    }
    ipcRenderer.on('comfy-titlebar:theme-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:theme-changed', handler)
  },
  ready: () => {
    ipcRenderer.send('comfy-window:title-bar-ready')
  },
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('__comfyTitleBar', bridge)
} else {
  ;(globalThis as Record<string, unknown>).__comfyTitleBar = bridge
}
