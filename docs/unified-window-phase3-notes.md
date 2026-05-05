# Unified Window — Phase 3 Design Notes

Capture of design constraints / open questions that need to be resolved when
Phase 3 (retiring the standalone launcher window in favour of panels inside
each ComfyUI window) is planned.

These are **not** the Phase 3 plan itself — they're guardrails surfaced while
Phase 1 / Phase 2 were being shipped.

---

## 1. "No instance running" lifecycle states the panel must handle

The unified-window panels live inside a ComfyUI window. When Phase 3 moves
Dashboard / Installations / Running / Models / Media / snapshot flows into
panels, those panels will frequently be visible **while the instance is not
actually running** — for reasons like:

- The user clicked an action (e.g. "Update ComfyUI", "Restore Snapshot",
  "Switch Channel") that requires the install to be stopped, so the launcher
  shut ComfyUI down on their behalf and is now mid-operation.
- The user clicked the Comfy tab in the title bar before ComfyUI had finished
  booting on first launch.
- ComfyUI crashed and the window is alive but the instance isn't.
- The user is updating Desktop itself (auto-updater) and the launcher is
  about to restart everything.
- The user just stopped the instance from the running view but kept the
  window open to look at logs / snapshots / models.

Implications:

- **Every panel must be safe to render with `sessionStore.isRunning(id) ===
  false`.** REQUIRES_STOPPED checks should pass through cleanly (no need to
  prompt the user to stop something that isn't running).
- **The Comfy tab body** in this state currently shows whatever the
  WebContentsView last had (often the in-progress shutdown page or a stale
  ComfyUI screen). Phase 3 should explicitly render an "instance is stopped /
  starting / restarting" state in the Comfy tab body — driven by
  sessionStore + the launchingInstances / stoppingInstances sets that already
  exist in `sessionStore.ts`.
- **Restart-after-update flows** need a clear UX contract: who initiates the
  re-launch when the operation finishes? Today the launcher window's
  `progressStore` tracks `result.navigate === 'detail'` and the user clicks
  Done; in a panelized world the panel that started the action should
  re-launch the instance (or surface a "Start ComfyUI" button) when the
  operation completes successfully.
- **Window teardown:** when the install backing the window is deleted /
  migrated from inside its own panel, the window should close. This is
  wired today via the `close-comfy-window` IPC channel, with the panel
  calling `window.api.closeComfyWindow(installationId)` in
  `handleNavigateList`. Phase 3 panels for Dashboard / Installations etc.
  should reuse this same mechanism rather than rolling new teardown paths.

## 2. Replace "primary install" with "recent install"

The Dashboard today hinges on a single primary install (set via
`launcherPrefs.setPrimary` and rendered with the gold-star button in
`DetailModal`). With Phase 3 collapsing the standalone launcher window:

- **The "primary" concept goes away.** With the launcher window retired,
  there is no global "open this install on launch" surface — every install
  has its own ComfyUI window now.
- **"Recent" becomes the driver of most flows.** This includes:
  - The startup picker (when launching Desktop without a window already
    open) — use most-recent rather than primary.
  - The "open existing" entry-point when the user adds a new install from a
    flow that needs a starting point (e.g. snapshot-load, migrate-from).
  - Any UI that wants to surface "what install would the user most likely
    interact with right now."

### What "recent" needs to track

Today `Installation.lastLaunchedAt` is a single timestamp updated whenever
the install is launched. That's enough for a single-axis "most recent" sort,
but Phase 3 needs richer recency signals:

- **Globally most-recent:** the single install the user touched last,
  regardless of source category.
- **Most-recent per source category:** so flows like "open my most recent
  Standalone install" or "show me my most recent Desktop migration" don't
  need to filter the global list. Source categories today include `local`,
  `cloud`, and `desktop` (see `sourceCategory` on `Installation`).
- **What counts as "ran"?** Decide whether "recent" means "launched the
  process" (current `lastLaunchedAt` semantics) vs. "user actually
  interacted with the panel/instance" vs. "any action ran against this
  install." Most likely "process actually started" is the right signal —
  it's already tracked and survives crashes naturally.

#### Per-category recency tracking — **DONE** (Phase 3 prep)

The data layer for the per-category signal landed on
`feat/unified-window-titlebar-panels`:

- `InstallationRecord` (and the renderer-side `Installation` type) now
  carries an optional `lastLaunchedAtByCategory: Record<string, number>`
  alongside the existing global `lastLaunchedAt`. The two fields are
  always written together.
- `installations.markLaunched(installationId, resolveCategory?)` is the
  single helper for stamping both fields atomically. The launch path in
  `_addSession` (src/main/lib/ipc/shared.ts) calls it as
  `markLaunched(id, (inst) => sourceMap[inst.sourceId]?.category)` — the
  resolver runs inside the same enqueue lock that performs the write so
  there's no separate read round-trip, and `installations.ts` stays free
  of any source-plugin dependency. The existing `installationEvents`
  'updated' event still fires.
- `installations.getRecent()` and `installations.getRecentByCategory(category, resolveCategory)`
  expose the rankings. `getRecentByCategory` falls back to the global
  `lastLaunchedAt` for installs that pre-date the per-category field, so
  legacy data still participates in rankings until the next launch.
  `resolveCategory` is supplied by the caller (typically
  `(inst) => sourceMap[inst.sourceId]?.category`) to keep
  `installations.ts` free of any source-plugin dependency.
- Unit coverage in `src/main/installations.test.ts` exercises the
  write-both-fields path, the per-category vs. global ranking, the
  legacy-fallback case, the cross-category isolation case, and the
  `markLaunched` event emission contract.

The "primary install" surface (gold-star button, `primaryInstallId` pref,
`set-primary-install` action) is intentionally **untouched** in this
landing — recency is purely additive data so any future consumer can use
it. Removing primary is a separate, larger step that will land alongside
the chooser-view rebuild (see below).

### The chooser view (replaces Dashboard *and* Installs)

When the launcher window is retired, "what should the user see when the
app launches with no window open?" can't be "auto-open the most-recent
install" — that gets stuck in a loop the moment the most-recent install
is no longer bootable (corrupt env, deleted files, broken snapshot, etc.).
Instead, the recency signal feeds a **chooser view** that surfaces both
the recent installs and the full list at once, and lets the user pick.

The chooser view also collapses Phase 3's "Dashboard" and "Installations
list" surfaces into a single screen — they're solving the same problem
("which install do I want to open right now"), just from different
angles. Both go away; the chooser is the replacement.

#### Layout

```
╭───────────────────────────────────────────────╮
│ ☁  Cloud — try / connect                      │  ← single promo row,
├───────────────────────────────────────────────┤    pinned at the top
│ Recent                                        │
│   Install A   local     2 min ago             │
│   Install B   desktop   1 hour ago            │
├───────────────────────────────────────────────┤
│ All                                           │
│   Install A   local                           │
│   Install B   desktop                         │
│   Install C   local     (never run)           │
╰───────────────────────────────────────────────╯
```

- **Cloud row sits *above* the table**, not inside it. Cloud isn't a disk
  install, doesn't carry the same actions, and deserves the prominence
  separate from the on-disk listing.
- **Recent and All are sections of one table**, not separate tabs — both
  are visible without a click. Recent is driven by `getRecent()` /
  `getRecentByCategory()`; All is the same data the current Installs page
  surfaces.
- **No "primary" affordance.** The gold-star concept goes away with this
  rebuild — no star column, no `primaryInstallId` pref, no
  `set-primary-install` action. Recent + manual selection covers the same
  user need without the dual-source-of-truth problem.

#### Where the chooser lives

The chooser is the default content of an **install-less host window** —
i.e. a ComfyUI-shaped window whose Comfy WebContentsView is empty
(no install booted yet). The same window shape that hosts a real Comfy
install hosts the chooser; the title bar's Comfy tab body simply renders
the chooser instead of an instance. Picking an install in the chooser
either swaps the Comfy view in-place or opens a fresh window for that
install (decision deferred to the implementation thread).

This same install-less host window also hosts the File-menu flows from
section 5 (new install / track existing / load snapshot / etc.) — the
chooser and those flows are different "modes" of the same window shape,
which is why section 5's "open a new ComfyUI window even when the install
doesn't exist yet" works without a special-case window class.

#### What goes away alongside the chooser

The chooser rebuild is the right moment to delete:

- The **Dashboard view** (`DashboardView.vue` and its store wiring) — the
  chooser fully replaces it.
- The **Installs page** as a separate view — same.
- The **primary install system** in its entirety — the gold-star button
  and `confirmSetPrimary` flow in `DetailModal.vue`, the `primaryInstallId`
  field on `useLauncherPrefs`, the `set-primary-install` source action,
  and any persisted `primaryInstallId` in settings (drop-on-load is fine
  since the data is purely advisory).
- The "promotable local" / `ensureDefaultPrimary` logic in
  `registerInstallationHandlers.ts` and `shared.ts`.

Pin probably stays as an affordance for the Recent/All sections — useful
for "always surface these installs" without conflating with recency.

### Migration considerations when removing primary

- `setPrimary` / `pinInstall` IPC channels and the corresponding source
  actions (`set-primary-install`, `pin-install`, `unpin-install`) need a
  deprecation path. Pin probably stays — it's still useful for the
  Dashboard's "show these installs prominently" affordance. Primary likely
  goes away entirely.
- The star button in [DetailModal.vue](../src/renderer/src/views/DetailModal.vue)
  and the `confirmSetPrimary` flow need to be removed once the primary
  concept is gone — and `useLauncherPrefs` should drop `primaryInstallId`
  to keep the surface area small.
- Any data migration on the persisted settings should clean up the
  `primaryInstallId` key.

## 3. Consolidate Models + Media into a single "Directories" panel

The launcher's separate **Models** and **Media** tabs both browse on-disk
folders that ComfyUI installations point at — models live under each
install's `models/` (or a shared models dir), and media is the rendered
output / input dirs. Conceptually they're two views of the same idea:
"directories that an installation reads/writes." Phase 3 should merge them
into a single **Directories** panel with subsections (or a sidebar) for
Models / Outputs / Inputs / shared roots, sharing a single browse / open /
reveal-in-finder action set.

Implementation hints when this lands:

- The current `ModelsView` and `MediaView` already share a lot of structure
  (folder tree, scanning, breadcrumb). Pull the shared pieces into a single
  `DirectoriesView` and have the per-category logic live in the source
  layer (so a future "snapshots dir" or "logs dir" can plug in the same
  way).
- The renaming applies to the sidebar entry, the i18n keys (`models.title`
  / `media.title` collapse into `directories.title`), and any telemetry
  view names (`desktop2.view.opened` payloads).

## 4. Rename "Downloads" settings category to "Cache"

The current Launcher Settings page groups "Downloads" together (model
download paths, in-flight download list, etc.). With the new direction,
that section is really the on-disk **Cache** — wheels, model files, GitHub
release tarballs, and any other large blob the launcher pulls down on
behalf of an install. Rename the category and update both the i18n key
(`settings.section.downloads` → `settings.section.cache`) and any
telemetry / settings-section IDs that downstream consumers may key off.

## 4b. Unify New Install + Quick Install into a single flow

Both `NewInstallModal.vue` and `QuickInstallModal.vue` are now mounted
as full-panel bodies inside `PanelApp.vue` (Phase 3 step 2e), but the
two flows are conceptually overlapping — Quick Install is essentially
"new install with a fixed default source/variant pre-selected, fewer
steps". With the unified-window direction, two parallel entry-points
into "create an install" doesn't carry its weight.

**TODO — pending design decision.** Unify the two flows into one. Open
question: keep Quick Install as the surface and grow it to cover the
full new-install configurability, or keep New Install and add a
"quick start" preset / shortcut at the top of step 1, or fold both
into a single new flow component. Decide before deleting either of
the existing `*Modal.vue` files. Either way the chooser CTA / File
menu entries should land on a single canonical create-install panel.

## 5. Drop the top-bar action cluster in favour of a "File" menu / new window

Today the launcher window's top toolbar carries a row of buttons:
**New Install**, **Quick Install**, **Track**, **Load Snapshot** — plus the
Dashboard / Installations / Running / Models / Media / Settings tabs in the
sidebar. With Phase 3 retiring the launcher window entirely, this top-bar
cluster doesn't carry over: there's no longer a "home" view to hang it on,
and stuffing the same buttons into every ComfyUI window's title bar would
be visually heavy.

Direction:

- Promote the install-creation flows (new install, quick install, track
  existing, load snapshot, attach a remote / cloud install, etc.) to
  entries on a native **File** menu (or platform equivalent — the
  application menu on macOS, an in-window menu on Windows / Linux).
- Selecting any of these entries opens a **new ComfyUI window** that hosts
  the relevant install panel — even if the install doesn't exist yet (a
  new-install or quick-install panel can run inside a window that doesn't
  yet have ComfyUI booted, since the panel renderer is independent of the
  Comfy WebContentsView).
- The existing `comfyTitleBar` then becomes the navigation surface — the
  comfy tab is the install identity, the panel pills swap chrome around
  it. No more global toolbar.

### Other consequences of the "no launcher" direction

- **No more Running tab.** Each install is its own ComfyUI window now;
  closing the window stops the instance (and main already owns this
  shutdown path via `stopComfyUI`). The "list of running instances"
  affordance is the OS-level window list itself. The Running view's
  remaining responsibilities (showing logs, surfacing crash banners,
  cancel-launch button) need to slot into the per-install panels — most
  likely a "Console" or "Status" panel button next to Install Settings.
- The dashboard's "what should I open" surface is replaced by the
  startup-picker described in section 2 (most-recent install). If no
  install exists yet, the picker hands off to the File-menu new-install
  flow.
- The pinned / starred / favourites concepts only matter to the extent
  that they help the startup picker rank installs — pin probably stays as
  a "show this in the picker first" affordance, primary goes away (see
  section 2).

## 6. Promote Downloads to its own title-bar panel

Today the in-flight downloads list is rendered by
[`DownloadsPanel.vue`](../src/renderer/src/components/DownloadsPanel.vue),
which mounts as a floating overlay inside the ComfyUI area. That made
sense when the launcher window owned the chrome and downloads had to slot
in somewhere unobtrusive — but in the unified window each ComfyUI tab is
already isolated, and stacking a floating panel on top of the Comfy
WebContentsView is awkward (it lives in a separate WebContents, can't
participate cleanly in z-ordering, and steals real estate from ComfyUI).

Phase 3 should turn Downloads into a first-class **title-bar panel** next
to Install Settings / Launcher Settings — same WebContentsView swap
pattern that Phases 1–2 established. The downloads list is global (all
installs share the same queue / cache), so a single Downloads panel per
window is fine; clicking it swaps in the existing `DownloadsPanel`
contents (probably renamed to `DownloadsView` once it's no longer a
floating component) inside the panel WebContentsView.

This also resolves the floating-component / WebContentsView z-order pain
without needing to move the panel into the Comfy renderer (which would
re-couple us to ComfyUI's storage and CSP).

## 7. Title bar v3 — pill always-pill, click-anywhere, nav placement

The title bar shipped in Phase 3 (`title bar v2 — File menu (left) + center
install pill with caret`, commit `716eb03`) ships a working but
visually-rough pill: the caret sits in a separate button that's framed by
a decorative shape that does not render correctly across themes /
fullscreen states, and the pill body and caret are two distinct hit
targets so users have to aim for the small caret to open the install
menu. The Back / Forward navigation arrows landed alongside the File
menu in `title-left`, which makes them feel like part of the File flow
rather than a top-level navigation surface.

Direction:

- **One pill, one click target.** Drop the inner two-button structure
  (`title-install-name` button + `title-install-caret` button wrapped
  in `title-install-pill`). Render a single `<button class="title-install-pill">`
  whose label is the install name and whose trailing element is the
  ChevronDown — the chevron is decoration inside the pill, not a
  separate hit target. The whole pill opens the install menu (or, on
  install-less host windows, opens the chooser / does nothing — final
  behaviour TBD with section 5's File-menu flows).
- **Pill always looks like a pill.** Solid surface fill, rounded ends,
  visible border at rest. Drop the broken decorative frame around the
  caret — it doesn't render correctly and stops carrying its weight
  once the pill itself is the affordance.
- **Visible hover.** The pill must brighten / shift border on `:hover`
  so it's clearly interactive. Today the caret has hover styling but
  the name button is bare text — once the two collapse, the unified
  pill needs a single coherent hover state.
- **Move Back / Forward to the left of the pill, not next to File.**
  In `title-left` today the order is `[File ▾] [◀] [▶]`. Browser-style
  navigation belongs visually adjacent to the thing being navigated —
  i.e. left of the install pill that hosts the panels — not bundled
  with the File menu. Restructure `title-bar` so the layout is roughly
  `[File ▾]   [◀] [▶] [ Install Name ▾ ]   [drag spacer]` with the
  arrows + pill living in a single horizontal group centred in the
  bar, and File alone on the far left.

Implementation hints:

- The pill rebuild touches both `TitleBarApp.vue` (template + scoped
  styles for `.title-install-pill`, `.title-install-name`,
  `.title-install-caret`) and `TitleBarApp.test.ts` (which currently
  asserts on the two-button structure and the caret-only menu path).
- The caret-frame artefact is in the scoped styles around
  `.title-install-caret` — a `border-left` separator + padding that
  reads as a button divider on dark backgrounds and disappears on
  light themes. Once the inner caret button goes away, that styling
  goes with it.
- The Back / Forward buttons stay wired to the existing
  `goBack` / `goForward` IPC handlers from Phase 3; this is purely a
  visual / DOM-position change, not a behaviour change.
- Install-less host windows currently hide the caret (`v-if="!isInstallLess"`).
  Decide whether the install-less pill becomes an inert label or a
  clickable affordance that opens the chooser — both are reasonable;
  the former is simpler and matches today's behaviour.

## 8. Chooser cards — restore the "goods" + click-for-actions

The Phase 3 chooser-view rebuild (commit `71997be`, "rewrite ChooserView
as a golden-ratio recents grid") collapsed the dense Dashboard /
Installations cards into clean recents tiles, but in doing so it
dropped a lot of the metadata and affordances the old cards carried.
Those signals are still useful — installs are the user's main object
of interest and the chooser is now the only place they live, so the
card needs to do more work.

What needs to come back to each chooser card:

- **Current ComfyUI version** the install is on (commit short-sha or
  tag, depending on source category). Today `Installation.commitInfo`
  / `Installation.versionInfo` carries this; the chooser card just
  doesn't render it.
- **Update-available indicator** when the install's source has a
  newer release than what's checked out (driven by the same release-
  cache + channel logic that `DetailModal`'s update banner uses).
  Probably a small "Update" pill or chevron badge on the card corner;
  a click opens the Install Settings panel scrolled to / focused on
  the Update section.
- **Migrate prompt** when an install has a pending migration
  (currently surfaced via `MigrationBanner` inside `DetailModal`).
  The same banner-style affordance should be visible on the card
  itself so users don't have to open the install to discover the
  migration.
- **Progress bars** for in-flight install / update / restore /
  migrate operations. The data is already in `progressStore` and
  `installationStore.runningTaskFor(id)`; the chooser just doesn't
  surface it. A thin progress bar across the card bottom + a status
  line ("Updating ComfyUI…", "Restoring snapshot…") covers it.
- **Running indicator** — a blue (`var(--accent)`) border around any
  card whose install is currently running (driven by
  `sessionStore.isRunning(id)`). This is the same affordance the
  legacy `instance-card.card-running` rule in `main.css` already
  defines; the chooser tile just needs to opt into it.
- **Error visibility** — when an install's last action errored or its
  session crashed, the card should show a "View error" affordance
  (probably a red dot + click-to-open-logs/-error-detail). Today
  errors live in `progressStore.completedFor(id)` with
  `result.outcome === 'failed'` and the modal-based error dialog;
  the chooser needs a card-level surface so users notice without
  opening the install.

Click behaviour:

- **Click ≠ open.** Today clicking a chooser tile opens the install
  directly. With the card carrying real interactive content (update
  pill, migrate banner, error chip) the bare click target is
  ambiguous. Switch the primary card click to a **dropdown / popover
  of actions** — Open, Update, Restore Snapshot, Settings, Reveal in
  Finder, Delete, etc. — keyed off the install's source category
  (so cloud installs get a different action set than local ones).
- **Native menu, not HTML.** The chooser body lives in the panel
  WebContentsView, which has the same clipping caveats as the title
  bar — section 7 / the Phase 3 title-bar dropdown work both went
  native via `Menu.popup()` for this reason. The chooser's card
  action menu should follow the same pattern: panel renderer asks
  main to popup a native menu at click coordinates, main routes the
  selected action back over IPC.
- **Double-click → open.** Keep a fast-path: double-click on the
  card opens the install (the most common action), single-click
  surfaces the menu. Or alternatively a primary "Open" button on
  the card itself + click-anywhere-else for the menu. Decide during
  implementation.

Layout implication: the card grows from a label + thumbnail into a
content-bearing tile. Re-evaluate the golden-ratio grid sizing — the
cards likely need more vertical room (or a denser two-column metadata
strip below the install name) to accommodate version + update +
running + error signals without going visually noisy.

### Status

First slice landed on `feat/unified-window-titlebar-panels`:

- **Version display.** `Installation.version` (already populated by
  every source plugin) renders in the meta line as a monospace chip
  between `sourceLabel` and the relative-time stamp. Slightly muted
  + monospaced so it reads as data, not prose.
- **Running indicator switched to accent blue.** The
  `chooser-tile-running` shadow now uses `var(--accent)` (#4a90e2
  fallback) instead of the previous `var(--accent-success)` green
  — matches the "this is the live one" semantics in §8 spec and the
  legacy `instance-card.card-running` rule.
- **Error visibility.** New `chooser-tile-errored` modifier paints a
  red `var(--accent-danger)` inset border and a top-right
  AlertCircle badge (16px, danger red, `pointer-events: none` so the
  card-level click still wins) whenever
  `sessionStore.errorInstances.has(inst.id)` is true. Click-to-
  dismiss still flows through the existing right-click → "Dismiss
  error" item; the badge is a card-level visibility affordance.
  Errored takes precedence over running in the rare case both are
  set (a crashed-while-running install reads more usefully as
  errored).
- **Pill chips replace the dot-separated meta line.** Each datum
  (source label, version, last-launched timestamp) renders in its
  own `.chooser-tile-pill` chip — discrete, scannable, and wraps
  onto a second row on narrow tiles instead of ellipsing the line.
  The version pill keeps the monospace face so commit-shas and
  semver values still read as data.
- **Bigger min tile size.** Grid `minmax(240px, 1fr)` →
  `minmax(320px, 1fr)`. The tiles need to fit the install name + the
  three meta pills + room for an icon + future pills (update /
  migrate / progress) without going cramped; 240px was the carryover
  from the original recents-grid landing where the tiles only had
  to show name + sourceLabel + relative-time. Auto-fill + 1fr still
  grows more columns on wide windows. The grid's `overflow-y: auto`
  was already in place — the bigger min-width just makes the
  scrollbar appear sooner on narrow / tile-heavy windows.

Second slice landed on the same branch:

- **Update-available pill.** When `Installation.statusTag.style ===
  'update'` (already populated by the standalone + portable source
  plugins via the same release-cache logic that drives Install
  Settings' update banner) the chooser tile renders an accent-blue
  "Update" pill in the meta line with an `ArrowDownToLine` icon. The
  pill is purely visual today — the click action that scrolls Install
  Settings to the Update section is folded into the pending click→
  popover refactor below.
- **Migrate prompt pill.** Legacy Desktop installs (`sourceCategory
  === 'desktop'` with `status === 'installed'`) get a warning-amber
  "Migrate" pill in the meta line with an `ArrowRightLeft` icon. Same
  visual-only treatment — the actual migration UI still lives behind
  Install Settings, the pill is a card-level discoverability prompt.
- **In-flight progress bar + status pill.** The chooser subscribes to
  `progressStore.getProgressInfo(id)` per tile. While an op is in
  flight, the timestamp pill is replaced by an accent-blue status pill
  carrying the live phase text ("Resolving dependencies…",
  "Restoring snapshot…") and a thin (3px) progress bar pinned to the
  card bottom tracks the percent value. Indeterminate progress (when
  the op hasn't reported a percent yet) renders a swept stripe.

Third slice landed on the same branch:

- **Click → action popover, double-click → open fast-path.** The
  bare click that previously opened the install now anchors a
  popover at the tile's bottom-left. Today the popover surfaces
  Open + Pin / Unpin + Dismiss error — the same items the right-
  click context menu carries plus an explicit Open entry at the
  top. The composable `useInstallContextMenu({ onOpen })` powers
  both surfaces from a single state (modes `'context'` and
  `'action'`); the right-click menu still fires through the
  unchanged `openCardMenu` path, the click popover through a new
  `openActionMenu` path. The HTML-rendered route was preferred
  over the native `Menu.popup()` route — the chooser body lives
  in the panel WebContentsView which doesn't have the title-bar
  clipping caveat that drove §14 to BrowserWindow popups. A
  setTimeout-based debounce (250ms — the conventional double-
  click threshold) keeps the popover from flashing on screen
  during a double-click. Cleanup runs in `onBeforeUnmount`.

Still open:

- **Action set expansion.** The popover currently carries Open +
  Pin / Unpin + Dismiss error. Update / Migrate / Install
  Settings / Reveal in Folder / Restore Snapshot / Delete depend
  on the `open-install-host-window-on-panel(installationId, panel)`
  IPC tracked in Issue #470 — once that lands, those items move
  into this popover so the chooser becomes the single launching
  surface for any install action. The update / migrate pills
  should fold their click targets into the same popover (e.g.
  "Update available — Update now / View details").

## 9. Install Settings — Restart instead of Launch when running

Today the Install Settings panel's primary action is **Launch** — a
solid-blue (`button.primary`) button that boots ComfyUI. When the
install is already running, that button is currently still labelled
Launch (or hidden, depending on the source) which is confusing: the
user sees "Launch" while the instance is clearly running in the
Comfy WebContentsView next to it.

Direction:

- **When the install is running, the primary action becomes Restart.**
  Same button slot, label switches based on `sessionStore.isRunning(id)`.
- **Restart requires confirmation.** A modal-confirm flow ("This will
  stop ComfyUI and start it again. Any unsaved work will be lost.
  Restart?") before the actual stop+start. The confirmation step is
  what differentiates Restart from Launch — Launch is a clean boot
  with nothing to lose, Restart kills a live process.
- **Hollow blue, not solid blue, to telegraph the confirmation.**
  Use `button.accent` (outline blue, blue text) rather than
  `button.primary` (solid blue, white text) when the action will
  prompt before executing. This becomes a project-wide signal:
  *solid primary = does the thing immediately; outline accent =
  asks first.* Cross-check existing buttons that prompt-then-act
  (Delete, Migrate, Restore Snapshot) so they all follow the same
  rule.
- **Restart wiring.** Reuse the existing `stopComfyUI` +
  `launchInstallation` paths sequentially via a new
  `restartInstallation` orchestrator (or just chain them in the
  IPC handler if there's no shared state to manage). Make sure the
  Comfy WebContentsView stays attached across the stop→start cycle
  so the user sees the lifecycle view rather than a window flash.

## 10. Update channel as a dropdown

The current update-channel selector in Install Settings is a fixed
two-button toggle (Stable / Nightly, depending on source). With the
roadmap heading toward more channels — beta, custom branch tracking,
preview builds, and per-source-extension channels — the toggle stops
scaling.

Direction:

- **Dropdown / select instead of a toggle row.** Same selection
  semantics, but rendered as a `<select>` (or a styled menu) so we
  can grow the channel list without redesigning the settings row.
- **Channels come from the source layer.** Each source plugin already
  knows what channels it offers (`Source.channels` or similar) — the
  settings panel should render whatever the source declares rather
  than hardcoding a Stable/Nightly pair in the renderer.
- **Plumbing.** This is mostly a settings-renderer change plus a
  small extension to whatever IPC currently exposes the channel list.
  The actual "switch channel" IPC and source-side update flow stay
  unchanged.

This is a deferrable cleanup — the toggle works today — but landing
it before adding a third channel avoids a special-case "we needed a
dropdown by then anyway" scramble.

## 11. Chooser host window must steal focus on app launch — **DONE**

Symptom (reported during Phase 3 testing): launching Desktop 2.0 fresh
from a shortcut / packaged build leaves the chooser host window
unfocused — it appears behind whatever app the user clicked from. The
legacy launcher window did not exhibit this; its `ready-to-show` path
called `focus()` explicitly.

Root cause: `openChooserHostWindow` (the install-less host window
constructor) never called `bringToFront(comfyWindow)` after creating
the window. The companion `openOrFocusChooserHostWindow` only brings
an *existing* window forward — for a freshly-spawned chooser host
nothing forced the foreground, so Windows' focus-theft prevention
won the race.

Fix: call `bringToFront(comfyWindow)` at the end of
`openChooserHostWindow`, right after the initial `layoutViews()`
tick. `bringToFront` already encapsulates the Windows-specific
"always-on-top toggle" trick used elsewhere in main, so the install-
backed `openComfyWindow` path doesn't need a parallel change — its
`bringToFront` calls were already in place from the earlier focus
work.

Landed on `feat/unified-window-titlebar-panels`.

## 12. Chooser host title-bar / window-controls colour mismatch — **DONE**

Symptom: in the install-less chooser host window, the Vue-rendered
title bar and the OS-level window controls (close / minimise /
maximise on Win/Linux, traffic lights on macOS) painted different
colours, leaving a visible stripe across the top of the window.

Root cause: two independent paint paths.

- The Vue `<header class="title-bar">` paints `themeBg ?? var(--surface)`.
  In `openChooserHostWindow` the entry's `lastTheme` was seeded as
  `{ bg: COMFY_BG, text: '#dddddd' }` — `COMFY_BG` is `#171717`, the
  ComfyUI dark fallback used for the *body* background, not the title
  bar.
- The OS-level overlay (`comfyTitleBarOverlay()`) paints `#353535`,
  which matches `TITLEBAR_BG` from `theme.ts`.

Install-backed windows have a `applyComfyTheme` path that pushes the
ComfyUI frontend's theme through to both surfaces (`theme-changed`
IPC + `setTitleBarOverlay({ color, symbolColor })`), so they stay in
sync as the install's theme changes. The chooser host has no
ComfyUI frontend feeding it, so the two surfaces just sat at their
respective construction-time defaults.

Fix (initial): seed the chooser's `lastTheme.bg` to `TITLEBAR_BG`
so both surfaces share one colour at construction time.

Superseded by §13's launcher-theme-aware refresh path — the chooser
host now resolves its title-bar colour from the launcher renderer's
`--surface` (via `titleBarOverlayForTheme`) instead of the static
`TITLEBAR_BG`, and refreshes both surfaces whenever the theme flips.

Landed on `feat/unified-window-titlebar-panels`.

## 13. Chooser host title bar must follow launcher light/dark theme — **DONE**

Symptom (follow-on to §12): switching the launcher theme between
dark / light from inside the chooser host repainted the panel body
correctly but left the chooser host's title-bar Vue and OS overlay
stuck at their construction-time dark values. Light mode looked
broken — a dark title-bar stripe sat above a light panel body.

Root cause: install-less host windows have no ComfyUI frontend
feeding them a theme; install-backed windows have `applyComfyTheme`
to drive both surfaces. There was no equivalent path for the chooser
host, so launcher-theme changes (Settings → Theme, or the OS-level
dark-mode preference flipping while the setting is `'system'`) only
reached the panel body's HTML/CSS via the standard `theme-changed`
broadcast — not the title-bar Vue (`comfy-titlebar:theme-changed`)
or the OS overlay (`setTitleBarOverlay`).

Fix:

- Added a `ThemeChangedCallback` to `RegisterCallbacks` (sibling to
  `LocaleCallback`) and an `_onThemeChanged` slot in
  `lib/ipc/shared.ts`.
- Fired `_onThemeChanged()` from `registerSettingsHandlers.ts` in
  both the explicit `set-setting('theme', …)` branch and the
  `nativeTheme.on('updated')` system-mode branch, alongside the
  existing `_broadcastToRenderer('theme-changed', …)` broadcast.
- Added `getChooserHostTheme()` in `index.ts` — returns
  `{ bg, text }` from `titleBarOverlayForTheme(resolveTheme() === 'dark')`,
  i.e. the launcher renderer's `--surface` (`#262729` dark, `#e9e9e9`
  light) — and `applyChooserHostTheme(entry)` /
  `applyChooserHostThemeToAll()` helpers that repaint the title-bar
  Vue + OS overlay for every install-less host window.
- Wired `onThemeChanged: applyChooserHostThemeToAll` into the
  `ipc.register({…})` call in `app.whenReady`.
- `openChooserHostWindow` now uses the launcher-resolved overlay
  (`titleBarOverlayForTheme`) at construction time, and seeds
  `lastTheme` + `titleBarView.setBackgroundColor` from
  `getChooserHostTheme()` so the title bar pre-paints the right
  surface colour and avoids the legacy `TITLEBAR_BG` (#353535)
  fallback flash.
- Install-backed windows are unaffected — their `applyComfyTheme`
  path still drives ComfyUI-themed colours; this hook only walks
  `entry.installationId === null` entries.

Landed on `feat/unified-window-titlebar-panels`.

---

## 14. Title-bar dropdowns rendered as child BrowserWindow popups — **DONE**

Symptom (follow-on to §7): the File / Install dropdowns in the title
bar were native `Menu.popup()` menus. They worked, but they came with
a string of compromises — platform-default chrome instead of our
design tokens, no theme-matched border / shadow, and on Windows the
menu's first hover state was inconsistent with the hover-gated buttons
above it. The user explicitly wanted to follow the
Chrome / Discord / VS Code precedent of rendering title-bar menus as
HTML inside a child window so the dropdowns blend with the Vue title
bar instead of standing apart from it.

We considered an alternative — grow the title-bar `WebContentsView`
height while a menu is open so an HTML popup can render inside the
existing view — and rejected it. Every shipping product that does
title-bar dropdowns natively (Chrome / Discord / VS Code) uses a
child window for popups: no clipping by the host view's bounds, no
z-order gymnastics with the body view, free click-outside dismissal
via the popup's own blur event, and a real OS-level shadow that
doesn't require CSS workarounds.

Fix:

- New renderer entry `src/renderer/src/comfyTitleMenu/` (mirrors the
  shape of the existing `comfyTitleBar/` entry) with
  `comfyTitleMenu.html`, a `main.ts` mount, and a `TitleMenuApp.vue`
  component that renders the dropdown card. Items, kind, and theme
  arrive as a base64-encoded JSON blob in the URL `config` parameter
  so the first paint already has everything — no IPC round-trip /
  blank flash before the menu shows. Card uses the same Inter font +
  design tokens (`--surface`, `--border`, `--text-muted`) as the rest
  of the launcher; the popup is themed from `entry.lastTheme` so it
  matches the launcher's surface colour in light + dark and follows
  ComfyUI-themed install-backed windows.
- New preload `src/preload/comfyTitleMenuPreload.ts` exposes a tiny
  `__comfyTitleMenu` bridge with `activate(id)` /
  `close()` — the popup posts `comfy-titlemenu:item-activated` for
  clicks and `comfy-titlemenu:close` for the Escape key.
- New main helper `openTitleMenuPopup` in `src/main/index.ts` creates
  a frameless transparent child `BrowserWindow` with the requesting
  comfy / chooser host as its parent, sized from the items
  (`computePopupHeight`) and positioned at the absolute screen
  coordinates derived from the parent's `getContentBounds()` plus
  the renderer-supplied title-bar-local anchor. Loads
  `comfyTitleMenu.html` with the encoded config, focuses on
  `ready-to-show`, and `popup.on('blur', () => popup.close())` for
  click-outside dismissal. On `closed` it sends
  `comfy-titlebar:menu-closed { menu }` back to the title-bar
  webContents — preserving the existing 100ms `MENU_REOPEN_GUARD_MS`
  reopen-suppression in `TitleBarApp.vue` (the same guard the user
  shortened from 250ms in §7).
- The previous `Menu.buildFromTemplate(...).popup(...)` block in the
  `comfy-window:open-title-menu` handler is replaced with a call to
  `openTitleMenuPopup`. Item / kind / install-less filtering
  (`menuKind === 'install' && entry.installationId === null` →
  refuse) is unchanged. The renderer-side bridge methods
  `openFileMenu` / `openInstallMenu` and the
  `{ menu, anchor: { x, y } }` payload shape are unchanged so all
  existing 14 `TitleBarApp.test.ts` cases still pass without
  modification.
- Vite config gets a new preload input
  (`comfyTitleMenuPreload`) and a new renderer input
  (`comfyTitleMenu`) so the popup ships in the production bundle.

Item activation routes through the same handlers we already had:
File → `openChooserHostWindow` for "New Window",
`setActivePanel(…, 'launcher-settings')` for "Desktop 2 Settings";
Install → `setActivePanel(…, 'install-settings' | 'directories')` and
`updater.runCheck('title-bar-check')` for "Check for Updates". The
popup closes itself after activation.

Hover-gating (§7) is unaffected: child-window popups still steal
focus from the parent comfy window, so the title-bar webContents
still fires `window.blur` and the renderer's `isHoverActive` gate
drops to false; re-arming on a fresh `pointermove` continues to
work the same way.

Landed on `feat/unified-window-titlebar-panels`.

---

## 15. Waffle menu reorganization — Directories belongs to the global menu — **DONE**

The install pill previously surfaced Install Settings, Directories,
and Check for Updates. Directories is a global concern (the
launcher's view of the disk — models, outputs, etc. live cross-
install) and shouldn't be scoped to any one install. Moving it from
the install pill into the waffle (File / hamburger) menu leaves the
install pill strictly install-scoped (Install Settings + Check for
Updates only) and lets the waffle menu host all the global / app-
level affordances in one place.

Fix:

- `buildTitleMenuItems` in `src/main/index.ts` now emits
  `[New Window, Directories, Desktop 2 Settings]` for the File menu
  and `[Install Settings]` for the install pill (the previous
  `Check for Updates` entry was removed in a follow-up — it
  duplicated the per-install settings update section and didn't
  surface meaningful feedback at the title-bar level). The
  `'directories'` activation branch in `activateTitleMenuItem`
  moves from the install kind to the file kind alongside
  `'launcher-settings'`.
- Directories stays per-window for now (same wiring as
  `launcher-settings`) — the panel renderer is shared, but each
  host window owns its own panel WebContentsView and history stack.
  The view itself is install-agnostic (`DirectoriesView.vue` reads
  global `getModelsSections()` / `getMediaSections()` with no
  installationId), so it works equally on install-backed and
  install-less host windows.
- The install-less rejection in `setActivePanel` is narrowed from
  `(panel === 'install-settings' || panel === 'directories')` to
  just `panel === 'install-settings'` — Directories is now reachable
  from the chooser host's File menu. Install Settings remains
  install-scoped (the install caret menu is still suppressed in
  install-less host windows so there's no UI to reach it from
  there).
- The further waffle entries listed for §16 (Return to Dashboard,
  Close All Windows, Import Snapshot as New Install) are still open
  — see that section.

Landed on `feat/unified-window-titlebar-panels`.

---

## 16. Window-level lifecycle ergonomics — close install / close all / dashboard return / import snapshot

Several related affordances are missing for the multi-window world
the unified host opened up:

- **Close out of the current install and return to the "dashboard"**
  (the install-less chooser host body) without closing the window.
  Today the only way to leave an install in a window is to close the
  whole window or pick another install via the pill (which swaps the
  window in-place to the new install). There's no "go back to
  picking an install" gesture inside an install-backed window.
- **Close All Windows** in one click. With several host windows
  open, closing them individually is tedious; quit-from-tray closes
  the app entirely. A waffle-menu entry that shuts every host window
  but leaves the app alive (tray persists) is the missing middle
  step.
- **Import Snapshot as New Install**. We can already load a snapshot
  into an existing install via the load-snapshot panel, but there's
  no path to import a snapshot as a brand-new install. This is a
  natural sibling to New Install / Quick Install / Track on the
  chooser body — and a candidate for the waffle once the in-window
  flows are unified.

These slot into the waffle menu as the global affordances:

- New Window (existing) — **DONE**
- Return to Dashboard (new — install-backed windows only; swaps the
  window in-place from the install body to the chooser body) — **DONE**
- Close Window (existing as an OS button, but more discoverable here) — **DONE**
- Close All Windows (new) — **DONE**
- Import Snapshot as New Install (new) — **TODO**
- Directories (§15) — **DONE**
- Desktop 2 Settings (existing) — **DONE**

The current shipped File / waffle menu shape (install-backed host
window — install-less chooser host omits Return to Dashboard since
it would be a no-op there):

```
New Window
Return to Dashboard
Close Window
Close All Windows
─────────────
Directories
Desktop 2 Settings
```

`Close Window` calls `entry.window.close()` on the parent host —
each host window's existing `close` handler runs the full teardown
(`stopRunning` + webContents close + `window.destroy()`), so the
menu entry just dispatches the close. `Close All Windows` calls
the new `closeAllHostWindows()` helper, which snapshots
`comfyWindows.values()` and dispatches `close()` on each entry —
the snapshot is necessary because the per-window `closed` callback
deletes from the map mid-iteration. The activate handler's
trailing `hideTitleMenuPopup` is guarded against an
already-destroyed popup, so the parent-of-popup window in the
"Close Window" / "Close All Windows" path tears down cleanly even
though the popup is auto-destroyed by Electron when its parent
goes away.

`Close All Windows` is gated by a native confirmation dialog when
more than one host window is open. The dialog is parented to the
window the menu was opened from, lists the open windows by
`window.getTitle()`, and — when the legacy `hasActiveOperations()`
flag is set — also lists running ComfyUI sessions, in-progress
operations (installs / updates / migrations), and active model
downloads, pulled from the same `getActiveDetails()` helper that
powered the legacy launcher's quit-warning modal (commit
`d22bdf6`). With zero or one window open the close happens
straight through with no prompt — single-window close is
indistinguishable from `Close Window` so prompting would be
needless friction. Buttons are `[Close All]` (response 0) and
`[Cancel]` (response 1, defaultId/cancelId), so an inadvertent
Enter or Esc dismisses without action.

`Return to Dashboard` is wired as a swap-via-close: capture the
install-backed window's bounds (and maximised state), open a fresh
chooser host, apply those bounds to the new window so it appears at
the same screen position / size, then dispatch `close()` on the
original window. The original's existing close handler runs the
full teardown (`stopRunning` + webContents close +
`window.destroy()`) so the install gets stopped cleanly.

A truly single-window swap would re-key the `comfyWindows` entry
from `installationId` to a synthetic `chooser:N`, null out
`entry.installationId`, tear down the comfy-specific wiring
(download manager, theme observer, panelView's loaded URL with the
old installationId baked into the query string), and re-route the
closure-bound `installationId` reads inside `layoutViews()` and
several install-backed event handlers (the install-backed
`layoutViews` in particular is bound at construction with `const
entry = comfyWindows.get(installationId)` — re-keying breaks that
lookup). That's a substantial rewrite of construction-time
bindings; the swap-via-close approach delivers the user-facing
affordance with a brief flicker as the cost.

The doc TBD — install-pill identity click vs. waffle entry vs. both
— remains open as a follow-up; the waffle entry covers the
discoverability case for now.

Still open:

- **Import Snapshot as New Install.** No flow exists yet; it's a
  brand-new variant of the new-install / load-snapshot pipeline.
  Defer until the new-install / quick-install unification (§4b)
  lands so we have a single canonical create-install panel to
  thread the "starting from a snapshot" entry-point into.

---

## 17. Full-screen takeover for startup / update flows

Today the startup and update flows render as modals layered over
the chooser or comfy body. Two problems with that:

- The startup / update *is* the primary in-flight action — it should
  read as a full-screen takeover (replacing the active body) rather
  than a modal sitting on top of one. Modal styling implies "you can
  dismiss this and resume what's behind"; a full-screen body says
  "this is what the window is doing right now".
- The OS-level window controls (`−` minimize, `×` close) currently
  both surface during these flows. The semantically meaningful
  distinction is **interrupt vs let it keep running**:
    - `×` closes the host window, which interrupts the install /
      update.
    - `−` minimizes the host window, which doesn't interrupt
      anything — the action keeps running in the background and the
      user can pop the window back open from the tray.

  We probably want to keep `−` working with that meaning, but it's
  also worth considering dropping `−` entirely since the user can
  always create a new chooser host window (or click the tray entry)
  to view the dashboard / observe progress, even while the original
  host window is busy. Dropping `−` simplifies the controls down to
  "interrupt" (`×`) only, with the implicit fallback of opening
  another window to keep checking on the running action.

Open question: do we hide `−` only during these flows, or globally?
Hiding only during the flow flickers the controls in/out; hiding
globally is a static UX decision that we can make once.

---

## 18. Title-bar status pills — restart-required + updates available

Two related visibility gaps the title bar should fill:

- **Restart-required after a settings change.** Some settings in
  Install Settings and Desktop 2 Settings only take effect on a
  restart of the ComfyUI instance (per-install) or a relaunch of
  Desktop 2 (app-wide). Today there's no in-product signal that the
  user's last settings edit hasn't fully landed yet — they have to
  remember which settings are restart-gated. We should surface a
  per-scope "restart to apply" affordance somewhere persistent.
- **Updates available** for either the ComfyUI instance or Desktop 2
  itself. Both are tracked by the updater module today (the panel's
  `UpdateBanner` shows them), but the title bar — the only chrome
  that's always visible across panels and across the live ComfyUI
  view — has no signal until the user reaches the relevant settings
  surface.

Both fit naturally as small status pills in the title bar, mirroring
the affordance pills we'd surface on install cards (§8). The split
mirrors the per-scope authority of each pill:

- **Desktop 2-scoped pills** sit to the **right of the waffle menu**
  (the global / app-level surface). This is where the "Desktop 2
  update available" pill lives, and where a Desktop-2-scoped
  "restart Desktop 2 to apply" pill would live if a global setting
  needs a relaunch.
- **ComfyUI-instance-scoped pills** sit to the **right of the
  ComfyUI install pill** (the per-install surface). This is where
  the "ComfyUI update available" pill lives, and where a
  per-install "restart ComfyUI to apply" pill would live after an
  Install Settings change that needs the instance to relaunch.

Implementation notes:

- The pill renderer is `TitleBarApp.vue`. The hover-gating
  (`is-hover-active`) and the title-bar height (`TITLEBAR_HEIGHT`,
  37px including the 1px bottom border) both have to keep working;
  pills should fit inside the existing 36px content area without
  growing the bar.
- Click affordances: an update pill should open the relevant update
  panel (Desktop 2 update → launcher-settings update section;
  ComfyUI update → install-settings update section). A
  "restart-required" pill should ideally trigger the restart
  directly, since the user just opted into the change.
- Visual: tone-matched chip with a tiny dot (or `ArrowUp` /
  `RotateCw` icon for updates / restart respectively), sized to read
  at title-bar scale. Keep it subtle — these are persistent, not
  alarming.
- Install-less host windows (no installation backing the entry)
  should suppress the per-install pills entirely; only the
  Desktop-2-scoped slot is meaningful there.
- The pill state must survive panel navigation (chooser → install
  settings → comfy and back) since it's window-chrome state, not
  panel state. Source it from the same updater-broadcast and
  settings-change pipeline that drives `UpdateBanner` so the two
  surfaces never disagree.

Open questions:

- Do we batch multiple per-scope signals into a single pill ("3
  changes need restart"), or render them as individual pills
  side-by-side? Side-by-side wastes title-bar real estate fast; a
  single pill that opens a list popup is probably the right
  treatment once we get past one signal per scope.
- For settings whose restart-required state is *implicit* (e.g.
  changing the install's Python version), the change site has to
  tag the setting as restart-gated in the same place the renderer
  reads from, otherwise we'd have to enumerate restart-gated
  settings in two places.

---

## 19. Naming + flow titles pass

The unified window has accumulated names and titles that read fine
in isolation but are inconsistent or insufficient now that they all
live in the same chrome. Two threads to pull on:

- **Naming review** of menu / panel labels.
    - "Desktop 2 Settings" should just be "App Settings". The
      product name belongs in the OS title bar / about dialog, not
      in every menu entry where it competes with ComfyUI's own
      "File" menu and the install identity in the pill.
    - Audit other places we lean on the "Desktop 2" brand
      (`launcher-settings` panel header, tray entries, CTA copy)
      and decide which ones drop the brand. Rule of thumb: in
      chrome and menus, drop it; in install-less startup / "about"
      surfaces, keep it.
    - Confirm "Install Settings" / "Directories" / "Check for
      Updates" still read clearly once "Desktop 2 Settings" loses
      its brand.
- **Flow titles + subtitles.** The new-install flow currently
  embeds itself in the panel area but has no top-level title
  saying "an install is happening" — only the per-step headings
  inside the flow. The user lands on a step ("Pick a source",
  "Choose a location") and has to infer the broader context. Each
  hosted flow (`new-install`, `track`, `load-snapshot`,
  `quick-install`) needs:
    - A grand title at the top of the panel ("New Install",
      "Tracking an existing install", etc.) that survives across
      the steps in the flow.
    - A subtitle line saying *what* this is doing (e.g. "Set up a
      fresh ComfyUI instance from a downloaded standalone build.")
      so the user can confirm they're in the flow they meant to
      start.
    - Internal step titles stay, but read as sub-sections of the
      grand title rather than as the page heading.

This is a coordinated copy + layout pass across the panel renderer
(`PanelApp.vue`, `views/SettingsView.vue`,
`views/DirectoriesView.vue`, the new-install / track / load-snapshot
/ quick-install panel files) and the title-bar menu builder
(`buildTitleMenuItems` in `src/main/index.ts`). Worth doing in one
go so we don't keep flip-flopping individual labels.

---

## Status

In progress. Phase 2 (`feat/unified-window-titlebar-panels`) is the
active branch and a substantial slice of Phase 3 has already shipped
on it — the launcher window has been retired, the chooser host window
opens at startup, the title-bar v2 / File menu / install pill landed,
new-install / track / load-snapshot / quick-install panels are hosted,
the Directories panel exists, per-source-category recency tracks both
fields atomically, and the unified-window navigation history (Back /
Forward + HTML title-bar dropdowns) is live.

Sections 1, 2, 3, 4, 4b, 5, 6 retain open work — the chooser cards
still need the affordances called out in section 8, primary-install
removal hasn't fully landed (the gold-star + `primaryInstallId` pref
are still present), Models + Media haven't been merged into
Directories yet (Directories currently surfaces only models /
output / input dirs through a flatter UI, not the consolidated
`DirectoriesView` from §3), Downloads is still a floating component,
and the new-install / quick-install flows haven't been unified.

Sections 7–10 capture UX refinements queued up while the unified
window is live: title-bar pill polish, restoring the data on chooser
cards + switching click-to-actions, Restart-vs-Launch in Install
Settings, and the update-channel dropdown.

Sections 11–14 are recently shipped UX refinements: chooser-host
focus on launch (§11), chooser-host title-bar / overlay colour match
(§12), live launcher-theme tracking on the chooser host (§13), and
title-bar dropdowns rendered as child `BrowserWindow` popups in place
of native `Menu.popup()` (§14).

§15 — moving Directories out of the install pill into the global
File / waffle menu — has landed. The remaining batch (§16–§19) is
the next slice of open UX work: filling in the missing window-level
lifecycle gestures — return-to-dashboard, Close All Windows, Import
Snapshot as New Install (§16), turning startup / update modals into
full-screen takeovers with a clear interrupt-vs-keep-running split
on the window controls (§17), surfacing restart-required + update-
available state via title-bar pills (Desktop-2-scoped to the right
of the waffle, ComfyUI-scoped to the right of the install pill —
§18), and a coordinated naming + flow-titles pass — "Desktop 2
Settings" → "App Settings", grand title/subtitle on every hosted
flow (§19).

Capture decisions made in subsequent design discussions in this file.
The doc remains the source of truth for "what's left" on this branch
until the work is split into per-feature implementation threads.
