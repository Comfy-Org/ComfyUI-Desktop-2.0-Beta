/**
 * Fuzzy-match a lowercased needle against a lowercased name. Returns >0 on hit, 0 on miss, 1 on empty needle.
 * Tiers: exact (1000), whole-string prefix (900−len), word-prefix (800), substring (600−pos), acronym (400), tight subsequence (50–200, span ≤ 2× needle).
 * Loose subsequence is rejected on purpose (it made "cuda" match `--enable-cors-header`). Word boundaries are hyphen, underscore, and whitespace.
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
