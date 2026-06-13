// Shared main-process color constants. Brand colors match the frontend design system.

import { perceivedLuminance, LUMINANCE_LIGHT_THRESHOLD } from '../../shared/colorLuminance'

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

/** Window-control symbol color (`#dddddd` on dark backgrounds, `#333333` on light) chosen by the
 *  perceived luminance of `bg` so the min/max/close glyphs stay legible against any reported
 *  ComfyUI theme. Accepts `#rgb` / `#rrggbb` / `rgb()` / `rgba()`; falls back to the dark-safe
 *  light glyph on any parse failure. */
export function readableSymbolColor(bg: string): string {
  const rgb = parseColor(bg)
  if (!rgb) return '#dddddd'
  const [r, g, b] = rgb
  return perceivedLuminance(r, g, b) >= LUMINANCE_LIGHT_THRESHOLD ? '#333333' : '#dddddd'
}

function parseColor(input: string): [number, number, number] | null {
  const s = input.trim().toLowerCase()
  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/)
  if (hex?.[1]) {
    const h = hex[1]
    const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)]
  }
  const rgb = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/)
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  return null
}

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
