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

> **Update — polish slice landed.** All non-gated items are done as of
> the Track F commits (`1e4939a`, `784c2e8`). Items below are tagged
> **`[DONE — <commit>]`** where shipped, **`[GATED]`** where waiting on
> the Settings split / Running-install ownership decisions, or
> **`[DEFERRED]`** for things split into their own follow-up. See the
> Tracks A / B / C / D / E / F / G commits for implementation detail.
>
> **Update — modal unification landed.** The Takeover ↔ Modal rethink
> in the Cross-cutting section is RESOLVED end-to-end (Tracks M-1
> through M-7, commits `4ac023d`..`d581c9f`). Items previously
> tagged `[GATED — modal pattern]` are unblocked; most have shipped
> as part of the unification — see the per-item updates below.

---

## First Time Use

- **Large click targets for the cloud-vs-local pick.** **`[DONE — 24cb005]`**
  Restructured as two big horizontal squares (Local left, Cloud right).
- **Skip the pick step for returning users.** **`[DONE — 82cc241]`**
  Detection lives in `src/main/lib/firstUseDetection.ts`; takeover takes a
  `skipPick` flag on `open()` and emits `complete` after consent.
- **No easy escape from the first-use flow.** **`[DONE — 24cb005]`**
  In-app ✕ removed; OS chrome close still works.
- **First-use auto-launches on completion.** **`[DONE — 85178d7]`**
  Cloud / new-install / migrate branches all auto-launch via a
  `pendingFirstUseAutoLaunchId` ref + progressStore watcher in PanelApp.
- **New branching step on Local + Legacy Desktop detected.** **`[DONE — 85178d7]`**
  New `localBranch` step renders only when legacy desktop is present;
  Migrate routes to Quick Install, Install-new routes to Standalone.

---

## Dashboard

- **Drop pinning entirely.** **`[DONE — a425aaa]`**
  Pin/unpin actions, Pinned filter, gold-star UI, `primaryInstallId` pref —
  all removed. Closes the §2 cleanup.
- **Drop the "Desktop" install category.** **`[DONE — 78c471e]`**
  Filter chip removed; Legacy Desktop installs surface under Local.
- **Tile play/stop overlap with progress bar.** **`[DONE — 4ff13bf]`**
  Progress bar moved into the icon ↔ text gap.
- **Refresh install-type icons** **`[DONE — 78b29cd]`**
  New mapping in `src/renderer/src/lib/installTypeIcon.ts` — Standalone =
  `LaptopMinimal`, Cloud = `Cloud`, Legacy Desktop = `Computer` (chunkier,
  visibly older). Title-bar consumer in Track B.
- **Don't treat new dashboard/chooser-host windows as
  pseudo-launchers.** **`[GATED — vague, needs decision before action]`**
- **Tile click for an already-running install closes the originating
  dashboard window and focuses the existing instance window.**
  **`[GATED — running-install ownership]`**
- **All settings open as modals on the dashboard.** **`[DONE — b9b715f, 9f4f3ba, 1e76613]`**
  Directories / App Settings / Install Settings now render through the
  unified `Modal` primitive with `ModalShell` + steady viewport-filling
  height.
- **Click-outside-modal dismisses the modal.** **`[DONE — 0194d98]`**
  Standard non-binding modal semantics on the unified primitive
  (`binding: false` → backdrop-click closes; binding modals opt out).
- **Tile click for an in-progress tile opens the in-progress modal.**
  **`[DONE — 0c0b0c4 + modal-unification]`**
  In-flight tile click routes via `triggerAction` → in-progress
  modal (Tier 2) on the unified primitive.
- **Visually deactivate actions blocked by a running operation.** **`[DONE — 0c0b0c4]`**
  Shared `isStoppedActionGated(inst)` predicate on `useInstallContextMenu`
  drives both kebab menu items and the visible Update/Migrate pills so
  they cannot disagree.
- **Closing a running instance from the dashboard is right-click
  only.** **`[GATED — running-install ownership]`**
- **Top-of-dashboard utility row.** **`[GATED — borderline; can ship the
  button surfaces independently of the modal pattern decision but
  intentionally deferred to the next polish slice]`**

---

## Comfy Instance (title bar ↔ takeovers/modals)

- **Install-update pill shows the target version.** **`[DONE — 52c0c9d]`**
  `comfy-titlebar:install-update-changed` extended from `boolean` to
  `{ available: boolean, version?: string }`; pill now reads "Update v{version}".
- **App-update pill behaviour gated by the auto-update setting.** **`[DONE — 1c54755]`**
  Main's updater decides `'available'` (auto-off) vs skip-to-`'ready'`
  (auto-on); pill copy in `useAppUpdateState` diverges per kind.
- **Spawned auxiliary windows (cloud login etc.) shouldn't expose the
  title-bar file menu.** **`[DONE — 2f32f1d]`**
  Investigation showed strict-equality sender match in `findEntryByTitleBarSender`
  + `preload: undefined` for `setWindowOpenHandler` popups already prevents
  the regression. Shipped a hardening commit with a contract comment so
  future title-menu IPCs don't re-open the surface.
- **Verify the macOS "passkey/token sign-in unavailable" notice still
  fires on those auxiliary windows.** **`[DONE — 2f32f1d]`**
  Confirmed `injectMacPasskeyWarning` still hooked via
  `comfyContents.on('did-create-window', …)`.
- **Install-type icon in title bar replaces textual `— Standalone` /
  `— Cloud` suffix.** **`[DONE — 82ea084]`**
  Title bar consumes `installTypeMetaFor` from Track G's helper.
- **Waffle menu dropdown is empty / no-ops while a new-install
  takeover is mounted.** **`[DONE — c4b13ce]`**
  File menu exempted from `isInert` disable; pills/nav arrows stay gated.
- **Show crash error / log inside the Comfy Instance window when its
  instance crashes.** **`[DONE — d43ba7d, cba61e3]`**
  Per-install crash buffer (8 KB cap) in main + new `getLastCrashError`
  IPC; lifecycle view's crashed state renders an inline collapsible
  "Show error log" block.
- **Downloads tray in the title bar.** **`[DONE — 1e4939a, 784c2e8]`**
  `ArrowDownToLine` icon, neutral chrome, square-ish 6px radius vs
  pills' 999px — distinct from update pills at a glance. Hidden when
  zero in-flight + zero recent. Legacy injected toast/dock/tab UI fully
  removed from `comfyContentScript.ts`.
- **Settings live as a tab in the Comfy Instance view's left-sidebar
  layout.** **`[GATED — settings-split decision]`**
- **Comfy Instance is closed-off** — no New Install / Track / Load
  Snapshot / Migrate entries in the in-Comfy waffle menu. **`[DONE — dfe2bcf]`**
  In-Comfy menu didn't actually offer them; added them to the chooser-host
  menu plus a defensive guard in `activateTitleMenuItem` so an out-of-order
  IPC carrying one of those item IDs against an install-backed parent is
  dropped silently.

---

## Cross-cutting

### Install-type icon set **`[DONE — 78b29cd (helper + tile), 82ea084 (title bar)]`**

- New iconography landed via `src/renderer/src/lib/installTypeIcon.ts`:
  - **Standalone** = `LaptopMinimal` (modern slim local device)
  - **Cloud** = `Cloud`
  - **Legacy Desktop** = `Computer` (chunkier tower silhouette — visibly older)
  - **Remote** = `Globe`, **Unknown** = `Box` (fallbacks)
- Same helper drives the dashboard tile AND the Comfy Instance title bar
  (textual `— Standalone` / `— Cloud` suffix replaced with the icon).

### Takeover ↔ Modal rethink — **RESOLVED (modal-unification track shipped)**

Originally the architectural decision that gated a lot of the
per-category items. Resolved end-to-end by Tracks M-1..M-7 (commits
`4ac023d`..`d581c9f`): the two-primitive Takeover + Modal system
collapsed into one `Modal` component with `binding` / `opacity` /
`width` props. The bullets below describe the original problem
statement; every one has shipped under the unification track.

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

1. ~~**Takeover ↔ Modal rethink — overall pattern.**~~ **RESOLVED** —
   modal-unification Tracks M-1..M-7 shipped. Max-width tokens,
   binding/non-binding split, `TakeoverBack` chevron, and
   cancel-on-window-close wiring all landed.
2. **Settings split** — exact left-sidebar layout for Comfy Instance,
   tab ordering, "Preferences" vs "App Settings" naming. **Gated on
   the window-mode unification re-enable** (currently disabled — see
   [window-mode-unification-revert.md](window-mode-unification-revert.md)).
3. **Running-install ownership** — exact lock scope (read-only on
   dashboard? grayed-out subset of actions? action-menu items
   removed?).
4. **App-update popover surface** — panel-positioned card vs true
   title-bar child-window popup.
5. **Restart-required pill family** — deferred from §18; needs a
   restart-gated-setting registry. Separate piece of work, not part of
   this polish slice.
6. **Window-mode unification re-enable** — in-place attach/detach is
   currently disabled in production due to lifecycle edge cases (see
   `dac9b16` and the revert doc). Underlying infra (`comfyWindows`
   keyed by `windowKey`, `attachInstall` / `detachInstall`,
   `claimAttachHost`) is intact and dormant; re-enable is a one-line
   IPC change once the partition-rebuild / cancel-prompt-funnel /
   panelView-stale-state lifecycle bugs are addressed.

---

## Followup tracker

| ID | Source | Status |
|----|--------|--------|
| §19 brand audit | [docs/unified-window-phase3-notes.md](unified-window-phase3-notes.md) §19 | [Issue #473](https://github.com/Comfy-Org/ComfyUI-Desktop-2.0-Beta/issues/473) |
| §18 restart-required pill | [docs/unified-window-phase3-notes.md](unified-window-phase3-notes.md) §18 | Deferred to its own pass |
| `swap-installations.{ps1,sh}` legacy `primaryInstallId` read | Track A pin-removal (a425aaa) | Dead read; scripts already fall back gracefully. Cleanup alongside other dev-tooling pass. |
| Running-state CTAs use show/hide instead of disabled styling | Track A item 4 (0c0b0c4) | Visual consistency — extend `looks-disabled` pattern to Show Window / Stop when an op is in flight. |
| `DetailModal` action buttons use their own `useActionGuard` | Track A item 4 (0c0b0c4) | Audit whether the chooser-tile show-but-disabled pattern can subsume `useActionGuard`. |
| `confirmMigration` modal stacking on first-use | Track D (85178d7) | Visual layering wasn't formally verified — manual smoke test on the migrate branch. |
| Migrate auto-launch heuristic | Track D (85178d7) | "Newest local install" fallback could pick the wrong install in concurrent-install scenarios. Expose new install id from migrate action result instead. |
| `zh.json` locale missing `comfyLifecycle.*`/etc. | Track E (cba61e3) | Either move `zh.json` to `locales/drafts/` or fully translate. |
| `ConsoleModal` doesn't surface new `lastStderr` field | Track E (cba61e3) | Parity polish — show stderr alongside `errorInfo.message`. |
| Title-bar i18n parity | Track B item 4 (82ea084) | `INSTALL_TYPE_LABELS` map hard-codes English in `TitleBarApp.vue`; wire vue-i18n into title-bar renderer to use `installTypeMetaFor(...).labelKey` instead. |
| Auto-download verification on packaged build | Track B item 2 (1c54755) | Confirm `runCheck('auto-download')` actually triggers the download in todesktop runtime when the periodic auto-check has only "checked". |
| `DownloadsTrayPopover` ↔ `DownloadsPanel` overlap | Track F (1e4939a) | Both render the same `downloadStore` data. Decide which surface is canonical once settings-sidebar-tab work lands. |
| App-update popover surface | Decision log | Deferred — panel-positioned card vs true title-bar child-window popup. |
| Takeover ↔ Modal rethink (max-width, ✕ removal, "back to main" affordance) | Cross-cutting | **DONE — modal-unification Tracks M-1..M-7 (`4ac023d`..`d581c9f`).** |
| Settings split (Comfy-Instance left-sidebar tab layout) | Cross-cutting | **Open — gated on window-mode unification re-enable (currently disabled).** |
| Running-install ownership | Cross-cutting | **Open — gates running-tile click handoff, dashboard close-running, "don't treat dashboard windows as pseudo-launchers".** |
| New-install wizard restructure | Cross-cutting | **Open — gates first-time vs subsequent install flow + snapshot-import location.** |
| Window-mode unification re-enable | [window-mode-unification-revert.md](window-mode-unification-revert.md) | **Open — infra dormant; bugs in partition rebuild / cancel-prompt funnel / panelView stale state must be fixed before re-enable.** |
| Post-unification code review findings | [post-unification-code-review.md](post-unification-code-review.md) | **Open — F1, F13, F14, F17 fixed; remaining findings tracked in that doc.** |
