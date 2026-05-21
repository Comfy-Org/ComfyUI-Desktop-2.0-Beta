import { BrowserWindow } from 'electron'
import { resolveTheme } from './ipc/shared'

/** Height (px) of the custom title bar — must match the CSS `--titlebar-height`. */
export const TITLEBAR_HEIGHT = 36

/** Position of macOS traffic-light buttons, vertically centered within the title bar. */
export const TRAFFIC_LIGHT_POSITION: Electron.Point = { x: 13, y: Math.round((TITLEBAR_HEIGHT - 16) / 2) }

/** Colors must stay in sync with `--titlebar-bg` in `src/renderer/src/assets/main.css`.
 *  The title bar is locked to the dark surface for now regardless of the
 *  app theme — light-theme support across every title-bar surface (Vue
 *  pills, dropdown popups, tooltips, OS overlay) hasn't been audited yet,
 *  and rendering the bar in two themes while half the chrome inside it
 *  isn't theme-aware looks broken. Once light theme is plumbed through
 *  every title-bar surface, restore the `isDark`-branched values below.
 *  TODO(titlebar-light-theme): re-enable `color: isDark ? '#211927' : '#e9e9e9'`
 *  and `symbolColor: isDark ? '#dddddd' : '#333333'`. */
export function titleBarOverlayForTheme(_isDark: boolean): Electron.TitleBarOverlayOptions {
  return {
    color: '#211927',
    symbolColor: '#dddddd',
    height: TITLEBAR_HEIGHT,
  }
}

/** Overlay colors for ComfyUI windows — matches `--comfy-menu-bg` from the frontend design system. */
export function comfyTitleBarOverlay(): Electron.TitleBarOverlayOptions {
  return {
    color: '#353535',
    symbolColor: '#dddddd',
    height: TITLEBAR_HEIGHT,
  }
}

/**
 * Update the title bar overlay on the main launcher window only.
 * ComfyUI instance windows use their own fixed overlay color
 * (matching the frontend's --comfy-menu-bg) and should not be updated.
 */
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
