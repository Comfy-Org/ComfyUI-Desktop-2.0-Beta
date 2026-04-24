# Issue #431: View Flattening & Navigation Composable

## Problem

The modal views (Detail, Console, Progress, NewInstall, QuickInstall, Track, LoadSnapshot) each managed their own overlay lifecycle — escape-to-close, backdrop click, z-index stacking — via a `useModalOverlay` composable duplicated in every view. This made it hard to reason about overlay ordering, led to repeated boilerplate, and prevented centralized control over the overlay stack.

## Plan

The refactor was split into phases:

### Phase 1 (separate PR #432)
- Deduplicate shared utilities across modal/view components.

### Phase 2a–2b: Navigation composable + App.vue integration
- Create `useNavigation.ts` — a singleton composable with:
  - `activeTab` (reactive tab state)
  - `overlays` (reactive overlay stack)
  - `present()` / `dismiss()` / `dismissTop()` / `dismissAll()` for overlay management
  - `patchOverlay()` for updating overlay props in-place
  - `registerController()` / `invokeWhenReady()` for bridging imperative component APIs
- Migrate `App.vue` to drive all modal visibility through `nav.present()` / `nav.dismiss()` instead of manual template refs and boolean flags.
- Add E2E infrastructure: Playwright tests against the real Electron app with isolated temp home dirs and seeded installation fixtures.
- Fix window visibility issues (#283) on Windows.

### Phase 2c: Modal view flattening
- Remove `useModalOverlay` composable and the outer `view-modal` wrapper div from all 7 modal views.
- Change each view's root element to `view-modal-content`, delegating overlay chrome to a centralized shell.

### Phase 2d: ViewShell overlay manager
- Create `ViewShell.vue` — iterates `nav.overlays` and wraps each in a `view-modal.active` div with centralized escape-to-close and click-outside-to-close logic.
- Implement controller registry pattern to fix timing gaps:
  - Modal views register their imperative methods (e.g. `open()`, `startOperation()`) on mount via `registerController()`.
  - `App.vue` uses `nav.invokeWhenReady()` for all imperative calls, which queues the call if the controller isn't registered yet and replays it once it is.

### Post-refactor cleanup
- Extract `useControllerRegistration` composable to deduplicate the `onMounted`/`onUnmounted` registration boilerplate across 5 modal views.
- Extract `i18n` creation from `main.ts` into `i18n.ts` to break the `useModal` → `main.ts` import chain that caused test side-effects.

## Key files

| File | Role |
|------|------|
| `src/renderer/src/composables/useNavigation.ts` | Singleton navigation state, overlay stack, controller registry |
| `src/renderer/src/composables/useControllerRegistration.ts` | Lifecycle helper for registering/unregistering controllers |
| `src/renderer/src/views/ViewShell.vue` | Centralized overlay wrapper (escape, backdrop, stacking) |
| `src/renderer/src/i18n.ts` | Extracted i18n instance (avoids main.ts side-effects in tests) |
| `e2e/navigation.test.ts` | 18 E2E tests for tab switching, modal open/close, stacking |
| `e2e/lifecycle.test.ts` | 12 E2E tests for install → launch → stop → update flow |
| `e2e/support/electronHarness.ts` | Isolated Electron launcher for E2E (temp home, CDP port, error suppression) |
| `e2e/support/comfyWindow.ts` | CDP bridge for interacting with ComfyUI WebContentsView |
| `e2e/launchApp.ts` | Shared app launcher that waits for Vue mount |

## Commits

1. `3f48d84` — feat: navigation composable, E2E infrastructure, window fixes
2. `89e06c2` — feat: ViewShell overlay manager, modal view flattening, lifecycle E2E tests
3. `40e151b` — feat: CDP bridge for ComfyUI WebContentsView E2E testing
4. `07b9ea2` — fix: extract i18n module, fix E2E harness and lifecycle tests
5. `d74d5f1` — refactor: extract useControllerRegistration composable
6. `4994044` — feat: Phase 3 infrastructure — fullscreen mode support, E2E tests

## Phase 3: Per-View Fullscreen Migration

**Goal**: Make each view capable of rendering in both `modal` and `fullscreen` modes.

### Infrastructure (Complete)

- **CSS**: `.view-fullscreen` class — `position: fixed`, fills content area to the right of sidebar, no backdrop.
- **ViewShell**: Renders overlays with `mode === 'fullscreen'` in `.view-fullscreen` wrapper (no backdrop click/dismiss). Renders `mode === 'modal'` in `.view-modal.active` as before. Both use `data-overlay-key` and `data-overlay-mode` attributes.
- **E2E bridge**: `window.__E2E_NAV__` exposes `present()`, `dismiss()`, `dismissAll()`, `switchTab()` for programmatic fullscreen testing.
- **E2E tests**: `e2e/fullscreen.test.ts` — 18 tests covering Settings baseline, all 7 modal views in modal+fullscreen modes, backdrop absence, stacking, Escape, tab persistence.

### Migration order

1. SettingsView (tab → also modal) — **done** — added `'settings'` to `OverlayKey`/`OverlayPropsMap`, `mode` prop selects overlay vs tab template, extracted `SettingsSections.vue` to deduplicate section rendering, ViewShell renders settings overlay, 3 E2E tests added
2. NewInstallModal — **done** — already mode-agnostic via ViewShell wrapper, no per-view changes needed
3. QuickInstallModal — **done** — already mode-agnostic via ViewShell wrapper, no per-view changes needed
4. DetailModal — **done** — already mode-agnostic via ViewShell wrapper, no per-view changes needed
5. TrackModal — **done** — already mode-agnostic via ViewShell wrapper, no per-view changes needed
6. LoadSnapshotModal — **done** — already mode-agnostic via ViewShell wrapper, no per-view changes needed
7. ConsoleModal — **done** — already mode-agnostic via ViewShell wrapper, no per-view changes needed
8. ProgressModal — **done** — already mode-agnostic via ViewShell wrapper, no per-view changes needed

## Status

Phase 3 complete. All views migrated. SettingsView can now be presented as modal/fullscreen overlay in addition to its tab role. All 7 modal views work in both modes through ViewShell without per-view changes. All tests passing (630 unit tests, 17 navigation E2E, 21 fullscreen E2E, 12 lifecycle E2E).
