# Post-Phase 3 UX polish — running notes

Captured from a design session reviewing the Phase 3 unified-window
result. Phase 3 shipped the structural skeleton (chooser host
window, single Comfy Instance windows, title-bar v2, Tier 3
takeovers, first-use flow, status pills, etc.). This document is the
follow-on: the polish + UX decisions the skeleton revealed.

The notes are organized into three context categories:

- **First Time Use** — the very first launch, before any installs exist
  beyond Cloud (always present) and possibly Legacy Desktop (auto-detected).
- **Dashboard** — the chooser-host window, viewed when no Comfy Instance
  is the focus.
- **Comfy Instance** — a window backed by a specific install, hosting
  the live ComfyUI WebContentsView.

A common thread across all three is the relationship between the
title bar, takeovers, and modals — that thread is captured in the
**Cross-cutting** section.

> **Status note for whoever picks this up:** items in the per-category
> sections are mostly small / well-scoped and can ship one slice at a
> time. The Cross-cutting **Takeover ↔ Modal rethink** is the big
> architectural decision the rest of the polish hinges on; several
> items in the per-category lists are gated on it (those are flagged
> below). Prioritize getting alignment on that section before kicking
> off the gated work.

---

## First Time Use

- **Large click targets for the cloud-vs-local pick.** Today the choice
  cards are small. Restructure as **two big squares laid out
  horizontally** (Local on one side, Cloud on the other) — each one a
  generous click target so the choice reads like a real fork in the
  road, not a checkbox-sized pick.
- **Skip the pick step for returning users.** If the launcher detects
  prior usage of Desktop 2.0 beta — i.e. installs exist beyond the
  always-present Cloud and potentially Legacy Desktop entries — the
  cloud/local pick is suppressed; the user only sees the T&Cs +
  telemetry consent step. They've already made the choice; don't
  re-litigate it.
  - The first-use takeover stops at consent and emits `complete`
    instead of advancing to `pick`.
- **No easy escape from the first-use flow.** Today the takeover's ✕
  button lets users punt straight to the dashboard, which is exactly
  what we don't want for a first-time user — they should follow the
  flow through to a real choice.
  - Drops cleanly out of the bigger "drop the takeover ✕ button"
    decision (cross-cutting), but specifically: for first-use we want
    to push hard on getting the user to a working ComfyUI as their
    first interaction.
  - The user can still close the *window* via the OS chrome (any
    takeover keeps that escape hatch); we just don't render an in-app
    dismiss affordance that drops them into the dashboard mid-onboarding.
- **First-use auto-launches on completion.**
  - Cloud branch picked → cloud install auto-launches.
  - Local branch picked → after the new-install completes, the
    resulting Standalone install auto-launches.
  - The user reaches a running ComfyUI as the natural endpoint of
    first-use, no extra "click play" step.
- **New branching step on Local + Legacy Desktop detected.** If the
  user picks Local AND we detect a Legacy Desktop installation present
  on this machine, present a follow-up screen with two options:
  - **Migrate current install** — routes to the existing migration /
    Quick Install path (same shortcut MigrationBanner already uses).
  - **Install new** — routes to the regular new-install Standalone
    path with type-pick skipped.

  The migration option only renders when the detection succeeds;
  otherwise the Local pick goes straight to new-install Standalone.

---

## Dashboard

- **Drop pinning entirely.** Pin/unpin actions, the Pinned filter, the
  gold-star UI, the `primaryInstallId` pref. Old dashboard rationale
  (highlight a few installs) is gone now that the new dashboard shows
  every install. Closes the §2 cleanup work too.
- **Drop the "Desktop" install category.** Legacy Desktop installs
  continue to live under Local (status quo before the category split).
  Remove the `desktop` filter chip and any source-category routing
  that depends on it.
- **Tile play/stop overlap with progress bar.** Buttons sit too low;
  when the progress bar renders along the card bottom they collide.
  Fix by moving the progress bar — the empty gap between the icon and
  the text is a natural new home for it. Buttons stay where they are.
- **Refresh install-type icons** *(cross-cutting — see below)*.
- **Don't treat new dashboard/chooser-host windows as
  pseudo-launchers.** The dashboard *looks* launcher-ish, but each
  window has one job — the dashboard window is the dashboard, full
  stop. Drop affordances that try to make it more.
- **Tile click for an already-running install closes the originating
  dashboard window and focuses the existing instance window.** No
  separate close button on the tile — clicking the running tile is the
  single-action handoff. The dashboard window the click originated in
  dies; focus lands on the live Comfy.
- **All settings open as modals on the dashboard.** Both per-install
  settings (clicked from a tile) and app-level / "Preferences"
  settings (clicked from the waffle menu) — modals only, no takeovers,
  no left-sidebar layout. *(Gated on the modal pattern decision.)*
- **Click-outside-modal dismisses the modal.** Current behaviour
  leaves the modal stuck unless the user finds the explicit close
  action.
- **Tile click for an in-progress tile opens the in-progress modal**
  (not Manage). The user clearly wants to see what's running on that
  install. Right-click still surfaces the action menu (where Manage…
  lives) for users who want the full controls.
- **Visually deactivate actions blocked by a running operation.**
  Today disabled actions look identical to live ones until the user
  clicks and gets a no-op or an error. Apply uniform `disabled`
  styling so the user sees which controls are gated by the running op
  without having to attempt them.
- **Closing a running instance from the dashboard is right-click
  only.** No close button on the tile itself; the action lives only in
  the right-click action menu. And the action **actually closes the
  running Comfy Instance window** — not the orphaned "dashboard says
  closed but the window's still alive" half-state we have today.
  Reuses the same close path the user would hit from the Comfy
  Instance window's own OS chrome.
- **Top-of-dashboard utility row.** Small "Import Existing Install"
  button (mirrors the old launcher's affordance) **and** "Load
  Snapshot" button, sitting alongside each other up top. These are not
  part of the New Install flow — they're peer entry points for
  bringing an external install in. Triggers the same Track and
  Load-Snapshot modals that exist today, but reached via the dashboard
  chrome rather than buried inside the new-install wizard.

---

## Comfy Instance (title bar ↔ takeovers/modals)

- **Install-update pill shows the target version.** Today it's a
  generic "Update available"; switch to "Update v{version}" matching
  how the app-update pill already reads. The version is already in the
  install's `statusTag` payload, so it's a label change + small data
  plumb.
- **App-update pill behaviour gated by the auto-update setting.**
  - *Auto-updates ON* → app downloads automatically in the background.
    Pill stays hidden during download, then appears beside the waffle
    menu as **"Update will apply on restart"** (or similar) once the
    update is staged. Clicking opens the popover with a Restart-now
    action; otherwise it applies on the next launch.
  - *Auto-updates OFF* → pill appears as **"Update v{version}
    available"** the moment an update is detected (current
    `kind='available'` behaviour). Clicking opens the popover with the
    manual Download action.

  This means the existing `kind: 'available' | 'ready' | null` state
  machine stays, but main now decides whether to enter `'available'`
  (auto-off) or skip straight through download into `'ready'`
  (auto-on). Pill copy diverges per kind.
- **Spawned auxiliary windows (cloud login etc.) shouldn't expose the
  title-bar file menu.** Regression — these windows are not full Comfy
  hosts and should never expose the waffle/file menu. Need to identify
  when this regressed.
- **Verify the macOS "passkey/token sign-in unavailable" notice still
  fires on those auxiliary windows.** Don't lose that affordance while
  fixing the file-menu reachability.
- **Install-type icon in title bar replaces textual `— Standalone` /
  `— Cloud` suffix.** The icon disambiguates source category at a
  glance without consuming label width. Cross-cutting with the icon
  refresh below.
- **Waffle menu dropdown is empty / no-ops while a new-install
  takeover is mounted.** Bug — the menu should still be navigable from
  inside takeovers, or if intentionally locked, it should reflect that
  uniformly.
- **Show crash error / log inside the Comfy Instance window when its
  instance crashes.** Currently the lifecycle view tells you it
  crashed but doesn't surface what happened — need the error/log
  context in-window so the user doesn't have to dig into log files.
- **Downloads tray in the title bar.** This is the §6 follow-through,
  but as a tray rather than a full panel. Replaces the
  renderer-injected downloads UI currently drawn into the ComfyUI page
  surface — pulls Desktop's download UI out of ComfyUI's namespace.
  Visually distinct from the update pills (which already use a
  Download icon) — needs different iconography / chrome so the user
  reads "downloads tray" vs "update available pill" at a glance.
- **Settings live as a tab in the Comfy Instance view's left-sidebar
  layout.** The this-install settings are one tab; the global /
  Preferences tab and Directories tab share the same sidebar. This is
  where the "unified settings with categories" surface actually lives.
  *(Gated on the settings-split decision.)*
- **Comfy Instance is closed-off** — no New Install / Track / Load
  Snapshot / Migrate entries in the in-Comfy waffle menu. Once in a
  Comfy Instance window, the only Desktop-2 escape hatch is "go back
  to dashboard" (which kills the running instance — no silent
  overlap).

---

## Cross-cutting

### Install-type icon set

- **New iconography for install types.** Specifically: Legacy Desktop
  should read as visibly older / different from a current Standalone
  install — survey options. The same icons drive both:
  - Dashboard tile (already shows source-category info)
  - Comfy Instance title bar (replacing the textual category suffix)

### Takeover ↔ Modal rethink — **BIG DECISION**

This is the architectural decision that gates a lot of the per-category
items. Several items above will need refinement once this is settled.

- **Takeovers need a max-width.** Today they fill the whole window;
  should sit centered with a max-width like modals do, so flow content
  doesn't stretch unreadably wide.
- **Drop the takeover ✕ button.** The OS chrome already renders an ✕
  in the top-right (at least on Windows) — duplicating it is awkward.
- **Two distinct purposes for takeovers:**
  1. **Binding flows** — exiting requires some kind of commitment
     (first-use is the canonical example).
  2. ~~**Modal base on Comfy Instance**~~ — *superseded; see next bullet.*
- **Lean into "modal, not takeover" as the default.** Once max-width
  capped, takeover screens visually read as modals anyway → just make
  them modals (with possibly a different page background / dim level
  to set the takeover-style mood when needed). Reserve full takeovers
  for the binding cases above.
- **Modal-on-Comfy strategy (replaces the takeover-as-base idea).**
  Just use modals on Comfy Instance with **stronger background
  dimming** to differentiate from any modals ComfyUI itself renders.
  No takeover-base layer — simpler.
- **Always advertise "back to the window's main concern."** Whatever
  sits behind a modal/takeover (dashboard window → Dashboard,
  comfy-instance window → ComfyUI) needs a clear, persistent
  affordance to return to it. Open question — could be a back chevron
  in the chrome, an explicit "Return to ComfyUI" / "Return to
  Dashboard" button, dimmed-but-visible underlying surface that's
  clickable, etc.
- **Click-outside-to-close is the standard modal dismiss** (consistent
  with the Dashboard settings-as-modal change above). Reserve "no easy
  escape" for the binding-flow takeovers.

#### Flow inventory + strawman per context

The full set of flows that currently mount as takeovers/modals/popovers,
with where each sits once we apply the rules above. Items marked
*(decision pending)* await the big-decision discussion.

| # | Flow | On Dashboard | On Comfy Instance |
|---|------|--------------|-------------------|
| 1 | First-use | **Takeover** (binding, no easy exit) | n/a — first-use only mounts on dashboard/chooser host |
| 2 | New install | **Modal** | **Removed** |
| 3 | Track existing | **Modal** | **Removed** |
| 4 | Load snapshot | **Modal** | **Removed** |
| 5 | Quick install / migration | **Modal** (kept — used by MigrationBanner and the first-use Local + Legacy detected branch) | **Removed** |
| 6 | Manage… (per-install) | **Modal** | **Sidebar tab** |
| 7 | App-level Preferences | **Modal** | **Sidebar tab** |
| 8 | Directories | **Modal** | **Sidebar tab** |
| 9 | In-progress (Tier 2) | Modal | Modal (heavy dim) |
| 10 | Update-while-running | n/a (install isn't running on dashboard) | **Takeover** (binding — ends in restart) |
| 11 | App-update popover | *(decision pending — panel-positioned card vs true title-bar child-window popup)* | Same |
| 12 | App-update banner | Stays in-panel | Stays in-panel |
| 13 | Cancel-op confirm | Modal | Modal |
| 14 | Channel switch confirm | Modal | Modal |
| 15 | Alerts / confirms | Modal | Modal |

### Settings split

- **Two different settings homes by context, not one unified surface:**
  - **Dashboard** → per-install and app-level settings each open as
    standalone modals. Lightweight, single-purpose, no
    sidebar/categories.
  - **Comfy Instance** → settings live as a tab in the in-view
    left-sidebar layout (this install's settings + Directories +
    Preferences). The "categorised" settings experience belongs to the
    Comfy Instance window only.
- App-level settings tab may be renamed **"Preferences"** to
  disambiguate from install-scoped settings.

### Running-install ownership / inconsistency

- Today the dashboard window can act on installs that are actively
  running in *another* (Comfy Instance) window — close them, start
  them, etc. This causes inconsistent state: e.g. starting a running
  install from the dashboard sometimes closes the dashboard and
  opens-into the existing window, sometimes does the wrong thing
  entirely.
- **Idea: lock modifying a running install to *only* the Comfy
  Instance window where it's running.** Dashboard tiles for running
  installs are read-only-ish (focus-only, no start/stop/edit) until
  that window is closed. Reduces the surface area where two windows
  could disagree about what's happening.
- Worth thinking through carefully — affects close-window /
  dashboard-return paths, the "click tile to focus existing"
  interaction we just added, and lifecycle ergonomics generally.

### New-install wizard restructure

- **Today the wizard starts in the "middle"** because the first step
  is install-type selection (Standalone vs remote-connection variants)
  — feels disorienting because the user landed there by clicking "New
  Install," not by picking a category.
- **First-time install path:** drop the install-type selection from
  the wizard entirely. The first install should funnel users straight
  into the canonical happy-path (Standalone Local) — no upfront fork.
  Keeps onboarding short and decisive.
- **Subsequent new-install paths (post-first-use):** install-type
  selection comes back as an explicit step, since by then the user is
  choosing among options on purpose, not being onboarded.
- ~~Bring back "install from snapshot" section on the new-install
  screen~~ → **moved out of the wizard**, lives as a top-of-dashboard
  utility button instead.
- ~~Drag-in / file-pick routes into snapshot-import-as-new-install
  flow~~ → drag-in still works but is owned by the dashboard's "Load
  Snapshot" entry point, not the wizard.
- **Quick Install / migration stays** as a flow — used by
  MigrationBanner and by the first-use "Local + Legacy detected"
  branch.

---

## Decision log — explicit answers given so far

| Question | Decision |
|----------|----------|
| Are New Install / Track / Load Snapshot reachable from Comfy Instance? | **No — removed from in-Comfy waffle menu.** |
| Modal-on-Comfy strategy: takeover-as-base + modal on top, or just modal with strong dim? | **Just modal with stronger background dim.** |
| Does first-use auto-launch on completion? | **Yes — both branches.** |
| Does Quick Install survive? | **Yes — keep, used by MigrationBanner and the first-use Local + Legacy branch.** |
| App-update popover: panel-positioned card vs true title-bar child-window popup? | **Deferred — pick this up later.** |

## Open questions / decisions still pending

1. **Takeover ↔ Modal rethink — overall pattern.** Max-width spec, ✕
   button removal, "back to main concern" affordance shape (back
   chevron vs explicit button vs clickable underlying surface).
2. **Settings split** — exact left-sidebar layout for Comfy Instance,
   tab ordering, "Preferences" vs "App Settings" naming.
3. **Running-install ownership** — exact lock scope (read-only on
   dashboard? grayed-out subset of actions? action-menu items
   removed?).
4. **App-update popover surface** — panel-positioned card vs true
   title-bar child-window popup.
5. **Restart-required pill family** — deferred from §18; needs a
   restart-gated-setting registry. Separate piece of work, not part of
   this polish slice.

---

## Followup tracker

| ID | Source | Status |
|----|--------|--------|
| §19 brand audit | [docs/unified-window-phase3-notes.md](unified-window-phase3-notes.md) §19 | [Issue #473](https://github.com/Comfy-Org/ComfyUI-Desktop-2.0-Beta/issues/473) |
| §18 restart-required pill | [docs/unified-window-phase3-notes.md](unified-window-phase3-notes.md) §18 | Deferred to its own pass |
