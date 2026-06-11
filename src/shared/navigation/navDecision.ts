/**
 * State-driven instance/window navigation — the single source of truth for the
 * #926 behavior matrix. Pure (no Vue, no Electron, no I/O), so it runs
 * identically in the renderer (which drives the CTA label + caret items) and in
 * main (which re-asserts it before executing a verb). Same input ⇒ same output,
 * which is what makes it snapshot-testable and impossible to drift between
 * processes.
 *
 * The decision space is the finite product `ViewKind × TargetKind × TargetRun`,
 * modelled as a total transition table keyed by a canonical tuple encoding
 * (`CellKey`): a lookup is O(1) and a missing cell falls through to an explicit
 * no-op. The table is *data*; the matrix is reviewed by reading it. To change a
 * behavior, edit the cell and its snapshot test — nothing else.
 *
 * `remote` is folded into `cloud` before this function is called (see `navClass`
 * in ../viewKind); there are no `remote` cells.
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

/**
 * The action to perform. Maps 1:1 onto a main-process primitive (the renderer
 * dispatcher / the handlers in `src/main/index.ts`):
 *   - `switch` — detach the current install, attach the target into THIS window
 *   - `restart` — restart the current install in place
 *   - `open-new` — land the target in its own window, leaving the current alone
 *   - `focus` — bring the target's existing window to front
 *   - `no-op` — nothing to do
 *   - `install-wizard` — open the new-install flow
 */
export type Verb = 'switch' | 'restart' | 'open-new' | 'focus' | 'no-op' | 'install-wizard'

/** i18n KEYS (not resolved text) for the primary CTA label, by cell. The
 *  renderer resolves these via `t(...)`. */
export const NAV_LABEL = {
  start: 'instancePicker.open',
  restart: 'instancePicker.restart',
  switch: 'instancePicker.switch',
  openDashboard: 'instancePicker.openDashboard',
  openCloud: 'instancePicker.openCloud',
  openInNewWindow: 'instancePicker.openInNewWindow',
  newInstall: 'instancePicker.newInstance',
} as const
export type NavLabelKey = (typeof NAV_LABEL)[keyof typeof NAV_LABEL]

export interface NavDecision {
  window: 'same' | 'new'
  verb: Verb
  /** i18n key for the primary CTA label (resolved by the renderer). */
  primaryLabel: NavLabelKey
  /** Caret/dropdown alternatives for this exact cell. Each is a fully-formed
   *  decision (its own intent already applied), so the dropdown renders them
   *  directly. Empty when the cell has no alternative. */
  secondary: NavDecision[]
  /** Telemetry event to emit when this decision executes, if any. */
  telemetry: 'instance.switched' | 'instance.opened_new_window' | null
  /** Reserved (currently unset by every cell). Allows a SECOND window for an
   *  install that already owns one, bypassing `openInstallInNewWindow`'s
   *  focus-existing guard. Kept wired end-to-end for a future "second cloud/
   *  remote window"; cloud-self currently resolves to Restart instead (a true
   *  second view of one session isn't supported). */
  allowDuplicate?: true
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
  primaryLabel: NAV_LABEL.start,
  secondary: [],
  telemetry: null,
}

/** Build a decision with sane defaults (no secondary / telemetry). */
const dec = (
  over: Partial<NavDecision> & Pick<NavDecision, 'window' | 'verb' | 'primaryLabel'>,
): NavDecision => ({
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

/**
 * The transition table. Rows mirror the CTO matrix grouping; only reachable
 * cells are listed (unreachable tuples fall through to `NO_OP`). Every "cloud"
 * row also covers remote (folded upstream).
 */
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
    /**
     * Primary "Switch" swaps B into this window; the caret offers "Open in new
     * window" so the user can keep A running. Main's `pickInstallFromPicker`
     * owns the confirm — a 3-way modal (Switch / Open in new window / Cancel).
     */
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
    // Matrix: cloud always opens in a NEW window — it's lightweight and the
    // local instance A keeps running. No swap.
    dec({
      window: 'new',
      verb: 'open-new',
      primaryLabel: NAV_LABEL.openCloud,
      telemetry: 'instance.opened_new_window',
    }),
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
    /**
     * Documentation-only cell: the "Open Dashboard" chip is not table-driven —
     * it routes through the shared `activate('new-window')` path, so it opens a
     * new window for all hosts. The CTO matrix specifies same-window here; this
     * is a tracked deviation until the chip consults the table.
     */
    dec({ window: 'new', verb: 'open-new', primaryLabel: NAV_LABEL.openDashboard }),
  ],
  [
    cellKey('cloud', 'instance', 'stopped'),
    // Matrix: start the instance in a NEW window so the cloud session keeps
    // running. Labelled "Open in new window" (it spawns a window, not a swap).
    dec({
      window: 'new',
      verb: 'open-new',
      primaryLabel: NAV_LABEL.openInNewWindow,
      telemetry: 'instance.opened_new_window',
    }),
  ],
  [
    cellKey('cloud', 'instance', 'running-elsewhere'),
    dec({ window: 'same', verb: 'focus', primaryLabel: NAV_LABEL.switch }),
  ],
  [
    cellKey('cloud', 'cloud', 'self'),
    // The current cloud/remote session itself. Matrix row 16 wanted a SECOND
    // window, but a second view of one cloud/remote session isn't supported
    // (single-window auth/session; the fresh-host relaunch dead-ends on the
    // chooser). Restart in place instead — a real, working action.
    dec({ window: 'same', verb: 'restart', primaryLabel: NAV_LABEL.restart }),
  ],
  [
    // A DIFFERENT cloud/remote target that's already open elsewhere → focus it.
    cellKey('cloud', 'cloud', 'running-elsewhere'),
    dec({ window: 'same', verb: 'focus', primaryLabel: NAV_LABEL.switch }),
  ],
  [
    // A stopped cloud target from a cloud/remote host → open it in a new window;
    // the current cloud/remote session keeps running (mirrors cloud → instance).
    cellKey('cloud', 'cloud', 'stopped'),
    dec({
      window: 'new',
      verb: 'open-new',
      primaryLabel: NAV_LABEL.openInNewWindow,
      telemetry: 'instance.opened_new_window',
    }),
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
  const primary = TABLE.get(cellKey(input.currentView, input.target, input.targetRun)) ?? NO_OP

  if (input.intent === 'new-window') {
    const alt = primary.secondary.find((s) => s.window === 'new')
    return alt ?? primary
  }
  return primary
}
