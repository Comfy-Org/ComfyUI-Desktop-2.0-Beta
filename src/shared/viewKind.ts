/**
 * Instance-navigation vocabulary, shared across main / preload / renderer (one
 * union + helpers so the navigation matrix can't drift between processes).
 *
 *   - `ViewKind` — what a host window currently shows: the dashboard (chooser),
 *     a local instance, or a cloud/remote session. A `remote`-backed host
 *     presents as `'cloud'` for navigation (Cloud and Remote share behavior;
 *     the CTO matrix has no separate Remote row).
 *   - `Category` — the raw `sourceCategory` carried on an installation/entry.
 *     Kept verbatim for copy/telemetry.
 *   - `NavClass` — the navigation class a `Category` collapses to: `remote`
 *     folds into `cloud` because neither has a local process at risk, so they
 *     share kill-confirm, new-window, and carve-out behavior.
 */
export type ViewKind = 'dashboard' | 'instance' | 'cloud'
export type Category = 'local' | 'cloud' | 'remote'
export type NavClass = 'local' | 'cloud'

const VALID_CATEGORY: ReadonlySet<Category> = new Set<Category>(['local', 'cloud', 'remote'])

/** Collapse a raw source category to its navigation class (`remote` ⇒ `cloud`). */
export function navClass(category: Category): NavClass {
  return category === 'local' ? 'local' : 'cloud'
}

/**
 * Classify a host's view-kind from its active install. The single definition of
 * the dashboard/instance/cloud rule, shared by the main-process entry classifier
 * (`computeViewKind`) and the snapshot builder so they can't diverge:
 *   - no active install → `'dashboard'`
 *   - local install     → `'instance'`
 *   - cloud|remote (or unknown category on an install-backed host) → `'cloud'`
 */
export function viewKindFor(activeInstallationId: string | null, category: Category | null): ViewKind {
  if (activeInstallationId === null) return 'dashboard'
  return category === 'local' ? 'instance' : 'cloud'
}

/** Coerce an unknown `sourceCategory` payload to a `Category`, or `null` when
 *  absent/unrecognised (install-less hosts have no category). */
export function normaliseCategory(raw: unknown): Category | null {
  return typeof raw === 'string' && VALID_CATEGORY.has(raw as Category) ? (raw as Category) : null
}
