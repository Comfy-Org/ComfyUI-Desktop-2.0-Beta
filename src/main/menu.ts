/* ============================================================================
 *
 * ⚠️  DEV-ONLY APPLICATION MENU EXTRA (read before changing)
 *
 * The optional `toggleEmbeddedDevTools` wiring below exposes View → Toggle
 * Developer Tools routed to nested WebContentsViews. That is NEVER appropriate
 * for production users as a casually discoverable OS menu unless product
 * explicitly wants it — we only pass `devOverrides` from `index.ts` when
 * `ELECTRON_RENDERER_URL` is set (electron-vite dev). Production packaged
 * builds do not set that env var — keep it that way.
 *
 * DO NOT change the caller to gate only on `!app.isPackaged` without also
 * requiring a dev-only marker, or unpacked/preview artifacts could expose
 * tooling unintentionally.
 *
 * ============================================================================ */

import { Menu } from 'electron'
import type { BaseWindow, MenuItemConstructorOptions } from 'electron'

export type AppMenuDevOverrides = {
  /** ⚠️ Dev-only — see file banner. */
  toggleEmbeddedDevTools?: (focusedWindow?: BaseWindow | null) => void
}

/**
 * Install the global application menu used by every BrowserWindow we
 * spawn — including OAuth / cloud-login popups created via
 * `comfyContents.setWindowOpenHandler`. Without this, Electron's default
 * menu is inherited and exposes destructive items (Close Window /
 * Close All Windows) that bypass our managed shutdown:
 *
 *   - On Windows / Linux the menu sits in each window's title bar (or is
 *     reachable via the system-menu icon at the top-left). We strip it
 *     entirely with `setApplicationMenu(null)` so popups expose only the
 *     OS frame controls (Restore / Move / Size / Minimize / Maximize /
 *     Close — all of which route through our window `close` handlers).
 *
 *   - On macOS the menu is application-global and cannot be removed, so
 *     we install a sanitized template that keeps the standard
 *     `appMenu` (About / Hide / Hide Others / Show All / Quit) and
 *     `editMenu` (Undo / Redo / Cut / Copy / Paste / Select All — needed
 *     for OAuth form fields), plus a custom Window submenu containing
 *     only `minimize` / `zoom` / `front` and explicitly omitting the
 *     default `close` / `closeAllWindows` roles. The default File / View
 *     / Help menus are dropped entirely.
 *
 *   ⚠️ When `devOverrides.toggleEmbeddedDevTools` is passed (electron-vite
 *     dev only — see `index.ts` + file banner), a minimal View submenu
 *     adds reload + routed Toggle Developer Tools so Inspect works inside
 *     WebContentsViews. Stock `toggleDevTools` role targets empty shell WC.
 */
export function installAppMenu(
  platform: NodeJS.Platform = process.platform,
  devOverrides?: AppMenuDevOverrides,
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
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
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
