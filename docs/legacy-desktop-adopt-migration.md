# Legacy Desktop → Desktop 2.0 adoption

When the user installed ComfyUI via the original Electron-based "ComfyUI
Desktop" (v1), Desktop 2.0 detects it and exposes one path forward: the
existing **Migrate to Standalone** action, which now adopts the legacy
install in place instead of copying it.

There is no separate "adopt" UI, no cutover splash, no first-launch
takeover. The OG migration surfaces stay where they are
(`MigrationBanner`, `DetailModal`, `useInstallContextMenu`,
`useComfyUISettings`); only the underlying handler changed.

## Two user-visible flows

1. **Manage → Migrate to Standalone** — same confirm modal as before;
   on confirm the legacy install is adopted and the freshly-minted
   Desktop 2.0 install opens in its own window
   (`ProgressModal.handleDone` reads `newInstallationId`).

2. **Launch on a not-yet-adopted desktop install** — the
   `useListAction.executeAction` chokepoint intercepts the `launch`
   action when `inst.sourceId === 'desktop' && !inst.adopted`, shows a
   "Migrate before launching?" confirm, then chains
   `runAction('migrate-to-standalone')` → `runAction(adoptedId, 'launch')`
   in a single progress overlay.

## Adoption contract

`adoptDesktopInstall` (in `src/main/lib/desktopAdopt.ts`) is idempotent
and marker-based:

- Writes `.comfyui-desktop-2` at the legacy basePath after the new
  install record exists, so a crash mid-flow never poisons retries.
- Re-runs detect the marker and return the existing record without
  touching disk.
- Captures a forensic snapshot under `<basePath>/.snapshots/` and a
  legacy-config backup under `<configDir>/legacy-backup/<timestamp>/`
  before mutating anything.
- Sources ComfyUI into the new install path via two ordered strategies:
  1. Pre-swap copy from `<configDir>/legacy-staging/comfyui` if present
     and valid.
  2. Git clone of upstream (or the Chinese mirror) as fallback.
- Allocates a fresh install path under `defaultInstallDir()` —
  the legacy basePath is never moved.
- Carries `modelsDirs` from `extra_models_config.yaml` and
  telemetry consent (`Comfy-Desktop.SendStatistics`) into Desktop 2.0
  settings; existing user choice wins.
- Derives `launchArgs` from `comfy.settings.json`
  (`server_config.listen` / `server_config.port` / `extra_server_args`).
- Registers the new install with `adopted: true`, `adoptedBaseDir`,
  `adoptedPythonPath`, `adoptedSourceMode`, `useSharedPaths: false`,
  `autoUpdateComfyUI: false`.

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
- Pins ComfyUI to the legacy basePath via
  `--base-directory` / `--user-directory` / `--input-directory` /
  `--output-directory` CLI args so the user-editable `launchArgs` stays
  free of these structural paths.

Adopted records set `useSharedPaths: false`, so `launch.ts` also skips
its own `--input-directory` / `--output-directory` injection (no
duplicate args).

## What this design intentionally does NOT do

- No first-launch cutover splash or silent auto-adopt.
- No dedicated "Adopt in place" beta action or status pill.
- No side-by-side "adopt your legacy install" banner.
- No deferred Python-repair queue. A broken `.venv` either prompts the
  user to cancel/proceed during adoption or fails fast — repair is a
  separate user action afterward.
- No per-trigger orchestrator modes. `adoptDesktopInstall` takes one
  shape; the dispatcher decides everything else.
