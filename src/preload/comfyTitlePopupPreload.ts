import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

/**
 * Title-bar dropdown popup bridge.
 *
 * All title-bar dropdowns (waffle menu, downloads tray, …) share a single
 * frameless transparent child `WebContentsView` per parent window. This
 * preload exposes the surface that popup needs to talk back to main:
 * activate an item (menu kind), ask to close, signal readiness, receive
 * new configuration on each open, and — for the downloads kind —
 * subscribe to live tray-state pushes and dispatch per-entry actions.
 *
 * The popup view is reused across opens (created once per parent
 * window, hidden between uses) so opening feels instant after the first
 * paint — main pushes a fresh `set-config` payload (kind, theme, …)
 * each time before showing the view.
 */

export interface TitlePopupMenuItem {
  id?: string
  /** Visible label. English fallback when `labelKey` is set;
   *  rendered verbatim otherwise. */
  label?: string
  /** Optional vue-i18n key the popup's MenuView resolves against the
   *  shared en catalog. Lets main-built labels participate in i18n
   *  even though main itself can't run vue-i18n. */
  labelKey?: string
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

/** Live downloads-tray entry pushed to the popup. Shape mirrors
 *  `DownloadProgress` in `src/main/lib/comfyDownloadManager.ts`. */
export interface PopupDownloadEntry {
  url: string
  filename: string
  directory?: string
  savePath?: string
  progress: number
  receivedBytes?: number
  totalBytes?: number
  speedBytesPerSec?: number
  etaSeconds?: number
  status: 'pending' | 'downloading' | 'paused' | 'completed' | 'error' | 'cancelled'
  error?: string
  /** First-seen wall-clock timestamp (ms). Stable across status
   *  transitions so the popup view can render a single insertion-
   *  ordered list (terminal entries stay in their slot rather than
   *  jumping to the bottom of a separate "recent" bucket). */
  createdAt?: number
}

export interface PopupDownloadsState {
  active: PopupDownloadEntry[]
  recent: PopupDownloadEntry[]
}

export type PopupDownloadAction =
  | { action: 'pause'; url: string }
  | { action: 'resume'; url: string }
  | { action: 'cancel'; url: string }
  | { action: 'show-in-folder'; url: string; savePath: string }
  | { action: 'dismiss'; url: string }
  | { action: 'clear-finished' }

/** Settings tabs the popup can deep-link the host's panelView into.
 *  Mirrors `SettingsTab` in `views/SettingsModal.vue` — kept inline
 *  because the popup's tsconfig slice can't see the renderer's view
 *  layer. */
export type PopupSettingsTab = 'comfy' | 'directories' | 'downloads' | 'global'

export interface ComfyTitlePopupBridge {
  /** A menu item was clicked — main routes by id and hides the popup. */
  activate(id: string): void
  /** Close the popup without activating anything (Escape key, settings
   *  deep-link, etc.). */
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
  /** Subscribe to live downloads-tray state pushes. Fires every time
   *  the main-side download manager broadcasts a new state and on the
   *  initial state push for a freshly-opened downloads popup. */
  onDownloadsChanged(cb: (state: PopupDownloadsState) => void): () => void
  /** Dispatch a per-entry action (pause / resume / cancel /
   *  show-in-folder) to main, which routes to the corresponding
   *  download-manager API. */
  downloadsAction(action: PopupDownloadAction): void
  /** Close the popup and ask main to open the unified Settings modal
   *  on the host's panelView at the given tab. Used by the downloads
   *  view's "View all in Settings…" link. */
  openSettingsTab(tab: PopupSettingsTab): void
  /** Ask main to resize the popup view to the given natural content
   *  height (CSS px). Main clamps to a [min, max] band so the popup
   *  shrinks to fit empty / few-entry states and stays compact under
   *  long histories. Only meaningful for the `'downloads'` kind — the
   *  menu kind is sized deterministically from its item list. */
  requestSize(height: number): void
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

function isDownloadsState(value: unknown): value is PopupDownloadsState {
  if (!value || typeof value !== 'object') return false
  const v = value as { active?: unknown; recent?: unknown }
  return Array.isArray(v.active) && Array.isArray(v.recent)
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
  onDownloadsChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, data: unknown): void => {
      if (isDownloadsState(data)) cb(data)
    }
    ipcRenderer.on('comfy-titlepopup:downloads-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlepopup:downloads-changed', handler)
  },
  downloadsAction: (action) => {
    ipcRenderer.send('comfy-titlepopup:downloads-action', action)
  },
  openSettingsTab: (tab) => {
    ipcRenderer.send('comfy-titlepopup:open-settings-tab', { tab })
  },
  requestSize: (height) => {
    if (!Number.isFinite(height) || height <= 0) return
    ipcRenderer.send('comfy-titlepopup:request-size', { height })
  },
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('__comfyTitlePopup', bridge)
} else {
  ;(globalThis as Record<string, unknown>).__comfyTitlePopup = bridge
}
