/**
 * Title-bar chrome-lockdown mode, shared across main / preload / renderer (one union + validator so new modes propagate with no drift).
 *   - `'none'` — full title-bar button set.
 *   - `'consent-lockdown'` — first-use consent; chrome locked.
 *   - `'post-consent'` — later first-use steps; locked but with a Skip Onboarding escape hatch.
 *   - `'loading-lockdown'` — a ProgressModal takeover; locked with no escape hatch (cancel via ProgressModal's ✕).
 */
export type FirstUseMode =
  | 'none'
  | 'consent-lockdown'
  | 'post-consent'
  | 'loading-lockdown'

const VALID: ReadonlySet<FirstUseMode> = new Set<FirstUseMode>([
  'none',
  'consent-lockdown',
  'post-consent',
  'loading-lockdown',
])

/** Coerce an unknown IPC payload to a valid mode, defaulting to `'none'`. */
export function normaliseFirstUseMode(raw: unknown): FirstUseMode {
  return typeof raw === 'string' && VALID.has(raw as FirstUseMode)
    ? (raw as FirstUseMode)
    : 'none'
}

// First-use modes (consent + post-consent): full chrome lockdown, pill/feedback hidden.
export function isFirstUseLockdownMode(mode: FirstUseMode): boolean {
  return mode === 'consent-lockdown' || mode === 'post-consent'
}

// ProgressModal takeover mode: the user keeps full title-bar access while the op runs in the background.
export function isLoadingLockdownMode(mode: FirstUseMode): boolean {
  return mode === 'loading-lockdown'
}

// True for every non-`'none'` mode. Prefer the granular predicates above; retained for the CSS class hook + back-compat.
export function isChromeLockedMode(mode: FirstUseMode): boolean {
  return mode !== 'none'
}
