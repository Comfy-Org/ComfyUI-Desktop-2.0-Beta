# Issue #357 — Code Quality Plan

> Code duplication, stale code, and large files that make sense to break down into multiple smaller ones.

**Related issues:** #136 (split ipc.ts), #351 (inline spawn duplication in standalone.ts)

## Context

- **Standalone** is the primary install method; shared helpers should be extracted from its patterns.
- **Portable** and **Git** are active migration on-ramps — they must remain fully functional so users build trust before migrating to standalone.
- **Desktop (v1)** is a legacy migration-only path.
- **Cloud** is excluded from the source picker (`category !== 'cloud'`); likely legacy or future-only.

---

## Phase 1: Split the god files ✅

### 1a. `src/main/lib/ipc.ts` (2469 lines) → domain-based modules ✅

Split into `src/main/lib/ipc/` directory:

| Module | Responsibility |
|--------|---------------|
| `index.ts` | Thin composition root — calls all register functions |
| `registerAppHandlers.ts` | App-level IPC: version, paths, theme, quit, updater |
| `registerSourceHandlers.ts` | Source listing, metadata, field options |
| `registerInstallationHandlers.ts` | Install CRUD, detail sections, actions |
| `registerSessionHandlers.ts` | Launch, stop, session lifecycle |
| `registerSnapshotHandlers.ts` | Snapshot CRUD, diff, export/import, restore |
| `registerSettingsHandlers.ts` | Settings, models, downloads, preferences |
| `startupMaintenance.ts` | Fire-and-forget startup tasks |

### 1b. `src/main/sources/standalone.ts` (1395 lines) → responsibility-based modules ✅

Split into `src/main/sources/standalone/` directory:

| Module | Responsibility |
|--------|---------------|
| `index.ts` | Exported `SourcePlugin` — composes the pieces |
| `install.ts` | Download, install, post-install env setup |
| `macRepair.ts` | macOS quarantine/codesign repair |
| `updateSections.ts` | Release channel cards, update UI sections |
| `actions.ts` | Detail actions (launch settings, snapshot, migrate, etc.) |
| `envPaths.ts` | Python/uv path resolution, site-packages discovery |

### 1c. `src/main/lib/snapshots.ts` (1649 lines) → domain-based modules ✅

Split into `src/main/lib/snapshots/` directory:

| Module | Responsibility |
|--------|---------------|
| `index.ts` | Re-exports public API |
| `types.ts` | All exported interfaces (Snapshot, SnapshotEntry, etc.) |
| `store.ts` | Snapshot persistence, listing, deletion, deduplication |
| `diff.ts` | Snapshot diff generation and comparison |
| `exportImport.ts` | Export/import envelope logic |
| `restore.ts` | Restore orchestration, pip reconciliation, git restore |
| `pythonEnv.ts` | uv path, Python path helpers |
| `tabData.ts` | Snapshot tab data endpoints |

---

## Phase 2: Extract duplicated source-plugin helpers + break down run-action ✅

### Completed

- **Break down `run-action`** (2a) — split the 931-line handler in `registerSessionHandlers.ts` into `sessionActions/` directory with grouped modules: `basic.ts`, `delete.ts`, `copy.ts`, `migrate.ts`, `launch.ts`, `delegate.ts`, `types.ts`, `index.ts`. Dispatcher reduced to ~90 lines with switch statement.
- **Shared launch settings builder** (2b) — `sources/common/launchSettingsFields.ts` with `buildLaunchSettingsFields()`, adopted by standalone, portable, git
- **URL source factory** (2c) — `sources/common/urlSource.ts` with `createUrlSource()`, reduced cloud.ts and remote.ts to ~10 lines each
- **Shared action builders** (2d) — `launchAction()`, `openFolderAction()`, `migrateToStandaloneAction()` in `lib/actions.ts`, adopted by standalone, portable, git
- **Shared logged-process runner** (2d) — `runLoggedProcess()` and `formatProcessError()` in `lib/logged-process.ts`, adopted by portable and git (#351)

### Intentionally skipped

- **Shared Python launch command builder** — portable and git both use `parseArgs → extractPort`, but differ enough in Python path resolution and main.py discovery that a shared builder would be more complex than the duplication.
- **Shared release/channel section builder** — portable and standalone both build channel cards, but standalone has significantly more complex logic (ComfyVersion formatting, downgrade detection, copy-and-update action) that makes a shared builder awkward.

---

## Phase 3: Stale/dead code cleanup ✅

### Completed

- **Unified `getUvPath()` / `getActivePythonPath()`** — extracted canonical versions (with `resolveActiveEnv` fallback logic) into `lib/pythonEnv.ts`; `snapshots/pythonEnv.ts` and `standalone/envPaths.ts` now re-export from the shared module
- **Optional plugin methods** — made `getFieldOptions` and `getListActions` optional on `SourcePlugin` interface; removed no-op implementations from `desktop.ts` and `urlSource.ts`
- **desktop.ts labelling** — added module-level JSDoc documenting it as v1-migration-only with removal criteria
- **Swallowed `catch {}` logging** — added `console.warn` to three high-impact catch blocks (settings JSON parse, post-restore snapshot save, snapshot pruning); intentional fire-and-forget catches left unchanged

### Intentionally skipped

- **Legacy selectors in `comfyContentScript.ts`** — no enforced minimum frontend version, so the legacy `.comfy-missing-models` selectors remain as a safety net for older ComfyUI builds

---

## Phase 4: Break up large Vue components — Skipped

Evaluated all four candidates and decided not to split:

- **`SnapshotTab.vue` (1041)** — ~500 lines is scoped CSS; script logic is cohesive single-tab state
- **`NewInstallModal.vue` (905)** — multi-step wizard with shared state across steps; splitting creates prop-drilling with no reuse
- **`ArgsBuilder.vue` (824)** — tightly coupled parser/autocomplete/schema logic; already has 11 tests
- **`LoadSnapshotModal.vue` (764)** — half is scoped CSS; straightforward single-purpose modal

Unlike the backend god files (5+ responsibilities entangled), each Vue file has one job. Splitting would create single-use child components with more indirection and no architectural benefit.

---

## Guardrails

- Run `pnpm run typecheck && pnpm run lint && pnpm run build && pnpm run test` at each step
- Don't weaken portable/git plugin implementations — they are active migration on-ramps
- Don't delete hidden/legacy sources until migration usage is confirmed
- Keep exported APIs identical when splitting files
