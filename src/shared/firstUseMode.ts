/**
 * Title-bar chrome-lockdown mode, shared across main / preload / renderer.
 *
 * One union, one validator — every IPC boundary that carries this value
 * imports from here so a new mode added below propagates with no drift.
 *
 *   - `'none'`              — no lockdown; full title-bar button set.
 *   - `'consent-lockdown'`  — first-use consent step; chrome fully
 *                             locked, only the static centre pill +
 *                             update pills render.
 *   - `'post-consent'`      — later first-use steps; same chrome
 *                             lockdown, but the waffle menu surfaces a
 *                             single Skip Onboarding escape hatch
 *                             (see `buildTitlePopupMenuItems`).
 *   - `'loading-lockdown'`  — a Tier-3 ProgressModal takeover is open
 *                             (install / update / migrate / snapshot /
 *                             launch). Same chrome lockdown as consent;
 *                             waffle menu has no escape hatch — the op
 *                             owns the window until it finishes or the
 *                             user cancels via ProgressModal's own ✕.
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

/**
 * First-use takeover modes (consent + post-consent) — full chrome
 * lockdown. The user is mid-bootstrap and the only escape hatches
 * are the consent buttons or (on `post-consent`) the menu's Skip
 * Onboarding entry. The pill, trailing pills, and feedback button
 * are all hidden.
 */
export function isFirstUseLockdownMode(mode: FirstUseMode): boolean {
  return mode === 'consent-lockdown' || mode === 'post-consent'
}

/**
 * ProgressModal takeover mode — a long-running op (install / update /
 * migrate / snapshot / launch) is mounted. The user keeps full access
 * to the title bar so they can open the picker, swap windows, send
 * feedback, or quit cleanly while the op runs in the background. The
 * waffle + pill + trailing pills all stay live.
 */
export function isLoadingLockdownMode(mode: FirstUseMode): boolean {
  return mode === 'loading-lockdown'
}

/**
 * Legacy union — true for every non-`'none'` mode. Retained for the
 * `is-consent-lockdown` CSS class hook on the title-bar root and for
 * back-compat with callers that haven't migrated to the granular
 * predicates above. Prefer `isFirstUseLockdownMode` /
 * `isLoadingLockdownMode` for new code so chrome gates can distinguish
 * first-use lockdown (hide everything) from loading lockdown (keep
 * everything live).
 */
export function isChromeLockedMode(mode: FirstUseMode): boolean {
  return mode !== 'none'
}
