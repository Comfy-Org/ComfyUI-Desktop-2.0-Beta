# E2E Hardening Plan (Thread G)

This plan exists to grow the fast E2E suite to cover the four UI surfaces that have repeatedly hit silent regressions during the recent refactors:

1. **Settings panel** (Global / Directories / Downloads / per-install ComfyUI Settings tabs)
2. **Title-bar dropdowns** (waffle menu items, downloads tray repaint, hover tooltips)
3. **Downloads shelf** (sizing for empty / 1 / many; per-row controls per status)
4. **Update pills** — both the per-install ComfyUI update pill and the Desktop self-update pill

Land this *before* Thread F (P3 / P4 renderer splits + comment trim) so the next round of refactors has regression coverage instead of relying on manual smoke testing.

---

## Status legend

- ✅ Done
- 🟡 In progress / partial
- ◻ Not started

---

## Why now

The Thread D / E refactors all passed both the fast E2E and lifecycle suites, then immediately regressed:
- **Title popup couldn't reopen** after a blur dismiss (`menu-closed` IPC was bypassed in the auto-dismiss path) — caught only by the user manually clicking the menu twice.
- **Downloads drawer stuck at ceiling** with one entry — caught only by the user opening the tray with a download in flight.

Both bugs would have been one-line E2E assertions away from being caught at PR time. The user has had to play the role of a flaky regression test for each landed refactor; this thread invests once in the test surface so future refactors fail loud.

---

## Existing E2E infrastructure (recap)

What we already have, [`e2e/`](../e2e):

- [`launchApp`](../e2e/launchApp.ts) — boots the packaged Electron build inside an isolated `HOME` / `APPDATA`, seeds optional installations + settings, returns `{ app, panel, titleBar, cleanup }`.
- [`WebContentsPage`](../e2e/support/cdpPages.ts) — eval-bridge facade over a `WebContentsView`'s `webContents` (because the parent BrowserWindow has no DOM, so Playwright's `connectOverCDP` hangs during enumeration). Supports `exists` / `click` / `text` / `pressKey` / `waitForSelector` / `waitForVisible`.
- [`chooserHelpers`](../e2e/support/chooserHelpers.ts) — `clickInstallTile`, `openTitleMenu`, `expectTakeoverOpen`, `dismissOverlay`.
- Two projects in playwright.config: `windows` (fast smoke, ~6s for 9 tests) and `lifecycle` (full install + launch + stop, ~2 min for 8 tests).

What's missing is a way to **seed the four target surfaces' state from the test harness without driving the entire production data path** (real downloads, real GitHub release fetches, real auto-updater). Without these hooks, every test would either need a network round-trip or a real install — too slow for the fast suite.

---

## G0 — Add a single `E2E` env-var gate + dev-hook IPC module  ✅

The whole plan hinges on one piece of plumbing: a test-only subsystem that's only registered when `process.env['E2E'] === '1'`. The existing harness in [`electronHarness.ts`](../e2e/support/electronHarness.ts) sets `E2E: '1'` in the per-test isolated env, and `src/main/index.ts whenReady` does:

```ts
if (process.env['E2E'] === '1') {
  const { registerE2EHooks } = await import('./lib/e2eHooks')
  registerE2EHooks()
}
```

`src/main/lib/e2eHooks.ts` exports `registerE2EHooks()` which attaches a typed `__e2e` object to `globalThis` so Playwright's `app.evaluate(...)` bridge can call into it directly (no IPC channel hop needed — `app.evaluate` already runs in the main process). The implementations live in their owning modules as `_test_*` exports so each surface stays cohesive:

| Helper | Effect | Used by phases |
|---|---|---|
| `seedDownloads` | Replace `comfyDownloadManager`'s in-memory active/recent maps with a supplied snapshot via `_test_setSeededTrayState`, then emit `tray-state-changed`. | G1 |
| `setInstallUpdate` | Stub `computeInstallUpdateAvailable` for a given installation id (or globally) via `lib/e2eOverrides.ts`. The next title-bar paint reads the override. | G3 |
| `setAppUpdateState` | Push a fake `AppUpdateState` through the existing `app-update:state-changed` broadcast via `_test_setUpdateState`. | G3 |
| `getTitlePopupBounds` | Read the currently-open title-bar dropdown popup's bounds via `_test_getOpenTitlePopupBounds` so size-regression assertions are cheap. | G1, G4 |

Renderer-side code stays untouched — every existing IPC that drives these surfaces (`openSystemModal`, `panel-trigger-overlay`, `app-update:state-changed`, `comfy-titlepopup:downloads-changed`) already routes through main, so seeding state there fans out to the renderers via the production channels.

A matching `e2e/support/devHooks.ts` thin wrapper exposes typed helpers around each `globalThis.__e2e` call:

```ts
export function seedDownloads(app: ElectronApplication, snapshot: DownloadsTrayStateLike): Promise<void>
export function setInstallUpdate(app: ElectronApplication, opts: { installationId?: string; available: boolean; version?: string }): Promise<void>
export function setAppUpdateState(app: ElectronApplication, state: AppUpdateStateLike): Promise<void>
export function getTitlePopupBounds(app: ElectronApplication): Promise<PopupBoundsResult | null>
```

A smoke test in [`e2e/devhooks-smoke.test.ts`](../e2e/devhooks-smoke.test.ts) exercises every helper end-to-end so a regression in the bridge fails loudly here rather than mis-attributing across the dependent G1–G4 suites.

---

## G1 — Downloads shelf coverage  ✅

[`e2e/downloads-shelf.test.ts`](../e2e/downloads-shelf.test.ts) (chooser host, fast suite, 6 tests, ~3.4s total):

| Test | Asserts | Catches |
|---|---|---|
| Empty drawer fits content | Open via title-bar tray button → popup height < 200px | Empty-state regression / over-padded empty placeholder |
| One downloading entry fits content | Seed 1 active entry → open → popup height 80–260px (NOT clipped at the 360 ceiling) | The exact bug we just fixed (`scrollHeight === clientHeight` on flex children) |
| Many entries cap at ceiling, list scrolls | Seed 12 active entries → open → popup height pinned to the ceiling AND `.downloads-list` has `scrollHeight > clientHeight` | Loss of internal scroll, e.g. if someone sets `overflow: visible` |
| Per-status controls render | Seed entries with each status → open → assert pause only on `downloading`, resume only on `paused`, cancel hidden on terminal, dismiss only on terminal | Status-action mapping regressions |
| `Clear finished` only when something to clear | Seed 1 active + 0 finished → open → assert no `.downloads-clear`. Add a finished entry mid-open → assert it appears | The header rendering condition |
| Live repaint while open | Open empty shelf → seed new entries mid-open → assert row count tracks | The `tray-state-changed` broadcast → `comfy-titlepopup:downloads-changed` route |

---

## G2 — Settings panel coverage  ✅

[`e2e/settings.test.ts`](../e2e/settings.test.ts) (chooser host, fast suite — install-less tabs only, 6 tests, ~5.4s total):

| Test | Asserts | Catches |
|---|---|---|
| Settings opens from waffle menu | Open menu → click `Settings` item → assert `.settings-modal-shell` mounts AND default active tab is `global` (the install-less default) | The `setActivePanel('settings')` IPC chain + `switchPanel('settings')` overlay open |
| Escape dismisses settings | Open → press Escape on panel → assert `.settings-modal-shell` removed | Modal Escape handler regression |
| Reopens cleanly | Open → close → step past reopen-suppression → open → assert state correct | Single-open / re-mount regressions in the overlay slot |
| Global tab renders | Open settings → click Global tab → assert at least one `.settings-section` mounts in `SettingsView` | Global-settings shape changes |
| Directories tab renders | Open → Directories → assert `.directories-panel` mounts | Directory picker regressions |
| Downloads (settings) tab renders | Open → Downloads tab (the *settings* one, not the popup) → assert `.downloads-tab` mounts | Settings-side downloads view regressions |

The per-install ComfyUI Settings tab is install-backed only — sidebar gates it on `hasInstallation` — so it's left for the lifecycle suite where a real install backs the host.

---

## G3 — Update pills coverage  ✅

[`e2e/update-pills.test.ts`](../e2e/update-pills.test.ts) (chooser host, fast suite, 6 tests, ~3.2s total):

| Test | Asserts | Catches |
|---|---|---|
| Desktop-update pill hidden when state is idle | `setAppUpdateState({kind: null, ...})` → assert no `.title-update-pill.is-app-update` | Default state |
| Desktop-update pill renders for state=available | Push state → pill visible + label includes "update" + no `is-ready`/`is-downloading` modifier | The `kind === 'available'` branch in `appUpdatePillLabel` |
| Desktop-update pill renders for state=downloading | Push state → pill visible with `is-downloading` class | The `kind === 'downloading'` branch + spinner class |
| Desktop-update pill renders for state=ready | Push state → pill visible with `is-ready` class | The `kind === 'ready'` branch |
| Clicking the ready pill opens the system-modal restart prompt | Push `ready` → click pill → assert `comfySystemModal.html` popup visible | The `comfy-window:click-app-update-pill` → `openSystemModal` flow |
| Install-update pill suppressed on install-less chooser | Seed install-update override → assert pill stays hidden | The `!isInstallLess` gate in `showInstallUpdatePill` |

The "install-update pill renders + clicks open Settings" path is install-backed-only (the pill is suppressed on install-less hosts by design) — that flow is left for the lifecycle suite, which has a real install to launch a window against.

The desktop-update tests use `setAppUpdateState` which routes through `_setUpdateState` → `_stateChangeCallbacks` → `_broadcastAppUpdateStateToTitleBars`, so the renderer code path is exactly the production one.

---

## G4 — Title-bar dropdown + tooltip regression coverage  ✅

[`e2e/dropdowns.test.ts`](../e2e/dropdowns.test.ts) (chooser host, fast suite, 4 new tests, ~3s total). The existing dropdown smoke tests stay in [`chooser.test.ts`](../e2e/chooser.test.ts) — moving them risked breaking what already works for no real benefit.

| Test | Asserts | Catches |
|---|---|---|
| Reset Zoom item absent at zoom 0 | Open menu with comfyView at level 0 → assert no `Reset Zoom` item | The `if (level !== 0)` gate in `buildTitlePopupMenuItems` |
| Reset Zoom item appears with percent label at non-zero zoom | Load `about:blank` into the dummy comfyView (Electron `setZoomLevel` is a no-op without a loaded URL) → set zoom to level 1 → open menu → assert item present and labelled `Reset Zoom (120%)` | The `buildTitlePopupMenuItems` zoom branch + percent computation |
| Listener counts stable across opens | Snapshot `popup.webContents` listener total → run 5 open / close cycles → assert total unchanged | Listener leak regressions in `EmbeddedPopupView` (auto-dismiss event handlers re-attached per open would surface here) |
| Opening the menu hides the title-bar tooltip | Show tooltip → open menu → assert tooltip popup hidden | The `hideTitleTooltipPopup(getTitleTooltipForParent(...))` line in `openTitlePopup` |

---

## G5 — Optional: visual regression snapshots  ◻

If sizing bugs keep slipping past pixel-count assertions, add Playwright `toHaveScreenshot()` snapshots for:
- Downloads shelf at 0 / 1 / 5 / overflowing entry counts
- Settings modal each tab
- Each update-pill state

This adds CI baseline-management overhead, so defer until the assertions in G1–G4 prove insufficient. Ship without it for now.

---

## Estimated effort

- **G0 plumbing**: 1 commit, ~150 lines (`e2eHooks.ts` + `devHooks.ts` wrapper + `index.ts` wiring + harness env-var).
- **G1 downloads shelf**: 1 commit, ~250 lines test code, 6 tests.
- **G2 settings**: 1 commit, ~200 lines test code, 6 tests.
- **G3 update pills**: 1 commit, ~250 lines test code, 6 tests.
- **G4 dropdowns**: 1 commit, ~150 lines test code, 4 new + 3 moved tests.

Total: 5 commits, ~22 new fast E2E tests. Should add ~20–30s to the fast-suite runtime.

---

## What this *doesn't* cover

- **Real install / launch / stop** — already covered by the lifecycle suite. Nothing here replaces it.
- **Network code paths** — release-cache, auto-updater HTTP fetches, GitHub API. We seed state past those layers.
- **PanelApp.vue routing internals** — those will be addressed by Thread F (P3 splits) and need their own unit-level coverage at that point.

---

## Order

1. **G0** first (single small commit). Everything else depends on it.
2. **G1** next (downloads shelf), because that's where the most recent regression lived.
3. **G3** (update pills) before **G2** (settings) — the update pills are wholly main-driven so the dev-hook plumbing is exercised faster.
4. **G2** (settings) last in the test-writing phase.
5. **G4** is a low-risk consolidation — can land any time after G0.

After Thread G lands, resume with Thread F (P3 + P4) with a much firmer regression net.
