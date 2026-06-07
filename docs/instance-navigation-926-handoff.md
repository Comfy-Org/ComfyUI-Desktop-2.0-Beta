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

## 1. CTO matrix (source of truth)

### Dashboard → X
| Target (state) | Behavior | Primary CTA | Secondary (caret) |
|---|---|---|---|
| Dashboard | No-op | – | – |
| Instance (stopped) | Start, same window | **Start** | – |
| Instance (running) | Focus existing window | **Switch** | – |
| Cloud (closed) | Open, same window | **Open Cloud** | Open in new window |
| Cloud (open) | Focus existing window | **Switch** | Open in new window |
| + New Instance | Install wizard | **New Install** | – |

### Instance A → X
| Target (state) | Behavior | Primary CTA | Secondary (caret) |
|---|---|---|---|
| Dashboard | New window (A keeps running) | **Open Dashboard** | – |
| Self (A) | Restart in place | **Restart** | – |
| Instance B (stopped) | Switch by default, expose new-window | **Switch** | Open in new window → 3-way modal |
| Instance B (running) | Focus B's window | **Switch** | – |
| Cloud (closed) | Always new window (A keeps running) | **Open Cloud** | – |
| Cloud (open) | Focus existing | **Switch** | Open in new window |

### Cloud → X
| Target (state) | Behavior | Primary CTA | Secondary (caret) |
|---|---|---|---|
| Dashboard | Same window *(see deviation)* | **Open Dashboard** | – |
| Instance (stopped) | New window (cloud keeps running) | **Start (new window)** | – |
| Instance (running) | Focus existing | **Switch** | – |
| Cloud (self) | Second cloud window | **Open in new window** | – |
| + New Instance | Install wizard, new window | **New Install** | – |

---

## 2. Implementation status

| Cell | Status | Notes |
|---|---|---|
| All Dashboard → X | ✅ shipped | unchanged from prior behavior |
| Instance → Dashboard | ✅ new window | existing `activate('new-window')` |
| Instance → self | ✅ restart | unchanged |
| **Instance → Instance B (stopped)** | ✅ **3-way modal** | Phase 3a — Switch / Open in new window / Cancel |
| Instance → Instance B (running) | ✅ focus | unchanged |
| **Instance → Cloud (closed)** | ✅ **new window** | Phase 3b — was swap-in-place |
| **Cloud → Instance (stopped)** | ✅ **new window** | Phase 3b — was swap-in-place |
| Cloud → Instance (running) | ✅ focus | unchanged |
| **Cloud → Cloud (self)** | ✅ **second window** | Phase 3d — `allowDuplicate` carve-out |
| Cloud → Dashboard | ⚠️ **new window** | **Deviation:** matrix wants same-window; chip is not table-driven (hardcoded `activate('new-window')`). Left new-window for now. |

**The caret split-button** (footer): label fills the left (click = primary
action), a chevron on the right opens the navigation alternatives. Appears only
where the matrix lists a secondary.

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
| Select stopped **B** → click **Switch** | **3-way modal**: *Switch* (stop A, swap B in) / *Open in new window* (keep A, B in new window) / *Cancel*. Try each. |
| Select stopped **B** → caret ▾ → **Open in new window** | B opens in a **new** window directly (no modal); **A keeps running** |
| Select **B running** elsewhere → **Switch** | B's existing window is **focused** |
| Select **Cloud** (closed) → **Open Cloud** | Cloud opens in a **new** window; **A keeps running** |

### Cloud → X (you are in a Cloud window)
| Do this | Expect |
|---|---|
| Click **Open Dashboard** | Dashboard opens (currently **new** window — known deviation) |
| Select stopped instance → **Start (new window)** | Instance launches in a **new** window; **Cloud keeps running** |
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
| Main: swap / 3-way modal / new-window primitive | [`src/main/index.ts`](../src/main/index.ts) (`pickInstallFromPicker`, `openInstallInNewWindow`) |
| 3-way modal infra | [`src/main/popups/systemModal.ts`](../src/main/popups/systemModal.ts) (`openSystemModalChoiceAsync`) |

**Tests:** `navDecision.test.ts` covers every cell + the full input cross-product;
`useInstanceActions.test.ts` covers verb→bridge routing.
