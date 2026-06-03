# Legacy Desktop → Desktop 2.0 adoption

When the user installed ComfyUI via the original Electron-based "ComfyUI
Desktop" (v1), Desktop 2.0 detects it and exposes one path forward: the
existing **Migrate to Standalone** action, which now adopts the legacy
install in place instead of copying it.

There is no separate "adopt" UI, no cutover splash, no first-launch
auto-trigger today (see "Open scope" below). The OG migration surfaces
stay where they are (`MigrationBanner`, `DetailModal`,
`useInstallContextMenu`, `useComfyUISettings`); only the underlying
handler changed.

## User-visible flows

1. **Manage → Migrate to Standalone** — same confirm modal as before,
   but desktop-source installs route through `useAdoptAction` (which
   renders a plain reuse list — no snapshot preview, no variant pick,
   no pip-sync toggle) rather than `useMigrateAction`'s full standalone
   migration flow. On confirm the legacy install is adopted and the
   freshly-minted Desktop 2.0 install opens in its own window
   (`ProgressModal.handleDone` reads `newInstallationId`).

2. **Launch on a not-yet-adopted desktop install** — the
   `useListAction.executeAction` chokepoint intercepts the `launch`
   action when `inst.sourceId === 'desktop' && !inst.adopted`, shows a
   "Migrate before launching?" confirm, then chains
   `runAction('migrate-to-standalone')` → `runAction(adoptedId, 'launch')`
   in a single progress overlay.

3. **First-use takeover → Local → Migrate** — `useFirstUseChain.
   handleFirstUseChainMigrate()` fires the same `runAction(inst.id,
   'migrate-to-standalone')` against the auto-tracked legacy desktop
   install. Gated by `detectFirstUseState().hasLegacyDesktop` so the
   sub-step only appears when there's something to migrate.

## Adoption contract

`adoptDesktopInstall` (in `src/main/lib/desktopAdopt.ts`) is idempotent
and marker-based:

- Writes `.comfyui-desktop-2` at the legacy basePath **after** the new
  install record exists, so a crash mid-flow never poisons retries.
  If the marker write fails (disk full, permissions, …), the just-added
  installation record is rolled back so the next attempt isn't blocked
  by a duplicate entry. The marker also makes `detectDesktopInstall()`
  skip this workspace on subsequent boots, so the startup auto-tracker
  can't reseed a "ComfyUI Legacy Desktop" card next to the adopted one.
- Removes any auto-tracked `sourceId === 'desktop'` record whose
  `installPath` matches the adopted basePath, so the dashboard reflects
  the swap immediately (best-effort; the marker check above is the
  belt-and-braces version that catches anything left behind).
- Re-runs detect the marker and return the existing record without
  re-running the destructive steps. The re-run **does** run a
  best-effort `installAdoptedRequirements` reconcile against the legacy
  venv so older adoptions (pre-requirements-step) and installs whose
  deps drifted after a manual ComfyUI source update can self-heal by
  re-running Migrate-to-Standalone. `installFilteredRequirements` is
  idempotent — repeating it on an up-to-date venv is a uv no-op.
- Captures a forensic snapshot under `<basePath>/.snapshots/` and a
  legacy-config backup under `<configDir>/legacy-backup/<timestamp>/`
  before mutating anything.
- Sources ComfyUI into the new install path via two ordered strategies:
  1. Pre-swap copy from `<configDir>/legacy-staging/comfyui` if present
     and valid.
  2. Git clone of upstream (or the Chinese mirror) as fallback.
- Allocates a fresh install path under `defaultInstallDir()` —
  the legacy basePath is never moved.
- Installs `requirements.txt` (and `manager_requirements.txt` when
  present) into the legacy `.venv` via the bundled `uv` binary, filtered
  by `installFilteredRequirements` so PyTorch packages are preserved
  verbatim (we never clobber the legacy CUDA build). Best-effort: a
  non-zero exit logs a warning, never aborts adoption.
- One-shot `git checkout <latest stable tag>` of the ComfyUI source
  tree. Adopting users are coming in through what they perceive as a
  ComfyUI update, so they expect a fresh server. The record's
  `autoUpdateComfyUI` flag stays `false` afterward — ongoing ComfyUI
  updates remain opt-in per install (Desktop 2.0's standard policy).
- Captures hardware hints from legacy `config.json` (`adoptedFromGpu`,
  `adoptedSelectedDevice`) and the legacy app's `package.json` version
  (`adoptedFromLegacyVersion`) for a future "rebuild as managed
  standalone" flow and for telemetry segmentation.

### Settings carry (`carryLegacySettings`)

Applies a "v2 user choice wins" rule via `settings.has()` (which reads
the raw `settings.json` and ignores built-in defaults) so a key the
user has already configured in v2 is never overwritten.

| v2 key | Legacy source | Notes |
|---|---|---|
| `modelsDirs` | `<basePath>/models` + every `base_path` in `extra_models_config.yaml` | Always appended (never blocked by `has()`) — model dirs are additive. |
| `telemetryEnabled` | `Comfy-Desktop.SendStatistics` | |
| `autoInstallUpdates` | force `true` | Desktop-app silent-update toggle. **Not** carried from `Comfy-Desktop.AutoUpdate` — the cutover ships as an in-place app update from Legacy Desktop, and inheriting a legacy `false` would lock users out of future Desktop 2.0 updates including fixes to the adoption flow itself. Forced on once at adoption; respects any later v2-side toggle. |
| `pypiMirror` | `Comfy-Desktop.UV.PypiInstallMirror` | Feeds every `uv pip install` v2 runs (adoption requirements, custom-node installs, manager extras, snapshot restore). |
| `useChineseMirrors` + `chineseMirrorsPrompted` | inferred from `pypiMirror` matching `aliyun`/`tencent`/`tsinghua`/`mirrors.cernet.edu.cn` | Suppresses the locale-triggered first-launch CN-mirror prompt. |
| `firstUseCompleted` | force `true` | Skips the first-use takeover for adopted users. |
| `inputDir` / `outputDir` (global) | `<basePath>/input` / `<basePath>/output` | Only when v2 hasn't already persisted a choice. Seeds fresh managed installs created later by the same user. |

Intentionally NOT carried:

- `Comfy.ColorPalette` — ComfyUI frontend canvas-palette setting; the
  adopted install reads it from its own `<basePath>/user/...`. v2's
  `theme` setting is the launcher chrome (`'system'|'dark'|'light'`),
  not equivalent.
- `Comfy-Desktop.UV.TorchInstallMirror` — no v2 consumer; standalone
  variants ship torch pre-bundled. The legacy `comfy.settings.json` is
  preserved in `legacy-backup/<timestamp>/` if a future managed-rebuild
  flow needs it.

### Launch-args derivation (`deriveLaunchArgs`)

Reads `Comfy.Server.LaunchArgs` (a flat dotted-key map) from
`comfy.settings.json` and rebuilds the user-facing `launchArgs` string:

- **Stripped** (v2 owns or doesn't apply):
  `extra-model-paths-config`, `front-end-root`, `log-stdout`,
  `database-url`.
- **Promoted** out of the string into per-install record fields:
  `input-directory` → `inputDir`, `output-directory` → `outputDir`.
  The new fields drive the v2 Storage tab's per-install folder pickers
  and feed `launch.ts` when `useSharedInputOutput` is off.
- **Preserved** verbatim: every other key, including explicit
  `base-directory`, `user-directory`, and `listen`. Adopters who pinned
  `--listen 0.0.0.0` for LAN access keep that.
- **Synthesized when absent**: `--port 8000` (preserves legacy's
  baked-in default; matters for bookmarked URLs) and `--enable-manager`
  (legacy always included it). `--listen 127.0.0.1` is NOT synthesized
  because it matches ComfyUI's native default — emitting it would only
  add noise to the editable string.

### Per-install record fields

```
adopted: true
adoptedAt:   ISO timestamp
adoptedBaseDir: <legacyBasePath>
adoptedPythonPath: <legacyBasePath>/.venv/{Scripts,bin}/python(.exe)
adoptedSourceMode: 'pre-swap-copy' | 'git-clone-fallback'
adoptedFromLegacyVersion?: legacy app package.json version
adoptedFromGpu?:           legacy config.json detectedGpu
adoptedSelectedDevice?:    legacy config.json selectedDevice
adoptedComfyTagAtMigration?: tag chosen by the one-shot checkout

releaseTag: 'legacy-adopted'
variant:    'legacy-uv-py312'
pythonVersion: '3.12'

launchArgs:    derived string (port + enable-manager + preserved keys)
launchMode:    'window'
browserPartition: 'unique'
portConflict:  'auto'
autoUpdateComfyUI: false

useSharedModels:      true            # legacy models/ are in global modelsDirs
useSharedInputOutput: false           # workspace pinned to legacy basePath
inputDir:  <legacyBasePath>/input     # (or promoted --input-directory override)
outputDir: <legacyBasePath>/output    # (or promoted --output-directory override)
```

## Prompts

The orchestrator escalates a few runtime decisions back to the caller
via a `promptUser(kind, ctx)` callback. The dispatcher
(`handleMigrateToStandalone` in
`src/main/lib/ipc/sessionActions/migrate.ts`) wires this to native
`dialog.showMessageBox` modals anchored to the focused window.

| `kind` | When | Cancel behavior |
|---|---|---|
| `tcc` | macOS denies access to the legacy folder | throws `tcc-denied` |
| `venv-broken` | `.venv` missing or `import torch` fails | throws `venv-broken-cancelled`; "Adopt anyway" proceeds |
| `source-missing` | Both staged copy and git clone failed | throws synthetic `source-missing-switch-to-managed` → dispatcher routes the renderer to the new-install flow |
| `confirm-adopt` | Reserved for runtime escalations | (unused today) |

## Adopted-launch path

The `standalone` source's `getLaunchCommand` detects
`installation.adopted === true` and:

- Uses `adoptedPythonPath` (the legacy uv-managed `.venv`) instead of
  the standalone-env tarball's Python.
- Runs `ComfyUI/main.py` from the new install path.
- Pins ComfyUI to the legacy basePath via `--base-directory` /
  `--user-directory` CLI args (structural plumbing the user shouldn't
  need to touch). Input/output go through the per-install record
  fields and `launch.ts`'s shared-input-output branch instead.

`launch.ts` injects `--input-directory` / `--output-directory` from
either the global shared paths (when `useSharedInputOutput` is on) or
the per-install fields (when off — the adopted case). Same end result;
no duplicate args.

## Telemetry

| Event | Properties |
|---|---|
| `desktop2.adopt.started` | (none) |
| `desktop2.adopt.succeeded` | `installation_id`, `legacy_version`, `adopted_source_mode`, `has_venv`, `has_extra_models_yaml`, `models_dir_count`, `carried_keys[]`, `carry_skipped_keys[]`, `adopted_path_override_input`, `adopted_path_override_output`, `adopted_comfy_tag_at_migration`, `requirements_uv_available`, `requirements_core_exit`, `requirements_manager_exit`, `requirements_pygit2_exit`, `gpu`, `selected_device` |
| `desktop2.adopt.failed` | `error_bucket`, `error_message` (first 500 chars) |
| `desktop2.adopt.*` step events | `desktop2.adopt.backup`, `tcc`, `validate_venv`, `snapshot`, `source`, `comfy_update`, `requirements`, `requirements_reconcile`, `carry_settings`, `register` — all wrapped in `telemetry.trackedStep` |

## Adopted-install parity with managed standalone

Once adopted, the install should behave like any other standalone for
the destructive/derived flows the dashboard exposes. The launcher
resolves the right Python + uv per-install:

- `getActivePythonPath(installation)` returns `adoptedPythonPath`
  (legacy `.venv` python) for adopted installs.
- `getActiveUvPath(installation)` returns the uv pip-installed into
  the legacy `.venv` for adopted installs.
- `getActiveVenvDir(installation)` points at `<adoptedBaseDir>/.venv`
  for site-packages lookups during snapshot restore.

These shims cover snapshot save/restore, custom-node dependency
installs, and migrate-from flows without per-call special-casing.

**Delete.** Adopted-aware: the wrapper at `installPath` is removed
in full (it only contains the freshly cloned ComfyUI source — never
user data), then `<adoptedBaseDir>/.venv` and the adopt-side marker
are removed. `models/`, `user/`, `input/`, `output/`, `custom_nodes/`
and any other entries under `adoptedBaseDir` are preserved. The
install-side marker at `<installPath>/.comfyui-desktop-2` is what
satisfies the delete safety check; older adoptions backfill it on
the next idempotent re-run.

**Copy / Copy & Update.** `performCopy` does a real deep copy for
adopted installs. After the wrapper tree is copied to `destPath`,
`standalone.fixupCopy(inst, destPath, …)` pulls the per-install
state out of `<adoptedBaseDir>` into the new install:

- `.venv` → `<destPath>/ComfyUI/.venv`  (preserves the user's
  exact pytorch + python versions)
- `user`, `custom_nodes`, `input`, `output` → `<destPath>/ComfyUI/…`
- `models` is NOT copied — `useSharedModels: true` keeps them
  global, matching adopted defaults.

Then the venv path metadata (`pyvenv.cfg`, POSIX script shebangs) is
rewritten from `<adoptedBaseDir>` → `<destPath>/ComfyUI` so the copy
boots independently of the original legacy workspace. The new
record stays `adopted: true` with `adoptedBaseDir` pointing at its
own `ComfyUI/` dir and `adoptedPythonPath` at the new venv — that
keeps the adopted-aware code paths (launch, snapshot, dep installs)
working off the copy. The "where did this come from" fields
(`adoptedFromLegacyVersion`, `adoptedFromGpu`, `adoptedSelectedDevice`,
`adoptedComfyTagAtMigration`, `adoptedSourceMode`) are dropped —
they describe the original migration event, not the derived copy.
`adoptedAt` is reset to the copy time.

**In-place ComfyUI updates work for adopted installs.** The updater
script (`update_comfyui.py`) only needs Python + `pygit2`, both of
which the adopted install has after `installAdoptedRequirements`
pip-installs `pygit2` into the legacy venv. `runComfyUIUpdate` branches
on `installation.adopted` to spawn against `adoptedPythonPath` instead
of `getMasterPythonPath()`. `CM_USE_PYGIT2=1` is already injected by
`buildLaunchEnv` for every `sourceId === 'standalone'` install, so
Manager v4 picks the pygit2 backend transparently without needing
system `git` on PATH (Legacy Desktop never required it). When the
pygit2 install fails during adoption, in-place update returns the
underlying `ImportError` and Copy & Update remains the fallback.

## What this design intentionally does NOT do

- No silent first-launch auto-adopt (see "Open scope" below — this is
  the next piece of work for the in-place-update flow).
- No dedicated "Adopt in place" beta action or status pill.
- No side-by-side "adopt your legacy install" banner.
- No deferred Python-repair queue. A broken `.venv` either prompts the
  user to cancel/proceed during adoption or fails fast — repair is a
  separate user action afterward.
- No per-trigger orchestrator modes. `adoptDesktopInstall` takes one
  shape; the dispatcher decides everything else.
- No auto-update of ComfyUI after adoption. The one-shot checkout
  during adoption is **distinct** from the per-install opt-in update
  policy that applies from then on.

## Open scope (not yet on this branch)

The eventual cutover ships Desktop 2.0 as an in-place update of the
legacy app installer (same signing identity, same install path). After
the update, the user expects to launch "ComfyUI" and have it Just
Work — they shouldn't see a chooser or a takeover. Today they do.

Items pending to close the loop:

- Auto-trigger adoption from the first-launch takeover (or skip the
  takeover entirely when `hasLegacyDesktop`) so the user lands directly
  in their adopted ComfyUI window.
- Wire `desktop2.adopt.*` telemetry properties so the migration funnel
  is visible end-to-end in PostHog.
