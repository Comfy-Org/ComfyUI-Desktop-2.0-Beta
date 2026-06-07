/**
 * State-driven instance/window navigation — the single source of truth for the
 * #926 behavior matrix. Pure (no Vue, no Electron, no I/O), so it runs
 * identically in the renderer (which drives the CTA label + caret items) and in
 * main (which re-asserts it before executing a verb). Same input ⇒ same output,
 * which is what makes it snapshot-testable and impossible to drift between
 * processes.
 *
 * The decision space is the finite product `ViewKind × TargetKind × TargetRun`.
 * It is modelled as a total transition table keyed by a canonical tuple encoding
 * (`CellKey`), so a lookup is O(1) and a missing cell falls through to an
 * explicit no-op. The table is *data*; the matrix is reviewed by reading it.
 *
 * IMPORTANT (rollout): this file currently encodes **current** behavior — the
 * pre-#926 baseline — so phases 0-2 are behavior-identical. Each Phase-3 delta
 * flips exactly one cell here (and its snapshot test), making the behavior
 * change the entire review surface.
 *
 * `remote` is folded into `cloud` before this function is called (see
 * `navClass` in ../viewKind); there are no `remote` cells.
 */
import type { NavClass, ViewKind } from '../viewKind'

/** What the user clicked toward. `'new-instance'` is the "+ New Instance" row;
 *  everything else is an install/dashboard target. */
export type TargetKind = 'dashboard' | 'instance' | 'cloud' | 'new-instance'

/** Runtime state of the target relative to the current host. `'self'` = the
 *  target IS the current host's own install. */
export type TargetRun = 'stopped' | 'running-here' | 'running-elsewhere' | 'self'

/** Which affordance the user used: the primary CTA, or a caret/dropdown item. */
export type Intent = 'primary' | 'new-window'

/** The action to perform. Maps 1:1 onto an existing main-process primitive (see
 *  the dispatcher in the renderer / the handlers in src/main/index.ts). */
export type Verb =
  | 'switch' // detach current install, attach target into THIS window (pickInstall)
  | 'restart' // restart the current install in place (restartInstall)
  | 'open-new' // land target in a window, leaving the current one alone
  | 'focus' // bring the target's existing window to front
  | 'no-op' // nothing to do
  | 'install-wizard' // open the new-install flow

/** Confirmation gate the verb must pass before executing. */
export type Confirm =
  | 'kill-local' // 2-way "stop the local process?" (current behavior)
  | 'switch-3way' // 3-way "stop & switch / open new window / cancel" (Phase 3a)
  | null

/** i18n KEYS (not resolved text) for the primary CTA label, by cell. The
 *  renderer resolves these via `t(...)`. */
export const NAV_LABEL = {
  start: 'instancePicker.open',
  restart: 'instancePicker.restart',
  switch: 'instancePicker.switch',
  openDashboard: 'instancePicker.openDashboard',
  openCloud: 'instancePicker.openCloud',
  openInNewWindow: 'instancePicker.openInNewWindow',
  startNewWindow: 'instancePicker.startNewWindow',
  newInstall: 'instancePicker.newInstance',
} as const
export type NavLabelKey = (typeof NAV_LABEL)[keyof typeof NAV_LABEL]

export interface NavDecision {
  window: 'same' | 'new'
  verb: Verb
  confirm: Confirm
  /** i18n key for the primary CTA label (resolved by the renderer). */
  primaryLabel: NavLabelKey
  /** Caret/dropdown alternatives for this exact cell. Each is a fully-formed
   *  decision (its own intent already applied), so the dropdown renders them
   *  directly. Empty when the cell has no alternative. */
  secondary: NavDecision[]
  /** Telemetry event to emit when this decision executes, if any. */
  telemetry: 'instance.switched' | 'instance.opened_new_window' | null
}

export interface NavInput {
  /** Current host view-kind — `remote` already folded into `cloud`. */
  currentView: ViewKind
  /** Navigation class of the current host (`null` on a dashboard host). */
  currentClass: NavClass | null
  target: TargetKind
  /** Navigation class of the target — `remote` already folded into `cloud`. */
  targetClass: NavClass
  targetRun: TargetRun
  intent: Intent
}

/** Canonical, collision-free table key. Only the three table dimensions; class
 *  is not a key (cloud/remote already folded, and verb deltas key on view). */
type CellKey = `${ViewKind}|${TargetKind}|${TargetRun}`
const cellKey = (view: ViewKind, target: TargetKind, run: TargetRun): CellKey =>
  `${view}|${target}|${run}`

// ── decision constructors ───────────────────────────────────────────────────
const NO_OP: NavDecision = {
  window: 'same',
  verb: 'no-op',
  confirm: null,
  primaryLabel: NAV_LABEL.start,
  secondary: [],
  telemetry: null,
}

/** Build a decision with sane defaults (no confirm / secondary / telemetry). */
const dec = (
  over: Partial<NavDecision> & Pick<NavDecision, 'window' | 'verb' | 'primaryLabel'>,
): NavDecision => ({
  confirm: null,
  secondary: [],
  telemetry: null,
  ...over,
})

/** The "Open in new window" caret alternative shared by several cells. */
const OPEN_NEW_WINDOW_SECONDARY: NavDecision = dec({
  window: 'new',
  verb: 'open-new',
  primaryLabel: NAV_LABEL.openInNewWindow,
  telemetry: 'instance.opened_new_window',
})

// ── the transition table (CURRENT behavior — baseline before #926 deltas) ─────
//
// Rows mirror the CTO matrix grouping. Reachable cells only; unreachable tuples
// fall through to NO_OP via the lookup miss path. Every "cloud" row also covers
// remote (folded upstream). `confirm` for in-place switches is filled at the
// boundary (decideNavigation) from the current host's class, since the table is
// class-agnostic.
const TABLE: ReadonlyMap<CellKey, NavDecision> = new Map<CellKey, NavDecision>([
  // Dashboard → X
  [cellKey('dashboard', 'dashboard', 'self'), NO_OP],
  [
    cellKey('dashboard', 'instance', 'stopped'),
    dec({ window: 'same', verb: 'switch', primaryLabel: NAV_LABEL.start }),
  ],
  [
    cellKey('dashboard', 'instance', 'running-elsewhere'),
    dec({ window: 'same', verb: 'focus', primaryLabel: NAV_LABEL.switch }),
  ],
  [
    cellKey('dashboard', 'cloud', 'stopped'),
    dec({
      window: 'same',
      verb: 'switch',
      primaryLabel: NAV_LABEL.openCloud,
      secondary: [OPEN_NEW_WINDOW_SECONDARY],
    }),
  ],
  [
    cellKey('dashboard', 'cloud', 'running-elsewhere'),
    dec({
      window: 'same',
      verb: 'focus',
      primaryLabel: NAV_LABEL.switch,
      secondary: [OPEN_NEW_WINDOW_SECONDARY],
    }),
  ],
  [
    cellKey('dashboard', 'new-instance', 'stopped'),
    dec({ window: 'same', verb: 'install-wizard', primaryLabel: NAV_LABEL.newInstall }),
  ],

  // Instance A → X
  [
    cellKey('instance', 'dashboard', 'self'),
    // Already-current behavior: dashboard opens in a NEW window so A keeps
    // running (the `handleOpenDashboard` → activate('new-window') workaround).
    dec({ window: 'new', verb: 'open-new', primaryLabel: NAV_LABEL.openDashboard }),
  ],
  [
    cellKey('instance', 'instance', 'self'),
    dec({ window: 'same', verb: 'restart', primaryLabel: NAV_LABEL.restart }),
  ],
  [
    cellKey('instance', 'instance', 'stopped'),
    // Primary "Switch" swaps B into this window (kill-confirm filled at the
    // boundary). The caret offers "Open in new window" so the user can keep A
    // running. When the per-version flag is on, main upgrades the swap confirm
    // to a 3-way modal that folds both choices into one prompt (Phase 3a).
    dec({
      window: 'same',
      verb: 'switch',
      primaryLabel: NAV_LABEL.switch,
      secondary: [OPEN_NEW_WINDOW_SECONDARY],
      telemetry: 'instance.switched',
    }),
  ],
  [
    cellKey('instance', 'instance', 'running-elsewhere'),
    dec({ window: 'same', verb: 'focus', primaryLabel: NAV_LABEL.switch }),
  ],
  [
    cellKey('instance', 'cloud', 'stopped'),
    // CURRENT: swap cloud into this window. Phase 3b flips to window:'new'.
    dec({ window: 'same', verb: 'switch', primaryLabel: NAV_LABEL.openCloud, telemetry: 'instance.switched' }),
  ],
  [
    cellKey('instance', 'cloud', 'running-elsewhere'),
    dec({
      window: 'same',
      verb: 'focus',
      primaryLabel: NAV_LABEL.switch,
      secondary: [OPEN_NEW_WINDOW_SECONDARY],
    }),
  ],

  // Cloud → X
  [
    cellKey('cloud', 'dashboard', 'self'),
    // CURRENT == matrix: dashboard in the SAME window (cloud has no local
    // process to keep alive; the session survives server-side).
    dec({ window: 'same', verb: 'switch', primaryLabel: NAV_LABEL.openDashboard }),
  ],
  [
    cellKey('cloud', 'instance', 'stopped'),
    // CURRENT: swap instance into the cloud window. Phase 3b flips to new window.
    dec({ window: 'same', verb: 'switch', primaryLabel: NAV_LABEL.start, telemetry: 'instance.switched' }),
  ],
  [
    cellKey('cloud', 'instance', 'running-elsewhere'),
    dec({ window: 'same', verb: 'focus', primaryLabel: NAV_LABEL.switch }),
  ],
  [
    cellKey('cloud', 'cloud', 'self'),
    // CURRENT: picking the cloud host's own install is a no-op. Phase 3d turns
    // this into a second cloud window via a cloud-only carve-out.
    NO_OP,
  ],
  [
    cellKey('cloud', 'new-instance', 'stopped'),
    dec({ window: 'new', verb: 'install-wizard', primaryLabel: NAV_LABEL.newInstall }),
  ],
])

/**
 * Resolve a single navigation decision for a (current host, target, intent)
 * tuple. O(1): one `Map.get` plus an intent branch.
 *
 * For `intent === 'new-window'`, returns the matching `secondary` alternative if
 * the cell offers one; otherwise falls back to the primary decision (the caret
 * isn't shown when `secondary` is empty, so this fallback is defensive).
 */
export function decideNavigation(input: NavInput): NavDecision {
  const base = TABLE.get(cellKey(input.currentView, input.target, input.targetRun)) ?? NO_OP

  // In-place switches that would kill a LOCAL process need the 2-way confirm;
  // cloud/remote current hosts have no local process, so no confirm. Filled
  // here (not in the table) because the table is class-agnostic.
  const primary: NavDecision =
    base.verb === 'switch' && base.window === 'same' && input.currentClass === 'local'
      ? { ...base, confirm: 'kill-local' }
      : base

  if (input.intent === 'new-window') {
    const alt = primary.secondary.find((s) => s.window === 'new')
    return alt ?? primary
  }
  return primary
}
