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
  /** Currently-selected install in the picker's right pane. Drives
   *  which install's Settings + Snapshots accordions render. Defaults
   *  to the host's active install on open; flips when the user picks
   *  a different row (popup pushes via `setPickerSelectedInstall`). */
  selectedInstallationId: string | null
  /** Detail sections for the selected install — same shape
   *  `getDetailSections` returns to the renderer. `null` when no
   *  selection or the source can't produce sections. Typed loosely
   *  here because the preload's tsconfig slice can't see the
   *  renderer's `DetailSection` type. */
  selectedSettings: Record<string, unknown>[] | null
  /** Snapshot list payload for the selected install — same shape
   *  `get-snapshots` returns. `null` when no selection or no install
   *  path. */
  selectedSnapshots: Record<string, unknown> | null
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
  /** Picker → Restart on a running install. Main confirms via a native
   *  dialog (parented to the picker's host window), stops the running
   *  session, then re-runs the focus-or-launch flow against the same
   *  install so the user lands in a fresh Comfy window. Cancelling the
   *  confirm is a no-op. */
  restartInstall(installationId: string): void
  /** Tell main the picker's right-pane has switched to this install
   *  (or `null` when nothing is selected). Main re-resolves the
   *  install's Settings + Snapshots and pushes a fresh snapshot so
   *  the accordions render the new install's data. Idempotent. */
  setPickerSelectedInstall(installationId: string | null): void
  /** Picker → mutate a field on the selected install's settings.
   *  Routes through the same allowlist + handler the drawer uses.
   *  Resolves with `{ok, message?}` so the popup can show inline
   *  error UX without polling for a refreshed snapshot. */
  pickerUpdateField(
    installationId: string,
    fieldId: string,
    value: unknown,
  ): Promise<{ ok: boolean; message?: string }>
  /** Picker → run a snapshot-lifecycle action (save / restore /
   *  delete). Main enforces a strict allowlist on the channel so
   *  this can't fire arbitrary actions. */
  pickerRunAction(
    installationId: string,
    actionId: 'snapshot-save' | 'snapshot-restore' | 'snapshot-delete',
    actionData?: Record<string, unknown>,
  ): Promise<{ ok: boolean; message?: string }>
  /** Picker → run an install-level action via the parent panel's
   *  `useInstallContextMenu` dispatch. Main hides the popup, then
   *  forwards the action to the picker's parent host's panel renderer
   *  (panel-trigger-overlay `picker-install-action`). Allowed action
   *  ids match the picker's More menu: `open-folder`, `copy`, `remove`
   *  (untrack), `delete`. Delete routes through DetailModal so the
   *  source-side confirm + showProgress chain runs in its modal
   *  context; the rest fire `window.api.runAction` directly. */
  openInstallAction(installationId: string, actionId: string): void
  /** Fires every time main is about to show the popup view, including
   *  the fast path that skips re-sending `set-config` when the config
   *  is unchanged. Popup-side views use this to reset transient
   *  per-open state (e.g. the instance picker re-selects the host's
   *  currently-active install) — `onConfig` alone would miss the
   *  fast-path reopens. */
  onWillShow(cb: (info: { kind: TitlePopupConfig['kind'] }) => void): () => void
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
    selectedInstallationId?: unknown
    selectedSettings?: unknown
    selectedSnapshots?: unknown
  }
  if (!Array.isArray(v.installs)) return false
  if (v.activeInstallationId !== null && typeof v.activeInstallationId !== 'string') return false
  if (!Array.isArray(v.runningInstallationIds)) return false
  // Selected fields are optional on the wire — pre-v2 snapshots from
  // older bundles that haven't been rebuilt yet still validate.
  if (
    v.selectedInstallationId !== undefined
    && v.selectedInstallationId !== null
    && typeof v.selectedInstallationId !== 'string'
  ) return false
  if (
    v.selectedSettings !== undefined
    && v.selectedSettings !== null
    && !Array.isArray(v.selectedSettings)
  ) return false
  if (
    v.selectedSnapshots !== undefined
    && v.selectedSnapshots !== null
    && typeof v.selectedSnapshots !== 'object'
  ) return false
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
  restartInstall: (installationId) => {
    ipcRenderer.send('comfy-titlepopup:restart-install', { installationId })
  },
  setPickerSelectedInstall: (installationId) => {
    ipcRenderer.send('comfy-titlepopup:set-picker-selected-install', { installationId })
  },
  pickerUpdateField: (installationId, fieldId, value) =>
    ipcRenderer.invoke('comfy-titlepopup:picker-update-field', {
      installationId,
      fieldId,
      value,
    }),
  pickerRunAction: (installationId, actionId, actionData) =>
    ipcRenderer.invoke('comfy-titlepopup:picker-run-action', {
      installationId,
      actionId,
      actionData,
    }),
  openInstallAction: (installationId, actionId) => {
    ipcRenderer.send('comfy-titlepopup:open-install-action', {
      installationId,
      actionId,
    })
  },
  onWillShow: (cb) => {
    const handler = (_event: IpcRendererEvent, data: unknown): void => {
      if (!data || typeof data !== 'object') return
      const kind = (data as { kind?: unknown }).kind
      if (kind !== 'menu' && kind !== 'downloads' && kind !== 'instance-picker') return
      cb({ kind })
    }
    ipcRenderer.on('comfy-titlepopup:will-show', handler)
    return () => ipcRenderer.removeListener('comfy-titlepopup:will-show', handler)
  },
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('__comfyTitlePopup', bridge)
} else {
  ;(globalThis as Record<string, unknown>).__comfyTitlePopup = bridge
}
