/**
 * Builds the `window.api` bridge object exposed to renderer surfaces.
 *
 * Imported by both `preload/index.ts` (default panel preload) and
 * `preload/comfyTitleBarPreload.ts` (title-bar preload). Rollup splits
 * this into a shared chunk at `out/preload/chunks/api-*.js`, which the
 * preload entries then `require()` at runtime.
 *
 * NOTE — sandbox interaction
 *   Electron 40 defaults preloads to `sandbox: true`, and sandboxed
 *   preloads can only `require()` from the whitelist `electron`,
 *   `events`, `timers`, `url`. The chunked `require("./chunks/...")`
 *   fails silently in that mode, leaving `window.api` undefined and
 *   the renderer blank.
 *
 *   Workaround: every host webPreferences that loads a preload using
 *   this builder explicitly opts out of the sandbox via
 *   `sandbox: false` (title-bar `WebContentsView` and panel
 *   `WebContentsView` in `src/main/index.ts`). `contextIsolation: true`
 *   and `nodeIntegration: false` remain enabled — the real wall
 *   between renderer JS and Node — so the security posture is
 *   roughly equivalent to historical VS Code / Slack / Teams.
 *
 *   See issue #521 for the planned upgrade: a build-time chunk
 *   inlining plugin that lets us re-enable sandbox without
 *   duplicating ~330 lines of bridge code across both preloads.
 */
import { ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { ElectronApi, ResolvedTheme } from '../types/ipc'

export function buildElectronApi(): ElectronApi {
  return {
    platform: process.platform,

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
    getInstallationsSummary: () => ipcRenderer.invoke('get-installations-summary'),
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
    openGlobalSettings: () =>
      ipcRenderer.send('comfy-titlepopup:open-global-settings'),
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
    relaunchApp: () => ipcRenderer.invoke('app:relaunch'),
    resetZoom: () => ipcRenderer.invoke('reset-zoom'),
    getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
    getInstallationDdContext: (installationId: string) => ipcRenderer.invoke('get-installation-dd-context', installationId),
    getInstallsInventory: () => ipcRenderer.invoke('get-installs-inventory'),
    getDeviceId: () => ipcRenderer.invoke('get-device-id'),

    // Model downloads
    listModelDownloads: () => ipcRenderer.invoke('model-download-list'),
    pauseModelDownload: (url) => ipcRenderer.invoke('model-download-pause', { url }),
    resumeModelDownload: (url) => ipcRenderer.invoke('model-download-resume', { url }),
    cancelModelDownload: (url) => ipcRenderer.invoke('model-download-cancel', { url }),
    dismissModelDownload: (url) => ipcRenderer.invoke('model-download-dismiss', { url }),
    clearFinishedModelDownloads: () => ipcRenderer.invoke('model-download-clear-finished'),
    showDownloadInFolder: (savePath) => ipcRenderer.invoke('show-download-in-folder', { savePath }),

    // Updates
    checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
    downloadUpdate: () => ipcRenderer.invoke('download-update'),
    installUpdate: () => ipcRenderer.invoke('install-update'),
    getUpdateCapabilities: () => ipcRenderer.invoke('get-update-capabilities'),
    getAppUpdateState: () => ipcRenderer.invoke('get-app-update-state'),

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
    onAppUpdateStateChanged: (callback) => {
      const handler = (_event: IpcRendererEvent, data: unknown) =>
        callback(data as Parameters<typeof callback>[0])
      ipcRenderer.on('app-update:state-changed', handler)
      return () => ipcRenderer.removeListener('app-update:state-changed', handler)
    },
    onAppUpdateDownloadProgress: (callback) => {
      const handler = (_event: IpcRendererEvent, data: unknown) =>
        callback(data as Parameters<typeof callback>[0])
      ipcRenderer.on('app-update:download-progress', handler)
      return () => ipcRenderer.removeListener('app-update:download-progress', handler)
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
    onModelDownloadRemoved: (callback) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data as Parameters<typeof callback>[0])
      ipcRenderer.on('model-download-removed', handler)
      return () => ipcRenderer.removeListener('model-download-removed', handler)
    },
    onModelDownloadsClearedFinished: (callback) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data as Parameters<typeof callback>[0])
      ipcRenderer.on('model-downloads-cleared-finished', handler)
      return () => ipcRenderer.removeListener('model-downloads-cleared-finished', handler)
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
    onRequestCloseDrawer: (callback) => {
      const handler = (): void => callback()
      ipcRenderer.on('panel:request-close-drawer', handler)
      return () => ipcRenderer.removeListener('panel:request-close-drawer', handler)
    },
    onPanelTriggerOverlay: (callback) => {
      const handler = (_event: IpcRendererEvent, data: unknown) =>
        callback(
          data as {
            kind:
              | 'install-update'
              | 'app-update-restart-prompt'
              | 'app-update-download-prompt'
              | 'open-settings'
              | 'picker-pick-install'
              | 'picker-install-action'
            installationId?: string
            actionId?: string
            version?: string | null
            settingsTab?: 'comfy' | 'directories' | 'downloads' | 'global'
          },
        )
      ipcRenderer.on('panel-trigger-overlay', handler)
      return () => ipcRenderer.removeListener('panel-trigger-overlay', handler)
    },
  }
}
