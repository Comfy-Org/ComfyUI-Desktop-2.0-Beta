import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { PICKER_SETTINGS_CHANNELS as CH } from '../types/ipc'

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
  /** Compact = default identity-card right pane. Expanded = full
   *  per-install settings UI in the right pane + 95dvw×95dvh popup
   *  bounds. Flipped by `setPickerMode` IPC. */
  mode: 'compact' | 'expanded'
  /** When `mode === 'expanded'`, the tab the settings UI opens on
   *  ('config' | 'status' | 'update' | 'snapshots'). `null` in
   *  compact mode. */
  initialTab: string | null
  /** When `mode === 'expanded'`, an action id to fire automatically
   *  after the settings UI mounts (kebab Update / Migrate / etc.).
   *  `null` once consumed. */
  autoAction: string | null
}

/** One models-directory row pushed in the global-settings snapshot.
 *  Mirrors `GlobalSettingsModelsDir` in `src/main/popups/titlePopup.ts`. */
export interface PopupGlobalSettingsModelsDir {
  path: string
  isPrimary: boolean
  isDefault: boolean
}

/** Snapshot pushed to the global-settings popup. Field arrays + the
 *  `channelPickerField` are loose-typed (renderer casts to `DetailField`
 *  on receipt) because the preload tsconfig slice can't see the
 *  renderer's view types. */
export interface PopupGlobalSettingsSnapshot {
  overviewFields: Record<string, unknown>[]
  cacheFields: Record<string, unknown>[]
  advancedFields: Record<string, unknown>[]
  sharedDirectoriesFields: Record<string, unknown>[]
  modelsDirs: PopupGlobalSettingsModelsDir[]
  modelsSystemDefault: string
  appUpdate: {
    state: Record<string, unknown>
    progress: Record<string, unknown> | null
    isDownloading: boolean
    capabilities: { systemManaged: boolean; canSelfUpdate: boolean }
    installedVersion: string
    platform: NodeJS.Platform
    lastCheckedAt: number | null
  }
  channelPickerField: Record<string, unknown> | null
  activeInstallationId: string | null
  hasActiveInstall: boolean
  githubUrl: string
  i18n: {
    overview: string
    updates: string
    cache: string
    models: string
    advanced: string
    sharedDirectories: string
  }
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
  | {
      kind: 'global-settings'
      snapshot: PopupGlobalSettingsSnapshot
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
  /** Host OS — set synchronously from `process.platform`. Used by popup
   *  views for OS-conditional copy (e.g. "Show in Finder" vs
   *  "Show in Explorer") without IPC. */
  platform: NodeJS.Platform
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
  /** Close the popup and ask main to mount the standalone "View All
   *  Downloads" modal on the host's panelView. The richer, brand-
   *  redesigned companion to the popup tray — used when users want to
   *  monitor large multi-GB downloads without the popup auto-dismissing
   *  on focus loss. */
  openDownloadsModal(): void
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
  /** Subscribe to live global-settings snapshot pushes. Fires whenever
   *  any input changes (settings write / updater state / install-list
   *  change) while a global-settings popup is open. */
  onGlobalSettingsSnapshot(
    cb: (snapshot: PopupGlobalSettingsSnapshot) => void,
  ): () => void
  /** Global Settings → write a setting. Same side-effects as
   *  `window.api.setSetting`, but routed through the popup bridge so
   *  the popup renderer (which lacks `window.api`) can mutate. */
  globalSettingsUpdateField(
    fieldId: string,
    value: unknown,
  ): Promise<{ ok: boolean; message?: string }>
  /** Global Settings → persist the full models-dir list (add / remove
   *  / reorder). */
  globalSettingsSetModelsDirs(dirs: string[]): Promise<{ ok: boolean }>
  /** Open a directory picker. Returns the chosen path or `null` when
   *  the user cancels. */
  globalSettingsBrowseFolder(defaultPath?: string): Promise<string | null>
  /** Open a folder in the OS file manager. */
  globalSettingsOpenPath(path: string): void
  /** Open an external URL — restricted to http/https main-side. */
  globalSettingsOpenExternal(url: string): void
  /** Launcher updater — check / download / install. */
  globalSettingsCheckForUpdate(): Promise<{ available: boolean; version?: string; error?: string }>
  globalSettingsDownloadUpdate(): Promise<void>
  globalSettingsInstallUpdate(): void
  /** Renderer mirrors `localStorage.lastCheckedAt` back to main so the
   *  next snapshot rebroadcast shows the freshest timestamp. */
  globalSettingsSetLastCheckedAt(value: number): void
  /** ChannelPicker `@action` route. The IPC handler enforces the
   *  allowlist (`copy-update | release-update | switch-channel |
   *  update`); the popup just forwards whatever the picker emits. */
  globalSettingsRunInstallAction(
    installationId: string,
    actionId: string,
    actionData?: Record<string, unknown>,
  ): Promise<{ ok: boolean; message?: string }>

  // ----- Per-install (ComfyUI) settings bridge -----
  //
  // Picker's expanded Manage state runs the same per-install settings
  // UI the legacy drawer used (`ComfyUISettingsContent.vue` +
  // `useComfyUISettings`). The popup process has no `window.api`, so
  // each `window.api.*` method that UI calls gets a thin pass-through
  // here. Naming is `pickerSettings*` to keep these clearly distinct
  // from `globalSettings*` (which is the launcher-wide settings popup
  // — different surface, different scope).
  //
  // Each one is a 1:1 wrapper over the corresponding main-side handler
  // (no validation or transformation in the popup process). The popup's
  // `window.api` shim in `comfyTitlePopup/main.ts` re-exports these
  // under their original `window.api.*` names so the settings UI runs
  // unchanged.
  pickerSettingsGetDetailSections(installationId: string): Promise<Record<string, unknown>[]>
  pickerSettingsGetDiskSpace(path: string): Promise<{ total: number; free: number }>
  pickerSettingsUpdateInstallation(
    installationId: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown> | void>
  pickerSettingsRunAction(
    installationId: string,
    actionId: string,
    actionData?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>
  pickerSettingsGetFieldOptions(
    sourceId: string,
    fieldId: string,
    selections: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]>
  pickerSettingsGetInstallations(): Promise<Record<string, unknown>[]>
  pickerSettingsGetInstallationSize(installationId: string): Promise<{ sizeBytes: number }>
  pickerSettingsStopComfyUI(installationId: string): Promise<void>
  pickerSettingsGetSnapshots(installationId: string): Promise<Record<string, unknown>>
  pickerSettingsGetSnapshotDetail(
    installationId: string,
    filename: string,
  ): Promise<Record<string, unknown>>
  pickerSettingsGetSnapshotDiff(
    installationId: string,
    filename: string,
    mode: 'previous' | 'current',
  ): Promise<Record<string, unknown>>
  pickerSettingsExportSnapshot(
    installationId: string,
    filename: string,
  ): Promise<{ ok: boolean; message?: string }>
  pickerSettingsExportAllSnapshots(
    installationId: string,
  ): Promise<{ ok: boolean; message?: string }>
  pickerSettingsImportSnapshotsPreview(): Promise<{
    ok: boolean
    preview?: Record<string, unknown>
    message?: string
  }>
  pickerSettingsImportSnapshotsDiff(
    installationId: string,
  ): Promise<{ ok: boolean; diff?: Record<string, unknown>; message?: string }>
  pickerSettingsImportSnapshotsConfirm(installationId: string): Promise<{
    ok: boolean
    imported?: number
    restoreFile?: string
    message?: string
  }>
  pickerSettingsPreviewSnapshotFile(): Promise<{
    ok: boolean
    preview?: Record<string, unknown>
    message?: string
  }>
  pickerSettingsGetComfyArgs(
    installationId: string,
  ): Promise<{ args: Record<string, unknown>[]; error?: string } | null>
  pickerSettingsBrowseFolder(opts?: { defaultPath?: string }): Promise<string | null>
  pickerSettingsCancelOperation(installationId: string): Promise<void>
  pickerSettingsPreviewDesktopMigration(
    installationId: string,
    desktopId: string,
  ): Promise<Record<string, unknown>>
  pickerSettingsPreviewLocalMigration(
    installationId: string,
  ): Promise<Record<string, unknown>>
  /** Relaunch the app — used by `ComfyUISettingsContent`'s footer
   *  Relaunch button. Routes to `app.relaunch()` main-side. */
  pickerSettingsRelaunchApp(): void
  /** Pull the panel-side i18n catalog (loaded from main's
   *  `locales/en.json`). The popup process boots with a minimal static
   *  catalog (`i18nMessages.ts`); the expanded settings UI needs keys
   *  the panel catalog has but the static one doesn't (`actions.*`,
   *  `diskSpace.*`, etc.). The popup merges this payload on top of its
   *  static catalog once the expanded mode opens. */
  pickerSettingsGetLocaleMessages(): Promise<Record<string, unknown>>
  /** Flip the picker between its compact and expanded states. Main
   *  animates the popup bounds (compact ~720×natural → expanded
   *  ~95dvw×95dvh) and rebroadcasts a snapshot with `mode` set so the
   *  picker view re-renders the right pane (compact identity card vs.
   *  expanded `ComfyUISettingsContent`). */
  setPickerMode(
    mode: 'compact' | 'expanded',
    opts?: { initialTab?: string; autoAction?: string | null },
  ): void
  /** Forward a `show-progress` request from the picker's settings UI to
   *  the parent host's panel renderer. The panel rebuilds the apiCall
   *  closure from `actionId`/`actionData` and routes through its existing
   *  ProgressModal pipeline. Picker collapses to compact so the modal is
   *  not occluded. */
  pickerForwardShowProgress(payload: {
    installationId: string
    actionId: string
    actionData?: Record<string, unknown>
    title: string
    cancellable?: boolean
    triggersInstanceStart?: boolean
    opKind?: 'launch' | 'install' | 'update' | 'destructive' | 'snapshot' | 'generic'
    isRestart?: boolean
  }): void
}

function isPopupConfig(value: unknown): value is TitlePopupConfig {
  if (!value || typeof value !== 'object') return false
  const v = value as {
    kind?: unknown
    items?: unknown
    theme?: unknown
    snapshot?: unknown
  }
  if (
    v.kind !== 'menu'
    && v.kind !== 'downloads'
    && v.kind !== 'instance-picker'
    && v.kind !== 'global-settings'
  ) return false
  if (!v.theme || typeof v.theme !== 'object') return false
  const theme = v.theme as { bg?: unknown; text?: unknown }
  if (typeof theme.bg !== 'string' || typeof theme.text !== 'string') return false
  if (v.kind === 'menu' && !Array.isArray(v.items)) return false
  if (v.kind === 'instance-picker' && !isInstancePickerSnapshot(v.snapshot)) return false
  if (v.kind === 'global-settings' && !isGlobalSettingsSnapshot(v.snapshot)) return false
  return true
}

function isGlobalSettingsSnapshot(value: unknown): value is PopupGlobalSettingsSnapshot {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (!Array.isArray(v['overviewFields'])) return false
  if (!Array.isArray(v['cacheFields'])) return false
  if (!Array.isArray(v['advancedFields'])) return false
  if (!Array.isArray(v['sharedDirectoriesFields'])) return false
  if (!Array.isArray(v['modelsDirs'])) return false
  if (typeof v['modelsSystemDefault'] !== 'string') return false
  if (!v['appUpdate'] || typeof v['appUpdate'] !== 'object') return false
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
    mode?: unknown
    initialTab?: unknown
    autoAction?: unknown
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
  // Mode fields are also optional on the wire — old main builds that
  // don't yet emit them still validate. Default to compact in the
  // consumer when missing.
  if (v.mode !== undefined && v.mode !== 'compact' && v.mode !== 'expanded') return false
  if (
    v.initialTab !== undefined
    && v.initialTab !== null
    && typeof v.initialTab !== 'string'
  ) return false
  if (
    v.autoAction !== undefined
    && v.autoAction !== null
    && typeof v.autoAction !== 'string'
  ) return false
  return true
}

const bridge: ComfyTitlePopupBridge = {
  platform: process.platform,
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
  openDownloadsModal: () => {
    ipcRenderer.send('comfy-titlepopup:open-downloads-modal')
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
      if (
        kind !== 'menu'
        && kind !== 'downloads'
        && kind !== 'instance-picker'
        && kind !== 'global-settings'
      ) return
      cb({ kind })
    }
    ipcRenderer.on('comfy-titlepopup:will-show', handler)
    return () => ipcRenderer.removeListener('comfy-titlepopup:will-show', handler)
  },
  onGlobalSettingsSnapshot: (cb) => {
    const handler = (_event: IpcRendererEvent, data: unknown): void => {
      if (isGlobalSettingsSnapshot(data)) cb(data)
    }
    ipcRenderer.on('comfy-titlepopup:global-settings-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlepopup:global-settings-changed', handler)
  },
  globalSettingsUpdateField: (fieldId, value) =>
    ipcRenderer.invoke('comfy-titlepopup:global-settings-update-field', { fieldId, value }),
  globalSettingsSetModelsDirs: (dirs) =>
    ipcRenderer.invoke('comfy-titlepopup:global-settings-set-models-dirs', { dirs }),
  globalSettingsBrowseFolder: (defaultPath) =>
    ipcRenderer.invoke('comfy-titlepopup:global-settings-browse-folder', { defaultPath }),
  globalSettingsOpenPath: (path) => {
    ipcRenderer.send('comfy-titlepopup:global-settings-open-path', { path })
  },
  globalSettingsOpenExternal: (url) => {
    ipcRenderer.send('comfy-titlepopup:global-settings-open-external', { url })
  },
  globalSettingsCheckForUpdate: () =>
    ipcRenderer.invoke('comfy-titlepopup:global-settings-check-for-update'),
  globalSettingsDownloadUpdate: () =>
    ipcRenderer.invoke('comfy-titlepopup:global-settings-download-update'),
  globalSettingsInstallUpdate: () => {
    ipcRenderer.send('comfy-titlepopup:global-settings-install-update')
  },
  globalSettingsSetLastCheckedAt: (value) => {
    ipcRenderer.send('comfy-titlepopup:global-settings-set-last-checked', { value })
  },
  globalSettingsRunInstallAction: (installationId, actionId, actionData) =>
    ipcRenderer.invoke('comfy-titlepopup:global-settings-run-install-action', {
      installationId,
      actionId,
      actionData,
    }),
  // Per-install settings (picker expanded Manage). Each handler is a 1:1
  // pass-through to the main-side IPC. Channels namespaced `comfy-titlepopup:*`
  // so they don't collide with the panel's `window.api` IPCs.
  pickerSettingsGetDetailSections: (installationId) =>
    ipcRenderer.invoke(CH.getDetailSections, { installationId }),
  pickerSettingsGetDiskSpace: (path) => ipcRenderer.invoke(CH.getDiskSpace, { path }),
  pickerSettingsUpdateInstallation: (installationId, data) =>
    ipcRenderer.invoke(CH.updateInstallation, { installationId, data }),
  pickerSettingsRunAction: (installationId, actionId, actionData) =>
    ipcRenderer.invoke(CH.runAction, { installationId, actionId, actionData }),
  pickerSettingsGetFieldOptions: (sourceId, fieldId, selections) =>
    ipcRenderer.invoke(CH.getFieldOptions, { sourceId, fieldId, selections }),
  pickerSettingsGetInstallations: () => ipcRenderer.invoke(CH.getInstallations),
  pickerSettingsGetInstallationSize: (installationId) =>
    ipcRenderer.invoke(CH.getInstallationSize, { installationId }),
  pickerSettingsStopComfyUI: (installationId) =>
    ipcRenderer.invoke(CH.stopComfyUI, { installationId }),
  pickerSettingsGetSnapshots: (installationId) =>
    ipcRenderer.invoke(CH.getSnapshots, { installationId }),
  pickerSettingsGetSnapshotDetail: (installationId, filename) =>
    ipcRenderer.invoke(CH.getSnapshotDetail, { installationId, filename }),
  pickerSettingsGetSnapshotDiff: (installationId, filename, mode) =>
    ipcRenderer.invoke(CH.getSnapshotDiff, { installationId, filename, mode }),
  pickerSettingsExportSnapshot: (installationId, filename) =>
    ipcRenderer.invoke(CH.exportSnapshot, { installationId, filename }),
  pickerSettingsExportAllSnapshots: (installationId) =>
    ipcRenderer.invoke(CH.exportAllSnapshots, { installationId }),
  pickerSettingsImportSnapshotsPreview: () => ipcRenderer.invoke(CH.importSnapshotsPreview),
  pickerSettingsImportSnapshotsDiff: (installationId) =>
    ipcRenderer.invoke(CH.importSnapshotsDiff, { installationId }),
  pickerSettingsImportSnapshotsConfirm: (installationId) =>
    ipcRenderer.invoke(CH.importSnapshotsConfirm, { installationId }),
  pickerSettingsPreviewSnapshotFile: () => ipcRenderer.invoke(CH.previewSnapshotFile),
  pickerSettingsGetComfyArgs: (installationId) =>
    ipcRenderer.invoke(CH.getComfyArgs, { installationId }),
  pickerSettingsBrowseFolder: (opts) =>
    ipcRenderer.invoke(CH.browseFolder, { defaultPath: opts?.defaultPath }),
  pickerSettingsCancelOperation: (installationId) =>
    ipcRenderer.invoke(CH.cancelOperation, { installationId }),
  pickerSettingsPreviewDesktopMigration: (installationId, desktopId) =>
    ipcRenderer.invoke(CH.previewDesktopMigration, { installationId, desktopId }),
  pickerSettingsPreviewLocalMigration: (installationId) =>
    ipcRenderer.invoke(CH.previewLocalMigration, { installationId }),
  pickerSettingsRelaunchApp: () => {
    ipcRenderer.send(CH.relaunchApp)
  },
  pickerSettingsGetLocaleMessages: () => ipcRenderer.invoke(CH.getLocaleMessages),
  setPickerMode: (mode, opts) => {
    ipcRenderer.send('comfy-titlepopup:set-picker-mode', {
      mode,
      initialTab: opts?.initialTab,
      autoAction: opts?.autoAction ?? null,
    })
  },
  pickerForwardShowProgress: (payload) => {
    ipcRenderer.send('comfy-titlepopup:forward-show-progress', payload)
  },
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('__comfyTitlePopup', bridge)
} else {
  ;(globalThis as Record<string, unknown>).__comfyTitlePopup = bridge
}
