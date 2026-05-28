/**
 * Picker popup `window.api` shim.
 *
 * The picker popup has the `comfyTitlePopupPreload` bridge, not `window.api`.
 * To run the per-install settings UI inside it, we install a minimal
 * `window.api` shim that forwards the methods the settings UI actually calls
 * to the popup's `pickerSettings*` bridge. Adding a new call from the settings
 * UI requires: (1) bridge method in `comfyTitlePopupPreload.ts`, (2) main
 * handler in `pickerSettingsHandlers.ts`, (3) entry in `API_MAP` below.
 */

import type { ComfyTitlePopupBridge } from '../../../preload/comfyTitlePopupPreload'

// `window.api.X` → `bridge.pickerSettingsY`. Keep this list aligned with the
// `pickerSettings*` surface on the bridge — TypeScript catches typos.
const API_MAP = {
  getDetailSections: 'pickerSettingsGetDetailSections',
  getDiskSpace: 'pickerSettingsGetDiskSpace',
  updateInstallation: 'pickerSettingsUpdateInstallation',
  runAction: 'pickerSettingsRunAction',
  getFieldOptions: 'pickerSettingsGetFieldOptions',
  getInstallations: 'pickerSettingsGetInstallations',
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
} as const satisfies Record<string, keyof ComfyTitlePopupBridge>

type ShimApi = {
  [K in keyof typeof API_MAP]: ComfyTitlePopupBridge[(typeof API_MAP)[K]]
} & {
  browseFolder: (defaultPath?: string) => ReturnType<
    ComfyTitlePopupBridge['pickerSettingsBrowseFolder']
  >
  relaunchApp: () => void
  /** Live-refresh hook for settings views (e.g. SnapshotsView). The popup
   *  has no `installations-changed` IPC, so map it onto the picker's snapshot
   *  rebroadcast — which fires whenever the selected install's data (snapshot
   *  set included) changes — so the Snapshots tab reloads in place. */
  onInstallationsChanged: (cb: () => void) => () => void
}

export function installPickerSettingsApiShim(): void {
  const bridge = (window as unknown as { __comfyTitlePopup?: ComfyTitlePopupBridge })
    .__comfyTitlePopup
  if (!bridge) {
    // No bridge → leave `window.api` undefined so any settings-UI mount fails
    // with a clear "bridge missing" error rather than silent no-ops.
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
 * Merge main's i18n catalog (e.g. `actions.restart`, `diskSpace.*`) on top of
 * the popup's static catalog. Idempotent — the caller is expected to cache the
 * returned promise so concurrent expands share one IPC.
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
