/**
 * Perceived luminance of an 8-bit RGB color via the ITU-R BT.601 weights
 * (`(r*299 + g*587 + b*114) / 1000`), range 0–255. Shared by main + renderer so
 * the dark/light title-bar threshold can't drift between the two. Callers keep
 * their own color parsing (regex in main, canvas-normalise in the renderer) and
 * compare against {@link LUMINANCE_LIGHT_THRESHOLD}.
 */
export function perceivedLuminance(r: number, g: number, b: number): number {
  return (r * 299 + g * 587 + b * 114) / 1000
}

/** Luminance at/above which a background reads as "light" (so it wants dark chrome). */
export const LUMINANCE_LIGHT_THRESHOLD = 128
