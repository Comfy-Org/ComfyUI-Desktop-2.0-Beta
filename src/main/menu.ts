/*
 * ⚠️ DEV-ONLY: `toggleEmbeddedDevTools` exposes a devtools menu item. The caller must keep gating it
 * on a dev-only marker (`ELECTRON_RENDERER_URL`), NOT just `!app.isPackaged`, or unpacked/preview
 * artifacts could expose tooling to production users.
 */

import { app, Menu } from 'electron'
import type { BaseWindow, MenuItemConstructorOptions } from 'electron'

export type AppMenuDevOverrides = {
  /** ⚠️ Dev-only — see file banner. */
  toggleEmbeddedDevTools?: (focusedWindow?: BaseWindow | null) => void
}

export type AppMenuHandlers = {
  /** macOS-only: the "Check for Updates…" app-menu item. Routes to `updater.runCheck`; adds no update logic. */
  onCheckForUpdates?: () => void
}

/**
 * Install the global app menu for every BrowserWindow (including OAuth/cloud popups). Without it,
 * Electron's default menu exposes destructive Close items that bypass our managed shutdown.
 * Win/Linux: strip the menu entirely. macOS: sanitized template keeping appMenu + editMenu (needed
 * for OAuth fields) and a Window submenu with no close roles.
 */
export function installAppMenu(
  platform: NodeJS.Platform = process.platform,
  devOverrides?: AppMenuDevOverrides,
  handlers?: AppMenuHandlers,
): void {
  const routedDevTools =
    typeof devOverrides?.toggleEmbeddedDevTools === 'function'
      ? devOverrides.toggleEmbeddedDevTools
      : undefined

  if (platform !== 'darwin') {
    if (!routedDevTools) {
      Menu.setApplicationMenu(null)
      return
    }
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'View',
          submenu: [
            { role: 'reload' },
            { role: 'forceReload' },
            {
              label: 'Toggle Developer Tools',
              accelerator: 'Control+Shift+I',
              click: (_menuItem, bw) => {
                routedDevTools(bw)
              },
            },
          ],
        },
      ]),
    )
    return
  }
  const onCheckForUpdates =
    typeof handlers?.onCheckForUpdates === 'function' ? handlers.onCheckForUpdates : undefined

  // Stock `appMenu` role plus a "Check for Updates…" item after About; falls back to plain role if unwired.
  const appMenu: MenuItemConstructorOptions = onCheckForUpdates
    ? {
        label: app.name,
        submenu: [
          { role: 'about' },
          {
            label: 'Check for Updates…',
            click: () => {
              onCheckForUpdates()
            },
          },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      }
    : { role: 'appMenu' }

  const template: MenuItemConstructorOptions[] = [
    appMenu,
    { role: 'editMenu' },
    ...(routedDevTools
      ? ([
          {
            label: 'View',
            submenu: [
              { role: 'reload' },
              { role: 'forceReload' },
              {
                label: 'Toggle Developer Tools',
                accelerator: 'Alt+Command+I',
                click: (_menuItem, bw) => {
                  routedDevTools(bw)
                },
              },
            ],
          },
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
