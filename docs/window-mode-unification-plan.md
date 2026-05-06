# Window-mode unification — plan

Forward-looking plan for the next post-modal-unification track.
Captures the design and staging laid out in
[Issue #470](https://github.com/Comfy-Org/ComfyUI-Desktop-2.0-Beta/issues/470)
("Transform host windows in place between install-backed and chooser-host
modes (no window swap)").

This plan picks up after the modal-unification tracks M-1 through M-7
land on `feat/unified-window-titlebar-panels`.

---

## Goal

A single `HostWindow` primitive that owns the BrowserWindow + the three
WebContentsViews (titleBarView / panelView / comfyView). The
install-backing becomes an **attach / detach** pair of operations
against a long-lived BrowserWindow rather than a reason to construct a
new window.

Concrete user-facing wins (all from the issue):
- **Return to Dashboard in place** — replaces the swap-via-close in
  `returnToDashboard()` with `entry.detachInstall()`. No flicker.
- **Pick install from chooser body** — transforms the same window via
  `entry.attachInstall(id)` instead of opening or focusing a separate
  window.
- **Stop instance → release backing** — optionally exposes
  `detachInstall()` from the comfy-lifecycle UI for users who want to
  free the window without closing it.

## Why it's not done already

The architectural blocker is **construction-time closure binding to
`installationId`** in `src/main/index.ts`:

1. **`layoutViews` closures.** `openComfyWindow` (~line 872) and
   `openChooserHostWindow` (~line 1505) each define their own
   `layoutViews` that captures `installationId` (or `windowKey`) at
   construction and calls `comfyWindows.get(...)` against it. Two
   different functions; if you transform a window the wrong one is
   bound.
2. **Event-handler closures.** `comfyWindow.on('close')`,
   `comfyWindow.on('closed')`, the comfyContents handlers
   (did-fail-load retry, will-navigate, theme observer), and the
   download-manager attach all close over `installationId`. They must
   read from `entry.installationId` at runtime instead.
3. **Map-key convention.** `comfyWindows` is keyed by `installationId`
   for install-backed entries and `chooser:N` for chooser hosts.
   Re-keying mid-life breaks every `comfyWindows.get(...)` callsite
   that assumes a stable key.
4. **`comfyView` URL binding.** Loads the real ComfyUI URL on
   construction for install-backed; dummy + zero-sized for chooser.
   Transforming = either reload the URL on attach + park-and-collapse
   on detach, or destroy/recreate the view inside the same window.
5. **Install-specific wiring** attached on construction:
   `attachSessionDownloadHandler`, theme observer (`applyComfyTheme`
   vs `applyChooserHostTheme`), failure-retry, splash-page swap during
   relaunch. Need symmetric `attach(installationId)` / `detach()`
   operations.

## Cross-cutting decisions captured during the modal-unification
review

These were decided alongside the modal-unification work and unblock
follow-on UX once the unification lands:

- **First-use auto-launch heuristic** (post-Phase-3 polish followup) —
  resolves itself: with no window boundary to chase the resulting
  install across, the heuristic isn't needed.
- **Tile click for already-running install** — becomes "flip current
  window into instance mode" instead of "close originating dashboard
  window and focus existing instance".
- **Don't treat dashboard windows as pseudo-launchers** — collapses
  into the unification (every host is the same primitive).
- **Update-while-running** — stays in-window naturally regardless of
  mode.
- **Per-install settings tab + Preferences tab + Directories tab in
  the Comfy Instance left sidebar** (gated settings-split work) —
  becomes coherent once there's one window per install with one
  sidebar.

## Staging

Sliced for clean per-commit gates. Each stage is one or two commits.

### Stage W-1 — Stable numeric window key as the map key
- Replace the `installationId | 'chooser:N'` map-key convention with a
  monotonic numeric `windowKey`.
- All `comfyWindows.get(installationId)` callsites either:
  - look up via a secondary `installationId → windowKey` index, or
  - move to passing the `windowKey` explicitly.
- Mechanical refactor — no behaviour change. Existing tests and IPC
  surface stay green.

### Stage W-2 — Unify constructors
- Pull the BrowserWindow + titleBarView + panelView setup into a
  single `createHostWindow()` helper.
- The install-backing becomes an `attachInstall(id)` operation called
  immediately afterwards for the install-backed path; chooser hosts
  skip it.
- `openComfyWindow` and `openChooserHostWindow` collapse into thin
  wrappers around the helper while the call sites migrate.

### Stage W-3 — Symmetric attach / detach
- Move install-specific wiring behind paired `attachInstall(id)` /
  `detachInstall()` calls on the entry:
  - download manager attach / detach
  - theme observer swap (`applyComfyTheme` ↔ `applyChooserHostTheme`)
  - comfyView URL load vs park-and-collapse
  - failure-retry handler set vs cleared
  - splash-page swap during relaunch
- All event handlers (`comfyWindow.on('close')` / `'closed'` /
  comfyContents handlers) start reading `entry.installationId` at
  runtime instead of the captured constructor-time value.

### Stage W-4 — Swap call sites to in-place transform
- `returnToDashboard()` → `entry.detachInstall()`. Capture-bounds /
  open-fresh-chooser-host / dispatch-close goes away.
- Chooser-pick (`handleChooserPick` / tile click on Comfy panel) →
  `entry.attachInstall(id)` against the current host window instead
  of `openComfyWindow(...)`.
- "Stop instance" path (optional) — exposes `detachInstall()` from
  comfy-lifecycle so the user can free the window without closing it.

### Stage W-5 — Multi-window deduplication for "tile click on
already-running install"
- Tile click in chooser body for an install that's already running in
  another window → focus that window AND `detachInstall()` the
  current window (or `attachInstall(otherRunningInstall)` flip), per
  the cross-cutting decision above. The exact UX needs a small
  visual review.

## Risks

1. **Closure-binding sweep (W-2 / W-3)** is the highest-risk slice.
   Missing one event-handler that still captures `installationId` at
   construction means transforming a window leaves a stale handler
   firing against the wrong install. Need a grep audit + integration
   test that constructs → attaches → detaches → re-attaches.
2. **`comfyView` URL transitions** — Electron's WebContentsView
   doesn't have a "park" affordance built in; reloading on attach has
   a perceptible delay vs the current "view already constructed with
   URL" path. May need to keep the view loaded with `about:blank` and
   navigate on attach.
3. **Window bounds restore** — pre-W-1 bounds are saved per
   `installationId`; with the in-place transform we want to keep the
   window at its current bounds across attach/detach. Saved bounds
   become a per-install hint applied only at first-attach, not on
   every transform.
4. **Test coverage** — current tests are mostly renderer-focused;
   main-process construction / attach / detach is the gap. W-2/W-3
   want a small main-process integration test that walks
   construct → attach → detach → re-attach and asserts the
   `comfyWindows` map shape after each step.

## Out of scope for this plan

- Settings split (Comfy-Instance left-sidebar tab layout). Gated on
  the unification but separate plan.
- Code review against `main`. Runs after this plan lands.
- New-install wizard restructure. Touch-adjacent but intentionally
  deferred.

## Sequencing

This is the immediate next track after modal-unification (M-1
through M-7, all merged on `feat/unified-window-titlebar-panels`).
The code review against `main` runs **after** this plan lands —
running it earlier wastes effort because both unifications are
cross-cutting changes that would otherwise reshuffle the surface
being reviewed.
