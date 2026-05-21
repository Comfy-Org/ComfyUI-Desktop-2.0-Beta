/**
 * Picker popup `window.api` shim.
 *
 * The instance-picker popup is a separate WebContentsView with the
 * `comfyTitlePopupPreload` bridge — no `window.api`. To run the same
 * per-install settings UI the legacy drawer uses
 * (`ComfyUISettingsContent.vue` + `useComfyUISettings`) inside the
 * popup's expanded Manage state, we install a minimal `window.api`
 * shim here that routes each method the settings UI calls through the
 * popup's `pickerSettings*` bridge.
 *
 * Only the methods `ComfyUISettingsContent` + its downstream
 * (`SettingsSectionList`, `SnapshotsView`, `ArgsBuilderPage`,
 * `EnvVarsEditor`, `useComfyUISettings`, `useActionGuard`,
 * `useMigrateAction`) actually call are shimmed — full `window.api`
 * would balloon the surface and most methods would never be called
 * from inside the popup process. If a future addition to the settings
 * UI calls a new `window.api.*` method, add the corresponding bridge
 * proxy (`comfyTitlePopupPreload.ts`) + main handler
 * (`pickerSettingsHandlers.ts`) + this shim entry.
 */

import type { ComfyTitlePopupBridge } from '../../../preload/comfyTitlePopupPreload'

interface MinimalWindowApi {
  getDetailSections: ComfyTitlePopupBridge['pickerSettingsGetDetailSections']
  getDiskSpace: ComfyTitlePopupBridge['pickerSettingsGetDiskSpace']
  updateInstallation: ComfyTitlePopupBridge['pickerSettingsUpdateInstallation']
  runAction: ComfyTitlePopupBridge['pickerSettingsRunAction']
  getFieldOptions: ComfyTitlePopupBridge['pickerSettingsGetFieldOptions']
  getInstallations: ComfyTitlePopupBridge['pickerSettingsGetInstallations']
  getInstallationSize: ComfyTitlePopupBridge['pickerSettingsGetInstallationSize']
  stopComfyUI: ComfyTitlePopupBridge['pickerSettingsStopComfyUI']
  cancelOperation: ComfyTitlePopupBridge['pickerSettingsCancelOperation']
  getSnapshots: ComfyTitlePopupBridge['pickerSettingsGetSnapshots']
  getSnapshotDetail: ComfyTitlePopupBridge['pickerSettingsGetSnapshotDetail']
  getSnapshotDiff: ComfyTitlePopupBridge['pickerSettingsGetSnapshotDiff']
  exportSnapshot: ComfyTitlePopupBridge['pickerSettingsExportSnapshot']
  exportAllSnapshots: ComfyTitlePopupBridge['pickerSettingsExportAllSnapshots']
  importSnapshotsPreview: ComfyTitlePopupBridge['pickerSettingsImportSnapshotsPreview']
  importSnapshotsDiff: ComfyTitlePopupBridge['pickerSettingsImportSnapshotsDiff']
  importSnapshotsConfirm: ComfyTitlePopupBridge['pickerSettingsImportSnapshotsConfirm']
  previewSnapshotFile: ComfyTitlePopupBridge['pickerSettingsPreviewSnapshotFile']
  getComfyArgs: ComfyTitlePopupBridge['pickerSettingsGetComfyArgs']
  browseFolder: (defaultPath?: string) => ReturnType<
    ComfyTitlePopupBridge['pickerSettingsBrowseFolder']
  >
  previewDesktopMigration: ComfyTitlePopupBridge['pickerSettingsPreviewDesktopMigration']
  previewLocalMigration: ComfyTitlePopupBridge['pickerSettingsPreviewLocalMigration']
  relaunchApp: () => void
}

export function installPickerSettingsApiShim(): void {
  const bridge = (window as unknown as { __comfyTitlePopup?: ComfyTitlePopupBridge })
    .__comfyTitlePopup
  if (!bridge) {
    // Popup harness is missing — the shim is unusable. Leave
    // `window.api` undefined so any settings-UI mount surfaces a
    // clear "bridge missing" error rather than silently doing nothing.
    return
  }
  const api: MinimalWindowApi = {
    getDetailSections: bridge.pickerSettingsGetDetailSections.bind(bridge),
    getDiskSpace: bridge.pickerSettingsGetDiskSpace.bind(bridge),
    updateInstallation: bridge.pickerSettingsUpdateInstallation.bind(bridge),
    runAction: bridge.pickerSettingsRunAction.bind(bridge),
    getFieldOptions: bridge.pickerSettingsGetFieldOptions.bind(bridge),
    getInstallations: bridge.pickerSettingsGetInstallations.bind(bridge),
    getInstallationSize: bridge.pickerSettingsGetInstallationSize.bind(bridge),
    stopComfyUI: bridge.pickerSettingsStopComfyUI.bind(bridge),
    cancelOperation: bridge.pickerSettingsCancelOperation.bind(bridge),
    getSnapshots: bridge.pickerSettingsGetSnapshots.bind(bridge),
    getSnapshotDetail: bridge.pickerSettingsGetSnapshotDetail.bind(bridge),
    getSnapshotDiff: bridge.pickerSettingsGetSnapshotDiff.bind(bridge),
    exportSnapshot: bridge.pickerSettingsExportSnapshot.bind(bridge),
    exportAllSnapshots: bridge.pickerSettingsExportAllSnapshots.bind(bridge),
    importSnapshotsPreview: bridge.pickerSettingsImportSnapshotsPreview.bind(bridge),
    importSnapshotsDiff: bridge.pickerSettingsImportSnapshotsDiff.bind(bridge),
    importSnapshotsConfirm: bridge.pickerSettingsImportSnapshotsConfirm.bind(bridge),
    previewSnapshotFile: bridge.pickerSettingsPreviewSnapshotFile.bind(bridge),
    getComfyArgs: bridge.pickerSettingsGetComfyArgs.bind(bridge),
    // `window.api.browseFolder` takes a positional string in the panel
    // API; the popup bridge takes an opts object so the IPC channel
    // shape stays consistent with `globalSettingsBrowseFolder`.
    browseFolder: (defaultPath?: string) =>
      bridge.pickerSettingsBrowseFolder(defaultPath ? { defaultPath } : undefined),
    previewDesktopMigration: bridge.pickerSettingsPreviewDesktopMigration.bind(bridge),
    previewLocalMigration: bridge.pickerSettingsPreviewLocalMigration.bind(bridge),
    relaunchApp: () => bridge.pickerSettingsRelaunchApp(),
  }
  // Install on `window.api`. The full panel-side `window.api` has
  // ~150 methods; only these shimmed ones are reachable in the popup.
  // Any other access (e.g. `window.api.onInstanceStarted`) will be
  // `undefined` and surface a clear runtime error if hit — the popup
  // process intentionally has no listener subscriptions.
  ;(window as unknown as { api: MinimalWindowApi }).api = api
}

/**
 * Pull the panel-side i18n catalog (loaded from main's
 * `locales/en.json`) and merge it on top of the popup's static
 * `i18nMessages.ts` catalog. The expanded Manage UI needs keys
 * (`actions.restart`, `diskSpace.*`, etc.) that live in the panel
 * catalog only; without the merge those keys would render as their
 * dotted paths inside the popup.
 *
 * Idempotent — safe to call multiple times (e.g. on every expand).
 * The bridge IPC is cheap (it returns an in-memory object from main).
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
