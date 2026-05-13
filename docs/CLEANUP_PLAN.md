# Pre–Seamless-Transitions Cleanup Plan

This plan exists to remove friction in `src/main/index.ts` and the test suite **before** we start work on seamless dashboard ↔ instance window transitions (using one host window to flip between chooser and an install without spawning a new BrowserWindow).

It is not a feature plan; it is a code-hygiene checklist. Every item is independently shippable.

## Status legend

- ✅ Done
- 🟡 In progress / partial
- ◻ Not started

---

## Pass 1 — Already landed (this PR)

### Code cleanup
- ✅ Extract window-bounds cache to [`src/main/lib/windowState.ts`](../src/main/lib/windowState.ts) — `WindowBounds`, `flushWindowState`, `saveWindowBounds`, `getSavedBounds`, `getWindowOptions`.
- ✅ Extract context-menu helper to [`src/main/lib/contextMenu.ts`](../src/main/lib/contextMenu.ts).
- ✅ Strip explicit `// Phase N` plan-step comments from `standalone/actions.ts` and `version-resolve.ts` (AGENTS.md violation).
- ✅ Sweep stage / track / phase IDs from `index.ts`, `settings.ts`, and a handful of renderer composables and tests.
- ✅ Trim historical-narration headers in `index.ts` (Tray docking, removed TRAY_ICON, "replaces previous 'Choose an install'" pill text).

### Test-suite salvage
- ✅ Delete the broken `e2e/navigation.test.ts` and `e2e/fullscreen.test.ts` (referenced sidebar tabs and the `__E2E_NAV__` overlay system, both gone).
- ✅ Delete the obsolete CDP/eval-bridge module `e2e/support/comfyWindow.ts` and the sidebar-tab helpers `e2e/support/navigationHelpers.ts`.
- ✅ Build a new eval-bridge harness [`e2e/support/cdpPages.ts`](../e2e/support/cdpPages.ts) — `WebContentsPage` facade that runs `executeJavaScript` against the panel/title-bar WebContentsViews. Required because Playwright's `connectOverCDP` hangs during enumeration when the parent BrowserWindow has no DOM.
- ✅ Add chooser-flow helpers in [`e2e/support/chooserHelpers.ts`](../e2e/support/chooserHelpers.ts).
- ✅ Replace `launchApp.ts` to return `{ panel, titleBar }` `WebContentsPage` facades.
- ✅ New [`e2e/chooser.test.ts`](../e2e/chooser.test.ts) — 4 fast tests (chooser body renders, title-bar pill, new-install takeover, waffle menu).
- ✅ Rewrote [`e2e/lifecycle.test.ts`](../e2e/lifecycle.test.ts) against the per-install-window flow.
- ✅ Fixed [`e2e/window-visible.spec.ts`](../e2e/window-visible.spec.ts) to use the eval bridge.

## E2E test posture (post-rewrite)

The fast suite (`pnpm exec playwright test --project=windows`) is now the regression baseline. Run it after every structural change in the upcoming P0 splits — if the chooser stops rendering or the title-bar disappears, this catches it within seconds.

The lifecycle suite (`@lifecycle`, ~10 min/test) costs network + 500MB download per run. Use it to validate the install / launch / stop flow before merging any change to:
- `src/main/index.ts` host-window construction or `attachInstall` / `_detachInstallImpl`.
- `src/renderer/src/views/ChooserView.vue` (tile click handlers, status state).
- `src/main/sources/standalone/install.ts` or `actions.ts` (install / launch IPC contracts).

---

## P0 — Split `src/main/index.ts` (still ~4500 lines)

These extractions are ordered for safety: each one is self-contained at the boundary so the diff is mechanical.

### P0.1 — `src/main/popups/titleTooltip.ts`  (~400 lines) ✅
Move from `index.ts`:
- `TitleTooltipConfig`, `TitleTooltipPopupEntry` interfaces
- `TOOLTIP_POPUP_INITIAL_WIDTH`, `TOOLTIP_POPUP_INITIAL_HEIGHT`, `TOOLTIP_POPUP_SHADOW_GUTTER`, `TOOLTIP_VERTICAL_GAP`, `TOOLTIP_RENDER_ACK_TIMEOUT_MS` constants
- Maps: `titleTooltipPopupsByParent`, `titleTooltipPopupsByWebContents`
- Functions: `nextTitleTooltipToken`, `resolveTooltipTheme`, `ensureTitleTooltipPopup`, `positionTooltipPopup`, `showTitleTooltipPopupNow`, `hideTitleTooltipPopup`, `openTitleTooltipPopup`
- 4 IPC handlers: `comfy-titletooltip:ready`, `comfy-titletooltip:rendered`, `comfy-window:show-titlebar-tooltip`, `comfy-window:hide-titlebar-tooltip`

Exports: `openTitleTooltipPopup`, `hideTitleTooltipPopup`, `titleTooltipPopupsByParent` (read-only), and a `registerTitleTooltipIpc()` to be called from `whenReady`.

This is the lowest-risk subsystem to extract because nothing else in `index.ts` mutates its state — only `openTitlePopup` reads `titleTooltipPopupsByParent` to dismiss the tooltip when a menu opens.

### P0.2 — `src/main/popups/systemModal.ts`  (~270 lines) ✅
Move:
- `SystemModalSpec`, `SystemModalCallback`, `SystemModalEntry`, `OpenSystemModalOpts`
- Maps: `systemModalsByParent`, `systemModalsByWebContents`
- Functions: `ensureSystemModal`, `hideSystemModal`, `showSystemModalNow`, `openSystemModal`
- IPC handlers: `comfy-systemmodal:ready`, `comfy-systemmodal:rendered`, `comfy-systemmodal:close`, `comfy-systemmodal:result`

Exports: `openSystemModal`, `registerSystemModalIpc()`.

### P0.3 — `src/main/popups/titlePopup.ts`  (~890 lines) ✅
Moved:
- `TitlePopupMenuItem`, `TitlePopupConfig`, `TitlePopupEntry`, `OpenTitlePopupOpts`
- Constants: `POPUP_WIDTH`, `POPUP_RENDER_ACK_TIMEOUT_MS`, `DOWNLOADS_POPUP_*`
- Maps: `titlePopupsByParent`, `titlePopupsByWebContents`
- Functions: `computePopupHeight`, `buildTitlePopupMenuItems`, `ensureTitlePopup`, `hideTitlePopup`, `showTitlePopupNow`, `openTitlePopup`, `activateTitlePopupMenuItem`, `notifyTitlePopupDownloads`, plus a `prewarmTitlePopup(parent)` so `index.ts` can pre-create the popup on host construction without leaking the internal `ensureTitlePopup`.
- All `comfy-titlepopup:*` IPC handlers plus the title-bar triggers (`comfy-window:click-downloads-tray`, `comfy-window:open-title-menu`, `comfy-window:dismiss-title-menu`).

The popup module now subscribes to `downloadEvents` itself for live tray updates — `index.ts` no longer needs `_broadcastDownloadsToTitlePopups`. Cross-cutting actions reach the popup via a `TitlePopupHostBindings` callback bag passed to `registerTitlePopupIpc({ openChooserHostWindow, returnToDashboard, confirmAndCloseAllHostWindows, setActivePanel, triggerOpenFeedback, sendToPanelDeferred })`.

### P0.4 — `src/main/lib/processErrorHandlers.ts`  (~95 lines) ✅
Move: `serializeUnknownError`, `forwardDatadogError`, `registerProcessErrorHandlers`, the `processErrorHandlersRegistered` flag.

Exports: `registerProcessErrorHandlers`, `forwardDatadogError`.

### P0.5 — `src/main/host/registry.ts`  (~470 lines) ✅
Moved:
- `ComfyWindowEntry` interface
- `BodyMode`, `ComfyPanelKey`, `VALID_PANELS`
- Maps: `comfyWindows`, `installationIdToWindowKey` (private), `pendingAttachClaims`
- `lastFocusedInstallationId` mutable, exposed via `getLastFocusedInstallationId()` / `setLastFocusedInstallationId()`
- Helpers: `nextWindowKey`, `getEntryByInstallationId`, `indexInstallationId`, `dropInstallationIndex`, `registerHostEntry`, `unregisterHostEntry`, `computeBodyMode`, `findEntryByTitleBarSender`, `findPreferredHostByVisibility`, `findPreferredChooserHostWindow`, `findPreferredInstallHostWindow`, `openOrFocusChooserHostWindow`, `openOrFocusAnyHostWindow`, `bringToFront`

Late-binding: registry exposes `setHostFactories({ createChooser })` and `index.ts` calls it at the top of `whenReady` so `openOrFocus*` can spawn a fresh chooser host without importing host-construction code.

#### Thread C testing notes

Regression coverage already in the fast suite (`pnpm exec playwright test --project=windows`):
- `chooser body renders on cold start` — covers `comfyWindows` registration + `computeBodyMode(entry) === 'chooser'`.
- `title bar shows install-less pill` — covers `findEntryByTitleBarSender` resolving title-bar webContents back through `comfyWindows`.
- `clicking New Install tile opens the new-install takeover` — covers `setActivePanel` reading from `comfyWindows.get(windowKey)`.
- `activate hook focuses the existing chooser host instead of spawning a duplicate` — covers `openOrFocusAnyHostWindow` → `findPreferredInstallHostWindow` (returns null) → `findPreferredChooserHostWindow` → `findPreferredHostByVisibility` dedup. **Catches late-binding regressions where `setHostFactories` fires too late or returns a stale `comfyWindows` reference.**
- `title popup opens, renders menu items, and closes via bridge` — covers `findEntryByTitleBarSender` + `comfyWindows.get` resolving the parent for `openTitlePopup`.

Add as part of Thread C (after the registry module exists, the helpers are pure and trivially mockable):
- Vitest unit suite for `nextWindowKey` (sequential unique keys), `computeBodyMode(mockEntry)` (chooser vs install vs settings vs lifecycle modes), the `pendingAttachClaims` set/get/delete round-trip, and `findPreferredHostByVisibility(predicate)` with mock entries (visible-beats-minimised, insertion order within a bucket).

Not testable without a real install (only `lifecycle` suite covers these — run once at end of Thread C):
- `pendingAttachClaims` claim-then-consume cycle when the chooser pivots to an install host.
- `lastFocusedInstallationId` MRU tracking across multiple install hosts.
- `installationIdToWindowKey` secondary-index round-trip via `getEntryByInstallationId`.
- `findPreferredInstallHostWindow`'s 4-tier visible/MRU priority.

### P0.6 — `src/main/host/createHostWindow.ts`  (~660 lines) ✅
Moved `CreateHostWindowOpts`, `CreateHostWindowResult`, `injectMacPasskeyWarning` + the `PASSKEY_BANNER_*` constants, `createHostWindow`, `expectedPartitionFor`, `buildComfyView`, `rebuildComfyViewIfNeeded`, `applyChooserHostTheme`, `applyChooserHostThemeToAll`, `getChooserHostTheme`, `openChooserHostWindow`, plus the host-only constants `APP_ICON`, `APP_VERSION`, `CHOOSER_HOST_TITLE_TEXT`, `CHOOSER_HOST_WINDOW_TITLE`, `CHOOSER_HOST_BOUNDS_KEY`.

Late-binding: the module exposes `setHostWindowFactories({ consultPanelRendererClose, detachInstallImpl, preClearedClose, ensurePanelView, computeInstallUpdateAvailable })`, called once at the top of `whenReady` so `createHostWindow` can reach back into the lifecycle code that still lives in `index.ts` (and which P0.7 / P0.9 will pull out next).

### P0.7 — `src/main/host/attach.ts` and `src/main/host/detach.ts` ✅
Moved:
- `host/attach.ts` (~340 lines): `AttachInstallOpts`, `attachInstall`. Late-bound via `setAttachFactories({ comfyFailRetryTimerCancels, relaunchStates, computeInstallUpdateAvailable })` so the lifecycle-state maps still owned by `index.ts` reach the listener wiring without forcing a circular import.
- `host/detach.ts` (~290 lines): `_detachInstallImpl`, `returnToDashboard`, `confirmAndCloseAllHostWindows`, `closeAllHostWindows`, `consultPanelRendererClose`, plus the `preClearedClose` `WeakSet<BrowserWindow>` they share. The createHostWindow close handler imports `preClearedClose` via `setHostWindowFactories(...)` so all three sites read the same set.

These are the actual pivot points for seamless transitions. After the split, the seamless-transition feature can compose them as `entry.detachInstall(); attachInstall(entry, newOpts)` without rebuilding the BrowserWindow.

### P0.8 — `src/main/lib/ipc/registerAssetDownloadHandlers.ts` ✅
Move `registerAssetDownloadIpc`. Renames to `registerAssetDownloadHandlers` for consistency with the existing `register*Handlers.ts` files in `lib/ipc/`.

### P0.9 — `src/main/host/panelView.ts`  (~195 lines) ✅
Moved `ensurePanelView`, `focusActiveBody`, `setActivePanel`, `refreshComfyTabBody`, `sendToPanelDeferred`, plus the `comfy-window:set-panel` and `comfy-window:close-current-panel` IPC handlers (now wrapped in an exported `registerPanelViewIpc()` called once from `whenReady`). Pure relocation — the module imports its dependencies directly from `host/registry`, `lib/titleBarOverlay`, and `lib/ipc/shared` with no callback bag needed.

### Target end state
After P0.1–P0.9, `index.ts` should be **~600–800 lines**: imports, app-level wiring, `whenReady`, `before-quit` orchestration, lifecycle event routing (`onComfyExited`/`onLaunch`/`onStop`), tray menu, the `quit-app` / `focus-comfy-window` / `close-host-window` handlers, and the `register*Ipc()` startup calls for each subsystem.

---

## P1 — DRY: extract `EmbeddedPopupView` primitive

Once P0.1, P0.2, and P0.3 land as separate files, the duplication becomes obvious:

| Concern | titleTooltip | systemModal | titlePopup |
|---|---|---|---|
| Construct transparent `WebContentsView` with preload | ✓ | ✓ | ✓ |
| `parent.contentView.addChildView(popup)` | ✓ | ✓ | ✓ |
| Dev/prod URL load (env-gated) | ✓ | ✓ | ✓ |
| By-parent + by-webContents `Map`s | ✓ | ✓ | ✓ |
| Parent-`closed` teardown + listener cleanup | ✓ | ✓ | ✓ |
| `webContents.once('destroyed', …)` index cleanup | ✓ | ✓ | ✓ |
| Render-ack timer fallback (`pendingShowTimer`) | ✓ | ✓ | ✓ |
| `setVisible(true)` + re-stack on top dance | ✓ | ✓ | ✓ |
| `lastSyncedConfigJson` fast-path skip-re-IPC | ✓ | — | ✓ |

Extract `src/main/popups/embeddedPopupView.ts` exposing a class:

```ts
class EmbeddedPopupView<TConfig> {
  constructor(opts: {
    parent: BrowserWindow
    htmlName: 'comfyTitlePopup' | 'comfySystemModal' | 'comfyTitleTooltip'
    preload: string
    initialBounds: Electron.Rectangle
    setConfigChannel: string  // e.g. 'comfy-titlepopup:set-config'
    onParentClosed?: () => void
  })
  show(config: TConfig, position: Electron.Rectangle, opts?: { fastPath?: boolean }): void
  hide(opts?: { releaseFocusToParent?: boolean }): void
  destroy(): void
  onRendererReady(cb: () => void): void
  onRendered(cb: (token?: string) => void): void
}
```

Each subsystem then keeps only its **business logic** (menu-item building, anchor math, modal spec resolution, callback wiring) and delegates lifecycle to the primitive. Estimated removal: **~250 duplicated lines**.

⚠ Do not build this primitive before the 3 popups are in their own files. Building it ahead of time would force speculation about which methods to expose.

---

## P2 — Friction blocking the seamless-transition feature

These are concrete hot-spots that will hurt when the feature lands. Address only when touching the code anyway.

- **`createHostWindow` is monolithic** (~290 lines). Split into `buildSkeleton()` + `installLifecycleListeners()` + `wireTitleBarHandshake()` so chooser-host vs install-host become short specializations rather than a giant `if (installationId === null)` ladder.
- **`attachInstall` is monolithic** (~370 lines). Subsections that already exist as inline blocks (download wiring, navigation listeners, theme observer, will-prevent-unload, partition gate) should each become a `wire*` helper. Then a future `swapInstallInPlace(entry, newInstall)` can call the same helpers without re-running the entire 370-line setup.
- **`computeBodyMode` is the right abstraction** but several call sites still branch on `entry.installationId === null` directly (e.g. inside title-popup item builders, panel routing). Audit and route everything through `computeBodyMode` / a single `isChooserHost(entry)` predicate.
- **`pendingAttachClaims` is opaque** — a `Map<string, number>` with conventions in 3 places. After P0.5, put `claimAttachHost(installationId, windowKey)`, `consumeAttachClaim(installationId)` next to it as the only mutators.

---

## P3 — Other oversized files

| File | Action | Notes |
|---|---|---|
| `PanelApp.vue` | **Split** | Per-panel routing → composables. Keep `PanelApp.vue` as shell. Will be touched by seamless-transition work anyway. |
| `TitleBarApp.vue` | **Split** | Pull pill buttons + tooltip coordinator + update-pill state into composables. The tooltip composable will pair with **P1**. |
| `SnapshotTab.vue` | **Split** | List / diff / actions are independent. |
| `ChooserView.vue` | **Split** | Card grid, onboarding banner, pinned/recent are independent. Will be touched by seamless transitions. |
| `comfyDownloadManager.ts` | **Split** | Pull IPC registration → `lib/ipc/registerDownloadHandlers.ts`. |
| `lib/ipc/shared.ts` | **Trim** | Coherent — don't split, but trim long historical doc-comments. |
| `lib/snapshots/restore.ts` | **Leave** | One algorithm, well-commented. |

---

## P4 — Comment trimming sweep

After the file splits, do one pass over each new module to apply AGENTS.md rules:

- Drop any "previously did X / now does Y" narration.
- Drop any plan-phase / track / stage references.
- Collapse 10–25-line jsdoc blocks on simple helpers to one sentence.
- Keep the genuinely useful "why" comments (race conditions, OS quirks, IPC ordering invariants).

---

## Order of operations

Recommended execution order across follow-up threads:

1. **Thread A — Test salvage** ✅ (landed in this PR).
2. **Thread B — P0.1 + P0.2 + P0.4 + P0.8** ✅ (landed in this PR; `index.ts` 4533 → 3720 lines).
3. **Thread C — P0.5 (registry)** ✅ (landed in this PR; `index.ts` 3720 → 3125 lines).
4. **Thread D — P0.3 + P0.6 + P0.7 + P0.9** ✅ (landed in this PR; `index.ts` 3125 → ~905 lines). The host-window construction split. Final structure: `popups/titlePopup.ts` (~890), `host/createHostWindow.ts` (~660), `host/attach.ts` (~340), `host/detach.ts` (~290), `host/panelView.ts` (~195). Lifecycle-state maps (`relaunchStates`, `comfyFailRetryTimerCancels`) and `computeInstallUpdateAvailable` still live in `index.ts` and reach the new modules via `setAttachFactories(...)` / `setHostWindowFactories(...)` / `setDetachFactories(...)` — moving them out is a P3/P4 follow-up, not blocking the seamless-transition feature.
5. **Thread E — P1 (popup primitive)**. After all 3 popups live in their own files.
6. **Thread F — P3 + P4**. Renderer file splits and the comment trim sweep.

After Thread D, `index.ts` should be small enough that the seamless-transition feature is straightforward to start.
