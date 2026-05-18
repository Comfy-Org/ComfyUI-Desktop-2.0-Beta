/**
 * Shared fuzzy-matching primitive used by surfaces that filter a list
 * of named items by a user-typed needle (chooser dashboard search,
 * Comfy args builder flag search, …).
 *
 * Both inputs are expected lowercased by the caller. Returns a positive
 * score on a hit, 0 on miss, and 1 on empty needle (so callers can use
 * `score > 0` as "matches" and a stable positive value for sort ties).
 *
 * Tiers:
 *   - Exact match            (1000)
 *   - Whole-string prefix    (900 - len penalty)
 *   - Word-prefix elsewhere  (800)   e.g. "device" → "cuda-device"
 *   - Contiguous substring   (600 - position penalty)
 *   - Acronym hit            (400)   e.g. "cd" → "cuda-device"
 *   - Tight subsequence      (50-200, span ≤ 2× needle)
 *
 * Loose subsequence matches are explicitly NOT allowed — they were the
 * root cause of "cuda" matching `--enable-cors-header` via c…r…s.
 *
 * Word boundaries: hyphens, underscores, AND whitespace — so it works
 * for both hyphenated flag names ("cuda-device") and space-separated
 * install names ("ComfyUI Legacy Desktop").
 */
export function scoreName(needle: string, name: string): number {
  if (!needle) return 1
  if (!name) return 0
  if (name === needle) return 1000
  if (name.startsWith(needle)) return 900 - Math.min(needle.length, 50)
  const segments = name.split(/[-_\s]+/)
  for (const seg of segments) {
    if (seg.startsWith(needle)) return 800
  }
  const idx = name.indexOf(needle)
  if (idx >= 0) return 600 - Math.min(idx, 100)
  const acronym = segments.map((s) => s[0] ?? '').join('')
  if (acronym && acronym.includes(needle)) return 400
  let h = 0
  let firstHit = -1
  let lastHit = -1
  for (let n = 0; n < needle.length; n++) {
    const c = needle[n]!
    let found = -1
    while (h < name.length) {
      if (name[h] === c) {
        found = h
        h++
        break
      }
      h++
    }
    if (found === -1) return 0
    if (firstHit === -1) firstHit = found
    lastHit = found
  }
  const span = lastHit - firstHit + 1
  if (span > needle.length * 2) return 0
  return Math.max(50, 200 - span)
}
