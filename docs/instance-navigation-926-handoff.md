# Instance / Window Navigation (#926) — Handoff & Verification

State-driven navigation: given the **current view** (Dashboard | Instance | Cloud)
and the **clicked target**, decide whether to switch in place, restart, focus an
existing window, or open a new one.

The whole behavior matrix lives in **one pure function** —
[`decideNavigation`](../src/shared/navigation/navDecision.ts) — consumed by both
the renderer (CTA label + caret) and main (executor). To change a behavior, edit
that table and its test; nothing else.

> **Cloud ≡ Remote.** Remote installs share all cloud navigation behavior
> (`navClass` folds `remote → cloud`). Every "Cloud" row below also covers Remote.

---

## 1. CTO matrix (source of truth) — verbatim, with implementation status

The first 8 columns are the **original CTO matrix, reproduced verbatim**. The
**Implemented?** column records what shipped — see §1a for the two divergences.

| # | Current view | Click target | Target state | Current behavior | Proposed action | Primary CTA label | Secondary CTA (dropdown / split-button) | Implemented? |
|---|---|---|---|---|---|---|---|---|
| 1 | Dashboard | Dashboard | n/a | No button surfaced | No-op | – | – | ✅ |
| 2 | Dashboard | Instance A | Not running | Launch + same window | Launch + same window (unchanged) | Start | – | ✅ |
| 3 | Dashboard | Instance A | Already running | Switch / focus existing | Focus existing window | Switch | – | ✅ |
| 4 | Dashboard | Cloud | Not running | Open in same window verify | Open in same window | Open Cloud | Open in new window | ✅ |
| 5 | Dashboard | Cloud | Already open in window | Behavior inconsistent verify | Focus existing window | Switch | Open in new window | ✅ |
| 6 | Dashboard | + New Instance | n/a | Opens install wizard (modal/route) | Opens install wizard (unchanged) | New Install | – | ✅ |
| 7 | Instance A | Dashboard | n/a | Switch in same window verify | Always open in new window (A keeps running) | Open Dashboard | – | ✅ |
| 8 | Instance A | Instance A | Self | Restart Python process | Restart in same window (unchanged) | Restart | (future: Stop — defer for now) | ✅ (Stop deferred) |
| 9 | Instance A | Instance B | Not running | Switch in same window — user dislikes this | Switch in same window (default) — but expose new-window option | Switch | Open in new window → modal: "Stop A and switch, or open B in new window?" | ✅ |
| 10 | Instance A | Instance B | Already running | Behavior inconsistent verify | Focus existing window of B | Switch | – | ✅ |
| 11 | Instance A | Cloud | Not running | Behavior inconsistent verify | Always open in new window (cloud is lightweight; A keeps running) | Open Cloud | – | ✅ |
| 12 | Instance A | Cloud | Already open | Behavior inconsistent verify | Focus existing cloud window | Switch | Open in new window | ✅ |
| 13 | Cloud | Dashboard | n/a | Verify | Switch in same window | Open Dashboard | – | ⚠️ **DEVIATION — ships new-window** (§1a) |
| 14 | Cloud | Instance A | Not running | Verify | Open in new window (cloud window keeps running) | Start (in new window) | – | ✅ (CTA reads "Open in new window") |
| 15 | Cloud | Instance A | Already open | Verify | Focus existing window of A | Switch | Restart (defer? — open call for Maanil) | ✅ (Restart **deferred** — no caret) |
| 16 | Cloud | Cloud | Self | No-op or no button verify | Open a second Cloud window | Open in new window | – | ✅ |
| 17 | Cloud | + New Instance | n/a | Verify | Open install wizard in new window | New Install | – | ✅ |

### 1a. Divergences from the matrix (both confirmed with the team)

- **Row 13 — Cloud → Dashboard.** Matrix specifies **same window**; ships
  **new window**. The "Open Dashboard" chip is not table-driven — it routes
  through the shared `activate('new-window')` path. Confirmed *keep new-window
  for now*; revisit when the chip consults `decideNavigation`.
- **Rows 8 & 15 — deferred secondaries.** The "Stop" (row 8) and "Restart"
  (row 15) secondaries were marked deferred / open-call in the matrix itself and
  are intentionally **not** shipped. Restart of a running instance stays
  reachable from that instance's own window footer (avoids the "restart a window
  you're not looking at" footgun).

15/17 cells match exactly; row 13 is a confirmed deviation; rows 8 & 15
secondaries are confirmed deferrals.

---

## 2. UI notes

Per-cell status lives in the **Implemented?** column of the §1 matrix; the
deviations are in §1a. Two implementation notes:

- **The caret split-button** (footer): the label fills the left (click = primary
  action), a chevron on the right opens the navigation alternatives. It appears
  only where the matrix lists a secondary.
- **The 3-way prompt** fires for exactly one cell — **row 9** (Instance A →
  stopped Instance B), and only when the current host is a *local running*
  instance (the one the swap would stop). It is an **in-drawer dialog** (the
  picker stays open, matching the Restart confirm) with three choices: *Switch*
  (stop A, swap B in) / *Open in new window* (keep A) / *Cancel*. Implemented via
  `dialogs.confirm`'s `secondaryLabel` in `InstancePickerView` (`confirmSwitch`),
  which then calls `pickInstall(id, { confirmed: true })` so main skips its own
  modal. Cloud/remote/dashboard hosts have nothing to stop → straight switch, no
  prompt.

---

## 3. Manual verification

Run the app:

```bash
pnpm dev
```

Each case below: set up the **current view**, perform the **click**, confirm the
**expected result**. "Instance" = a local install; have at least two local
installs (A, B) and the Cloud entry available.

### Setup
1. Launch instance A → you're now in an **Instance** view (window shows A's canvas).
2. Open the title-bar instance pill → the **picker** opens.

### Dashboard → X
| Do this | Expect |
|---|---|
| From the dashboard window, select a **stopped** instance → click **Start** | It launches in the **same** window |
| Select an instance **running** in another window → click **Switch** | That instance's existing window is **focused** (no new window) |
| Select **Cloud** (closed) → click **Open Cloud** | Cloud opens in the **same** window |
| Select Cloud → open the **caret ▾** → **Open in new window** | Cloud opens in a **new** window; dashboard stays |
| Click **+ New Instance** | Install wizard opens |

### Instance A → X (you are in instance A's window)
| Do this | Expect |
|---|---|
| Click **Open Dashboard** chip | Dashboard opens in a **new** window; **A keeps running** |
| Select A itself → **Restart** | A restarts in place |
| Select stopped **B** → click **Switch** | **In-drawer 3-way dialog** (picker stays open): *Switch* (stop A, swap B in) / *Open in new window* (keep A, B in new window) / *Cancel*. Try each — on Cancel the picker stays put. |
| Select stopped **B** → caret ▾ → **Open in new window** | B opens in a **new** window directly (no modal); **A keeps running** |
| Select **B running** elsewhere → **Switch** | B's existing window is **focused** |
| Select **Cloud** (closed) → **Open Cloud** | Cloud opens in a **new** window; **A keeps running** |

### Cloud → X (you are in a Cloud window)
| Do this | Expect |
|---|---|
| Click **Open Dashboard** | Dashboard opens (currently **new** window — known deviation) |
| Select stopped instance → **Open in new window** | Instance launches in a **new** window; **Cloud keeps running** |
| Select instance **running** elsewhere → **Switch** | That window is **focused** |
| Select the **Cloud install itself** → **Open in new window** | A **second** Cloud window opens (two views of the same session) |
| Click **+ New Instance** | Install wizard opens in a new window |

### Regression spot-checks
- Local restart still shows the in-drawer "Restart instance?" confirm.
- Cloud/remote actions never show a local-process kill confirm.
- Cloud capacity gate still blocks the CTA when capacity is disabled.

---

## 4. Key files

| Concern | File |
|---|---|
| Decision table (the matrix as code) | [`src/shared/navigation/navDecision.ts`](../src/shared/navigation/navDecision.ts) |
| View-kind / category vocabulary | [`src/shared/viewKind.ts`](../src/shared/viewKind.ts) |
| Read-model (facts → NavInput) | [`src/renderer/src/composables/useInstanceNavState.ts`](../src/renderer/src/composables/useInstanceNavState.ts) |
| Verb → bridge dispatcher | [`src/renderer/src/composables/useInstanceActions.ts`](../src/renderer/src/composables/useInstanceActions.ts) |
| Footer CTA + caret split-button | [`src/renderer/src/components/settings/ComfyUISettingsContent.vue`](../src/renderer/src/components/settings/ComfyUISettingsContent.vue) |
| Picker dispatch wiring | [`src/renderer/src/comfyTitlePopup/InstancePickerView.vue`](../src/renderer/src/comfyTitlePopup/InstancePickerView.vue) |
| Main: swap (`confirmed` skips its modal) / new-window primitive | [`src/main/index.ts`](../src/main/index.ts) (`pickInstallFromPicker`, `openInstallInNewWindow`) |
| In-drawer 3-way switch prompt | [`InstancePickerView.vue`](../src/renderer/src/comfyTitlePopup/InstancePickerView.vue) (`confirmSwitch`) + [`useInstanceActions.ts`](../src/renderer/src/composables/useInstanceActions.ts) |

---

## 5. Test coverage

Coverage is split across two layers by design: **unit** tests pin the *decision*
(which verb/window for every cell), **e2e** tests pin the *wiring* (bridge → IPC →
main → real window). Together they cover every matrix cell; a few cells are
intentionally only unit/manual (noted below with the reason).

### Unit (fast, exhaustive)
| File | Covers |
|---|---|
| [`navDecision.test.ts`](../src/shared/navigation/navDecision.test.ts) | **Every matrix cell** explicitly + the full `ViewKind × TargetKind × TargetRun × class × intent` cross-product (totality — no cell can silently break) |
| [`useInstanceActions.test.ts`](../src/renderer/src/composables/useInstanceActions.test.ts) | Verb → bridge routing for all verbs; cloud-capacity gate; kill-confirm gate; `allowDuplicate` passthrough; focus-vs-spawn decision |
| [`useInstanceNavState.test.ts`](../src/renderer/src/composables/useInstanceNavState.test.ts) | Run-state derivation (self / running-here / running-elsewhere / stopped); remote⇒cloud fold |
| [`registry.test.ts`](../src/main/host/registry.test.ts) | `computeViewKind` (dashboard / instance / cloud; remote fold) |

### E2E (real app: bridge → IPC → window)
Assert via recorded IPC (`getIpcInvocations`) + live `BrowserWindow` counts.

| Spec | Test | Matrix cell |
|---|---|---|
| `nav-matrix-dashboard` | stopped instance: same-window launch | Dashboard → Instance (stopped) |
| | running instance: focus existing | Dashboard → Instance (running) |
| | cloud via "Open in new window" | Dashboard → Cloud caret |
| `nav-matrix-instance` | B via "Open in new window": spawns new window | Instance → Instance B caret |
| | B running elsewhere: focus | Instance → Instance B (running) |
| `nav-matrix-cloud` | cloud target with no window: new window | Instance/Cloud → Cloud (new window, Phase 3b) |
| | cloud self + allowDuplicate: second window | Cloud → Cloud self (row 16, Phase 3d) |
| | allowDuplicate threaded to main intact | (plumbing for the focus-vs-spawn branch) |

### Intentionally NOT e2e'd (with reason)
| Cell / behavior | Why not e2e | Where it's covered |
|---|---|---|
| **3-way modal rendering** (Switch / Open in new window / Cancel buttons + clicking each) | Fires only when the picker's parent host is a *truly attached local instance*, which needs a live ComfyUI process the e2e harness can't spawn. The new-window **routing** it triggers IS e2e'd. | Unit (`useInstanceActions.test.ts`) + manual §3 |
| **Focus-existing for an already-windowed install** (one process = one window) | Needs a real attached window in the registry (`installationIdToWindowKey` only populates on a real `attachInstall`). | Unit (`useInstanceActions.test.ts`) |
| Dashboard → Dashboard (no-op), → New Instance; Instance → self (restart), → Dashboard; Cloud → Dashboard, → New Instance | Trivial / unchanged / already covered by existing e2e (`lifecycle-picker-cluster`, `picker-stop-confirm`). | Unit + existing e2e suites |
| Cloud-host *view* setup for cloud→X tests | Attaching a real Cloud host needs a `cloud.comfy.org` launch (network + flaky). `openInstallInNewWindow` depends on the TARGET, not the calling view, so the cloud-target deltas are driven from the chooser host instead. | The view→primitive mapping is unit-tested in `navDecision.test.ts` |

**Run e2e:** `npx playwright test e2e/nav-matrix-*.test.ts --project=<os>` (note:
rebuild with `pnpm run build` first if main-process code changed — e2e runs the
built `out/` bundle).
