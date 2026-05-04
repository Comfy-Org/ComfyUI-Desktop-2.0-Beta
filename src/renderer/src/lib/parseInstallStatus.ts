/**
 * Parse a backend install-progress status string into structured fields.
 *
 * Per onboarding-redo-v2 §5: replaces v1's parser which dropped bytes from
 * `parts[0]` (Bug 2) and dropped file-counts during setup (Bug 3). This
 * parser is the single source of truth for the installing-screen Row A /
 * Row B layout. Pure function — no Vue / i18n deps so it can be unit-tested
 * against the exact strings the backend emits.
 *
 * Backend formats handled (verbatim from src/main/lib/installer.ts and
 * src/main/sources/standalone/install.ts):
 *
 *   "Downloading… 64.2 / 543.2 MB · 4.3 MB/s · 0:14 elapsed · 1:51 remaining"
 *   "Extracting… 67% · 0:14 elapsed · 0:08 remaining"
 *   "Copying packages… 2417 / 4302 files · 1m12s elapsed · 38s remaining"
 *
 * Plus special-case statuses without `·`:
 *
 *   "Waiting for another installation to finish downloading…"
 *   "Cached" / "Using cached download"
 *   "Starting download" / "Starting download…"
 *   "Creating Python environment…"
 *   "Finalizing setup"
 *
 * The parser never crashes the layout — anything it doesn't recognize is
 * rendered as `phase: 'unknown'` with the raw chunk in `primary`.
 */

export type ParsedPhase = 'download' | 'extract' | 'setup' | 'unknown'

export interface ParsedStatus {
  phase: ParsedPhase
  primary: string         // bytes line OR extract pct OR file count, prominent
  speed: string | null    // "4.3 MB/s" or null
  elapsed: string | null  // "0:14 elapsed" or null
  remaining: string | null // "1:51 remaining" or null
}

const EMPTY: ParsedStatus = {
  phase: 'unknown',
  primary: '',
  speed: null,
  elapsed: null,
  remaining: null,
}

export function parseInstallStatus(raw: string | null | undefined): ParsedStatus {
  if (!raw) return EMPTY
  const trimmed = raw.trim()
  if (!trimmed) return EMPTY

  // Special-case statuses that don't carry the `·` separator. Mostly status
  // ack strings emitted between progress events (waiting / cached / starting
  // / cleanup). We classify the phase so the header still reads right; the
  // primary text is short copy that fits in row A.
  const lower = trimmed.toLowerCase()
  if (lower.startsWith('waiting for another installation')) {
    return { phase: 'download', primary: 'Waiting…', speed: null, elapsed: null, remaining: null }
  }
  if (lower === 'cached' || lower.startsWith('using cached download')) {
    return { phase: 'download', primary: 'Cached', speed: null, elapsed: null, remaining: null }
  }
  if (lower.startsWith('starting download')) {
    return { phase: 'download', primary: 'Starting…', speed: null, elapsed: null, remaining: null }
  }
  if (lower.startsWith('creating python environment')) {
    return { phase: 'setup', primary: 'Creating Python environment…', speed: null, elapsed: null, remaining: null }
  }

  // Split on `·` and trim each part. Filter empty strings so a malformed
  // double-separator doesn't shift the indices.
  const parts = trimmed
    .split('·')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  if (parts.length === 0) return { ...EMPTY, primary: trimmed }

  const first = parts[0] || ''

  if (/^downloading/i.test(first)) {
    // "Downloading… 64.2 / 543.2 MB" → strip prefix → "64.2 / 543.2 MB".
    // The phase title above the bar already says "Downloading ComfyUI runtime"
    // so we don't repeat the verb here.
    const primary = first.replace(/^downloading…?\s*:?\s*/i, '').trim()
    return {
      phase: 'download',
      primary: primary || first,
      speed: parts[1] ?? null,
      elapsed: parts[2] ?? null,
      remaining: parts[3] ?? null,
    }
  }

  if (/^extracting/i.test(first)) {
    // "Extracting… 67%" → "67%". Extract reports its own percent in primary
    // because that's the most prominent extract metric (no bytes / file
    // count to show during this phase).
    const primary = first.replace(/^extracting…?\s*:?\s*/i, '').trim()
    return {
      phase: 'extract',
      primary: primary || first,
      speed: null,
      elapsed: parts[1] ?? null,
      remaining: parts[2] ?? null,
    }
  }

  if (/^copying packages/i.test(first)) {
    // "Copying packages… 2417 / 4302 files" → "2417 / 4302 files"
    // This is the file-counts visibility fix (Bug 3) — the parser pulls the
    // file fraction out of parts[0] so the layout can render it prominently.
    const primary = first.replace(/^copying packages…?\s*:?\s*/i, '').trim()
    return {
      phase: 'setup',
      primary: primary || first,
      speed: null,
      elapsed: parts[1] ?? null,
      remaining: parts[2] ?? null,
    }
  }

  // Catch-all: a status we don't recognize (e.g. "Finalizing setup",
  // "Fetching version tags…"). Render the raw chunk as primary so the user
  // sees something rather than nothing — never lie, never crash.
  return { phase: 'unknown', primary: first, speed: null, elapsed: null, remaining: null }
}
