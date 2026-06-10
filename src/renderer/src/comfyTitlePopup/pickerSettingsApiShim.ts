/**
 * Picker popup `window.api` shim. The popup has the comfyTitlePopupPreload
 * bridge, not window.api, so this forwards the settings UI's calls to the
 * popup's `pickerSettings*` bridge. Adding a call needs: bridge method in
 * comfyTitlePopupPreload.ts, main handler in pickerSettingsHandlers.ts, and
 * an entry in API_MAP below.
 */

import type { ComfyTitlePopupBridge } from '../../../preload/comfyTitlePopupPreload'

const API_MAP = {
  getDetailSections: 'pickerSettingsGetDetailSections',
  getDiskSpace: 'pickerSettingsGetDiskSpace',
  updateInstallation: 'pickerSettingsUpdateInstallation',
  runAction: 'pickerSettingsRunAction',
  getFieldOptions: 'pickerSettingsGetFieldOptions',
  getInstallations: 'pickerSettingsGetInstallations',
  getStableTags: 'pickerSettingsGetStableTags',
  getInstallationSize: 'pickerSettingsGetInstallationSize',
  stopComfyUI: 'pickerSettingsStopComfyUI',
  cancelOperation: 'pickerSettingsCancelOperation',
  getSnapshots: 'pickerSettingsGetSnapshots',
  getSnapshotDetail: 'pickerSettingsGetSnapshotDetail',
  getSnapshotDiff: 'pickerSettingsGetSnapshotDiff',
  exportSnapshot: 'pickerSettingsExportSnapshot',
  exportAllSnapshots: 'pickerSettingsExportAllSnapshots',
  importSnapshotsPreview: 'pickerSettingsImportSnapshotsPreview',
  importSnapshotsDiff: 'pickerSettingsImportSnapshotsDiff',
  importSnapshotsConfirm: 'pickerSettingsImportSnapshotsConfirm',
  previewSnapshotFile: 'pickerSettingsPreviewSnapshotFile',
  getComfyArgs: 'pickerSettingsGetComfyArgs',
  previewDesktopMigration: 'pickerSettingsPreviewDesktopMigration',
  previewLocalMigration: 'pickerSettingsPreviewLocalMigration',
  onReleaseCacheEnriched: 'pickerSettingsOnReleaseCacheEnriched',
  terminalSubscribe: 'terminalSubscribe',
  terminalUnsubscribe: 'terminalUnsubscribe',
  terminalWrite: 'terminalWrite',
  terminalResize: 'terminalResize',
  terminalRestart: 'terminalRestart',
  onTerminalOutput: 'onTerminalOutput',
  onTerminalExited: 'onTerminalExited',
} as const satisfies Record<string, keyof ComfyTitlePopupBridge>

type ShimApi = {
  [K in keyof typeof API_MAP]: ComfyTitlePopupBridge[(typeof API_MAP)[K]]
} & {
  browseFolder: (defaultPath?: string) => ReturnType<
    ComfyTitlePopupBridge['pickerSettingsBrowseFolder']
  >
  relaunchApp: () => void
  /** The popup has no installations-changed IPC, so this maps onto the
   *  picker's snapshot rebroadcast to live-refresh settings views. */
  onInstallationsChanged: (cb: () => void) => () => void
}

export function installPickerSettingsApiShim(): void {
  const bridge = (window as unknown as { __comfyTitlePopup?: ComfyTitlePopupBridge })
    .__comfyTitlePopup
  if (!bridge) {
    // Leave window.api undefined so a settings-UI mount fails loudly rather
    // than silently no-opping.
    return
  }

  const api = {} as ShimApi
  for (const [apiKey, bridgeKey] of Object.entries(API_MAP)) {
    const method = bridge[bridgeKey as keyof ComfyTitlePopupBridge] as (
      ...args: unknown[]
    ) => unknown
      ; (api as Record<string, unknown>)[apiKey] = method.bind(bridge)
  }
  // Adapters for the two methods whose shape diverges from a pure pass-through.
  api.browseFolder = (defaultPath?: string) =>
    bridge.pickerSettingsBrowseFolder(defaultPath ? { defaultPath } : undefined)
  api.relaunchApp = () => bridge.pickerSettingsRelaunchApp()
  api.onInstallationsChanged = (cb: () => void) => bridge.onInstancePickerSnapshot(() => cb())

    ; (window as unknown as { api: ShimApi }).api = api
}

/**
 * Merge main's i18n catalog on top of the popup's static catalog. The caller
 * should cache the returned promise so concurrent expands share one IPC.
 */
export async function mergePanelLocaleIntoPopup(
  mergeLocaleMessage: (locale: string, messages: Record<string, unknown>) => void,
): Promise<void> {
  const bridge = (window as unknown as { __comfyTitlePopup?: ComfyTitlePopupBridge })
    .__comfyTitlePopup
  if (!bridge) return
  try {
    const messages = await bridge.pickerSettingsGetLocaleMessages()
    mergeLocaleMessage('en', messages)
  } catch (err) {
    console.warn('Picker: locale merge failed', err)
  }
}
