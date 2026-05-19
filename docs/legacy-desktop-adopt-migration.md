# Legacy Desktop → Desktop 2.0 Adopt‑In‑Place Migration

> Status: **Plan / pre‑implementation.** Drives Phases 1–7 below.
>
> Replaces the existing "download a fresh standalone + restore snapshot" migration
> (see [`src/main/lib/desktopMigration.ts`](../src/main/lib/desktopMigration.ts)) with a
> single primitive — **adopt the existing legacy install in place** — that runs in
> two contexts: a user‑initiated beta action and a silent first‑launch action
> after the legacy app is replaced via ToDesktop.

---

## 1. Background

### 1.1 Why a new migration

Today's migration ([`desktopMigration.ts`](../src/main/lib/desktopMigration.ts) →
[`standaloneMigration.ts`](../src/main/lib/standaloneMigration.ts)) does the heaviest
possible thing:

1. Allocates a brand‑new directory under `~/ComfyUI-Installs/…`.
2. **Downloads** a ~1.5 GB standalone Python/torch tarball.
3. **Re‑installs** every pip package from the captured `pip freeze`.
4. **Re‑clones** every custom node.
5. **Copies** `user/`, `input/`, `output/` and registers `models/` as a shared dir.

This is the wrong shape for a forced auto‑update (where the user did not opt
into the migration) and even for the beta it has many high‑failure‑rate steps:
network downloads, mirror flakiness, pip resolves against the standalone Python
ABI, custom‑node post‑install scripts, and disk‑space doubling.

The new migration does almost none of this: it reuses the legacy `.venv` as
the Python environment, leaves all user data (`models`, `user`, `input`,
`output`, `custom_nodes`) untouched at the legacy `basePath`, and only
stages a fresh ComfyUI source checkout into a small new `installPath`.

### 1.2 Two delivery contexts (same primitive)

| Context | Trigger | UI |
|---|---|---|
| **Beta** | Desktop 2.0 beta detects a legacy install and exposes an "Adopt this install" action on the existing hidden [`desktop`](../src/main/sources/desktop.ts) source plugin. | Confirm dialog → progress phases → installation detail view. |
| **Cutover** | After the legacy `Comfy-Org/desktop` codebase is replaced with Desktop 2.0 source and shipped via ToDesktop, the next launch detects "I have legacy state but no installations record" and silently adopts. | One‑time "Welcome to Desktop 2.0" splash, no decisions required. |

Both call the same `adoptDesktopInstall()` orchestrator. Only the surrounding
chrome and prompt behavior differ.

### 1.3 The crucial source/data split in legacy desktop

Verified on a real Windows install:

- **App binary** at `%LOCALAPPDATA%\Programs\ComfyUI\ComfyUI.exe` — Electron
  bundle. The bundle also contains the **entire ComfyUI source** at
  `…\resources\ComfyUI\` (`main.py`, `comfy/`, `server.py`, `nodes.py`,
  `requirements.txt`, `comfyui_version.py`, …).
- **Electron `userData`** at `%APPDATA%\ComfyUI\` containing:
  - `config.json` — electron‑store of [`DesktopSettings`](../../desktop/src/store/desktopSettings.ts)
    (`basePath`, `installState`, `detectedGpu`, `selectedDevice`,
    `versionConsentedMetrics`, etc.).
  - `comfy.settings.json` — ComfyUI front‑end settings, including
    `Comfy-Desktop.AutoUpdate`, `Comfy-Desktop.SendStatistics`,
    `server_config.listen`, `server_config.port`, `extra_server_args`.
  - `extra_models_config.yaml` — YAML written by
    [`ComfyServerConfig`](../../desktop/src/config/comfyServerConfig.ts) holding
    one or more model base paths.
  - `window.json` — `AppWindowSettings` (size/position).
- **`basePath`** (default `~/Documents/ComfyUI` on Windows) is **data only**:
  `.venv/`, `models/`, `user/`, `input/`, `output/`, `custom_nodes/`, `temp/`.
  **No ComfyUI source.** The `.venv` is uv‑managed Python 3.12 (see
  [`virtualEnvironment.ts#L225`](../../desktop/src/virtualEnvironment.ts#L225))
  built against the bundle's `resources/ComfyUI/requirements.txt`.
- **No git anywhere**: legacy doesn't bundle git
  ([`installationManager.ts#L179`](../../desktop/src/install/installationManager.ts#L179)
  just prompts the user to install it), and `basePath` is **not** a git repo.
  ComfyUI source updates ride entirely on app updates — every ToDesktop
  release ships a new `resources/ComfyUI/`. Users never had write access to
  ComfyUI core files.

### 1.4 How legacy glues source to data

Legacy invokes the bundled ComfyUI with `basePath` injected via ComfyUI's own
CLI args
([`comfyServer.ts#L102-L113`](../../desktop/src/main-process/comfyServer.ts#L102-L113)):

```
<basePath>/.venv/Scripts/python.exe
  <appBundle>/resources/ComfyUI/main.py
  --base-directory   <basePath>
  --user-directory   <basePath>/user
  --input-directory  <basePath>/input
  --output-directory <basePath>/output
  --front-end-root   <appBundle>/resources/ComfyUI/web_custom_versions/desktop_app
  --extra-model-paths-config <userData>/extra_models_config.yaml
  --database-url     sqlite:///<basePath>/user/comfyui.db
  --listen ... --port ... --enable-manager  (etc.)
```

The implication for our plan: `installPath` and `basePath` don't have to be
the same place. We put ComfyUI source wherever Desktop 2.0 standalone
installs normally live, and pass `--base-directory <legacyBasePath>` (plus
its siblings) at launch.

### 1.5 Source sourcing — Strategy C (pre‑swap copy + post‑swap clone fallback)

The legacy bundle's `resources/ComfyUI/` disappears once the ToDesktop swap
replaces the bundle with Desktop 2.0 code. We need ComfyUI source available
to the adopted install regardless. Three options were considered; we adopt
**Strategy C**, which is the robust hybrid:

| Strategy | How | Pros | Cons |
|---|---|---|---|
| **A — Pre‑swap copy** | Final legacy release copies `resources/ComfyUI/` → `<staging>/legacy-comfyui-source/` at startup, **and** writes `basePath/.comfyui-legacy-version`. Adoption reads from the staged source. | No network at adopt time. Bit‑exact match with what user's `.venv` was built against. Offline‑capable. | Requires a final legacy‑repo release before the swap. ~100 MB extra disk during staging. |
| **B — Post‑swap git clone** | Final legacy release just writes `basePath/.comfyui-legacy-version`. Adoption clones the matching tag into `installPath/ComfyUI/` using Desktop 2.0's bootstrap pygit2. | Smaller disk footprint. Same code path Desktop 2.0 uses for updates. | Needs network at first launch after swap. Risk if exact commit isn't tag‑identifiable. |
| **C — Hybrid (chosen)** | Final legacy release does **both**: stages source AND writes version file. Adoption prefers the staged copy if present, falls back to git clone if not. | Robust to either path failing. Offline‑first. | Slightly more legacy‑release work. |

Staging location for Strategy C is `<userData>/legacy-staging/comfyui/` —
inside the legacy app's existing `userData` directory so the swap doesn't
clobber it (the bundle replacement only touches `resources/`, not
`userData`).

---

## 2. Shape of an adopted installation record

```ts
{
  id: 'inst-<ts>',
  sourceId: 'standalone',
  adopted: true,                          // routes a couple of launch fields
  installPath: '<~/ComfyUI-Installs/Adopted from Legacy Desktop>',  // NEW dir
  adoptedBaseDir: '<legacyBasePath>',     // e.g. ~/Documents/ComfyUI
  adoptedPythonPath: '<legacyBasePath>/.venv/Scripts/python.exe',
  adoptedFromLegacyVersion: '<legacy.package.json.version>',
  adoptedSourceMode: 'pre-swap-copy' | 'git-clone-fallback',
  adoptedAt: '<ISO>',
  releaseTag: 'legacy-adopted',           // synthetic for telemetry / UI badges
  variant: 'legacy-uv-py312',             // synthetic; indicates uv-managed 3.12
  pythonVersion: '3.12',
  version: '<comfyui_version.py value>',  // displayed in UI
  launchArgs: '<derived from legacy comfy.settings.json>',
  launchMode: 'window',
  browserPartition: 'unique',
  portConflict: 'auto',
  autoUpdateComfyUI: false,               // opt-in only; see §6
  useSharedPaths: false,                  // hybrid mode; see §3.3
  copiedFrom: 'legacy-desktop',
  copyReason: 'in-place-adoption',
  status: 'installed',
}
```

### 2.1 Disk layout after adoption

```
~/ComfyUI-Installs/Adopted from Legacy Desktop/      ← installPath  (~100 MB, NEW)
  ComfyUI/                                            ← fresh ComfyUI checkout
    main.py  comfy/  server.py  nodes.py  ...         (from pre-swap copy or git clone)
    .git/                                             ← present whenever adoptedSourceMode === 'git-clone-fallback'
                                                        and added on first successful update otherwise
  .comfyui-desktop-2                                  ← marker file with installId
  (no standalone-env/ — we reuse the legacy .venv)

~/Documents/ComfyUI/                                  ← basePath (UNTOUCHED)
  .venv/                                              ← Python; Desktop 2.0 never writes to this
  models/  user/  input/  output/  custom_nodes/      ← all data; never moved
  temp/
  .snapshots/legacy-adopted-<ts>.json                 ← forensic capture (see §4 step 6)
```

`basePath` is left exactly as the legacy app left it. ComfyUI itself reads
and writes `basePath/{user,input,output,models}` at runtime via the CLI args
in §2.3.

### 2.2 Adapter — minimal launch‑command patch

The standalone source's [`getLaunchCommand`](../src/main/sources/standalone/index.ts#L118-L135)
gets a small addition; no other path helpers change.

```ts
getLaunchCommand(inst): LaunchCommand | null {
  const pythonPath = inst.adopted
    ? (inst.adoptedPythonPath as string)
    : getActivePythonPath(inst)
  if (!pythonPath || !fs.existsSync(pythonPath)) return null

  const mainPy = path.join(inst.installPath, 'ComfyUI', 'main.py')
  if (!fs.existsSync(mainPy)) return null

  const userArgs = ((inst.launchArgs as string | undefined) ?? DEFAULT_LAUNCH_ARGS).trim()
  const parsed = userArgs.length > 0 ? parseArgs(userArgs) : []
  const port = extractPort(parsed)

  const adoptArgs = inst.adopted ? [
    '--base-directory',   inst.adoptedBaseDir as string,
    '--user-directory',   path.join(inst.adoptedBaseDir as string, 'user'),
    '--input-directory',  path.join(inst.adoptedBaseDir as string, 'input'),
    '--output-directory', path.join(inst.adoptedBaseDir as string, 'output'),
  ] : []

  return {
    cmd:  pythonPath,
    args: ['-s', path.join('ComfyUI', 'main.py'), ...adoptArgs, ...parsed],
    cwd:  inst.installPath,
    port,
  }
}
```

That's the entire `adopted: true` branching footprint inside the standalone
source. Custom‑node manager, snapshots, "open install folder", crash
recovery, and the update path all keep operating on `installPath/ComfyUI/`
which is a normal ComfyUI checkout.

### 2.3 Launch‑args derivation (from legacy `comfy.settings.json`)

User‑facing args (stored in the record's `launchArgs`):

```
launchArgs = [
  '--listen', server_config.listen ?? '127.0.0.1',
  '--port',   server_config.port   ?? '8000',
  '--enable-manager',                                       // legacy default
  ...flatten(extra_server_args)                             // user overrides
].join(' ')
```

Stored as one space‑separated string to match the standalone source's
existing `launchArgs` contract — the launch path already parses & extracts
the port via `parseArgs` / `extractPort`.

The `--base-directory`, `--user-directory`, `--input-directory`, and
`--output-directory` args are **not** stored in `launchArgs`; they're
appended by `getLaunchCommand` from the adopted record's
`adoptedBaseDir`. This keeps the user‑editable args clean and prevents the
user from accidentally breaking the data linkage by editing
"Launch arguments" in the UI.

---

## 3. Source mapping (legacy data → Desktop 2.0)

### 3.1 File‑level mapping

| Legacy file | Legacy key | → Desktop 2.0 target | Notes |
|---|---|---|---|
| `userData/config.json` | `basePath` | `installation.adoptedBaseDir` | Foundation; also seeds `--base-directory`. |
| `userData/config.json` | `selectedDevice` | telemetry | Display only ("RTX / CPU / MPS"). |
| `userData/config.json` | `detectedGpu` | telemetry | |
| `userData/config.json` | `windowStyle` | drop | Desktop 2.0 has its own window chrome. |
| `userData/config.json` | `versionConsentedMetrics` | drop | Re‑consent through Desktop 2.0's first‑use flow. |
| `userData/comfy.settings.json` | `server_config.listen` | `--listen <value>` in `launchArgs` | |
| `userData/comfy.settings.json` | `server_config.port` | `--port <value>` in `launchArgs` | Falls back to `8000`. |
| `userData/comfy.settings.json` | `Comfy-Desktop.SendStatistics` | Desktop 2.0 `settings.telemetryEnabled` | Only when not already set. |
| `userData/comfy.settings.json` | `Comfy-Desktop.AutoUpdate` | `installation.autoUpdateComfyUI` | Was wired to the *app* updater in legacy; in Desktop 2.0 it controls the **ComfyUI source** updater. Default `false`; see §6. |
| `userData/comfy.settings.json` | `extra_server_args` (object) | appended to `launchArgs` as `--key value` | Empty values stripped. |
| `userData/extra_models_config.yaml` | top‑level `basePath` model dirs | merged into `settings.modelsDirs` | Cross‑install visibility only — the adopted install reads them via `--base-directory`. See §3.3. |
| `userData/extra_models_config.yaml` | extra mounts (e.g. A1111 `base_path`) | merged into `settings.modelsDirs` | Same — cross‑install visibility for *other* installs. Per‑folder overrides ignored (matches standalone). |
| `basePath/models` | model folder | also appended to `settings.modelsDirs` | Cross‑install visibility only. The adopted install reads them via `--base-directory`. See §3.3. |
| `userData/window.json` | size/position | drop | Desktop 2.0 has [`windowState.ts`](../src/main/lib/windowState.ts). |
| `basePath/.venv` | uv‑managed Python 3.12 | `installation.adoptedPythonPath` | Used verbatim; never written to. |
| `basePath/{models,user,input,output,custom_nodes}` | data | left in place | No copy, no move, no symlink. |
| `basePath/extra_model_paths.yaml` (if present) | | left in place | ComfyUI still reads it on launch. |
| `<staging>/legacy-comfyui-source/` *or* GitHub | ComfyUI source | copied/cloned into `installPath/ComfyUI/` | Strategy C; see §1.5. |
| `basePath/.comfyui-legacy-version` | bundled ComfyUI version | resolves the git‑clone fallback ref | Written by final legacy release; read by adoption. |

### 3.2 ComfyUI source sourcing (Strategy C in detail)

At adoption time:

1. **Prefer staged copy.** If `<userData>/legacy-staging/comfyui/` exists and
   passes a sanity check (`main.py` present, `comfyui_version.py` matches
   `.comfyui-legacy-version`), copy it into `installPath/ComfyUI/`.
   `adoptedSourceMode = 'pre-swap-copy'`. No network needed.
2. **Otherwise, git clone.** Resolve the upstream tag/commit from
   `basePath/.comfyui-legacy-version` (or, as a last resort, by scanning
   `versionConsentedMetrics` from `config.json`). Shallow‑clone into
   `installPath/ComfyUI/` via Desktop 2.0's bootstrap pygit2 backend.
   `adoptedSourceMode = 'git-clone-fallback'`.
3. **If both fail**, surface a clear error with two options:
   - "Switch to managed Python environment" → runs the existing
     fresh‑standalone flow into `installPath/standalone-env/`, then deletes
     `installPath/ComfyUI/` and re‑extracts from the standalone tarball.
   - "Retry" → user can fix network/permissions and re‑run.

The staged copy is deleted from `<userData>/legacy-staging/` after a
successful adoption.

### 3.3 Coexistence with Desktop 2.0 shared paths (hybrid model)

Desktop 2.0 normally appends shared‑path args to every launch
([`launch.ts#L121-L140`](../src/main/lib/ipc/sessionActions/launch.ts#L121-L140)),
gated on `installation.useSharedPaths !== false`:

```ts
if (useSharedPaths) {
  launchCmd.args.push('--extra-model-paths-config', sharedYamlPath)
  launchCmd.args.push('--input-directory',  settings.inputDir)
  launchCmd.args.push('--output-directory', settings.outputDir)
}
```

Because argparse uses last‑wins, the relationship between an adopted
install's per‑install args and the shared‑path injection is set entirely
by the `useSharedPaths` flag on the record. Three behaviors are possible:

| | `useSharedPaths` | What `getLaunchCommand` appends | Net behavior |
|---|---|---|---|
| **A. Full shared** | `true` | `--base-directory`, `--user-directory` only | Adopted install uses Desktop 2.0 shared input/output/models. Requires copying legacy `basePath/{input,output}` → shared dirs to avoid hiding files. |
| **B. Full per‑install** | `false` | All four legacy paths | Pure adopt‑in‑place. Zero copies. Other installs can't see this user's models. |
| **C. Hybrid (chosen)** | `false` | All four legacy paths | Same launch behavior as B, **plus** `basePath/models` is appended to `settings.modelsDirs` so *other* installs can see those models. No files moved at adoption. |

The adopted record ships with **`useSharedPaths: false`** (matching the
legacy [`desktop`](../src/main/sources/desktop.ts#L42-L47) plugin's existing
`buildInstallation` default), so:

- `getLaunchCommand` appends `--base-directory`, `--user-directory`,
  `--input-directory`, `--output-directory` — all rooted at the legacy
  `basePath`.
- The shared‑path injection in `launch.ts` short‑circuits, so it never
  appends `--extra-model-paths-config` or its own `--input-directory` /
  `--output-directory` for the adopted install.
- `basePath/models` (plus any mounts from
  `userData/extra_models_config.yaml`) is appended to `settings.modelsDirs`
  purely for cross‑install visibility — future installs picking up shared
  paths see the user's models, while the adopted install itself reads
  them via `--base-directory`.

No files are moved at adoption time. Users who want to consolidate into
Desktop 2.0's shared dirs can do it manually later by copying files and
flipping `useSharedPaths` in settings.

---

## 4. The orchestrator: `adoptDesktopInstall()`

New file `src/main/lib/desktopAdopt.ts` exporting:

```ts
async function adoptDesktopInstall(opts: {
  trigger: 'beta-action' | 'first-launch-cutover'
  tools: AdoptTools
}): Promise<InstallationRecord>

interface AdoptTools {
  sendProgress: (phase: string, detail: Record<string, unknown>) => void
  sendOutput: (text: string) => void
  signal: AbortSignal
  promptUser: (kind: 'tcc' | 'venv-broken' | 'source-missing' | 'confirm-adopt', ctx?: unknown) => Promise<UserChoice>
}
```

### 4.1 Steps (all idempotent — safe to re‑run)

1. **Detect** the legacy install via [`detectDesktopInstall()`](../src/main/lib/desktopDetect.ts#L65-L97).
   Throw `no-legacy-install` if `null`.
2. **Marker check.** If `basePath/.comfyui-desktop-2` exists *and*
   `installations.list()` contains a matching record → return it (no‑op).
3. **Backup legacy state.** Copy
   `userData/{config.json,comfy.settings.json,extra_models_config.yaml,window.json}`
   → `userData/legacy-backup/<ts>/`. Best‑effort; logged on failure but never
   aborts.
4. **TCC pre‑prompt (macOS only).** Show a one‑step dialog explaining the
   upcoming OS prompt, then trigger it with a single
   `fs.readdir(basePath)`. On denial, present "Open System Settings → Privacy
   & Security" CTA and abort cleanly. (`assertReadable` already classifies
   the error.)
5. **Validate the legacy `.venv`.** Spawn `python -c "import sys, torch"` with
   a 30 s timeout. On failure, surface two recoverable options via
   `promptUser`:
   - *"Use this install anyway (Python will be repaired on next launch)"*
   - *"Cancel adoption"*

   Cutover mode picks *use anyway* automatically and queues a one‑time
   "Repair Python" task for next launch.
6. **Capture a forensic snapshot.** Reuse
   [`captureDesktopSnapshot()`](../src/main/lib/desktopDetect.ts#L152-L183) →
   write to `basePath/.snapshots/legacy-adopted-<ts>.json` with
   `skipPipSync: true`. Never restored unless the user explicitly clicks
   "Reset Python environment" later.
7. **Allocate `installPath`** under `defaultInstallDir()` (e.g.
   `~/ComfyUI-Installs/Adopted from Legacy Desktop`). Use `allocateUniqueDir`
   so re‑runs land at `… (1)`, `… (2)`, etc.
8. **Source ComfyUI** per §3.2 into `installPath/ComfyUI/`. On `source-missing`
   user choice "Switch to managed env" → defer to the existing fresh
   standalone flow and exit this orchestrator.
9. **Derive launch args** per §2.3.
10. **Write marker** `basePath/.comfyui-desktop-2` ← freshly minted `installId`.
11. **Carry settings** (modelsDirs from `extra_models_config.yaml`, telemetry
    consent if unset, theme, language).
12. **`installations.add(record)`** with the shape from §2.
13. **Telemetry**: `desktop2.adopt.{started,succeeded,failed}` with
    `{ trigger, legacy_version, adopted_source_mode, has_venv,
       has_extra_models_yaml, models_dir_count, custom_node_count, gpu,
       selected_device }`.
14. **Return** the record. UI navigates to the install detail view (beta) or
    closes the splash (cutover).

In cutover mode `promptUser` returns sensible defaults non‑interactively:
`tcc` → just trigger, `venv-broken` → `use-anyway`, `source-missing` →
`switch-to-managed`, `confirm-adopt` → `yes`.

---

## 5. Trigger A — Beta opt‑in action

Add the action **before** the existing `migrate-to-standalone` on the hidden
[`desktop`](../src/main/sources/desktop.ts) source plugin:

```ts
{
  id: 'adopt-in-place',
  label: t('desktop.adoptInPlace'),
  style: 'primary',
  showProgress: true,
  progressTitle: t('desktop.adopting'),
  confirm: {
    title: t('desktop.adoptConfirmTitle'),
    message: t('desktop.adoptConfirmMessage'),   // same data, same Python, ComfyUI source staged into a new managed dir
    confirmLabel: t('desktop.adoptConfirm'),
  },
}
```

`handleAction('adopt-in-place', …)` calls
`adoptDesktopInstall({ trigger: 'beta-action', tools })`.

The existing `migrate-to-standalone` action stays as a "fresh standalone"
fallback, moved under an "Advanced" submenu for users who explicitly want a
clean Python environment.

---

## 6. Trigger B — Cutover silent first‑launch

In [`src/main/index.ts`](../src/main/index.ts), early after `app.whenReady()`:

```ts
const cutoverDone   = settings.get('legacyCutoverCompleted') === true
const haveLegacy    = fs.existsSync(path.join(app.getPath('userData'), 'config.json'))
const haveInstalls  = (await installations.list()).length > 0
const isCutoverRun  = !cutoverDone && haveLegacy && !haveInstalls && detectDesktopInstall() != null

if (isCutoverRun) {
  await showCutoverSplash()                          // "Welcome to Desktop 2.0"
  await adoptDesktopInstall({ trigger: 'first-launch-cutover', tools: silentTools })
  settings.set('legacyCutoverCompleted', true)
}
```

- `showCutoverSplash()` is a one‑time modal: brand, "your existing install is
  being adopted", a single TCC pre‑prompt on Mac, and a "Continue" button.
- On failure, the splash flips into an error view with "Retry" + "Open Logs"
  CTAs. The user is never stranded on a blank app.
- **If `installations.json` already has entries** (the user had Desktop 2.0
  beta installed side‑by‑side), the silent adopt is **skipped** and a banner
  on the dashboard offers "We noticed your legacy install — adopt now?"
  instead.

---

## 7. ComfyUI updates after adoption

Because `installPath/ComfyUI/` is a normal git checkout (either cloned at
adoption time via Strategy C fallback, or upgraded to one on the first
successful update from the pre‑swap copy), Desktop 2.0's existing
ComfyUI‑update path **works out of the box**:

- `git fetch` + `git reset --hard <tag>` against `installPath/ComfyUI/`.
- `basePath` is never touched.
- User data (`models`, `user`, `input`, `output`, `custom_nodes`, `.venv`) is
  unaffected — none of it lives inside `installPath/ComfyUI/`.
- Users never had write access to ComfyUI core files in legacy desktop
  (those files lived inside the app bundle, replaced wholesale on every app
  update), so a hard reset is the *exact* historical behavior — no diff
  consent dialog needed.

The single concern is the `'pre-swap-copy'` case: it has no `.git/` until
the first update. On the first "Update ComfyUI" click we:

1. `git init` in `installPath/ComfyUI/` with per‑repo
   `core.autocrlf=false`, `core.fileMode=false`.
2. `git remote add origin <upstream>`.
3. `git fetch --depth=1 origin tag <target>`.
4. `git reset --hard <target>` — safe because the existing files came from
   the exact bundled snapshot.
5. Verify clean `git status`; if dirty (line‑ending churn etc.) the
   reset is repeated with `--quiet --no-verify`. If still dirty, surface a
   warning and offer "Switch to managed environment" as a fallback.

After that first update, future updates are vanilla `fetch` + `reset`.

`autoUpdateComfyUI` defaults to `false` on adoption to give the user one
deliberate opt‑in; we don't auto‑trigger an update on first launch.

---

## 8. Cutover‑release prerequisites (changes to the **legacy** repo)

Before swapping the legacy ToDesktop build payload to Desktop 2.0:

1. **Final legacy release must implement Strategy C staging.** At startup,
   the final legacy build:
   - Copies its own `resources/ComfyUI/` → `<userData>/legacy-staging/comfyui/`.
   - Reads `comfyui_version.py` and writes `basePath/.comfyui-legacy-version`
     containing the upstream ref string (tag or commit).
   - Both steps are idempotent and best‑effort; failure logs a warning but
     does not block launch.
   - This is the **hard blocker** for the swap. Without it, post‑swap users
     have no offline path to ComfyUI source.
2. **Keep `productName: "ComfyUI"`** in the cutover build's `package.json`
   only, so `app.getPath('userData')` resolves to the existing legacy dir.
   (Internal `name` can stay `comfyui-desktop-2` — Electron prefers
   `productName` when packaged.)
3. **Final legacy release** also sets
   `updateReadyAction.showNotification: 'never'` in `todesktop.init()` so
   the swap installs silently on next launch.
4. **Bundle `@todesktop/runtime` in the cutover build** so the *first* run
   after the swap still has ToDesktop alive for a rollback push. Disable
   proactive behavior (`autoUpdater: false`). A later release strips the
   dep entirely.
5. **Tag the cutover build distinctly** (e.g. `v0.6.0-legacy-cutover`) and
   detect it at runtime via a feature flag so we can surface different
   welcome copy and capture targeted telemetry.

---

## 9. Testing matrix

| Scenario | Beta mode | Cutover mode |
|---|---|---|
| Fresh legacy install, default `basePath` (Documents) | manual click → adopt | first launch → silent adopt |
| Legacy `basePath` on external volume | TCC prompt for the volume | same |
| Legacy install with broken `.venv` | "use anyway" path surfaced | "use anyway" auto, queue repair |
| Pre‑swap staged source present | uses staged copy (`pre-swap-copy`) | uses staged copy (`pre-swap-copy`) |
| Pre‑swap staged source missing but network OK | git clone fallback (`git-clone-fallback`) | git clone fallback |
| Pre‑swap staged source missing AND offline | "Switch to managed env" CTA | error splash; retry/open‑logs CTAs |
| Legacy `comfy.settings.json` with custom port `8188` | adopted record has `--port 8188` in `launchArgs` | same |
| Legacy `extra_models_config.yaml` with extra A1111 mount | mount added to `modelsDirs` | same |
| User had Desktop 2.0 beta previously (non‑empty `installations.json`) | adopt adds new record | **skip** silent adopt; show dashboard banner |
| Re‑run adoption | no‑op, returns existing record | no‑op, returns existing record |
| Adoption fails at step 5 (Python validation) | UI surfaces error, no record created | splash shows retry CTA |
| Mac TCC denied | clean error, link to System Settings | same |
| Legacy `basePath` moved/renamed since legacy last ran | detect returns `null`, action greyed out | splash explains, offers "Locate folder" |
| First "Update ComfyUI" after adoption (pre‑swap‑copy mode) | runs §7 git‑init flow | same |

Unit tests in `src/main/lib/desktopAdopt.test.ts` cover marker / no‑op /
settings‑mapping logic and the Strategy C decision matrix. Integration
tests under `e2e/` stage a fake legacy `basePath` + `userData/config.json` +
`legacy-staging/` and assert the resulting installation record + launch
args + `modelsDirs` + on‑disk layout.

---

## 10. Phasing

| Phase | Scope | Effort | Ship target |
|---|---|---|---|
| **1 — Adapter layer** | `adopted: true` launch‑command patch in [`standalone/index.ts`](../src/main/sources/standalone/index.ts) + tests. Pure additive change. | ~0.5 day | internal |
| **2 — Orchestrator** | `desktopAdopt.ts` + settings carry‑over + marker + snapshot capture + Strategy C source sourcing + tests. | ~2.5 days | internal |
| **3 — Beta UI** | `adopt-in-place` action on the [`desktop`](../src/main/sources/desktop.ts) plugin, confirm dialog, progress phases, "Switch to managed env" fallback CTA. | ~1 day | **next beta drop** |
| **4 — Cutover first‑launch** | Detection + splash + silent run + post‑adopt navigation. Gated behind `COMFY_ENABLE_LEGACY_CUTOVER=1`. | ~1.5 days | internal |
| **5 — Legacy repo prep** | Final legacy release with Strategy C staging + `.comfyui-legacy-version` write + `showNotification: 'never'`. **Hard blocker for the swap.** | ~1.5 days | coordinated with legacy repo |
| **6 — Cutover release** | Build Desktop 2.0 with `productName: "ComfyUI"`, ship into the legacy ToDesktop app id. Monitor `desktop2.adopt.*` telemetry. | ~0.5 day | **cutover release** |
| **7 — Cleanup** | Drop `@todesktop/runtime` from Desktop 2.0; deprecate the `desktop` legacy source after telemetry confirms <1 % of users still hit it. | ~1 day | post‑cutover |

**Beta‑usable:** end of Phase 3 (~4 days).
**Cutover‑ready:** end of Phase 6 (~7 days), of which ~1.5 days is in the
legacy repo.

---

## 11. Open questions

- **What do we do when the user has multiple legacy `basePath`s over time?**
  Only the most recent (from `config.json`) is adopted; older orphans are
  invisible. We could expose a "Locate other ComfyUI folders" flow later.
- **Should the silent cutover still show a splash on Windows where TCC
  isn't a concern?** Plan currently says yes for parity and so users notice
  the rebrand; revisit if it feels intrusive.
- **`Comfy-Desktop.AutoUpdate` ON in legacy** — do we honor it (silently
  start ComfyUI source updates the first time the adopted install is
  launched) or always require explicit re‑opt‑in? Lean toward re‑opt‑in for
  safety.
- **Pre‑swap staging location** — `<userData>/legacy-staging/` lives in the
  same dir Desktop 2.0 will own after the swap. Confirm this survives any
  electron‑store migrations Desktop 2.0 runs on first launch (it should:
  staging is a plain dir, not an electron‑store key).
