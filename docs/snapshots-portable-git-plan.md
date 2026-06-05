# Snapshots for Portable & Git Installs — Investigation & Plan

Tracking: [Comfy-Org/ComfyUI-Desktop-2.0-Beta#918](https://github.com/Comfy-Org/ComfyUI-Desktop-2.0-Beta/issues/918) — "Enable snapshotting of portable installs. Maybe consider snapshotting of git installs?"

**Status:** plan only — not implemented.

---

## Summary

The soft-snapshot system today is gated entirely to the `standalone` source. This document
plans extending **capture** (plus view / diff / export) to `portable` and `git` installs, while
**deferring restore** for those sources because restore mutates the Python environment and relies
on standalone-only layout + `uv` assumptions.

Recommended first PR scope: **capture-first, restore deferred**, with snapshot support modeled as
two independent capabilities (`capture` vs `restore`) so the UI/backend never imply that
portable/git snapshots can be restored.

---

## How snapshotting works today

A soft snapshot is a ~5 KB JSON capturing:

- **pip packages** — `uv pip freeze --python <python>`
- **custom nodes** — filesystem scan of `custom_nodes/` (+ `.disabled/`)
- **ComfyUI version** — git HEAD of `ComfyUI/` plus `manifest.json` (`comfyui_ref`, release tag, variant)

Snapshots are auto-captured on every ComfyUI boot/restart, plus `manual` / `pre-update` /
`post-update` / `post-restore` triggers. Users can list, view-diff, export/import, and restore.
"Hard snapshots" (= Copy Installation) are a separate concept and out of scope here.

Full background: `notes/reference/snapshots-spec.md` (workspace root).

---

## Standalone-specific assumptions (the blockers)

| Standalone assumption | Portable | Git |
|---|---|---|
| `uv` at `standalone-env/uv.exe` | none (uses `python_embeded`) | none (user venv) |
| python at `ComfyUI/.venv` | `python_embeded/python.exe` | `installation.venvPath` |
| `manifest.json` → ref / releaseTag / variant | none | none |
| ComfyUI at `installPath/ComfyUI` | `findPortableRoot(installPath)/ComfyUI` | `installPath` **or** `installPath/ComfyUI` |
| capture hooks gated `=== 'standalone'` | not wired | not wired |
| `snapshots` tab added in `getDetailSections` | not surfaced | not surfaced |

### Relevant code

- Capture hooks (gated `inst.sourceId === 'standalone'`): `src/main/lib/ipc/sessionActions/launch.ts` — boot (~L511), restart (~L634)
- Boot-time pygit2 fallback loop also filters standalone: `src/main/lib/ipc/index.ts` (~L141)
- Capture internals: `src/main/lib/snapshots/store.ts` — `captureState()` (~L80)
- Path resolution: `src/main/lib/pythonEnv.ts` — `getActiveUvPath` / `getActivePythonPath` / `getActiveVenvDir`
- pip freeze: `src/main/lib/pip.ts` — `pipFreeze()` (uv-only, ~L131)
- Direct freeze that already exists: `src/main/lib/desktopDetect.ts` — `pipFreezeDirect()` (`python -m pip freeze`, ~L115), reused by `src/main/lib/localMigration.ts`
- Restore (uv-centric): `src/main/lib/snapshots/restore.ts`
- Tab UI added by standalone only: `src/main/sources/standalone/updateSections.ts` (~L99, `tab: 'snapshots'`)
- Initial snapshot: `src/main/sources/standalone/install.ts` (postInstall)
- pre/post-update snapshots: `src/main/sources/standalone/updateOrchestrator.ts`
- Source plugins: `src/main/sources/portable.ts`, `src/main/sources/git.ts`
- Renderer: `src/renderer/src/components/SnapshotTab.vue`, `src/renderer/src/views/comfyUISettings/SnapshotsView.vue`
- Snapshot IPC handlers: `src/main/lib/ipc/registerSnapshotHandlers.ts`

---

## Scope decision: capture-first, defer restore

Restore mutates the environment (`uv pip install/uninstall`, CNR/git node restore, targeted
site-packages backup/rollback) and depends on standalone layout assumptions. Doing it safely for
portable/git is a materially larger feature.

Capture is read-only, cheap, robust, and delivers the core value of #918 (history, diff, export,
share). Ship that first.

**Hard requirement:** portable/git snapshots must never be presented as restorable. Model snapshot
support as two capabilities so capture and restore can diverge per source.

```ts
export interface SnapshotCapabilities {
  capture: boolean
  restore: boolean
}

export function getSnapshotCapabilities(sourceId: string): SnapshotCapabilities {
  return {
    capture: sourceId === 'standalone' || sourceId === 'portable' || sourceId === 'git',
    restore: sourceId === 'standalone',
  }
}
```

Use it in: launch boot/restart capture gates, detail tab visibility, snapshot IPC list context, UI
restore/import affordances, and as a backend guard on `snapshot-restore`.

---

## Plan

### Phase 1 — Capability flags + source-aware capture environment

1. Add `getSnapshotCapabilities(sourceId)` (capture: standalone|portable|git; restore: standalone only).
2. New helper, e.g. `src/main/lib/snapshots/environment.ts`, keyed by `sourceId`, returning:
   ```ts
   interface SnapshotCaptureEnvironment {
     comfyuiDir: string
     pythonPath: string | null
     uvPath?: string | null
     refFallback: string
     releaseTag: string
     variant: string
     skipPipSync?: boolean
   }
   ```
   - **standalone** — `installPath/ComfyUI`; `getActivePythonPath` / `getActiveUvPath`; manifest metadata; `skipPipSync` unset.
   - **portable** — centralize `findPortableRoot()`; `comfyuiDir = portableRoot/ComfyUI`;
     python = `portableRoot/python_embeded/python.exe`; `refFallback = version || 'Portable'`;
     `releaseTag = version`; `variant = ''`; **`skipPipSync: true`**.
   - **git** — resolve ComfyUI dir by locating `main.py` (`installPath/main.py` vs
     `installPath/ComfyUI/main.py`); python from `installation.venvPath` (fallback to
     `.venv`/`venv`/`.env`/`env`); `refFallback = branch || 'Git install'`; `releaseTag = ''`;
     `variant = ''`; **`skipPipSync: true`**.
3. Add `pipFreezeWithPython(pythonPath)` in `lib/pip.ts`. Extract a shared `parsePipFreezeOutput()`
   so `pipFreeze` (uv), `pipFreezeDirect` (desktopDetect), and the new direct freeze all share one
   parser. Use `python -m pip freeze --local`.
4. Refactor `captureState()` to consume the resolver:
   - tolerate missing `manifest.json` (ref = fallback, releaseTag/variant empty);
   - use resolved `comfyuiDir` for `readGitHead` + `scanCustomNodes`;
   - freeze strategy: uv if `uvPath` exists, else `pipFreezeWithPython`, else `{}` (non-fatal);
   - stamp `skipPipSync` for non-standalone captures.
5. **Version display** also assumes `installPath/ComfyUI`. Make `resolveSnapshotVersion()` /
   `resolveDiffVersions()` (in `snapshots/tabData.ts` and `snapshots/diff.ts`) use the resolved
   `comfyuiDir`, otherwise portable-nested and root-level git installs show degraded version labels.

### Phase 2 — Wire hooks + UI

6. Change boot/restart gates in `launch.ts` from `=== 'standalone'` to
   `getSnapshotCapabilities(inst.sourceId).capture`.
7. Surface the `snapshots` tab in `portable.ts` and `git.ts` `getDetailSections`.
8. Make `snapshot-save` / `snapshot-delete` generic session handlers guarded by `capture` (they are
   not really source-specific). Keep `snapshot-restore` standalone-delegated **and** backend-guarded:
   ```ts
   if (!getSnapshotCapabilities(inst.sourceId).restore)
     return { ok: false, message: 'Snapshot restore is not supported for this installation type yet.' }
   ```
9. UI: include `capabilities` in the snapshot list context. In `SnapshotTab.vue` and
   `SnapshotsView.vue`, when `restore: false` hide row Restore buttons / restore-framed CTAs and show
   a short note ("Snapshot restore is currently supported for Standalone installs only."). Keep
   create / view / diff / export / delete.
10. **Import auto-restore trap:** the current import flow stages snapshots and auto-restores the
    newest (`importSnapshotsConfirm()` returns `restoreFile`, UI then emits `snapshot-restore`). For
    capture-only sources, either disable import or make it history-only (do not return `restoreFile`,
    do not auto-run restore, treat the diff as informational). Do **not** ship the current import
    behavior unchanged for portable/git.

### Phase 3 — pre/post-update history hooks (optional, include if small)

11. Capture `pre-update` / `post-update` around portable `update-comfyui` and git `git-pull` — the
    moments users most want history. Best-effort and non-blocking. Defer explicitly if it grows the PR.

### Deferred — restore for portable/git

Needs a per-source `SnapshotProvider` abstraction with explicit preflight checks, non-uv pip sync,
backup/rollback outside the standalone venv, portable embedded-Python site-packages handling, git
venv discovery/ownership, and safe checkout rules for user-managed repos. Revisit when users ask,
telemetry shows usage, or support cases need rollback after portable update / git pull.

---

## Edge cases / test checklist

- portable: direct root and one-level-nested root
- git: root `main.py` and nested `ComfyUI/main.py`
- missing `manifest.json` — capture still succeeds with fallback version metadata
- missing / broken pip — save snapshot with empty package map, warn (non-fatal)
- missing / invalid git `venvPath` — nodes + ComfyUI version still captured, packages empty
- manual save / delete on portable + git
- restore hidden in UI and blocked in backend for portable/git
- import does not auto-restore when `restore: false`
- snapshot list / detail / diff use the correct source-aware `comfyuiDir`
- portable/git snapshots carry `skipPipSync: true` (guards against unsafe pip sync if later imported into a standalone install)
- capture stays best-effort and never blocks launch / restart

---

## Open questions

- Should portable/git `pre-update`/`post-update` hooks (Phase 3) land in the first PR or a follow-up?
- Import: fully disable for capture-only sources, or invest now in a history-only import mode?
- Do we want a one-time backfill (capture an initial snapshot for existing portable/git installs on
  next boot) — already covered naturally by the boot hook, so likely no extra work.
