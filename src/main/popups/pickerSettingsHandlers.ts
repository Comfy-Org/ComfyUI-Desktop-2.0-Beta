import { app, ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'

/**
 * Picker expanded-Manage IPC handlers.
 *
 * The instance-picker popup is a separate WebContentsView with its own
 * preload (`comfyTitlePopupPreload.ts`) — no `window.api`. To run the
 * full per-install settings UI inside it (the brand-redesigned tabbed
 * surface shared with the legacy drawer), the popup process needs each
 * `window.api.*` call the settings UI makes to round-trip through main.
 *
 * Each handler below registers a popup-facing IPC channel
 * (`comfy-titlepopup:picker-settings-*`) that internally forwards to
 * the existing panel-facing handler (`get-detail-sections`,
 * `update-installation`, etc.). This keeps the source of truth in one
 * place — we don't duplicate handler bodies — and means a future fix
 * to the panel-side handler automatically applies to the picker-side
 * dispatch with no extra work.
 *
 * The forwarding uses Electron's documented `_invokeHandlers` map.
 * That registry isn't part of the public API surface but is stable
 * across Electron releases and used by several production apps for
 * exactly this kind of internal dispatch (cross-popup proxying).
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
  // ---- Detail sections + disk + size ----
  ipcMain.handle(
    'comfy-titlepopup:picker-settings-get-detail-sections',
    (event, payload: { installationId?: unknown }) =>
      dispatchInvoke('get-detail-sections', event, payload?.installationId),
  )

  ipcMain.handle(
    'comfy-titlepopup:picker-settings-get-disk-space',
    (event, payload: { path?: unknown }) => dispatchInvoke('get-disk-space', event, payload?.path),
  )

  ipcMain.handle(
    'comfy-titlepopup:picker-settings-get-installation-size',
    (event, payload: { installationId?: unknown }) =>
      dispatchInvoke('get-installation-size', event, payload?.installationId),
  )

  // ---- Mutations ----
  ipcMain.handle(
    'comfy-titlepopup:picker-settings-update-installation',
    (event, payload: { installationId?: unknown; data?: unknown }) =>
      dispatchInvoke('update-installation', event, payload?.installationId, payload?.data),
  )

  ipcMain.handle(
    'comfy-titlepopup:picker-settings-run-action',
    (event, payload: { installationId?: unknown; actionId?: unknown; actionData?: unknown }) =>
      dispatchInvoke(
        'run-action',
        event,
        payload?.installationId,
        payload?.actionId,
        payload?.actionData,
      ),
  )

  // ---- Field options + installations lookup (used by select / fieldSelects
  //      chains inside `useComfyUISettings.runAction`) ----
  ipcMain.handle(
    'comfy-titlepopup:picker-settings-get-field-options',
    (event, payload: { sourceId?: unknown; fieldId?: unknown; selections?: unknown }) =>
      dispatchInvoke(
        'get-field-options',
        event,
        payload?.sourceId,
        payload?.fieldId,
        payload?.selections,
      ),
  )

  ipcMain.handle('comfy-titlepopup:picker-settings-get-installations', (event) =>
    dispatchInvoke('get-installations', event),
  )

  // ---- Session control (restart synthetic action) ----
  ipcMain.handle(
    'comfy-titlepopup:picker-settings-stop-comfyui',
    (event, payload: { installationId?: unknown }) =>
      dispatchInvoke('stop-comfyui', event, payload?.installationId),
  )

  ipcMain.handle(
    'comfy-titlepopup:picker-settings-cancel-operation',
    (event, payload: { installationId?: unknown }) =>
      dispatchInvoke('cancel-operation', event, payload?.installationId),
  )

  // ---- Snapshots tab ----
  ipcMain.handle(
    'comfy-titlepopup:picker-settings-get-snapshots',
    (event, payload: { installationId?: unknown }) =>
      dispatchInvoke('get-snapshots', event, payload?.installationId),
  )

  ipcMain.handle(
    'comfy-titlepopup:picker-settings-get-snapshot-detail',
    (event, payload: { installationId?: unknown; filename?: unknown }) =>
      dispatchInvoke('get-snapshot-detail', event, payload?.installationId, payload?.filename),
  )

  ipcMain.handle(
    'comfy-titlepopup:picker-settings-get-snapshot-diff',
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
    'comfy-titlepopup:picker-settings-export-snapshot',
    (event, payload: { installationId?: unknown; filename?: unknown }) =>
      dispatchInvoke('export-snapshot', event, payload?.installationId, payload?.filename),
  )

  ipcMain.handle(
    'comfy-titlepopup:picker-settings-export-all-snapshots',
    (event, payload: { installationId?: unknown }) =>
      dispatchInvoke('export-all-snapshots', event, payload?.installationId),
  )

  ipcMain.handle('comfy-titlepopup:picker-settings-import-snapshots-preview', (event) =>
    dispatchInvoke('import-snapshots-preview', event),
  )

  ipcMain.handle(
    'comfy-titlepopup:picker-settings-import-snapshots-diff',
    (event, payload: { installationId?: unknown }) =>
      dispatchInvoke('import-snapshots-diff', event, payload?.installationId),
  )

  ipcMain.handle(
    'comfy-titlepopup:picker-settings-import-snapshots-confirm',
    (event, payload: { installationId?: unknown }) =>
      dispatchInvoke('import-snapshots-confirm', event, payload?.installationId),
  )

  ipcMain.handle('comfy-titlepopup:picker-settings-preview-snapshot-file', (event) =>
    dispatchInvoke('preview-snapshot-file', event),
  )

  // ---- Args builder ----
  ipcMain.handle(
    'comfy-titlepopup:picker-settings-get-comfy-args',
    (event, payload: { installationId?: unknown }) =>
      dispatchInvoke('get-comfy-args', event, payload?.installationId),
  )

  // ---- Env vars editor folder picker ----
  ipcMain.handle(
    'comfy-titlepopup:picker-settings-browse-folder',
    (event, payload: { defaultPath?: unknown }) =>
      dispatchInvoke('browse-folder', event, payload?.defaultPath),
  )

  // ---- Migrate previews (`migrate-to-standalone` flow) ----
  ipcMain.handle(
    'comfy-titlepopup:picker-settings-preview-desktop-migration',
    (event, payload: { installationId?: unknown; desktopId?: unknown }) =>
      dispatchInvoke(
        'preview-desktop-migration',
        event,
        payload?.installationId,
        payload?.desktopId,
      ),
  )

  ipcMain.handle(
    'comfy-titlepopup:picker-settings-preview-local-migration',
    (event, payload: { installationId?: unknown }) =>
      dispatchInvoke('preview-local-migration', event, payload?.installationId),
  )

  // ---- Relaunch (footer button) ----
  // Direct `app.relaunch()` — same wiring as the panel-side
  // `'relaunch-app'` IPC, but fire-and-forget so the popup process
  // doesn't need to await its own teardown.
  ipcMain.on('comfy-titlepopup:picker-settings-relaunch-app', () => {
    app.relaunch()
    app.exit(0)
  })

  // ---- i18n catalog ----
  // Popup process boots with a smaller static catalog
  // (`renderer/src/lib/i18nMessages.ts`); the expanded settings UI
  // needs keys (e.g. `actions.restart`, `diskSpace.*`) that live in
  // main's `locales/en.json` instead. Pull the same payload the panel
  // pulls via `get-locale-messages` so the popup can merge it.
  ipcMain.handle('comfy-titlepopup:picker-settings-get-locale-messages', (event) =>
    dispatchInvoke('get-locale-messages', event),
  )
}
