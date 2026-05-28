import { BrowserWindow } from 'electron'
import { resolveTheme } from './ipc/shared'
import { TITLEBAR_BG } from './theme'

/** Height (px) of the custom title bar — must match the CSS `--titlebar-height`. */
export const TITLEBAR_HEIGHT = 36

/** Position of macOS traffic-light buttons, vertically centered within the title bar. */
export const TRAFFIC_LIGHT_POSITION: Electron.Point = { x: 13, y: Math.round((TITLEBAR_HEIGHT - 16) / 2) }

/** The single source of truth for the OS window-controls overlay color is
 *  {@link TITLEBAR_BG}, which mirrors `--titlebar-bg` (dark `--neutral-800`)
 *  in `src/renderer/src/assets/main.css`.
 *
 *  The title bar is locked to the dark surface for now regardless of the
 *  app theme — light-theme support across every title-bar surface (Vue
 *  pills, dropdown popups, tooltips, OS overlay) hasn't been audited yet,
 *  and rendering the bar in two themes while half the chrome inside it
 *  isn't theme-aware looks broken. Once light theme is plumbed through
 *  every title-bar surface, restore the `isDark`-branched values below.
 *  TODO(titlebar-light-theme): re-enable `color: isDark ? TITLEBAR_BG : '#e9e9e9'`
 *  and `symbolColor: isDark ? '#dddddd' : '#333333'`.
 *
 *  Used by EVERY window — launcher, install-less chooser hosts, and
 *  install-backed ComfyUI instance windows — so the min/max/close region
 *  is identical to the Vue bar above it everywhere. Instance windows must
 *  NOT adapt this to ComfyUI's in-page theme (see issue #609). */
export function titleBarOverlayForTheme(_isDark: boolean): Electron.TitleBarOverlayOptions {
  return {
    color: TITLEBAR_BG,
    symbolColor: '#dddddd',
    height: TITLEBAR_HEIGHT,
  }
}

/**
 * Update the title bar overlay on the main launcher window only.
 * Other windows set their overlay at creation via `titleBarOverlayForTheme`;
 * this is the live-repaint path for the launcher when the theme setting flips.
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
