import { Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'

/**
 * Install the global application menu used by every BrowserWindow we
 * spawn — including OAuth / cloud-login popups created via
 * `comfyContents.setWindowOpenHandler`. Without this, Electron's default
 * menu is inherited and exposes destructive items (Close Window /
 * Close All Windows / Quit) that bypass our managed shutdown:
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
 */
export function installAppMenu(platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { role: 'editMenu' },
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
