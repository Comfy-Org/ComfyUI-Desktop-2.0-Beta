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
  `cloud`, and `desktop` (see `sourceCategory` on `Installation`). Add
  per-category recency to the install record (e.g. `lastLaunchedAt` stays
  global, plus the per-category index can be derived in the source layer,
  OR introduce a separate `lastUsedAt` keyed by `{ category, id }`).
- **What counts as "ran"?** Decide whether "recent" means "launched the
  process" (current `lastLaunchedAt` semantics) vs. "user actually
  interacted with the panel/instance" vs. "any action ran against this
  install." Most likely "process actually started" is the right signal —
  it's already tracked and survives crashes naturally.

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

---

## Status

Open. Phase 2 has shipped (`feat/unified-window-titlebar-panels`); Phase 3
planning has not yet begun. Capture decisions made in subsequent design
discussions in this file before the Phase 3 implementation branch is opened.
