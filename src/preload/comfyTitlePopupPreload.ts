import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { PICKER_SETTINGS_CHANNELS as CH } from '../types/ipc'

/** Bridge for the title-bar dropdown popup (waffle menu, downloads tray,
 *  instance-picker, global-settings), which share one reused child
 *  WebContentsView per parent window. */

export interface TitlePopupMenuItem {
  id?: string
  /** English fallback when `labelKey` is set; rendered verbatim otherwise. */
  label?: string
  /** vue-i18n key the popup resolves against the shared en catalog, so
   *  main-built labels participate in i18n. */
  labelKey?: string
  checked?: boolean
  kind?: 'separator'
}

/** Single install row pushed to the picker. MUST stay a superset of
 *  `Installation` in `src/types/ipc.ts`, and mirror `InstancePickerInstall`
 *  in `src/main/popups/titlePopup.ts` (the popup's tsconfig can't see main's
 *  types). */
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
  /** Selected install in the picker's right pane; defaults to the host's active
   *  install on open. */
  selectedInstallationId: string | null
  /** Bumped only on a main-initiated selection retarget. The picker applies the
   *  snapshot's `selectedInstallationId` only when this advances, so a stale
   *  broadcast can't override the user's local click. Optional for older bundles. */
  pickerSelectionEpoch?: number
  /** Detail sections for the selected install (`getDetailSections` shape);
   *  `null` when no selection. */
  selectedSettings: Record<string, unknown>[] | null
  /** Snapshot list for the selected install (`get-snapshots` shape); `null` when
   *  no selection. */
  selectedSnapshots: Record<string, unknown> | null
  /** Tab the settings UI opens on; `null` = picker view default. */
  initialTab: string | null
  /** Action id auto-fired after the settings UI mounts; `null` once consumed. */
  autoAction: string | null
  autoActionNonce: number
  /** Installs with an inline background op in flight; drives the spinner dot. */
  operatingInstallationIds: string[]
  installOperationStatus: Record<string, {
    status: string
    percent: number
    done: boolean
    ok: boolean | null
    error: string | null
    cancellable: boolean
    title: string
    actionId: string
    actionData?: Record<string, unknown>
  }>
}

/** Mirrors `GlobalSettingsModelsDir` in `src/main/popups/titlePopup.ts`. */
export interface PopupGlobalSettingsModelsDir {
  path: string
  isPrimary: boolean
  isDefault: boolean
}

/** Snapshot for the global-settings popup; field arrays are loose-typed (the
 *  renderer casts to `DetailField` on receipt). */
export interface PopupGlobalSettingsSnapshot {
  generalFields: Record<string, unknown>[]
  telemetryFields: Record<string, unknown>[]
  desktopUpdateFields: Record<string, unknown>[]
  cacheFields: Record<string, unknown>[]
  advancedFields: Record<string, unknown>[]
  sharedDirectoriesFields: Record<string, unknown>[]
  installLocationFields: Record<string, unknown>[]
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
  githubUrl: string
  githubStars: number | null
  githubStarsLoading: boolean
  i18n: {
    overview: string
    updates: string
    storage: string
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

/** Mirrors `DownloadProgress` in `src/main/lib/comfyDownloadManager.ts`. */
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
  /** First-seen timestamp (ms), stable across status transitions so terminal
   *  entries keep their slot in a single insertion-ordered list. */
  createdAt?: number
  /** Set on a completed image asset; the popup lazily requests a thumbnail. */
  isImage?: boolean
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
  | { action: 'retry'; url: string }
  | { action: 'clear-finished' }

/** Settings tabs the popup can deep-link the host's panelView into. */
export type PopupSettingsTab = 'comfy' | 'directories' | 'downloads' | 'global'

export interface ComfyTitlePopupBridge {
  /** Host OS, for OS-conditional copy without IPC. */
  platform: NodeJS.Platform
  /** A menu item was clicked — main routes by id and hides the popup. */
  activate(id: string): void
  close(): void
  /** Renderer mounted; main flushes any config queued before ready. */
  ready(): void
  /** Renderer applied a config update and the new DOM painted; main waits for
   *  this before showing so no frame of the previous open's content is seen. */
  notifyRendered(): void
  /** Config push (one per open). */
  onConfig(cb: (config: TitlePopupConfig) => void): () => void
  onDownloadsChanged(cb: (state: PopupDownloadsState) => void): () => void
  /** Per-entry action (pause/resume/cancel/show-in-folder) routed to the
   *  download-manager API. */
  downloadsAction(action: PopupDownloadAction): void
  /** Close and open the unified Settings modal at the given tab. */
  openSettingsTab(tab: PopupSettingsTab): void
  /** Close and mount the standalone "View All Downloads" modal — for monitoring
   *  large downloads without the popup auto-dismissing on focus loss. */
  openDownloadsModal(): void
  /** Resize the popup to the given natural content height (CSS px); main clamps
   *  to a band. Only the `'downloads'`/`'instance-picker'` kinds use this. */
  requestSize(height: number): void
  /** Live picker snapshot pushes while a picker is open. */
  onInstancePickerSnapshot(
    cb: (snapshot: PopupInstancePickerSnapshot) => void,
  ): () => void
  /** Picker → pick install (focus-or-launch). Dismissed before launch. */
  pickInstall(installationId: string): void
  /** Picker → "+ New Install" row, landing on the same surface as the file
   *  menu's New Install. */
  openNewInstall(): void
  /** Picker → restart a running install (stop, then focus-or-launch). Pass
   *  `{ confirmed: true }` when an in-drawer confirm already ran so main skips
   *  its system-modal. */
  restartInstall(installationId: string, opts?: { confirmed?: boolean }): void
  /** Downscaled `data:` URL preview of a completed image download (the popup
   *  has no `window.api`); null for non-images / unreadable files. */
  getDownloadThumbnail(savePath: string): Promise<string | null>
  /** Cloud capacity status; the popup has no `window.api`, so this gives
   *  `useCloudCapacity` an equivalent read path. */
  getCloudCapacity(): Promise<'normal' | 'degraded' | 'disabled'>
  /** Cloud subscription tier; 'paid' relaxes a `disabled` gate to `degraded`. */
  getCloudUserTier(): Promise<'free' | 'paid' | 'unknown'>
  /** Tell main the right pane switched to this install; main re-resolves its
   *  Settings + Snapshots and pushes a fresh snapshot. Idempotent. */
  setPickerSelectedInstall(installationId: string | null): void
  /** Picker → mutate a settings field via the drawer's allowlist + handler. */
  pickerUpdateField(
    installationId: string,
    fieldId: string,
    value: unknown,
  ): Promise<{ ok: boolean; message?: string }>
  /** Picker → run a snapshot-lifecycle action; main enforces an allowlist. */
  pickerRunAction(
    installationId: string,
    actionId: 'snapshot-save' | 'snapshot-restore' | 'snapshot-delete',
    actionData?: Record<string, unknown>,
  ): Promise<{ ok: boolean; message?: string }>
  /** Picker → install-level action forwarded to the parent panel's
   *  `useInstallContextMenu` dispatch. */
  openInstallAction(installationId: string, actionId: string): void
  /** Fires before every show, including the fast path that skips `set-config`,
   *  so views can reset transient per-open state that `onConfig` would miss. */
  onWillShow(cb: (info: { kind: TitlePopupConfig['kind'] }) => void): () => void
  /** Live global-settings snapshot pushes while that popup is open. */
  onGlobalSettingsSnapshot(
    cb: (snapshot: PopupGlobalSettingsSnapshot) => void,
  ): () => void
  /** Global Settings → write a setting (the popup lacks `window.api`). */
  globalSettingsUpdateField(
    fieldId: string,
    value: unknown,
  ): Promise<{ ok: boolean; message?: string }>
  globalSettingsSetModelsDirs(dirs: string[]): Promise<{ ok: boolean }>
  globalSettingsBrowseFolder(defaultPath?: string): Promise<string | null>
  globalSettingsOpenPath(path: string): void
  /** http/https only (enforced main-side). */
  globalSettingsOpenExternal(url: string): void
  globalSettingsCheckForUpdate(): Promise<{ available: boolean; version?: string; error?: string }>
  globalSettingsDownloadUpdate(): Promise<void>
  globalSettingsInstallUpdate(): void
  /** Renderer mirrors `localStorage.lastCheckedAt` back so the next snapshot
   *  shows the freshest timestamp. */
  globalSettingsSetLastCheckedAt(value: number): void

  // Per-install settings (picker's expanded Manage). Each is a 1:1 pass-through
  // to the main-side IPC; `pickerSettings*` keeps them distinct from
  // `globalSettings*`. The `window.api` shim in `comfyTitlePopup/main.ts`
  // re-exports these under their original names so the settings UI runs unchanged.
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
  /** Relaunch the app (`app.relaunch()` main-side). */
  pickerSettingsRelaunchApp(): void
  /** Pull the panel-side i18n catalog; the popup boots with a minimal static
   *  one and merges this on top once the expanded settings UI opens. */
  pickerSettingsGetLocaleMessages(): Promise<Record<string, unknown>>
  /** Fires when `enrichCommitsAhead` writes a new `commitsAhead`, so the open
   *  pane upgrades the "Latest from GitHub" card in place. */
  pickerSettingsOnReleaseCacheEnriched(
    callback: (data: { repo: string }) => void,
  ): () => void
  /** Forward a `show-progress` request to the parent panel renderer, which
   *  rebuilds the apiCall closure and routes through its ProgressModal. */
  pickerForwardShowProgress(payload: {
    installationId: string
    actionId: string
    actionData?: Record<string, unknown>
    title: string
    cancellable?: boolean
    triggersInstanceStart?: boolean
    opKind?: 'launch' | 'install' | 'update' | 'destructive' | 'snapshot' | 'generic'
    isRestart?: boolean
    routing?: 'same-host' | 'target-host' | 'inline-picker'
    successChoice?: boolean
  }): void
  /** Start a long-running action as an inline background op; the picker stays
   *  open and gets live progress via snapshot broadcasts. */
  pickerStartBackgroundOp(payload: {
    installationId: string
    actionId: string
    actionData?: Record<string, unknown>
    title: string
    cancellable: boolean
  }): void
  pickerCancelBackgroundOp(installationId: string): void
  /** Dismiss a completed background op so the right pane returns to settings. */
  pickerDismissBackgroundOp(installationId: string): void
  /** Main wants the renderer to cancel open modal/dialog state (e.g. before a
   *  kind-switch hide) so a half-open confirm doesn't survive as orphaned
   *  state. The handler should resolve open entries as if a backdrop was clicked. */
  onDismissModals(cb: () => void): () => void
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
  if (!Array.isArray(v['generalFields'])) return false
  if (!Array.isArray(v['telemetryFields'])) return false
  if (!Array.isArray(v['desktopUpdateFields'])) return false
  if (!Array.isArray(v['cacheFields'])) return false
  if (!Array.isArray(v['advancedFields'])) return false
  if (!Array.isArray(v['sharedDirectoriesFields'])) return false
  if (!Array.isArray(v['installLocationFields'])) return false
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
    pickerSelectionEpoch?: unknown
    selectedSettings?: unknown
    selectedSnapshots?: unknown
    mode?: unknown
    initialTab?: unknown
    autoAction?: unknown
  }
  if (!Array.isArray(v.installs)) return false
  if (v.activeInstallationId !== null && typeof v.activeInstallationId !== 'string') return false
  if (!Array.isArray(v.runningInstallationIds)) return false
  // Selected fields are optional on the wire so older bundles' snapshots validate.
  if (
    v.selectedInstallationId !== undefined
    && v.selectedInstallationId !== null
    && typeof v.selectedInstallationId !== 'string'
  ) return false
  if (
    v.pickerSelectionEpoch !== undefined
    && typeof v.pickerSelectionEpoch !== 'number'
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
  restartInstall: (installationId, opts) => {
    ipcRenderer.send('comfy-titlepopup:restart-install', {
      installationId,
      confirmed: opts?.confirmed === true,
    })
  },
  getDownloadThumbnail: (savePath: string) =>
    ipcRenderer.invoke('download-thumbnail', { savePath }),
  getCloudCapacity: async () => {
    // Reuses the panel's `get-cloud-capacity` handler, which awaits the boot
    // fetch so the first call doesn't race the network.
    const result = await ipcRenderer.invoke('get-cloud-capacity')
    if (result === 'normal' || result === 'degraded' || result === 'disabled') {
      return result
    }
    return 'normal'
  },
  getCloudUserTier: async () => {
    const result = await ipcRenderer.invoke('get-cloud-user-tier')
    if (result === 'free' || result === 'paid' || result === 'unknown') {
      return result
    }
    return 'unknown'
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
  // Per-install settings: 1:1 pass-throughs to the main-side IPC, namespaced so
  // they don't collide with the panel's `window.api` IPCs.
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
  pickerSettingsOnReleaseCacheEnriched: (callback) => {
    const handler = (_event: IpcRendererEvent, data: unknown) =>
      callback(data as { repo: string })
    ipcRenderer.on('release-cache-enriched', handler)
    return () => ipcRenderer.removeListener('release-cache-enriched', handler)
  },
  pickerForwardShowProgress: (payload) => {
    ipcRenderer.send('comfy-titlepopup:forward-show-progress', payload)
  },
  pickerStartBackgroundOp: (payload) => {
    ipcRenderer.send('comfy-titlepopup:start-background-op', payload)
  },
  pickerCancelBackgroundOp: (installationId) => {
    ipcRenderer.send('comfy-titlepopup:cancel-background-op', { installationId })
  },
  pickerDismissBackgroundOp: (installationId) => {
    ipcRenderer.send('comfy-titlepopup:dismiss-background-op', { installationId })
  },
  onDismissModals: (cb) => {
    const handler = (): void => cb()
    ipcRenderer.on('comfy-titlepopup:dismiss-modals', handler)
    return () => ipcRenderer.removeListener('comfy-titlepopup:dismiss-modals', handler)
  },
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('__comfyTitlePopup', bridge)
} else {
  ;(globalThis as Record<string, unknown>).__comfyTitlePopup = bridge
}
