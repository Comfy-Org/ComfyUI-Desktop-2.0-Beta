# View Flattening Plan (#431)

## Goal

Restructure the launcher so any view/modal can be displayed fullscreen (without sidebar) or in its current modal/tab context, without extensive code changes. Also eliminate code duplication throughout the codebase.

## Phase 1: Deduplication ✅ (PR #432)

Pure refactoring — no behavior changes. Eliminated ~700 lines of duplicated code.

### Renderer shared modules created

| Module | What it replaced |
|--------|-----------------|
| `lib/formatting.ts` | `formatBytes()` from 5 files |
| `lib/installHelpers.ts` | Disk space checker, path guardrails, NVIDIA check, disk space warning from 2-3 files |
| `composables/useModalOverlay.ts` | Escape + click-outside close from 9 modal files |
| `composables/useListAction.ts` | Action execution pipeline from DashboardView + InstallationList |
| `composables/useTerminalScroll.ts` | Terminal auto-scroll from ConsoleModal + ProgressModal |
| `components/VariantCardGrid.vue` | GPU/device card grid from 4 files |
| `components/PathDiskInfo.vue` | Path validation + disk info from 2 files |
| `components/InstallNamePath.vue` | Name + path + browse fields from 2 files |
| `components/SnapshotFilePreviewContent.vue` | Snapshot preview from LoadSnapshotModal + ImportPreviewModal |

### Main process deduplication

| Module | What it replaced |
|--------|-----------------|
| `lib/paths.ts` | `sanitizeDirName` + `allocateUniqueDir` from 5 files |
| `lib/delete.ts` | `formatDeleteStatus` from 3 files |
| `lib/git.ts` | `spawnStreamed` helper; `sources/git.ts` now uses lib helpers |
| `lib/standaloneMigration.ts` | `restoreSnapshotIntoInstallation` reused by IPC handlers |

### CSS unification

- Unified `sp-`/`ls-` snapshot preview prefixes (ModalDialog now uses `ls-`)
- Extracted ArgRow/ArgRadioGroup shared styles to `main.css`
- SnapshotTab uses global `ls-node-*`/`ls-pip-*` classes

## Phase 2: View/Modal Flattening Architecture

### 2a. Navigation composable/store

Create a `useNavigation` composable (or Pinia store) that manages a navigation stack. Each entry has:

```ts
interface NavEntry {
  component: Component
  props: Record<string, unknown>
  mode: 'tab' | 'modal' | 'fullscreen'
}
```

This replaces all the individual boolean refs and open/close handlers in App.vue (~20 refs, ~15 functions).

### 2b. ViewShell wrapper component

Create `ViewShell.vue` that renders the current navigation entry in the appropriate presentation mode:
- `tab` → sidebar + content area (current layout)
- `modal` → overlay with backdrop
- `fullscreen` → full viewport, no sidebar

Each view component just emits what it needs; the shell handles chrome (overlay, close button, sidebar visibility).

### 2c. Decouple views from their container

Remove `view-modal` / `view-modal-content` / overlay markup from each modal view. Each view just renders its content; `ViewShell` wraps it based on the navigation mode.

### 2d. Simplify App.vue

Replace the 20 refs + 15 handlers with the navigation composable. App.vue becomes: sidebar + `<ViewShell>`. Opening a view becomes:

```ts
nav.push({ component: NewInstallView, mode: 'fullscreen' })
```

## Phase 3: Per-View Migration (incremental)

Convert each view one at a time, verifying after each:

1. **SettingsView** → fullscreen-capable (simplest, no modal dependencies)
2. **NewInstallModal** → can render as fullscreen page
3. **QuickInstallModal** → can render as fullscreen page
4. **DetailModal** → can render as modal or fullscreen
5. **Remaining modals** (Console, Progress, Track, LoadSnapshot)

### Prior art

PR #221 (migration flow unification) successfully "flattened" the migration confirmation from a submenu path into an inline MigrationBanner component. Key lessons:
- The composable pattern (`useMigrateAction`) worked well for separating business logic from presentation
- Modal width needed explicit sizing (`modal-box-wide`, `width: 720px`) to prevent content-dependent sizing differences
- Hidden mid-migration installations (`status: 'installing'` filtered from list) prevented UI flicker

## Remaining deduplication (optional follow-up)

Items assessed but deferred:

| Finding | Reason deferred |
|---------|----------------|
| Instance action buttons template (3 files) | Structural differences too large between DashboardCard, InstallationList, RunningView |
| Install submission boilerplate | Different operation ordering, skipInstall branch, state management |
| Snapshot preview sp-/ls- template unification with ModalDialog | Different data shapes, tightly coupled to each component |
| Update-channel section builder (main process) | Complex plugin-specific hooks needed |
| Various small patterns (<10 lines) | Abstraction cost exceeds duplication cost |
