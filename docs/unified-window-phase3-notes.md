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

---

## Status

Open. Phase 2 has shipped (`feat/unified-window-titlebar-panels`); Phase 3
planning has not yet begun. Capture decisions made in subsequent design
discussions in this file before the Phase 3 implementation branch is opened.
