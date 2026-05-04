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
- **Window teardown:** if the install backing the window is deleted from
  inside its own panel (today this is a no-op via `handleNavigateList` in
  `PanelApp.vue`), main needs to actively close the parent ComfyUI window.
  Plumb this through `comfy-window:set-panel`-style IPC, or a dedicated
  `comfy-window:close` channel, when the navigate-list emit fires.

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

---

## Status

Open. Phase 2 has shipped (`feat/unified-window-titlebar-panels`); Phase 3
planning has not yet begun. Capture decisions made in subsequent design
discussions in this file before the Phase 3 implementation branch is opened.
