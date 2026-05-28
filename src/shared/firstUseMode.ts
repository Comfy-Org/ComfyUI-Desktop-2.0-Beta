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

/** True when any mode that should lock the title-bar chrome is active. */
export function isChromeLockedMode(mode: FirstUseMode): boolean {
  return mode === 'consent-lockdown' || mode === 'post-consent'
}
