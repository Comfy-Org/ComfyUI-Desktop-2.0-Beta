import { app, ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { PICKER_SETTINGS_CHANNELS as CH } from '../../types/ipc'

/**
 * Picker expanded-Manage IPC handlers.
 *
 * The instance-picker popup is a separate WebContentsView with its own preload
 * (no `window.api`). To run the per-install settings UI inside it, every
 * `window.api.*` call the settings UI makes must round-trip through main. Each
 * handler here registers a popup-facing channel that forwards to the existing
 * panel-facing handler — one source of truth, no duplicated bodies.
 *
 * Forwarding goes through `ipcMain._invokeHandlers` (a private Electron map,
 * stable as of v33 but not contractually so). If a future Electron release
 * removes it, factor the panel handlers into plain async functions both sides
 * call directly.
 */
type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
function dispatchInvoke(
  channel: string,
  event: IpcMainInvokeEvent,
  ...args: unknown[]
): Promise<unknown> {
  const internal = ipcMain as unknown as {
    _invokeHandlers: Map<string, InvokeHandler>
  }
  const handler = internal._invokeHandlers?.get(channel)
  if (!handler) {
    return Promise.reject(new Error(`No handler registered for '${channel}'`))
  }
  return Promise.resolve(handler(event, ...args))
}

export function registerPickerSettingsIpc(): void {
  ipcMain.handle(CH.getDetailSections, (event, payload: { installationId?: unknown }) =>
    dispatchInvoke('get-detail-sections', event, payload?.installationId),
  )

  ipcMain.handle(CH.getDiskSpace, (event, payload: { path?: unknown }) =>
    dispatchInvoke('get-disk-space', event, payload?.path),
  )

  ipcMain.handle(CH.getInstallationSize, (event, payload: { installationId?: unknown }) =>
    dispatchInvoke('get-installation-size', event, payload?.installationId),
  )

  ipcMain.handle(
    CH.updateInstallation,
    (event, payload: { installationId?: unknown; data?: unknown }) =>
      dispatchInvoke('update-installation', event, payload?.installationId, payload?.data),
  )

  ipcMain.handle(
    CH.runAction,
    (event, payload: { installationId?: unknown; actionId?: unknown; actionData?: unknown }) =>
      dispatchInvoke(
        'run-action',
        event,
        payload?.installationId,
        payload?.actionId,
        payload?.actionData,
      ),
  )

  ipcMain.handle(
    CH.getFieldOptions,
    (event, payload: { sourceId?: unknown; fieldId?: unknown; selections?: unknown }) =>
      dispatchInvoke(
        'get-field-options',
        event,
        payload?.sourceId,
        payload?.fieldId,
        payload?.selections,
      ),
  )

  ipcMain.handle(CH.getInstallations, (event) => dispatchInvoke('get-installations', event))

  ipcMain.handle(CH.stopComfyUI, (event, payload: { installationId?: unknown }) =>
    dispatchInvoke('stop-comfyui', event, payload?.installationId),
  )

  ipcMain.handle(CH.cancelOperation, (event, payload: { installationId?: unknown }) =>
    dispatchInvoke('cancel-operation', event, payload?.installationId),
  )

  ipcMain.handle(CH.getSnapshots, (event, payload: { installationId?: unknown }) =>
    dispatchInvoke('get-snapshots', event, payload?.installationId),
  )

  ipcMain.handle(
    CH.getSnapshotDetail,
    (event, payload: { installationId?: unknown; filename?: unknown }) =>
      dispatchInvoke('get-snapshot-detail', event, payload?.installationId, payload?.filename),
  )

  ipcMain.handle(
    CH.getSnapshotDiff,
    (event, payload: { installationId?: unknown; filename?: unknown; mode?: unknown }) =>
      dispatchInvoke(
        'get-snapshot-diff',
        event,
        payload?.installationId,
        payload?.filename,
        payload?.mode,
      ),
  )

  ipcMain.handle(
    CH.exportSnapshot,
    (event, payload: { installationId?: unknown; filename?: unknown }) =>
      dispatchInvoke('export-snapshot', event, payload?.installationId, payload?.filename),
  )

  ipcMain.handle(CH.exportAllSnapshots, (event, payload: { installationId?: unknown }) =>
    dispatchInvoke('export-all-snapshots', event, payload?.installationId),
  )

  ipcMain.handle(CH.importSnapshotsPreview, (event) =>
    dispatchInvoke('import-snapshots-preview', event),
  )

  ipcMain.handle(CH.importSnapshotsDiff, (event, payload: { installationId?: unknown }) =>
    dispatchInvoke('import-snapshots-diff', event, payload?.installationId),
  )

  ipcMain.handle(CH.importSnapshotsConfirm, (event, payload: { installationId?: unknown }) =>
    dispatchInvoke('import-snapshots-confirm', event, payload?.installationId),
  )

  ipcMain.handle(CH.previewSnapshotFile, (event) => dispatchInvoke('preview-snapshot-file', event))

  ipcMain.handle(CH.getComfyArgs, (event, payload: { installationId?: unknown }) =>
    dispatchInvoke('get-comfy-args', event, payload?.installationId),
  )

  ipcMain.handle(CH.browseFolder, (event, payload: { defaultPath?: unknown }) =>
    dispatchInvoke('browse-folder', event, payload?.defaultPath),
  )

  ipcMain.handle(
    CH.previewDesktopMigration,
    (event, payload: { installationId?: unknown; desktopId?: unknown }) =>
      dispatchInvoke(
        'preview-desktop-migration',
        event,
        payload?.installationId,
        payload?.desktopId,
      ),
  )

  ipcMain.handle(CH.previewLocalMigration, (event, payload: { installationId?: unknown }) =>
    dispatchInvoke('preview-local-migration', event, payload?.installationId),
  )

  // Fire-and-forget. If `relaunch()` throws (sandboxed builds), skip `exit()`
  // so the user isn't killed without a respawn.
  ipcMain.on(CH.relaunchApp, () => {
    try {
      app.relaunch()
      app.exit(0)
    } catch (err) {
      console.error('Picker: relaunch failed', err)
    }
  })

  // The popup boots with a smaller static i18n catalog; pull main's full
  // catalog so keys like `actions.restart` resolve inside the popup.
  ipcMain.handle(CH.getLocaleMessages, (event) => dispatchInvoke('get-locale-messages', event))
}
