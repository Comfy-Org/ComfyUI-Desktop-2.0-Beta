# Modal unification — plan

Forward-looking plan for the next post-Phase 3 polish track. Captures
the design decisions reached in the design review immediately following
the Tracks A–G ship (commit `5acd46b` on
`feat/unified-window-titlebar-panels`).

This is the immediate next track. The two follow-on items
(window-mode unification, code review against `main`) are sketched at
the bottom for sequencing context but are not part of this plan's
scope.

---

## Goal

Replace the two-primitive Modal + Takeover system with **one primitive
(Modal)** that takes style + binding props. Resolves several gated
items in [post-phase3-ux-polish.md](post-phase3-ux-polish.md), reduces
duplication risk, and prepares the codebase for the cleaner code review.

## Design rules

### Single primitive, three style variants

All three variants are the same `Modal` component with different prop
combinations:

| Variant | `binding` | `opacity` | `width` | Use cases |
|---------|-----------|-----------|---------|-----------|
| Regular modal | `false` | `dim` (current standard) | ~600px | Per-install Manage, Preferences, alerts, confirms, channel switch, cancel-op, etc. |
| Comfy-Instance modal | `false` | `heavy-dim` | ~600px | Same as regular but on Comfy Instance — heavier dim differentiates from any modals ComfyUI itself renders. |
| Takeover-modal | `true` | `opaque` | ~900–1000px (with side margins so it doesn't read as edge-stretched) | Install flows, first-use, update-while-running. |

The `opacity` prop is a finite enum (`dim` / `heavy-dim` / `opaque`),
not a numeric — keeps the surface auditable and stops drift.

### Binding modal semantics (`binding: true`)

- **No click-outside dismiss.**
- **No corner ✕ button** rendered by the modal chrome. Close affordance
  comes from inside the flow (cancel button) or from the OS chrome
  (window X).
- **Closing the window = cancelling the binding process** with
  appropriate rollback. See cancel matrix below.
- **Title bar stays fully interactive** (general rule). Clicking
  nav-arrows / install pill / window close counts as cancelling the
  binding flow. Confirm prompt may be shown for destructive cancels.
- **Special-case lockdown for First-Use T&C step only**: waffle menu
  hidden, centered window-title text non-interactable. Justified by
  the legal-gate semantics of T&C.
- **Explicit "back to main concern" affordance required**: back chevron
  in the modal chrome OR a "Return to <Dashboard|ComfyUI>" button.
  Decide per flow; intention must be clear.

### Non-binding modal semantics (`binding: false`)

- **Click-outside-to-close is the standard dismiss.**
- **Corner ✕ button OK.**
- **Title bar fully interactive**, no cancel semantics — closing the
  modal is a no-op against the underlying window state.
- **"Back to main concern" affordance** = the click-outside dismiss
  itself; no extra chrome required.

### `isInert` flag retirement

The Phase 3 §17 `isInert` flag system is **effectively retired** under
this model:

- General binding modals leave the title bar live → no inert state to
  push.
- The First-Use T&C lockdown becomes a small first-use-specific
  config (hide waffle, freeze center text), not a cross-cutting flag.
- Track C's file-menu carve-out becomes unnecessary — there's no
  inert state for the file menu to be exempted from.
- The `comfy-titlebar:inert-changed` IPC channel + bridge plumbing
  can be removed once all consumers are gone.

## Cancel matrix

| Binding flow | Cancel via | Effect |
|---|---|---|
| Update-while-running (Comfy Instance) | Title-bar action / window close / cancel button | Roll back update, leave install in working state. Comfy stays off (it was already stopped to begin the update — updates are NOT attempted while Comfy is running). |
| First-use post-T&C | Waffle "Skip onboarding" | Drop to dashboard; persistent flag set; first-use does NOT remount on next launch. |
| First-use post-T&C | Window X (OS chrome) | Close the app entirely. NO persistent flag; first-use REMOUNTS on next launch (the user has not explicitly opted out). |
| First-use T&C consent | Window X (only escape) | Close app; remount on next launch. |
| Install flows on Comfy Instance (binding subset) | Cancel button / window close | Roll back to working state. Match `main` branch's existing cancel semantics — main has these mostly right and current branch may have drifted. |

## Flow inventory under unification

Revised mapping of the [post-phase3-ux-polish.md](post-phase3-ux-polish.md)
flow inventory under this model. Items marked **(no change)** already
mount as the right primitive today.

| # | Flow | Variant on Dashboard | Variant on Comfy Instance |
|---|------|----------------------|---------------------------|
| 1 | First-use consent | **Binding takeover-modal + T&C lockdown** | n/a |
| 1b | First-use post-consent (pick / mirrors / localBranch) | **Binding takeover-modal** | n/a |
| 2 | New install | **Binding takeover-modal** (install flow) | Removed (per Track B item 3) |
| 3 | Track existing | **Binding takeover-modal** (install flow) | Removed |
| 4 | Load snapshot | **Binding takeover-modal** (install flow) | Removed |
| 5 | Quick install / migration | **Binding takeover-modal** (install flow) | Removed |
| 6 | Manage… (per-install) | Non-binding modal *(no change)* | Sidebar tab *(gated on settings split)* |
| 7 | App-level Preferences | Non-binding modal | Sidebar tab *(gated)* |
| 8 | Directories | Non-binding modal | Sidebar tab *(gated)* |
| 9 | In-progress (Tier 2) | Non-binding modal | Non-binding Comfy-Instance modal (heavy-dim) |
| 10 | Update-while-running | n/a | **Binding takeover-modal** |
| 11 | App-update popover | *(deferred — separate decision)* | Same |
| 12 | App-update banner | Stays in-panel *(no change)* | Stays in-panel |
| 13 | Cancel-op confirm | Non-binding modal *(no change)* | Non-binding modal |
| 14 | Channel switch confirm | Non-binding modal *(no change)* | Non-binding modal |
| 15 | Alerts / confirms | Non-binding modal *(no change)* | Non-binding modal |

## Width spec

- **Regular modal**: `max-width: 600px` (status quo for most current
  modals — confirm by audit).
- **Takeover-modal**: `max-width: ~900–1000px`. Side margins on the
  surrounding overlay should be generous enough that the modal never
  reads as "stretched into the sides" even on the smallest supported
  window width.
- Width tokens probably belong in
  `src/renderer/src/lib/modalSize.ts` (new) or extend the existing
  modal style module if there is one.

## Implementation tracks

Sliced for clean per-commit gates. Each track owns one or two commits.

### Track M-1 — Modal primitive consolidation
- Promote the existing `Modal` component to take `binding` (bool) +
  `opacity` (`'dim' | 'heavy-dim' | 'opaque'`) + `width` (`'regular' | 'takeover'`) props.
- Default values match current behavior so existing call sites are
  no-op until they explicitly opt into the new variants.
- Add the width-token style module if one doesn't exist yet.
- No behavior changes ship in this track — purely additive.

### Track M-2 — First-Use migration off Takeover
- Reshape `FirstUseTakeover.vue` into a binding takeover-modal.
- Add T&C-step lockdown config (hide waffle on chooser-host title bar,
  freeze centered window-title text — applies only during T&C step).
- Add "Skip onboarding" entry to the chooser-host waffle menu, gated
  to render only when first-use post-T&C is mounted. Action sets the
  persistent "skipped onboarding" flag and emits `complete`.
- Verify Track D's recent state machine work
  (`pendingFirstUseAutoLaunchId`, progressStore watcher, legacy-desktop
  `localBranch` step) survives the reshape intact.
- Window-X-during-first-use behavior: app exits without setting the
  persistent flag; first-use remounts on next launch. Confirm
  `before-close` lifecycle wiring.

### Track M-3 — Install-flow takeovers → binding modals
- Audit current state of New install / Track / Load snapshot /
  Quick install (migration). Some are likely modals already —
  standardize to binding takeover-modal where they are not.
- Update-while-running: convert from current Tier 3 takeover (added
  in Phase 3 §10) to binding takeover-modal. Verify Comfy-stop ↔
  modal-mount ordering is preserved.

### Track M-4 — `isInert` system retirement
- After M-1/M-2/M-3 land and no consumer relies on `isInert`:
  - Remove `comfy-titlebar:inert-changed` IPC channel.
  - Remove the `isInert` ref + bridge plumbing from
    `TitleBarApp.vue` and `comfyTitleBarPreload.ts`.
  - Remove main-side `setTitleBarInert(...)` calls.
  - Track C's file-menu carve-out comment can be simplified or
    removed.
- Sanity-check that no Phase 3 §17 follow-up depends on inert state.

### Track M-5 — "Back to main concern" affordance
- Add a back-chevron component (or "Return to ..." button slot) to
  the binding-modal chrome.
- Decide per flow which variant fits — capture choices in this doc.

Per-flow choices (captured during the M-5 ship):

| Flow | Affordance | Rationale |
|------|-----------|-----------|
| NewInstallModal / TrackModal / LoadSnapshotModal / QuickInstallModal | `TakeoverBack` chevron + "Back to Dashboard" label, mounted at the START of `view-modal-header`. Replaces the pre-M-5 corner ✕. | All four mount on the chooser-host window; the close emit returns to the chooser body underneath. Chevron + explicit label distinguishes from NewInstallModal's own per-step `wizard-back` button at the bottom (which navigates between wizard steps, not out of the wizard). |
| FirstUseTakeover | NO header back affordance. Skip Onboarding via the file-menu waffle (added M-2.2) is the post-consent escape; the consent step has no in-app escape by design. | First-use is the bootstrap flow — there is no underlying "main concern" surface to return to (no dashboard, no install). Adding a chevron-back here would dead-end the user. |
| ProgressModal in takeover mode (update-while-running) | Deferred to M-6. | The semantics here are "cancel update with rollback", not "go back to a still-live underlying surface" — Comfy was stopped to start the update so there is no live underlying state to return to. The cancel-on-window-close wiring in M-6 is the natural place to standardise this confirm + rollback flow. The current `−` (in-flight) / `✕` (finished) button stays until M-6. |

### Track M-6 — Cancel-on-window-close wiring
- Hook each binding modal into the window's `before-close` lifecycle
  so OS-chrome X triggers the right cancel/rollback path per the
  cancel matrix above.
- Add confirm prompt for destructive cancels where appropriate.
- Test: kill window during install / migration / update — verify
  rollback matches `main`-branch semantics.

Per-flow wiring (captured during the M-6 ship):

| Overlay | Cancel-prompt copy | `onCancel` (rollback hook) |
|---------|--------------------|----------------------------|
| Tier 2 progress (install / migrate / delete / restore / etc.) | Generic `Cancel "<operationName>"?` (named variant). | `progressStore.cancelOperation(installationId)` — wired in `handleShowProgress`. |
| Tier 3 takeover, `component: 'update'` (update-while-running) | Generic `Cancel "<operationName>"?` (named variant). | `progressStore.cancelOperation(installationId)` — same wiring as Tier 2 progress, both branches wrap the same store op. |
| Tier 3 takeover, install-flow wizards (`new-install` / `track` / `load-snapshot` / `quick-install`) | Dedicated `'discard-setup'` copy → "Discard install setup?" / "Your wizard selections won't be saved …" — distinct from `'quit-setup'` (bootstrap) and from the generic in-flight-op copy. | None. The wizard has no destructive op in flight; the prompt just dismisses the wizard. |
| Tier 3 takeover, `component: 'first-use'` | Existing `'quit-setup'` copy from M-2.4. | None. Window-close closes the app without a persistent flag (per the cancel matrix); rollback isn't applicable. |

The `onCancel` hook fires from inside `useOverlay.openOverlay` immediately AFTER the user confirms the cancel-prompt and immediately BEFORE the slot is cleared / pre-empted. That ordering ensures the in-flight op is told to stop before window destruction would otherwise orphan it. The hook covers both the close-via-consult path (`closeOverlay()` → `null` swap) AND the pre-empt path (Tier 2 progress being replaced by another Tier 2 / 3 op via the same prompt).

`onCancel` is unset for wizard takeovers (no main-side rollback to fire) and for first-use (the app exits, taking the renderer with it). Tier 1 popovers (manage / app-update / downloads) never trigger the prompt and so never read `onCancel`.

### Track M-7 — `useOverlay` Tier 3 retirement (if no consumer)
- After M-2/M-3, Tier 3 (takeover) may have no remaining caller.
- Collapse the tier system to Tier 1 (modal) + Tier 2 (in-progress).
- Update collision rules and tests.

## Risks

1. **FirstUseTakeover.vue reshape (M-2)** — Track D added a lot of
   state machine; carry through carefully to avoid regressing
   skipPick / legacy-desktop branch / auto-launch.
2. **Cancel-on-window-close (M-6)** — Electron's `before-close`
   lifecycle interacting with multiple async cancel/rollback paths
   needs careful UX. Confirm prompt vs silent cancel matters.
3. **Width tokens (M-1, M-5)** — visual review needed; first attempt
   probably needs iteration after seeing it.
4. **`isInert` retirement (M-4)** — must verify no late consumer.
   Search for `isInert`, `inert-changed`, `setTitleBarInert` before
   deleting.
5. **Install-flow audit (M-3)** — uncovering more divergence from
   `main` than expected (per the user's "main has the semantics
   right" comment) could expand M-3's scope. If so, scope down M-3
   to just the primitive switch and let the cancel-semantics fixes
   ride on the code-review pass.

## Sequencing relative to follow-on work

This plan is the immediate next track. Two larger items follow:

### Window-mode unification — separate plan / existing issue

Tracked in [Issue #470](https://github.com/Comfy-Org/ComfyUI-Desktop-2.0-Beta/issues/470)
("Transform host windows in place between install-backed and
chooser-host modes (no window swap)"). Goal: collapse "dashboard
window" and "Comfy Instance window" into a single window primitive
that flips modes, removing the window boundary that today makes
auto-launch + tile-click handoff awkward.

Decisions captured during this design review that update that issue:
- Resolves the "first-use auto-launch heuristic" followup in
  [post-phase3-ux-polish.md](post-phase3-ux-polish.md) — no window
  boundary to chase the resulting install across.
- Resolves "tile click for already-running install closes originating
  dashboard window and focuses existing instance" — becomes "flip
  current window into instance mode."
- Resolves "don't treat dashboard windows as pseudo-launchers" —
  collapses into the unification.
- Update-while-running stays in-window naturally regardless of mode.
- Per-install settings tab + Preferences tab + Directories tab in the
  Comfy Instance left sidebar (the gated settings-split work)
  becomes coherent once the window primitive is unified — there's
  one window per install, one sidebar.

### Code review against `main` — after both unifications land

Run `git diff main feat/...` review with cancel/rollback semantics as
the explicit checklist. Areas to scrutinize:

1. Cancel-op rollback paths (install / migrate / quick-install / update-while-running).
2. Install lifecycle state machine — did any state transitions get
   reordered or lose error-handling branches during Phase 3?
3. Window/process ownership — does cancelling an op from one window
   correctly kill the spawned process? Risk increased now that ops
   can be triggered on installs from multiple windows.
4. Settings/prefs read/write — did anything get migrated to a new
   shape and break the upgrade path from `main`?
5. Look for code duplication introduced during Phase 3 (per AGENTS.md
   post-change review). Particular hotspots: `useOverlay`,
   `installContextMenu`, IPC channel handler patterns,
   per-source-category branching.

The code review runs **after** modal + window-mode unifications
because both are cross-cutting changes that would otherwise reshuffle
the surface being reviewed — running it earlier wastes effort.

## Out of scope for this plan

- App-update popover surface decision (panel-positioned card vs
  title-bar child window) — explicitly deferred upstream, still
  deferred here.
- Settings split (Comfy-Instance left-sidebar tab layout) — depends
  on window-mode unification; not blocked by modal unification.
- Running-install ownership — depends on window-mode unification.
- New-install wizard restructure — depends on first-time vs
  subsequent install flow distinction; touch-adjacent to M-3 but
  intentionally deferred.
- Restart-required pill family (deferred from §18, [Issue #473](https://github.com/Comfy-Org/ComfyUI-Desktop-2.0-Beta/issues/473) sibling).
