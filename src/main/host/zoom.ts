/**
 * Pure zoom-level math for the comfy view's Ctrl/Cmd +/-/0 shortcut.
 *
 * Kept dependency-free (no electron import) so it stays trivially
 * unit-testable, and so the desktop drives zoom off a tracked absolute
 * level instead of a fresh `webContents.getZoomLevel()` read. After a
 * navigation, Chromium can report a level out of sync with the visually-
 * applied (persisted, per-`persist:` partition) zoom, which made zoom-in
 * silently stall while zoom-out still shrank, and left a stuck level
 * across restart. See issue #698.
 */

/** Zoom granularity. 0.5 mirrors Electron's standard zoomLevel step
 *  (~91% / 110% / ...). */
export const ZOOM_STEP = 0.5

/** Bounds for the desktop-managed comfy-view zoom level. Chromium clamps
 *  `setZoomLevel` to roughly [-7.6, 9] internally; we keep a tighter,
 *  symmetric range so a user can always zoom back to 1x (level 0) from
 *  either extreme. */
export const ZOOM_LEVEL_MIN = -5
export const ZOOM_LEVEL_MAX = 5

/**
 * Compute the next zoom level for a `before-input-event` keystroke.
 *
 * @param key      the event's `input.key` — one of `'='` / `'+'` (in),
 *                 `'-'` (out), or `'0'` (reset).
 * @param current  the desktop-tracked level (NOT a fresh getZoomLevel).
 * @returns        the clamped next level.
 */
export function nextZoomLevel(key: string, current: number): number {
  if (key === '0') return 0
  const step = key === '-' ? -ZOOM_STEP : ZOOM_STEP
  return Math.min(ZOOM_LEVEL_MAX, Math.max(ZOOM_LEVEL_MIN, current + step))
}
