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

## 3. Consolidate Models + Media into a single "Directories" panel — **DONE**

The launcher's separate **Models** and **Media** tabs both browse on-disk
folders that ComfyUI installations point at — models live under each
install's `models/` (or a shared models dir), and media is the rendered
output / input dirs. Conceptually they're two views of the same idea:
"directories that an installation reads/writes." Phase 3 merged them
into a single **Directories** panel reachable from the global File /
waffle menu (§15).

Status:

- `DirectoriesView.vue` lands as the merged surface — the Models
  sections render through `DirCard` (primary / default markers) and
  the Media sections render as plain `SettingField` rows under a
  shared "Shared Directories" header. Both data sources
  (`getModelsSections()`, `getMediaSections()`) are unchanged for
  the merge landing.
- `ModelsView.vue` and `MediaView.vue` are deleted — they had no
  remaining references after Phase 3 step 2 retired the launcher
  window's separate sidebar tabs. Their orphan `models.title` /
  `media.title` i18n keys are scrubbed alongside; the active
  `models.*` / `media.*` keys (primary, default, addDir,
  inputDir, outputDir, sharedDirs, …) survive because they're
  consumed by `DirCard`, `SettingField`, the standalone source
  plugin, and `registerSettingsHandlers`.
- Future work (out of scope for the merge landing): pull the
  per-source folder-tree / scanning / breadcrumb pieces into shared
  components, and let sources plug additional categories in
  (snapshots, logs, …).

## 4. Rename "Downloads" settings category to "Cache" — **DONE**

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

## 7. Title bar v3 — pill always-pill, click-anywhere, nav placement — **DONE**

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

Third slice landed on the same branch — kebab + Manage modal +
version fix + scrollable grid (replacing an earlier click→popover
attempt that ate the open fast-path):

- **Kebab (⋮) action menu.** Each install tile carries a top-right
  kebab icon button next to the error badge. Click on the kebab
  opens the per-tile action menu — Pin / Unpin, Manage…, Dismiss
  error — anchored beneath the icon. The kebab handler `stopPropagation`s
  so it doesn't double-fire as a card click. Right-click on the
  tile body still opens the same menu at pointer coordinates as a
  power-user gesture.
- **Card click is the open fast-path again.** Single click on the
  tile body emits `pick` directly — the user's primary "I want to
  use this install" gesture. The earlier popover-on-click route
  was rolled back: it ate the most common gesture (open) for the
  least common one (browse actions), and the popover items
  duplicated the right-click menu.
- **Manage… opens DetailModal as an overlay.** The Manage menu
  item mounts the existing `DetailModal` (in its modal-overlay
  mode, `inline: false`) on top of the chooser via a Teleport
  into the body element. The wrapper uses the standard
  `view-modal active` framing (matches PanelApp's ProgressModal
  treatment). Show-progress events bubble up through ChooserView
  to PanelApp so long-running actions kicked off from the modal
  use the same ProgressModal overlay the inline DetailModal does.
- **Source / version display matches the legacy DashboardCard.**
  When the source plugin populated `inst.listPreview` (e.g.
  "Stable" / "Latest" for the standalone source), the chooser tile
  shows that as the source pill and hides the version pill — the
  rule the old DashboardCard followed. This stops the chooser
  from rendering bare commit-shas next to the channel label for
  Latest-tracking installs.
- **Progress block, prominent.** The 3px sliver at the card bottom
  was replaced with a status-line + 6px-rounded-bar block sitting
  beneath the meta line. The pattern matches the legacy
  DashboardCard `card-progress` treatment so users recognise the
  in-flight surface; while progress is active, the timestamp +
  update + migrate pills are hidden so the meta row stays compact.
- **Scrollable grid.** The chooser's outer `panel-content` wrapper
  now drops its padding for the chooser branch (so the chooser
  owns its own filter / grid gutter) AND `.panel-chooser` itself
  picks up `flex: 1; min-height: 0; overflow: hidden`. Without
  these, `.chooser-grid`'s `overflow-y: auto` had no bounded
  height to scroll inside, so on tile-heavy windows the cards
  just clipped off the bottom instead of producing a scrollbar.

### Status — kebab expansion **DONE**

The chooser tile's kebab / right-click action menu now grows to cover
the actions the user previously had to drill into Manage… for. Same
items either way (kebab or right-click); the composable owns the menu
shape and the dispatch routing so the two surfaces cannot diverge.

Items today (state-gated):

- **Pin / Unpin** — non-cloud installs (unchanged).
- **Manage…** — opens `DetailModal` on the default tab (unchanged).
- **Update…** — `status === 'installed'` && `statusTag.style ===
  'update'`. Opens Manage on the Update tab so the channel surface
  picks up the user's interaction (the channel surface already routes
  Update Now through `openOverlay` per §10's Tier 2/Tier 3 split, so
  no new wiring is needed here).
- **Migrate to Standalone…** — `sourceCategory === 'desktop'` &&
  installed. Opens Manage with `autoAction: 'migrate-to-standalone'`
  so the source-side migration confirm + showProgress flow runs end
  to end without the user having to click through tabs.
- **Restore Snapshot…** — installed && `installPath` && non-cloud.
  Opens Manage on the Snapshots tab where SnapshotTab.vue handles
  the per-snapshot Restore action.
- **Open Folder** — `installPath` && non-cloud. Instant action via
  the source-side `open-folder` action; no overlay opened. (The
  source action handler already shells out to `shell.openPath` for
  the install directory.)
- **Delete…** — installed && non-cloud. Opens Manage with
  `autoAction: 'delete'`. DetailModal's `autoAction` loop finds the
  bottom Actions section's `delete` ActionDef and runs it through
  `runAction`, which fires the existing confirm dialog +
  `showProgress` Tier 2 progress overlay (delete requires the install
  to be stopped, so the classifier rule resolves to Tier 2).
- **Dismiss error** — when the install has a stored error in the
  session store (unchanged).

Pill / kebab dispatch unification:

- The composable exposes a `triggerAction(id, inst)` function that's
  the single dispatch path for both the menu select handler AND the
  chooser tile's visual Update / Migrate pills. The pill click
  handlers in `ChooserView.vue` (~lines 510-545) used to call
  `openManage(inst, { initialTab: 'update' })` /
  `openManage(inst, { autoAction: 'migrate-to-standalone' })` inline;
  they now call `triggerAction('update', inst)` /
  `triggerAction('migrate', inst)` so the routing decision lives in
  exactly one place.
- `useInstallContextMenu`'s `onManage` callback signature gained an
  optional second `{ initialTab?, autoAction? }` parameter so the
  composable can pass deep-link options through to the chooser's
  `openManage` helper. The bare Manage… menu item passes no options
  (default tab, no auto-action); the new entries each pass the
  appropriate combination.

Architectural contracts preserved:

- All actions that need overlay surfaces still go through the
  composable's `onManage` callback → `openManage` → `openOverlay({
  kind: 'manage', … })`. Tier 2/3 ops kicked off from inside the
  resulting Manage modal still bubble up via `@show-progress` to
  PanelApp's host-level slot, where §10's `isRunning` classifier
  picks Tier 2 progress vs Tier 3 takeover. No host-specific
  branches were added — the same code runs in chooser host and
  install host.
- Cloud installs only see Manage… / Update… / Restore Snapshot…
  (when applicable) / Dismiss error — the file-system / migration /
  delete items are gated behind `sourceCategory !== 'cloud'` because
  cloud installs are managed remotely.
- Standardised cancel-prompt copy (`overlay.cancel*`) still fires
  from `useOverlay` whenever a Tier 2/3 op kicked off via the kebab
  pre-empts an in-flight progress / takeover op.

DROPs that landed with this slice:

- The inline pill-click `openManage(inst, { initialTab: 'update' })`
  / `openManage(inst, { autoAction: 'migrate-to-standalone' })`
  duplication in `ChooserView.vue`. Replaced by `triggerAction('update',
  inst)` / `triggerAction('migrate', inst)` so the routing lives in
  one place.

i18n: new `chooser.menuUpdate` / `menuMigrate` / `menuRestoreSnapshot`
/ `menuRevealInFolder` / `menuDelete` keys added in both
`locales/en.json` and `locales/zh.json`.

## 9. Install Settings — Restart instead of Launch when running — **DONE**

Implemented in `DetailModal.vue` via a renderer-side override: when
`sessionStore.isRunning(installation.id)` is true, the bottom-pinned
`launch` action is rewritten to a synthetic `restart` action with
`style: 'accent'` (hollow blue), a confirmation dialog explaining
that any unsaved work will be lost, and a chained
`stopComfyUI` → `runAction(launch)` `apiCall` so the user sees a
single continuous "Restarting ComfyUI" ProgressModal rather than
two flashes. The `'accent'` style was promoted to a first-class
member of `ActionDef.style` in `src/types/ipc.ts` to formalise the
project-wide convention: *solid primary = does the thing
immediately; outline accent = asks first.* Cross-checking existing
prompt-then-act buttons (Delete, Migrate, Restore Snapshot) for the
same convention is queued as a follow-up cleanup pass.

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

## 10. Update channel as a dropdown — **DONE**

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

### Status — channel dropdown **DONE**

The Install Settings update-channel surface now picks the channel from
a `<select>` dropdown rather than a card-row of buttons. The per-channel
preview block (installed / latest / last-checked / status) and per-channel
actions (Update Now / Copy & Update / Switch Channel) still render
underneath for the currently-drafted channel — only the picker chrome
changed. Channels still come from the source plugin layer
(`getChannelDefs()` in `src/main/sources/standalone/updateSections.ts`)
via the `channel-cards` field's `options` array, so adding a third
channel (beta / custom branch / preview / per-source-extension) is a
source-side change with no renderer follow-up.

Renderer-side wiring:

- `DetailSection.vue`'s `f.editType === 'channel-cards'` branch
  replaces the `.channel-cards-row` button grid with a styled `<select>`
  bound to the same `draftValues[f.id]` local state. The "current" /
  "recommended" affordances move into the `<option>` label as inline
  suffixes (`Stable — Currently selected` / `Latest — Recommended`).
  The selected option's description renders below the dropdown so the
  longer-form copy (`Recommended — stable releases…`) still has a place
  to live.
- The draft pattern (`getDraft` / `getSelectedOption` / `getSelectedActions`)
  is untouched — switching channels stays a two-step gesture (pick
  from dropdown → click the action button on the draft channel)
  exactly as before. No new IPC, no shape change to the
  `channel-cards` field.
- Per-channel actions still emit `run-action` via the parent
  DetailModal, which converts `showProgress: true` into `show-progress`
  → `PanelApp.handleShowProgress`.

Tier routing for Update Now:

- `handleShowProgress` in `PanelApp.vue` now consults
  `sessionStore.isRunning(installationId)`. When the install is
  running, the operation must end in the running app (Update Now
  restarts after applying), so it routes through
  `openOverlay({ kind: 'takeover', component: 'update', installationId,
  operationName })` instead of the Tier 2 progress slot. Stopped
  installs keep the Tier 2 `kind: 'progress'` route (the progress
  doesn't end in the app — the install just goes from "stopped at
  version A" to "stopped at version B").
- The `'update'` takeover branch in PanelApp's takeover slot mounts
  the same `ProgressModal` component as the Tier 2 progress slot, with
  the existing `[data-overlay-key="takeover"] :deep(.view-modal-content)`
  override turning it into a full-window surface. The `progressRef`
  template ref is bound to both `v-if` branches — Vue resolves it to
  whichever is currently mounted, since the slots are mutually
  exclusive.
- `useOverlay`'s `TakeoverOverlay` interface gained an optional
  `installationId?` field so progress-style takeovers can carry the
  install id through to the slot's ProgressModal binding. Other
  takeover components (`new-install` / `track` / `load-snapshot` /
  `quick-install` / `first-use`) ignore the field.

DROPs that landed with this slice:

- `.channel-cards-row` / `.channel-card` / `.channel-card-header` /
  `.channel-card-label` / `.channel-card-current` / `.channel-card-badge`
  / `.channel-card-desc` markup in `DetailSection.vue` and the matching
  CSS rules in `src/renderer/src/assets/main.css`. Replaced by
  `.channel-select` / `.channel-select-desc`.

Architectural contracts preserved:

- Classifier rule §4 ("does completing the flow end in the running
  app?") drives the Tier 2 vs Tier 3 split — the `isRunning` check is
  the runtime expression of that rule for any showProgress action,
  not just Update Now.
- Cross-window invariant: same code in chooser host and install host;
  the takeover slot is host-agnostic and the `'update'` branch only
  needs an `installationId`, which the running-session check supplies.
- Title bar inert during the takeover: the existing tier watcher fires
  `setTitleBarInert(true)` on tier→3 transitions, so an Update Now
  takeover automatically inherits the file menu / install pill /
  back-forward disable like every other Tier 3 surface.
- Standardised cancel-prompt copy (`overlay.cancel*`) is what fires if
  another Tier 2/3 op pre-empts an in-flight Update Now takeover —
  no new variants added.
- Single source of truth for channel definitions: `getChannelDefs()` in
  the source plugin layer remains the only place that declares what
  channels exist. The renderer never hardcodes channel ids, labels, or
  descriptions.

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

### Status — close-window / dashboard tier-aware guard **DONE**

The window-close + return-to-dashboard paths now consult the panel
renderer before tearing down so a Tier 2 progress / Tier 3 takeover
op can prompt the user via the standardised cancel-prompt copy.

Renderer-side wiring:

- `useOverlay.openOverlay`'s "closing while an in-flight op is
  mounted" branch grew to cover Tier 3: any `next === null` close
  with `cur?.kind === 'progress' || 'takeover'` fires the same
  `confirmCancelCurrent(cur.operationName)` prompt the Tier 2 path
  already used.
- The renderer-internal intentional close paths (the takeover's own
  ✕ button, post-completion auto-close) bypass the prompt by
  directly mutating `currentOverlay.value = null`. This is the same
  pattern `handleProgressClose` already used and prevents a
  redundant double-confirm when the user explicitly dismissed the
  takeover. The new `dismissTakeoverDirect()` helper in `PanelApp`
  centralises the bypass; `handleFirstUseClose` /
  `handleFirstUseComplete` / `handleNewInstallTakeoverClose` and the
  Track / LoadSnapshot / QuickInstall takeover bindings all funnel
  through it. The prompt is now exclusively reserved for the
  consult-from-main path.
- `PanelApp` subscribes to `window.api.onCloseRequest` on mount.
  When main fires the consult, the handler calls `closeOverlay()`
  for any Tier 2/3 op (which prompts via the standard copy) and
  echoes the boolean result back via `window.api.respondCloseRequest`
  with the same `requestId`.

Main-side IPC:

- New `comfy-window:request-close` (main → panel renderer) and
  `comfy-window:request-close-response` (panel renderer → main)
  channels. Each consult uses a fresh `requestId` so multiple
  in-flight requests stay paired with their responses; the helper
  cleans up its `ipcMain.on` listener as soon as the matching
  reply arrives (or after a 5s timeout — a hung renderer shouldn't
  permanently wedge close).
- New `consultPanelRendererClose(panelView): Promise<boolean>`
  helper in `src/main/index.ts` encapsulates the round-trip. Falls
  back to "cleared" when the panelView is missing (no panel mounted
  yet — nothing to lose) or its webContents is destroyed.

Close-handler restructure:

- The install-backed `comfyWindow.on('close', …)` handler at
  `src/main/index.ts:1226` now `preventDefault`s, awaits the
  consult, and only runs the existing teardown sequence
  (`stopRunning` + webContents close + `comfyWindow.destroy()`)
  when the renderer cleared. A `closingInFlight` flag prevents
  re-entry on rapid clicks of the OS close button while the
  consult is pending.
- The install-less chooser-host `comfyWindow.on('close', …)`
  handler at `src/main/index.ts:1509` got the same treatment —
  previously it didn't `preventDefault`, so this commit also adds
  the explicit `comfyWindow.destroy()` call after the cleared
  teardown.
- `returnToDashboard` now consults the panel renderer up front so
  we don't open a fresh chooser window the user is about to abort.
  The consult happens BEFORE `openChooserHostWindow` so a dismissed
  prompt leaves the original install-backed window untouched (no
  flicker, no orphan chooser). When cleared, the entry is added to
  a module-level `preClearedClose` `WeakSet` so the close-handler
  consult that fires when `entry.window.close()` is dispatched can
  skip its own consult and tear down immediately.
- `confirmAndCloseAllHostWindows` pre-clears every entry after the
  global confirm dialog is accepted — the dialog already lists
  in-progress ops / sessions / downloads, so the per-window
  tier-aware prompt would be redundant noise after the user
  confirmed the bulk close. Pre-clearing also prevents the
  staircase-of-prompts UX where each window in turn prompts the
  user before tearing down.
- `closeAllHostWindows` itself is unchanged — it just dispatches
  `entry.window.close()` per entry; the consult/skip logic lives
  in the close handlers + `preClearedClose` set.

Architectural contracts preserved:

- Standardised cancel-prompt copy under `overlay.cancel*` —
  `cancelCurrentTitle` / `cancelNamedTitle` / `cancelMessage` /
  `cancelConfirm` — is reused unchanged for both the takeover→null
  close and the existing Tier 2 collision cases. No new variants.
- `useOverlay.openOverlay` still returns `Promise<boolean>`; the
  renderer-side consult handler threads the boolean directly back
  through `respondCloseRequest`, so main's go/no-go decision is the
  same value the user dismissed (or confirmed) the prompt with.
- Cross-window invariant: same code in chooser host and install
  host. The consult helper is host-agnostic (it operates on
  `entry.panelView`); the install-backed and install-less close
  handlers share the same shape (preventDefault → consult →
  teardown + destroy).
- Title bar inert during the takeover: unchanged. The tier watcher
  still fires `setTitleBarInert` on tier→3 transitions; the
  consult never moves the slot to Tier 3 by itself, only the
  existing `openOverlay({ kind: 'takeover' })` callers do.

DROPs that landed with this slice: none — the pre-§16 close handlers
were unconditional teardown; this slice just wraps them in the
tier-aware consult.

Type plumbing: new `ElectronApi.onCloseRequest` /
`ElectronApi.respondCloseRequest` entries in `src/types/ipc.ts`,
matching preload bindings in `src/preload/index.ts`.

Test fixtures: the `installMockApi` helper in
`src/renderer/src/panel/PanelApp.test.ts` gained no-op
`onCloseRequest` / `respondCloseRequest` mocks so the `onMounted`
subscription doesn't throw.

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

### Status — minimize button drop **REVERTED**

The OS-level minimize button is back on every host window.
`minimizable: false` is no longer set on the unified
`createHostWindow()` constructor in `src/main/index.ts`.

Why reverted: the original drop was justified by Tier 3 takeovers
needing a single unambiguous "interrupt" affordance (✕). Once the
modal-unification track retired the Tier 3 takeover semantics in
favour of binding modals on the unified `Modal` primitive, the
foundation for hiding `−` was gone — `−` is the standard OS "hide
this window, keep its work running" gesture and the binding modals
already handle window-close cancel-prompts independently. Hiding it
just removed a useful affordance for no remaining gain.

The TitleMenu popup `BrowserWindow` (`ensureTitleMenuPopup`) keeps
`minimizable: false` for its own popup-lifecycle reason (frameless
transparent child window) and is unaffected.

The takeover tier (full-screen body for install / update / first-use
flows, with the title-bar pills/dropdowns rendered inert during a
takeover) is the next slice of §17 — see the "Overlay slot
architecture" notes below once they land.

### Status — overlay slot foundation **DONE**

The overlay model is in place. New `useOverlay` composable in
`src/renderer/src/composables/useOverlay.ts` defines the discriminated
union `Overlay = manage | progress | flow | takeover` and the single
`openOverlay(next, { from })` entry-point. Each panel host owns
exactly one slot:

- **`PanelApp`** holds the host-level slot — `progress` today, future
  `takeover` (Steps 3-4). Replaces the old `activeProgressId` /
  `handleShowProgress` / `handleProgressClose` trio.
- **`ChooserView`** holds the chooser-tile slot — `manage` today.
  Replaces the §8 Teleport-to-body Manage hack with an inline
  overlay slot.

Tier-collision rules are centralised in `useOverlay`:

- Tier 1 (`manage`, confirm/prompt) — auto-replace silently.
- Tier 2 (`progress` for ops that don't end in the app) — replacing
  one in-flight progress op with another (or closing while running)
  prompts the user via the standardised cancel-prompt copy under the
  `overlay.*` i18n namespace.
- Tier 3 (`flow` / `takeover` for ops that do end in the app) —
  pre-empts Tier 1 silently, pre-empts Tier 2 with the same prompt.

Two layered slots are coordinated by z-index alone: PanelApp's slot
renders above ChooserView's, so a Tier 2/3 op kicked off from inside
the chooser's Manage modal visually pre-empts the modal without the
chooser needing to react.

DROPs that landed with this slice:

- `ChooserView.handleManageShowProgress`'s `actionId === 'launch'`
  swap-in-place special case — the takeover-replaces-modal rule
  subsumes it. The launch action's progress now runs in the shared
  `ProgressModal` like everything else; the eventual swap to the
  install host happens after the takeover ends (Step 3).
- `ShowProgressOpts.actionId` field — only the launch-swap routed on
  it. Removed from `src/types/ipc.ts` and from the three call sites
  (`DetailModal`, `useListAction`, `ComfyLifecycleView`).
- `DetailModal.inline` prop — DetailModal renders one way now and the
  parent owns the close behaviour. The chooser overlay slot binds
  `@close="closeOverlay"`; PanelApp's install-settings panel binds
  `@close="handleInstallSettingsClose"` which calls the existing
  `closeCurrentPanel` IPC.
- `ChooserView.openManageDirect` / `openUpdateModal` /
  `openMigrateModal` collapsed into a single `openManage(install,
  { initialTab?, autoAction? })` call — one entry-point, three
  parameter variants.

Manage→Progress success behaviour: preserved. DetailModal's
`result.navigate === 'detail'` branch still calls
`refreshAllSections()` and leaves `activeTab` unchanged, so when the
host's Tier 2 progress overlay closes the chooser's Tier 1 manage
overlay is still mounted underneath on the originating tab. Future
actions can override the destination via a
`navigate: 'detail-status'`-style hint (additive — no current
callers).

Three steps still remain under §17 and the §10 / §16 / §18 / §19
sections — see the relevant headings for current state.

### Status — flow takeover migration **DONE**

The four install-creation / import flow modals
(`new-install` / `track` / `load-snapshot` / `quick-install`) now
mount as Tier 3 takeovers in `PanelApp`'s overlay slot instead of
swapping the panel body. The default body (chooser for install-less
hosts, launcher-settings for install-backed) stays mounted underneath
for the takeover's duration; dismissing the takeover drops the user
right back where they were with no navigation churn.

Renderer-side wiring:

- `useOverlay` already had `kind: 'takeover'` carved out — Step 3 just
  added the per-component dispatch in `PanelApp`'s template (one
  shared `[data-overlay-key="takeover"]` `view-modal`, one v-if branch
  per FlowComponent). The pre-§17 `.panel-flow` `:deep` overrides
  that turned modal-styled roots into full-panel bodies moved over to
  this same slot wholesale.
- `switchPanel(key)` no longer assigns flow keys to `activePanel`; it
  diverts them through a new `openFlowTakeover(component)` helper that
  awaits `openOverlay({ kind: 'takeover', component })`, then runs
  the modal's imperative `open()` reset post-mount (same form-state
  reset reason as the pre-§17 panel-body branches).
- `defaultBodyPanel()` is the new initial-`activePanel` source — flow
  keys passed via `?panel=…` URL or `panel-switch` IPC mount the
  takeover above this default rather than as the body itself.

Title-bar coordination via main:

- New IPC: `comfy-window:set-titlebar-inert` (panel renderer →
  main) → `comfy-titlebar:inert-changed` (main → title-bar
  WebContentsView). Main does NOT cache the flag; the title-bar
  renderer mirrors the boolean locally (matches how panel-changed /
  theme-changed already work).
- `PanelApp` watches `tier` and only signals on transitions
  in/out of Tier 3 — Tier 1 ↔ Tier 2 shifts are silent so we don't
  spam IPC.
- `TitleBarApp` adds an `isInert` flag and applies `is-inert` class +
  `:disabled` bindings to the file menu, install pill, and back/
  forward arrows for the takeover's duration. Each click handler also
  early-returns on `isInert.value` as belt-and-braces against
  keyboard activation. Window controls (× / □) live outside this
  view and stay live — the user always retains an "interrupt"
  affordance via close.

DROPs that landed with this slice:

- `<div v-else-if="activePanel === 'new-install'" class="panel-flow">`
  branches in `PanelApp`'s template (and the matching `'track'` /
  `'load-snapshot'` / `'quick-install'` branches). The
  `panel-content:has(.panel-flow)` and `.panel-flow :deep(...)` CSS
  rules they relied on went with them — the equivalent rules now
  hang off `[data-overlay-key="takeover"]`.
- `handleFlowClose` — `closeOverlay` does the same job at the
  overlay-slot level and the underlying body is already correct
  (we never left it).
- The "Switch the panel body and run the post-mount imperative
  open() reset" code path in `switchPanel` — flow vs non-flow are
  now structurally different surfaces (overlay vs body), not two
  branches of the same body swap.

Architectural contract preserved:

- Same code in chooser host and install host — `defaultBodyPanel()`
  reads `installationId` once at the top, but the takeover-slot
  template and `openFlowTakeover` are host-agnostic.
- The chooser host (or install-backed launcher-settings host) hosts
  the takeover for its entire duration; the eventual swap to the
  install host happens AFTER the takeover ends (same as today's
  `pendingPickUnsub` close-host-on-instance-started in
  `handleChooserPick`).
- Back/Forward + panel switches do NOT close overlays — the title
  bar's nav arrows are inert during a takeover and main's
  `panel-switch` IPC only updates `activePanel` (the body
  underneath); the takeover slot is independent.

The first-use takeover (Step 4) and the per-section follow-ups
(Steps 5/6) now slot into the same plumbing — first-use mounts at the
takeover slot just like new-install does, and Step 5's update
channel / kebab-menu actions feed the same `openOverlay` call.

### Status — first-use takeover **DONE**

The first-use Tier 3 takeover now auto-mounts on every launcher start
where `launcherPrefs.firstUseCompleted` is still `false`, runs the
user through T&C + telemetry consent → (locale-conditional) China
mirror prompt → Cloud-vs-Local pick, and only flips the persisted gate
when the user reaches a real completion path. Mid-flow cancel leaves
the gate at `false` so the takeover replays on the next launch.

Renderer-side wiring:

- New `FirstUseTakeover.vue` in `src/renderer/src/views/` — single
  component with internal `step` state (`'consent' | 'mirrors' |
  'pick'`) and an imperative `open()` reset. The China-mirror sub-step
  is only inserted when the resolved locale (fetched via
  `window.api.getLocale()`) starts with `'zh'`; both paths through
  that sub-step also set `chineseMirrorsPrompted` so the legacy
  prompt machinery doesn't re-fire later.
- `useLauncherPrefs` gained a `firstUseCompleted` ref backed by the
  same `getSetting`/`setSetting` pipeline as `pinnedInstallIds`, plus
  a `markFirstUseCompleted()` writer that's idempotent (so the
  chain-to-new-install close path can fire it without worrying about
  double-write). A `__resetLauncherPrefsForTest` helper is exported
  for the PanelApp test suite — module-level memoization is otherwise
  preserved for production.
- `PanelApp` adds a fifth `v-if` branch under `currentOverlay.component
  === 'first-use'` in the existing takeover slot — same shell, same
  `data-overlay-key="takeover"` styling, same automatic title-bar
  inert flag. A new `openFirstUseTakeover()` helper does the
  `openOverlay` + post-mount `open()` reset; auto-mount happens in
  `onMounted` after the URL-driven flow-panel branch (so a
  `?panel=new-install` request from main still wins, since
  `firstUseCompleted` will simply replay on the next launch).
- Local-branch chaining: a `chainingFirstUseToNewInstall` ref records
  that the user picked Local; `handleFirstUseChainLocal` flips the
  flag and calls `switchPanel('new-install')` (Tier 3 → Tier 3 swap is
  silent in `useOverlay`). The new-install takeover's `close` /
  `navigate-list` handlers route through a new
  `handleNewInstallTakeoverClose` wrapper that also marks
  `firstUseCompleted` when the chain flag is set, then clears it.
  Cloud-branch pick takes the direct `handleFirstUseComplete` path —
  marks completion immediately and closes the overlay.

Main / IPC additions:

- `KnownSettings.firstUseCompleted: boolean` in `src/main/settings.ts`
  (added to the `SETTINGS_SCHEMA` map alongside `pinnedInstallIds`).
- New `get-locale` IPC handler in
  `src/main/lib/ipc/registerSettingsHandlers.ts` — returns
  `i18n.getLocale()`. Required because the renderer's vue-i18n locale
  is always `'en'` (we deep-merge messages onto the en bundle), so
  `app.getLocale()` / the `language` setting can only be read from
  main. Wired through `src/preload/index.ts` and typed in
  `src/types/ipc.ts` as `getLocale(): Promise<string>`.

i18n:

- New `firstUse.*` namespace in both `locales/en.json` and
  `locales/zh.json` covering the takeover title, consent lead, T&C
  body, telemetry hint, accept-T&C button, "Not now" mirror skip,
  pick-step title/lead, and the Local-card label/description.
- China-mirror sub-step REUSES the existing
  `settings.chineseMirrorsSuggest{Title,Message,Confirm}` keys — no
  duplication.
- Cloud-card REUSES the existing `cloud.{label,desc}` keys.

Architectural contracts preserved:

- Same code in chooser host and install host — `defaultBodyPanel()`
  routes to chooser-vs-launcher-settings exactly as before; the
  first-use takeover sits above whichever default body the host
  resolves to.
- Title bar inert during the takeover: tier watcher already engages
  the `setTitleBarInert` IPC on tier→3 transitions (Step 3 wiring),
  so the first-use takeover automatically inherits the file menu /
  install pill / back-forward disable for free.
- Standardised cancel-prompt copy (`overlay.cancel*`) is what fires if
  the user pre-empts an in-flight Tier 2 progress op while opening
  first-use — no new variants added.
- Per-source mirror override plumbing intentionally NOT exposed in
  the takeover UI — the China-mirror step only flips the global
  `useChineseMirrors` setting (per-source overrides are Step 5+
  territory, code-ready behind that gate).

DROPs that landed with this slice: none — first-use is purely
additive on top of the takeover slot foundation Step 3 built.

---

## 18. Title-bar status pills — restart-required + updates available — DONE (updates pills only)

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

### Status (Phase 3 §18 — updates pills landed)

The two **updates-available pills** ship in this slice; the
restart-required pill family is deferred to a later pass (it requires
a new restart-gated-setting registry on top of this scaffolding —
see the second open question above).

What landed:

- **Composable-shared update state.** `useAppUpdateState` (under
  `src/renderer/src/composables/`) wraps the four
  `update-{available,download-progress,downloaded,error}` broadcasts
  plus `getUpdateCapabilities` / `getPendingUpdate` and exports a
  single `state` ref. Both the in-panel `UpdateBanner` and the new
  title-bar app-update popover (`AppUpdatePopover`) consume it, so
  the two surfaces can never disagree about what's pending. The
  banner refactor is a pure dedup — its dismiss flow keeps a local
  `visible` flag independent of `state` so dismissing the banner
  doesn't clear the underlying state the pill / popover read from.
- **`AppUpdateOverlay` (Tier 1).** New overlay kind in
  `useOverlay`. Rendered by `PanelApp.vue` as the
  `<AppUpdatePopover>` branch when
  `currentOverlay.kind === 'app-update'`. Tier 1 means a Tier 2/3 op
  silently pre-empts it — the popover is informational, not
  blocking.
- **Manage overlay slot in `PanelApp`.** §17 only mounted manage
  overlays inside `ChooserView`. §18 adds a parallel
  `currentOverlay.kind === 'manage'` branch in the host overlay slot
  too, so the install-update pill click can land directly on
  `DetailModal` (with `initialTab='update'`) without needing to be
  routed through ChooserView. Same component, different host.
- **Install-update via the existing `statusTag` pipeline.** Main's
  `computeInstallUpdateAvailable(installationId)` helper reuses
  `sourceMap[].getStatusTag` (the same call the IPC layer already
  makes in `registerInstallationHandlers`) — `style === 'update'`
  is the canonical "update is available" signal across the chooser,
  the manage overlay, and now the title-bar pill, so the three
  surfaces stay in lockstep without re-implementing the staleness
  rules.
- **`_broadcastAppUpdateStateToTitleBars` fan-out.** Wired once at
  startup via `updater.onUpdateStateChanged(...)`. Updater's
  existing `broadcast` already reaches title-bar webContents, but
  the title-bar preload doesn't expose those raw events — the new
  `comfy-titlebar:app-update-state-changed` channel carries just
  the data the pill needs (`kind`, `version`). The title-bar
  preload also surfaces `comfy-titlebar:install-update-changed` and
  `comfy-window:click-{app,install}-update-pill` so the pill data
  + click paths are fully owned by the title-bar bridge rather than
  poking holes in the panel preload.
- **Pill rendering + inert handling.** Both pills inherit the
  Tier 3 takeover `isInert` flag — they go disabled (and dimmed
  via the existing `.is-inert` rules) along with the file menu /
  install pill / nav arrows so a takeover can't be dismissed via
  the title bar.

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

`feat/unified-window-titlebar-panels` carries Phase 3 §1–§19 plus two
follow-on unification tracks (modal + window-mode). Current state:

**Phase 3 §1–§19** — all shipped on this branch. Notable details:

- §1, §2 (primary-install removal incl. gold-star + `primaryInstallId`
  pref), §4 ("Downloads" → "Cache"), §4b (new-install / quick-install
  unification), §5, §6 (downloads tray promoted out of the floating
  component), §7, §8, §9, §10, §11–§14, §15, §16, §17, §18 (updates
  pills only — restart-required pills deferred to §18 followup),
  §19.
- §17's minimize-button drop is REVERTED — `−` is back on every host
  window. The Tier 3 takeover machinery and the `isInert` title-bar
  lockdown that originally justified hiding `−` have been retired by
  the modal-unification track (see below); `kind: 'takeover'` survives
  in `useOverlay` only as a styling/variant differentiator on the
  unified `Modal` primitive.
- §18's restart-required pill family is deferred (needs a
  restart-gated-setting registry on top of the updates-pill
  scaffolding).

**Modal unification (post-§17 cleanup)** — shipped end-to-end. The
two-primitive Takeover + Modal system collapsed into one `Modal`
component with `binding` / `opacity` / `width` props. Install-flow
takeovers (new-install, track, load-snapshot, quick-install),
first-use, update-while-running, DetailModal, ProgressModal,
ImportPreviewModal, and Directories / App Settings / Install Settings
all render through this primitive. The `isInert` title-bar lockdown
system (the `comfy-titlebar:inert-changed` IPC, the bridge plumbing,
and every `setTitleBarInert(...)` call) is fully removed. Binding
modals get a `TakeoverBack` chevron (back to dashboard) and
cancel-on-window-close wiring. The legacy `kind: 'flow'` overlay
member is retired. See git log `4ac023d`..`d581c9f` for the slice.

**Window-mode unification — DISABLED.** Stages W-1..W-5 landed
(`comfyWindows` re-keyed by stable `windowKey`, `attachInstall` /
`detachInstall` operations, `claimAttachHost` IPC, in-place
returnToDashboard / chooser-pick attach), then were turned off in
production (`dac9b16`) due to lifecycle edge cases that left the app
windowless. The infra is intact and dormant; see
[window-mode-unification-revert.md](window-mode-unification-revert.md)
for the kept findings, the disabled call sites, and the re-enable
path.

**Open work on this branch:**

- Post-unification code review findings (see
  [post-unification-code-review.md](post-unification-code-review.md))
  — F1, F13, F14, F17 are fixed; the remaining findings are tracked
  there.
- Post-Phase 3 UX polish items still gated on Settings split,
  Running-install ownership, App-update popover decisions, and
  Restart-required pill family — see
  [post-phase3-ux-polish.md](post-phase3-ux-polish.md).
- §19 naming + flow-titles pass — partial; see followup tracker in
  the polish doc.

The doc remains the source of truth for "what shipped under each
phase 3 section". Cross-cutting follow-on work has its own docs
(linked above).
