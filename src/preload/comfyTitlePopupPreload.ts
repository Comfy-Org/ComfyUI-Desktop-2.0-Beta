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

/** Single install row pushed to the instance-picker popup. Mirror of
 *  `InstancePickerInstall` in `src/main/popups/titlePopup.ts` — kept in
 *  sync because the popup's tsconfig slice can't see the main process's
 *  types. Renderer-side `useInstallList` consumes this through the
 *  `Installation` interface in `src/types/ipc.ts` so the fields here
 *  must remain a superset of that. */
export interface PopupInstancePickerInstall {
  id: string
  name: string
  sourceLabel: string
  sourceCategory: string
  version?: string
  statusTag?: { style: string; label: string }
  lastLaunchedAt?: number
  installPath?: string
  status?: string
  [key: string]: unknown
}

export interface PopupInstancePickerSnapshot {
  installs: PopupInstancePickerInstall[]
  activeInstallationId: string | null
  runningInstallationIds: string[]
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
  | {
      kind: 'instance-picker'
      snapshot: PopupInstancePickerSnapshot
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
   *  long histories. Only meaningful for the `'downloads'` /
   *  `'instance-picker'` kinds — the menu kind is sized deterministically
   *  from its item list. */
  requestSize(height: number): void
  /** Subscribe to live instance-picker snapshot pushes. Fires whenever
   *  the install registry changes while a picker is open (add / remove
   *  / rename / mark-launched / running-state transitions). The popup
   *  re-binds its row list + re-evaluates the active row from the
   *  pushed `activeInstallationId`. */
  onInstancePickerSnapshot(
    cb: (snapshot: PopupInstancePickerSnapshot) => void,
  ): () => void
  /** Picker → pick install. Main implements the focus-or-launch
   *  contract: focus the running window if any, otherwise route to the
   *  host's panel renderer to launch in a new Comfy window. The popup
   *  is dismissed before the launch fires so the new window comes up
   *  unobstructed. */
  pickInstall(installationId: string): void
  /** Picker → "+ New Install" row. Routes to a fresh chooser host
   *  window's new-install panel — same surface the file menu's
   *  "New Install" entry lands on. */
  openNewInstall(): void
}

function isPopupConfig(value: unknown): value is TitlePopupConfig {
  if (!value || typeof value !== 'object') return false
  const v = value as {
    kind?: unknown
    items?: unknown
    theme?: unknown
    snapshot?: unknown
  }
  if (v.kind !== 'menu' && v.kind !== 'downloads' && v.kind !== 'instance-picker') return false
  if (!v.theme || typeof v.theme !== 'object') return false
  const theme = v.theme as { bg?: unknown; text?: unknown }
  if (typeof theme.bg !== 'string' || typeof theme.text !== 'string') return false
  if (v.kind === 'menu' && !Array.isArray(v.items)) return false
  if (v.kind === 'instance-picker' && !isInstancePickerSnapshot(v.snapshot)) return false
  return true
}

function isDownloadsState(value: unknown): value is PopupDownloadsState {
  if (!value || typeof value !== 'object') return false
  const v = value as { active?: unknown; recent?: unknown }
  return Array.isArray(v.active) && Array.isArray(v.recent)
}

function isInstancePickerSnapshot(value: unknown): value is PopupInstancePickerSnapshot {
  if (!value || typeof value !== 'object') return false
  const v = value as {
    installs?: unknown
    activeInstallationId?: unknown
    runningInstallationIds?: unknown
  }
  if (!Array.isArray(v.installs)) return false
  if (v.activeInstallationId !== null && typeof v.activeInstallationId !== 'string') return false
  if (!Array.isArray(v.runningInstallationIds)) return false
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
  onInstancePickerSnapshot: (cb) => {
    const handler = (_event: IpcRendererEvent, data: unknown): void => {
      if (isInstancePickerSnapshot(data)) cb(data)
    }
    ipcRenderer.on('comfy-titlepopup:installs-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlepopup:installs-changed', handler)
  },
  pickInstall: (installationId) => {
    ipcRenderer.send('comfy-titlepopup:pick-install', { installationId })
  },
  openNewInstall: () => {
    ipcRenderer.send('comfy-titlepopup:open-new-install')
  },
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('__comfyTitlePopup', bridge)
} else {
  ;(globalThis as Record<string, unknown>).__comfyTitlePopup = bridge
}
