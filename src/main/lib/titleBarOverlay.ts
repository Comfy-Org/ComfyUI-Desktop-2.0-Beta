import { BrowserWindow } from 'electron'
import { resolveTheme } from './ipc/shared'

/** Height (px) of the custom title bar — must match the CSS `--titlebar-height`. */
export const TITLEBAR_HEIGHT = 36

/** Colors must stay in sync with `--surface` in `src/renderer/src/assets/main.css`. */
export function titleBarOverlayForTheme(isDark: boolean): Electron.TitleBarOverlayOptions {
  return {
    color: isDark ? '#262729' : '#e9e9e9',
    symbolColor: isDark ? '#dddddd' : '#333333',
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
