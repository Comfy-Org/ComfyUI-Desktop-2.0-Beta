import { BrowserWindow } from 'electron'
import { resolveTheme } from './ipc/shared'
import { TITLEBAR_BG } from './theme'

/** Height (px) of the custom title bar — must match the CSS `--titlebar-height`. */
export const TITLEBAR_HEIGHT = 36

/** Position of macOS traffic-light buttons, vertically centered within the title bar. */
export const TRAFFIC_LIGHT_POSITION: Electron.Point = { x: 13, y: Math.round((TITLEBAR_HEIGHT - 16) / 2) }

/** OS window-controls overlay color, sourced from {@link TITLEBAR_BG}. Locked to the dark surface
 *  regardless of app theme until light theme is plumbed through every title-bar surface.
 *  TODO(titlebar-light-theme): re-enable `color: isDark ? TITLEBAR_BG : '#e9e9e9'` and `symbolColor: isDark ? '#dddddd' : '#333333'`.
 *  Used by every window; instance windows must NOT adapt this to ComfyUI's in-page theme. */
export function titleBarOverlayForTheme(_isDark: boolean): Electron.TitleBarOverlayOptions {
  return {
    color: TITLEBAR_BG,
    symbolColor: '#dddddd',
    height: TITLEBAR_HEIGHT,
  }
}

// Live-repaint path for the launcher window's overlay when the theme flips (others set theirs at creation).
let _mainWindowId: number | null = null

export function setMainWindowId(id: number): void {
  _mainWindowId = id
}

export function updateTitleBarOverlay(): void {
  if (process.platform === 'darwin' || _mainWindowId === null) return
  const win = BrowserWindow.fromId(_mainWindowId)
  if (!win || win.isDestroyed()) return
  const resolved = resolveTheme()
  try { win.setTitleBarOverlay(titleBarOverlayForTheme(resolved === 'dark')) } catch {}
}
