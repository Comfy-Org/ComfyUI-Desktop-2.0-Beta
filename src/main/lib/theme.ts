/**
 * Shared color constants for the main process.
 *
 * Brand colors match the frontend design system
 * (ComfyUI_frontend/packages/design-system/src/css/style.css).
 */

/** ComfyUI "Electric Yellow" — `--color-brand-yellow` / `--color-electric-400` in the frontend. */
export const BRAND_YELLOW = '#F0FF41'

/** Dark background used for comfy windows — matches the frontend's dark theme `--bg-color`. */
export const COMFY_BG_DARK = '#202020'

/** Light background — matches the frontend's light theme fallback. */
export const COMFY_BG_LIGHT = '#f5f5f5'

/** Default dark background for comfy windows (used at creation time before theme is known). */
export const COMFY_BG = '#171717'

/** Title bar background. Must stay in sync with `--titlebar-bg` (the dark
 *  theme's `--neutral-800`) in `src/renderer/src/assets/main.css` — this is the
 *  color the Vue `.title-bar` header paints, and the OS window-controls overlay
 *  (min/max/close) must use the same value so that region is seamless with the
 *  rest of the bar on every window, dashboard AND instance. Previously `#353535`
 *  (the old ComfyUI menu color), which is why instance windows painted the
 *  controls a different shade than the bar above them. */
export const TITLEBAR_BG = '#211927'

export interface SplashTheme {
  bg: string
  fg: string
  isDark: boolean
}

export const SPLASH_DARK: SplashTheme = { bg: COMFY_BG_DARK, fg: '#ffffff', isDark: true }
export const SPLASH_LIGHT: SplashTheme = { bg: COMFY_BG_LIGHT, fg: '#000000', isDark: false }
