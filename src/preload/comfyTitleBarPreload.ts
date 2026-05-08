import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { ElectronApi, ResolvedTheme } from '../types/ipc'

export type ComfyPanelKey =
  | 'comfy'
  | 'settings'
  | 'new-install'
  | 'track'
  | 'load-snapshot'
  | 'quick-install'

/** Anchor coordinates for a native title-bar menu — title-bar-local
 *  pixels (x = button left, y = button bottom). The titleBarView sits
 *  at window y=0 so these coordinates double as window coordinates in
 *  main. */
export interface TitleMenuAnchor {
  x: number
  y: number
}

/** Track F — single download entry surfaced by the title-bar tray.
 *  Mirror of the main-side `DownloadProgress` shape, kept in sync via
 *  `comfy-titlebar:downloads-changed` push. The title bar renders only
 *  a status-icon + filename + progress percent — it doesn't need
 *  byte counters or speed/ETA, so this interface stays minimal. */
export interface DownloadsTrayEntry {
  url: string
  filename: string
  directory?: string
  progress: number
  status: 'pending' | 'downloading' | 'paused' | 'completed' | 'error' | 'cancelled'
  error?: string
}

/** Track F — payload pushed by main on `comfy-titlebar:downloads-changed`.
 *  `active` is every in-flight (`pending` / `downloading` / `paused`)
 *  download; `recent` is the last N terminal entries (oldest first),
 *  capped server-side. The tray icon hides entirely when both arrays
 *  are empty. */
export interface DownloadsTrayState {
  active: DownloadsTrayEntry[]
  recent: DownloadsTrayEntry[]
}

export interface ComfyTitleBarBridge {
  /** The installation this title bar belongs to. */
  getInstallationId(): string | null
  /** Whether the host is macOS — controls left padding for traffic lights. */
  isMac(): boolean
  /** Request the main process to swap the active panel. */
  setPanel(panel: ComfyPanelKey): void
  /** File menu → "New Window" (Phase 3 title bar v2). Opens a fresh
   *  install-less chooser host window. Always creates a new one — the
   *  focus-existing path lives on the tray entry. */
  openNewWindow(): void
  /** Pop the File menu as a native OS menu. Avoids HTML popups that
   *  would be clipped by the title bar's WebContentsView bounds. */
  openFileMenu(anchor: TitleMenuAnchor): void
  /** Ask main to dismiss the File menu popup. Used to toggle the menu
   *  closed when the user reclicks the menu button while it is open
   *  — on macOS the blur-driven dismiss isn't reliable for sibling
   *  WebContentsView clicks. */
  dismissFileMenu(): void

  /** Subscribe to panel-active changes coming from main. */
  onPanelChanged(cb: (panel: ComfyPanelKey) => void): () => void
  /** Subscribe to title text changes coming from main. */
  onTitleChanged(cb: (title: string) => void): () => void
  /** Track B item 4 — subscribe to install source-category pushes
   *  from main. The raw category string (e.g. `'local'`, `'cloud'`,
   *  `'desktop'`) drives the install-type icon in the title bar via
   *  the renderer's `installTypeMetaFor()` helper. `null` for
   *  install-less host windows or when the install's source can't be
   *  resolved — the renderer suppresses the icon entirely in that
   *  case. */
  onSourceCategoryChanged(cb: (category: string | null) => void): () => void
  /** Subscribe to theme updates (background + symbol color). */
  onThemeChanged(cb: (theme: { bg: string; text: string }) => void): () => void
  /** Subscribe to macOS fullscreen state — drives traffic-light padding. */
  onFullscreenChanged(cb: (fullscreen: boolean) => void): () => void
  /** Subscribe to native title-bar menu open events. Fires when the
   *  popup becomes visible. The renderer uses this to track open
   *  state so a click on the menu button while open is suppressed
   *  (the blur-driven dismiss handles the close on its own). On
   *  macOS the click event can fire before the dismiss propagates,
   *  so a timestamp-only guard isn't reliable. */
  onMenuOpened(cb: (info: { menu: 'file' }) => void): () => void
  /** Subscribe to native title-bar menu close events. Fires when the
   *  popup created by `openFileMenu` closes, after the user picks an
   *  item or dismisses by clicking outside. The renderer uses this to
   *  suppress an immediate re-open if the same click that dismissed
   *  the menu also re-targets the menu button. */
  onMenuClosed(cb: (info: { menu: 'file' }) => void): () => void
  /** Subscribe to first-use takeover step changes (modal-unification
   *  Track M-2.2). Mode mirrors `firstUseMode` on the entry —
   *  `'none'` for no takeover mounted, `'consent-lockdown'` while the
   *  T&C consent step is on screen, `'post-consent'` for any later
   *  step. M-2.3 will use this to lock down the title bar during
   *  `'consent-lockdown'`; M-2.2 only plumbs the IPC end-to-end. */
  onFirstUseModeChanged(
    cb: (mode: 'none' | 'consent-lockdown' | 'post-consent') => void,
  ): () => void
  /** Subscribe to app-update state pushes (Phase 3 §18 status pills).
   *  `kind` is `'available'` after `update-available`, `'ready'` after
   *  `update-downloaded`, and `null` when nothing is pending. Drives
   *  the title-bar app-update pill that sits to the right of the
   *  hamburger menu.
   *
   *  Track B item 2 — `autoUpdate` mirrors the `autoUpdate` setting
   *  at the moment the state was committed. With auto-updates ON the
   *  `'available'` pill is suppressed entirely (main triggers the
   *  download itself); the `'ready'` pill then reads "Update will
   *  apply on restart". With auto-updates OFF the `'available'` pill
   *  reads "Update v{version} available" and the `'ready'` pill keeps
   *  the existing "Restart to update" copy. */
  onAppUpdateStateChanged(
    cb: (state: {
      kind: 'available' | 'ready' | null
      version: string | null
      autoUpdate: boolean
    }) => void,
  ): () => void
  /** Subscribe to install-update state pushes (Phase 3 §18 status
   *  pills). `available` is `true` when the install's
   *  `statusTag.style === 'update'`, `false` otherwise; `version`
   *  carries the target release version when known so the pill can
   *  read "Update v{version}" instead of the generic
   *  "Update available" (Track B item 1). Only relevant on
   *  install-backed host windows; install-less hosts never receive
   *  this signal. */
  onInstallUpdateAvailable(
    cb: (state: { available: boolean; version: string | null }) => void,
  ): () => void
  /** Click handler for the app-update pill. Main responds by sending
   *  `panel-trigger-overlay` to the host's panelView so the renderer
   *  can open the app-update popover via `openOverlay`. */
  clickAppUpdatePill(): void
  /** Click handler for the install-update pill. Main routes the
   *  request to the host's panelView with the entry's installationId
   *  so the renderer can open the manage overlay on the update tab. */
  clickInstallUpdatePill(): void
  /** Track F — subscribe to downloads-tray state pushes from main.
   *  Initial push happens on `onTitleBarReady` (both install-backed
   *  and chooser-host branches) so the tray renders correctly even
   *  when a title bar mounts AFTER an in-flight download started. */
  onDownloadsChanged(cb: (state: DownloadsTrayState) => void): () => void
  /** Track F — click handler for the downloads tray. Routes through
   *  the same `panel-trigger-overlay` channel as the app-update pill
   *  so the panel renderer can open the downloads popover. */
  clickDownloadsTray(): void
  /** Click handler for the title-bar Send Feedback button. Main
   *  resolves the host entry from the sender and forwards
   *  `comfy-panel:open-feedback` to the panel renderer, which fires
   *  the `desktop2.feedback.opened` telemetry action and opens the
   *  support URL via `openExternal`. */
  clickFeedback(): void
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
  openNewWindow: () => {
    ipcRenderer.send('comfy-window:new-chooser-window')
  },
  openFileMenu: (anchor) => {
    ipcRenderer.send('comfy-window:open-title-menu', { menu: 'file', anchor })
  },
  dismissFileMenu: () => {
    ipcRenderer.send('comfy-window:dismiss-title-menu')
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
  onSourceCategoryChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, category: unknown): void => {
      cb(typeof category === 'string' ? category : null)
    }
    ipcRenderer.on('comfy-titlebar:source-category-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:source-category-changed', handler)
  },
  onThemeChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, data: unknown): void => {
      const { bg, text } = (data || {}) as { bg?: string; text?: string }
      if (typeof bg === 'string' && typeof text === 'string') cb({ bg, text })
    }
    ipcRenderer.on('comfy-titlebar:theme-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:theme-changed', handler)
  },
  onFullscreenChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, fullscreen: unknown): void => {
      cb(!!fullscreen)
    }
    ipcRenderer.on('comfy-titlebar:fullscreen-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:fullscreen-changed', handler)
  },
  onMenuOpened: (cb) => {
    const handler = (_event: IpcRendererEvent, data: unknown): void => {
      const { menu } = (data || {}) as { menu?: unknown }
      if (menu === 'file') cb({ menu })
    }
    ipcRenderer.on('comfy-titlebar:menu-opened', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:menu-opened', handler)
  },
  onMenuClosed: (cb) => {
    const handler = (_event: IpcRendererEvent, data: unknown): void => {
      const { menu } = (data || {}) as { menu?: unknown }
      if (menu === 'file') cb({ menu })
    }
    ipcRenderer.on('comfy-titlebar:menu-closed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:menu-closed', handler)
  },
  onFirstUseModeChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, mode: unknown): void => {
      const normalised = mode === 'consent-lockdown' || mode === 'post-consent' ? mode : 'none'
      cb(normalised)
    }
    ipcRenderer.on('comfy-titlebar:first-use-mode-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:first-use-mode-changed', handler)
  },
  onAppUpdateStateChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, state: unknown): void => {
      const data = (state || {}) as { kind?: unknown; version?: unknown; autoUpdate?: unknown }
      const kind = data.kind === 'available' || data.kind === 'ready' ? data.kind : null
      const version = typeof data.version === 'string' ? data.version : null
      // Default-on if main forgets to send it — matches the underlying
      // `settings.get('autoUpdate') !== false` semantics.
      const autoUpdate = data.autoUpdate !== false
      cb({ kind, version, autoUpdate })
    }
    ipcRenderer.on('comfy-titlebar:app-update-state-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:app-update-state-changed', handler)
  },
  onInstallUpdateAvailable: (cb) => {
    const handler = (_event: IpcRendererEvent, state: unknown): void => {
      const data = (state || {}) as { available?: unknown; version?: unknown }
      const available = !!data.available
      const version = typeof data.version === 'string' ? data.version : null
      cb({ available, version })
    }
    ipcRenderer.on('comfy-titlebar:install-update-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:install-update-changed', handler)
  },
  clickAppUpdatePill: () => {
    ipcRenderer.send('comfy-window:click-app-update-pill')
  },
  clickInstallUpdatePill: () => {
    ipcRenderer.send('comfy-window:click-install-update-pill')
  },
  onDownloadsChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, state: unknown): void => {
      const data = (state || {}) as { active?: unknown; recent?: unknown }
      const active = Array.isArray(data.active) ? (data.active as DownloadsTrayEntry[]) : []
      const recent = Array.isArray(data.recent) ? (data.recent as DownloadsTrayEntry[]) : []
      cb({ active, recent })
    }
    ipcRenderer.on('comfy-titlebar:downloads-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:downloads-changed', handler)
  },
  clickDownloadsTray: () => {
    ipcRenderer.send('comfy-window:click-downloads-tray')
  },
  clickFeedback: () => {
    ipcRenderer.send('comfy-window:click-feedback')
  },
  ready: () => {
    ipcRenderer.send('comfy-window:title-bar-ready')
  },
}

// Expose the standard `window.api` bridge alongside `__comfyTitleBar` so the
// title-bar renderer can call `initializeRendererBootstrap()` (which depends
// on `window.api.getSetting` / `getDeviceId` / `onTelemetrySettingChanged` /
// etc.). Without this, telemetry only fired from the panel renderer — which
// only mounts in chooser/lifecycle modes — leaving steady-state ComfyUI
// sessions invisible to Datadog and PostHog.
//
// The api literal is inlined here (rather than imported from `./api`)
// because Electron 40 defaults preloads to `sandbox: true`, and sandboxed
// preloads can only `require()` from a small whitelist (`electron`, `events`,
// `timers`, `url`). When Rollup splits the api builder into a shared chunk
// the resulting `require("./chunks/api-*.js")` fails silently in the sandbox,
// leaving `window.api` and `window.__comfyTitleBar` undefined and the
// renderer blank. Keeping each preload self-contained avoids the chunk.
const api: ElectronApi = {
  // Sources / New Install
  getSources: () => ipcRenderer.invoke('get-sources'),
  getFieldOptions: (sourceId, fieldId, selections, context) =>
    ipcRenderer.invoke('get-field-options', sourceId, fieldId, selections, context),
  buildInstallation: (sourceId, selections) =>
    ipcRenderer.invoke('build-installation', sourceId, selections),
  getDefaultInstallDir: () => ipcRenderer.invoke('get-default-install-dir'),
  detectGPU: () => ipcRenderer.invoke('detect-gpu'),
  validateHardware: () => ipcRenderer.invoke('validate-hardware'),
  checkNvidiaDriver: () => ipcRenderer.invoke('check-nvidia-driver'),

  // File/URL
  browseFolder: (defaultPath?) => ipcRenderer.invoke('browse-folder', defaultPath),
  openPath: (targetPath) => ipcRenderer.invoke('open-path', targetPath),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getDiskSpace: (targetPath) => ipcRenderer.invoke('get-disk-space', targetPath),
  validateInstallPath: (targetPath) => ipcRenderer.invoke('validate-install-path', targetPath),
  getInstallationSize: (installationId) => ipcRenderer.invoke('get-installation-size', installationId),
  cancelInstallationSize: () => ipcRenderer.invoke('cancel-installation-size'),

  // Locale
  getLocaleMessages: () => ipcRenderer.invoke('get-locale-messages'),
  getAvailableLocales: () => ipcRenderer.invoke('get-available-locales'),
  getLocale: () => ipcRenderer.invoke('get-locale'),

  // First-use takeover state
  getFirstUseState: () => ipcRenderer.invoke('get-first-use-state'),

  // Installations
  getInstallations: () => ipcRenderer.invoke('get-installations'),
  addInstallation: (data) => ipcRenderer.invoke('add-installation', data),
  reorderInstallations: (orderedIds) =>
    ipcRenderer.invoke('reorder-installations', orderedIds),
  probeInstallation: (dirPath) => ipcRenderer.invoke('probe-installation', dirPath),
  trackInstallation: (data) => ipcRenderer.invoke('track-installation', data),
  installInstance: (installationId) =>
    ipcRenderer.invoke('install-instance', installationId),
  updateInstallation: (installationId, data) =>
    ipcRenderer.invoke('update-installation', installationId, data),

  // Running
  stopComfyUI: (installationId) => ipcRenderer.invoke('stop-comfyui', installationId),
  focusComfyWindow: (installationId) =>
    ipcRenderer.invoke('focus-comfy-window', installationId),
  closeComfyWindow: (installationId) =>
    ipcRenderer.invoke('close-comfy-window', installationId),
  closeHostWindow: () =>
    ipcRenderer.invoke('close-host-window'),
  closeCurrentPanel: () =>
    ipcRenderer.send('comfy-window:close-current-panel'),
  setFirstUseMode: (mode: 'none' | 'consent-lockdown' | 'post-consent') =>
    ipcRenderer.send('comfy-window:set-first-use-mode', { mode }),
  onFirstUseSkip: (callback) => {
    const handler = (): void => callback()
    ipcRenderer.on('comfy-panel:first-use-skip', handler)
    return () => ipcRenderer.removeListener('comfy-panel:first-use-skip', handler)
  },
  onOpenFeedback: (callback) => {
    const handler = (_event: IpcRendererEvent, data: unknown): void => {
      const source = (data as { source?: unknown } | null)?.source
      callback({ source: source === 'menu' ? 'menu' : 'titlebar' })
    }
    ipcRenderer.on('comfy-panel:open-feedback', handler)
    return () => ipcRenderer.removeListener('comfy-panel:open-feedback', handler)
  },
  onCloseRequest: (callback) => {
    const handler = (_event: IpcRendererEvent, data: unknown) =>
      callback(data as { requestId: string })
    ipcRenderer.on('comfy-window:request-close', handler)
    return () => ipcRenderer.removeListener('comfy-window:request-close', handler)
  },
  respondCloseRequest: (payload) =>
    ipcRenderer.send('comfy-window:request-close-response', payload),
  ackCloseRequest: (payload) =>
    ipcRenderer.send('comfy-window:request-close-ack', payload),
  transferHostBoundsToInstall: (installationId) =>
    ipcRenderer.invoke('transfer-host-bounds-to-install', installationId),
  claimAttachHost: (installationId) =>
    ipcRenderer.invoke('claim-attach-host', installationId),
  getRunningInstances: () => ipcRenderer.invoke('get-running-instances'),
  getLastCrashError: (installationId: string) =>
    ipcRenderer.invoke('get-last-crash-error', installationId),
  cancelLaunch: () => ipcRenderer.invoke('cancel-launch'),
  cancelOperation: (installationId) =>
    ipcRenderer.invoke('cancel-operation', installationId),
  killPortProcess: (port) => ipcRenderer.invoke('kill-port-process', port),

  // Actions
  getListActions: (installationId) =>
    ipcRenderer.invoke('get-list-actions', installationId),
  getDetailSections: (installationId) =>
    ipcRenderer.invoke('get-detail-sections', installationId),
  getComfyArgs: (installationId) =>
    ipcRenderer.invoke('get-comfy-args', installationId),
  runAction: (installationId, actionId, actionData?) =>
    ipcRenderer.invoke('run-action', installationId, actionId, actionData),

  // Snapshots
  getSnapshots: (installationId) => ipcRenderer.invoke('get-snapshots', installationId),
  getSnapshotDetail: (installationId, filename) =>
    ipcRenderer.invoke('get-snapshot-detail', installationId, filename),
  getSnapshotDiff: (installationId, filename, mode) =>
    ipcRenderer.invoke('get-snapshot-diff', installationId, filename, mode),
  exportSnapshot: (installationId, filename) =>
    ipcRenderer.invoke('export-snapshot', installationId, filename),
  exportAllSnapshots: (installationId) =>
    ipcRenderer.invoke('export-all-snapshots', installationId),
  importSnapshotsPreview: () =>
    ipcRenderer.invoke('import-snapshots-preview'),
  importSnapshotsDiff: (installationId: string) =>
    ipcRenderer.invoke('import-snapshots-diff', installationId),
  importSnapshotsConfirm: (installationId: string) =>
    ipcRenderer.invoke('import-snapshots-confirm', installationId),
  previewSnapshotFile: () =>
    ipcRenderer.invoke('preview-snapshot-file'),
  previewDesktopMigration: () =>
    ipcRenderer.invoke('preview-desktop-migration'),
  previewLocalMigration: (installationId: string) =>
    ipcRenderer.invoke('preview-local-migration', installationId),
  previewSnapshotPath: (filePath: string) =>
    ipcRenderer.invoke('preview-snapshot-path', filePath),
  createFromSnapshot: (filePath: string, name?: string, releaseTag?: string, variantId?: string) =>
    ipcRenderer.invoke('create-from-snapshot', filePath, name, releaseTag, variantId),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),

  // Settings
  getSettingsSections: () => ipcRenderer.invoke('get-settings-sections'),
  getModelsSections: () => ipcRenderer.invoke('get-models-sections'),
  getUniqueName: (baseName: string) => ipcRenderer.invoke('get-unique-name', baseName),
  getMediaSections: () => ipcRenderer.invoke('get-media-sections'),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  getSetting: (key) => ipcRenderer.invoke('get-setting', key),

  // Theme
  getResolvedTheme: () => ipcRenderer.invoke('get-resolved-theme'),

  // App
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  quitApp: () => ipcRenderer.invoke('quit-app'),
  resetZoom: () => ipcRenderer.invoke('reset-zoom'),
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
  getInstallationDdContext: (installationId: string) => ipcRenderer.invoke('get-installation-dd-context', installationId),
  getDeviceId: () => ipcRenderer.invoke('get-device-id'),

  // Model downloads
  listModelDownloads: () => ipcRenderer.invoke('model-download-list'),
  pauseModelDownload: (url) => ipcRenderer.invoke('model-download-pause', { url }),
  resumeModelDownload: (url) => ipcRenderer.invoke('model-download-resume', { url }),
  cancelModelDownload: (url) => ipcRenderer.invoke('model-download-cancel', { url }),
  showDownloadInFolder: (savePath) => ipcRenderer.invoke('show-download-in-folder', { savePath }),

  // Updates
  checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  getUpdateCapabilities: () => ipcRenderer.invoke('get-update-capabilities'),

  // Event listeners (return unsubscribe functions)
  onInstallProgress: (callback) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data as Parameters<typeof callback>[0])
    ipcRenderer.on('install-progress', handler)
    return () => ipcRenderer.removeListener('install-progress', handler)
  },
  onComfyOutput: (callback) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data as Parameters<typeof callback>[0])
    ipcRenderer.on('comfy-output', handler)
    return () => ipcRenderer.removeListener('comfy-output', handler)
  },
  onComfyExited: (callback) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data as Parameters<typeof callback>[0])
    ipcRenderer.on('comfy-exited', handler)
    return () => ipcRenderer.removeListener('comfy-exited', handler)
  },
  onComfyBootLog: (callback) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data as Parameters<typeof callback>[0])
    ipcRenderer.on('comfy-boot-log', handler)
    return () => ipcRenderer.removeListener('comfy-boot-log', handler)
  },
  onInstanceLaunching: (callback) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data as Parameters<typeof callback>[0])
    ipcRenderer.on('instance-launching', handler)
    return () => ipcRenderer.removeListener('instance-launching', handler)
  },
  onInstanceLaunchFailed: (callback) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data as Parameters<typeof callback>[0])
    ipcRenderer.on('instance-launch-failed', handler)
    return () => ipcRenderer.removeListener('instance-launch-failed', handler)
  },
  onInstanceStarted: (callback) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data as Parameters<typeof callback>[0])
    ipcRenderer.on('instance-started', handler)
    return () => ipcRenderer.removeListener('instance-started', handler)
  },
  onInstanceStopping: (callback) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data as Parameters<typeof callback>[0])
    ipcRenderer.on('instance-stopping', handler)
    return () => ipcRenderer.removeListener('instance-stopping', handler)
  },
  onInstanceStopped: (callback) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data as Parameters<typeof callback>[0])
    ipcRenderer.on('instance-stopped', handler)
    return () => ipcRenderer.removeListener('instance-stopped', handler)
  },
  onThemeChanged: (callback) => {
    const handler = (_event: IpcRendererEvent, theme: unknown) => callback(theme as ResolvedTheme)
    ipcRenderer.on('theme-changed', handler)
    return () => ipcRenderer.removeListener('theme-changed', handler)
  },
  onLocaleChanged: (callback) => {
    const handler = (_event: IpcRendererEvent, messages: unknown) => callback(messages as Record<string, unknown>)
    ipcRenderer.on('locale-changed', handler)
    return () => ipcRenderer.removeListener('locale-changed', handler)
  },
  onConfirmQuit: (callback) => {
    const handler = (_event: IpcRendererEvent, details: unknown) => callback(details as Parameters<typeof callback>[0])
    ipcRenderer.on('confirm-quit', handler)
    return () => ipcRenderer.removeListener('confirm-quit', handler)
  },
  onInstallationsChanged: (callback) => {
    const handler = () => callback()
    ipcRenderer.on('installations-changed', handler)
    return () => ipcRenderer.removeListener('installations-changed', handler)
  },
  onInstallationsVersionsUpdated: (callback) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => {
      const updates = (data as Record<string, unknown>).updates as { id: string; version: string }[]
      callback(updates)
    }
    ipcRenderer.on('installations-versions-updated', handler)
    return () => ipcRenderer.removeListener('installations-versions-updated', handler)
  },
  onAppUpdatePromptRestart: (callback) => {
    const handler = (_event: IpcRendererEvent, data: unknown) =>
      callback(data as { version: string })
    ipcRenderer.on('app-update:prompt-restart', handler)
    return () => ipcRenderer.removeListener('app-update:prompt-restart', handler)
  },
  onAppUpdateUserActionFailed: (callback) => {
    const handler = (_event: IpcRendererEvent, data: unknown) =>
      callback(data as { message: string })
    ipcRenderer.on('app-update:user-action-failed', handler)
    return () => ipcRenderer.removeListener('app-update:user-action-failed', handler)
  },
  onZoomChanged: (callback) => {
    const handler = (_event: IpcRendererEvent, level: unknown) => callback(level as number)
    ipcRenderer.on('zoom-changed', handler)
    return () => ipcRenderer.removeListener('zoom-changed', handler)
  },
  onModelDownloadProgress: (callback) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data as Parameters<typeof callback>[0])
    ipcRenderer.on('model-download-progress', handler)
    return () => ipcRenderer.removeListener('model-download-progress', handler)
  },
  onTelemetrySettingChanged: (callback) => {
    const handler = (_event: IpcRendererEvent, enabled: unknown) => callback(enabled as Parameters<typeof callback>[0])
    ipcRenderer.on('telemetry-setting-changed', handler)
    return () => ipcRenderer.removeListener('telemetry-setting-changed', handler)
  },
  onDatadogError: (callback) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data as Parameters<typeof callback>[0])
    ipcRenderer.on('dd-error', handler)
    return () => ipcRenderer.removeListener('dd-error', handler)
  },
  onTelemetryActionFromMain: (callback) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data as Parameters<typeof callback>[0])
    ipcRenderer.on('telemetry-action-from-main', handler)
    return () => ipcRenderer.removeListener('telemetry-action-from-main', handler)
  },
  onErrorDetail: (callback) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data as Parameters<typeof callback>[0])
    ipcRenderer.on('error-detail', handler)
    return () => ipcRenderer.removeListener('error-detail', handler)
  },
  onSuggestChineseMirrors: (callback) => {
    const handler = () => callback()
    ipcRenderer.on('suggest-chinese-mirrors', handler)
    return () => ipcRenderer.removeListener('suggest-chinese-mirrors', handler)
  },
  onSettingsChanged: (callback) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data as { key: string })
    ipcRenderer.on('settings-changed', handler)
    return () => ipcRenderer.removeListener('settings-changed', handler)
  },
  onPanelSwitch: (callback) => {
    const handler = (_event: IpcRendererEvent, data: unknown) =>
      callback(data as { panel: string; installationId?: string })
    ipcRenderer.on('panel-switch', handler)
    return () => ipcRenderer.removeListener('panel-switch', handler)
  },
  onPanelTriggerOverlay: (callback) => {
    const handler = (_event: IpcRendererEvent, data: unknown) =>
      callback(
        data as {
          kind:
            | 'install-update'
            | 'downloads'
            | 'app-update-restart-prompt'
            | 'app-update-download-prompt'
          installationId?: string
          version?: string | null
        },
      )
    ipcRenderer.on('panel-trigger-overlay', handler)
    return () => ipcRenderer.removeListener('panel-trigger-overlay', handler)
  },
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('__comfyTitleBar', bridge)
  contextBridge.exposeInMainWorld('api', api)
} else {
  ;(globalThis as Record<string, unknown>).__comfyTitleBar = bridge
  ;(globalThis as Record<string, unknown>).api = api
}
