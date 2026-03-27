# Issue #357 — Code Quality Plan

> Code duplication, stale code, and large files that make sense to break down into multiple smaller ones.

**Related issues:** #136 (split ipc.ts), #351 (inline spawn duplication in standalone.ts)

## Context

- **Standalone** is the primary install method; shared helpers should be extracted from its patterns.
- **Portable** and **Git** are active migration on-ramps — they must remain fully functional so users build trust before migrating to standalone.
- **Desktop (v1)** is a legacy migration-only path.
- **Cloud** is excluded from the source picker (`category !== 'cloud'`); likely legacy or future-only.

---

## Phase 1: Split the god files

### 1a. `src/main/lib/ipc.ts` (2469 lines) → domain-based modules

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

### 1b. `src/main/sources/standalone.ts` (1395 lines) → responsibility-based modules

Split into `src/main/sources/standalone/` directory:

| Module | Responsibility |
|--------|---------------|
| `index.ts` | Exported `SourcePlugin` — composes the pieces |
| `install.ts` | Download, install, post-install env setup |
| `macRepair.ts` | macOS quarantine/codesign repair |
| `updateSections.ts` | Release channel cards, update UI sections |
| `actions.ts` | Detail actions (launch settings, snapshot, migrate, etc.) |
| `envPaths.ts` | Python/uv path resolution, site-packages discovery |

### 1c. `src/main/lib/snapshots.ts` (1478 lines) → domain-based modules

Split into `src/main/lib/snapshots/` directory:

| Module | Responsibility |
|--------|---------------|
| `index.ts` | Re-exports public API |
| `store.ts` | Snapshot persistence, listing, deletion |
| `diff.ts` | Snapshot diff generation and comparison |
| `exportImport.ts` | Export/import envelope logic |
| `restore.ts` | Restore orchestration, pip reconciliation, git restore |
| `pythonEnv.ts` | uv path, site-packages, env helpers |

---

## Phase 2: Extract duplicated source-plugin helpers + break down run-action

- **Break down `run-action`** — split the ~900-line `run-action` handler in `registerSessionHandlers.ts` into per-action functions (e.g., `handleDelete()`, `handleLaunch()`, `handleCopy()`, `handleReleaseUpdate()`, `handleMigrateToStandalone()`)
- **Shared launch settings builder** — extracted from standalone's patterns, used by portable/git
- **Shared action builders** — launch, open-folder, delete/untrack, migrate actions
- **Shared Python launch command builder** — parseArgs/extractPort/cmd construction
- **Shared logged-process runner** — spawn + stdout/stderr + error-tail formatting (#351)
- **Shared release/channel section builder** — channel cards, confirm messages, notes truncation
- **URL source factory** — shared base for cloud.ts and remote.ts

---

## Phase 3: Stale/dead code cleanup

- `cloud.ts` — document as legacy/tracked-only (excluded from source picker)
- No-op plugin methods — make `SourcePlugin` interface hooks optional where possible
- `getUvPath()` duplication between standalone.ts and snapshots.ts
- `desktop.ts` — label clearly as v1-migration-only
- Legacy selectors in `comfyContentScript.ts` — evaluate removal if min frontend version allows
- Swallowed `catch {}` blocks — add debug/warn logging via consistent helper

---

## Phase 4: Break up large Vue components

- `SnapshotTab.vue` (1041) → toolbar, list, detail panel, composable
- `NewInstallModal.vue` (905) → source picker, fields form, path selector, summary
- `ArgsBuilder.vue` (824) → category sections, manual editor, summary
- `LoadSnapshotModal.vue` (764) → file picker, preview, shared snapshot components

---

## Guardrails

- Run `pnpm run typecheck && pnpm run lint && pnpm run build && pnpm run test` at each step
- Don't weaken portable/git plugin implementations — they are active migration on-ramps
- Don't delete hidden/legacy sources until migration usage is confirmed
- Keep exported APIs identical when splitting files
