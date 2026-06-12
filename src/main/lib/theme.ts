// Shared main-process color constants. Brand colors match the frontend design system.

/** ComfyUI "Electric Yellow" — `--color-brand-yellow` / `--color-electric-400` in the frontend. */
export const BRAND_YELLOW = '#F0FF41'

/** Dark background used for comfy windows — matches the frontend's dark theme `--bg-color`. */
export const COMFY_BG_DARK = '#202020'

/** Light background — matches the frontend's light theme fallback. */
export const COMFY_BG_LIGHT = '#f5f5f5'

/** Default dark background for comfy windows (used at creation time before theme is known). */
export const COMFY_BG = '#171717'

/** Title bar background. Must stay in sync with `--titlebar-bg` in `src/renderer/src/assets/main.css`
 *  so the OS window-controls overlay matches the Vue `.title-bar` on every window. */
export const TITLEBAR_BG = '#211927'

export interface SplashTheme {
  bg: string
  fg: string
  isDark: boolean
}

export const SPLASH_DARK: SplashTheme = { bg: COMFY_BG_DARK, fg: '#ffffff', isDark: true }
export const SPLASH_LIGHT: SplashTheme = { bg: COMFY_BG_LIGHT, fg: '#000000', isDark: false }

/** Brand-purple splash — matches the app's `--titlebar-bg` / `--neutral-800`
 *  chrome color so the update splash reads as part of the desktop app rather
 *  than a generic grey window. */
export const SPLASH_PURPLE: SplashTheme = { bg: TITLEBAR_BG, fg: '#ffffff', isDark: true }
