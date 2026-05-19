# Legacy Desktop → Desktop 2.0 Adopt‑In‑Place Migration

> Status: **Plan / pre‑implementation.** Drives Phases 1–7 below.
>
> Replaces the existing "download a fresh standalone + restore snapshot" migration
> (see [`src/main/lib/desktopMigration.ts`](../src/main/lib/desktopMigration.ts)) with a
> single primitive — **adopt the existing `basePath` in place** — that runs in two
> contexts: a user‑initiated beta action and a silent first‑launch action after
> the legacy app is replaced via ToDesktop.

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

The new migration **does none of this**: it leaves every file in place, reuses
the existing `.venv`, and just registers the install as a Desktop 2.0–managed
record with a small `adopted: true` flag.

### 1.2 Two delivery contexts (same primitive)

| Context | Trigger | UI |
|---|---|---|
| **Beta** | Desktop 2.0 beta detects a legacy install and exposes an "Adopt this install" action on the existing hidden [`desktop`](../src/main/sources/desktop.ts) source plugin. | Confirm dialog → progress phases → installation detail view. |
| **Cutover** | After the legacy `Comfy-Org/desktop` codebase is replaced with Desktop 2.0 source and shipped via ToDesktop, the next launch detects "I have legacy state but no installations record" and silently adopts. | One‑time "Welcome to Desktop 2.0" splash, no decisions required. |

Both call the same `adoptDesktopInstall()` orchestrator. The only difference is
how `promptUser` resolves and what the surrounding chrome looks like.

### 1.3 What the legacy app actually looks like on disk

Verified on a real Windows install:

- **App binary**: `%LOCALAPPDATA%\Programs\ComfyUI\ComfyUI.exe` (Electron bundle,
  no git, no Python).
- **Electron `userData`**: `%APPDATA%\ComfyUI\` containing:
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
- **`basePath`** (default `~/Documents/ComfyUI` on Windows): **flat** ComfyUI
  layout, **not** a git checkout. Contains `main.py`, `models/`, `user/`,
  `input/`, `output/`, `custom_nodes/`, `.venv/`. The `.venv` is uv‑managed
  Python 3.12 (see [`virtualEnvironment.ts#L225`](../../desktop/src/virtualEnvironment.ts#L225)).
- **No git**: legacy doesn't bundle git; it prompts the user to install it from
  `git-scm.com` if not on PATH (see
  [`installationManager.ts#L179`](../../desktop/src/install/installationManager.ts#L179)).
  More importantly, `basePath` itself is **not a git repo** — ComfyUI was
  extracted from bundled assets, not cloned.

### 1.4 What Desktop 2.0 expects

A standalone install record has:

- `installPath/ComfyUI/` for the ComfyUI source.
- `installPath/standalone-env/` for the prebuilt Python tarball.
- `.comfyui-desktop-2` marker file at `installPath`.
- `installations.json` entry with `sourceId: 'standalone'`, `releaseTag`,
  `variant`, `version`, `launchArgs`, `launchMode`, etc.

The adopted record reuses the same `standalone` source plugin but flips a flag
so launch helpers and path joins reach into the legacy flat layout instead of
the standard one.

---

## 2. Shape of an adopted installation record

```ts
{
  id: 'inst-<ts>',
  sourceId: 'standalone',
  adopted: true,                          // routes path helpers to legacy layout
  installPath: '<legacyBasePath>',        // flat, NOT <…>/ComfyUI
  adoptedPythonPath: '<legacyBasePath>/.venv/Scripts/python.exe',  // verbatim
  adoptedFromLegacyVersion: '<legacy.package.json.version>',
  adoptedAt: '<ISO>',
  releaseTag: 'legacy-adopted',           // synthetic for telemetry / UI badges
  variant: 'legacy-uv-py312',             // synthetic; indicates uv-managed 3.12
  pythonVersion: '3.12',
  version: 'Legacy Desktop',              // displayed in UI
  launchArgs: '<derived from legacy comfy.settings.json>',
  launchMode: 'window',
  browserPartition: 'unique',
  portConflict: 'auto',
  autoUpdateComfyUI: false,               // see §6 — disabled until git re-init
  comfyUIUpdatesBlocked: true,            // surfaced as a banner in the UI
  copiedFrom: 'legacy-desktop',
  copyReason: 'in-place-adoption',
  status: 'installed',
}
```

### 2.1 Adapter helpers (Phase 1)

Add to [`src/main/sources/standalone/envPaths.ts`](../src/main/sources/standalone/envPaths.ts):

```ts
export function getComfyUIDir(inst: InstallationRecord): string {
  return inst.adopted
    ? inst.installPath                                 // flat layout
    : path.join(inst.installPath, 'ComfyUI')
}

export function getActivePythonPath(inst: InstallationRecord): string | null {
  if (inst.adopted) {
    const p = inst.adoptedPythonPath as string | undefined
    return p && fs.existsSync(p) ? p : findLegacyVenvPython(inst.installPath)
  }
  return path.join(getVenvDir(inst.installPath), …existing…)
}
```

Then route every consumer (launch, custom‑node manager, snapshot capture,
crash recovery, "open install folder", etc.) through these helpers. The
existing standalone source's [`getLaunchCommand`](../src/main/sources/standalone/index.ts#L118-L135)
becomes a one‑line change: replace the hardcoded `path.join(installation.installPath, 'ComfyUI', 'main.py')`
with `path.join(getComfyUIDir(installation), 'main.py')`.

---

## 3. Source mapping (legacy data → Desktop 2.0)

| Legacy file | Legacy key | → Desktop 2.0 target | Notes |
|---|---|---|---|
| `userData/config.json` | `basePath` | `installation.installPath` | Foundation. |
| `userData/config.json` | `selectedDevice` | `installation.variant` hint, telemetry | Display only ("RTX / CPU / MPS"). |
| `userData/config.json` | `detectedGpu` | telemetry only | |
| `userData/config.json` | `windowStyle` | drop | Desktop 2.0 has its own window chrome. |
| `userData/config.json` | `versionConsentedMetrics` | drop | Re‑consent through Desktop 2.0's first‑use flow. |
| `userData/comfy.settings.json` | `server_config.listen` | `--listen <value>` in `launchArgs` | |
| `userData/comfy.settings.json` | `server_config.port` | `--port <value>` in `launchArgs` | Falls back to `8000`. |
| `userData/comfy.settings.json` | `Comfy-Desktop.SendStatistics` | Desktop 2.0 `settings.telemetryEnabled` | Only carried when not already set. |
| `userData/comfy.settings.json` | `Comfy-Desktop.AutoUpdate` | `installation.autoUpdateComfyUI` | Was wired to the *app* updater in legacy; in Desktop 2.0 it controls the **ComfyUI source** updater. Kept `false` until the git‑repo question (§6) is resolved per install. |
| `userData/comfy.settings.json` | `extra_server_args` (object) | appended to `launchArgs` as `--key value` | Empty values stripped. |
| `userData/extra_models_config.yaml` | top‑level `basePath` model dirs | merged into `settings.modelsDirs` | De‑duped and resolved against `~`. |
| `userData/extra_models_config.yaml` | extra mounts (e.g. A1111 `base_path`) | merged into `settings.modelsDirs` | Each subtree's base_path added; per‑folder overrides ignored (matches standalone). |
| `userData/window.json` | size/position | drop | Desktop 2.0 has [`windowState.ts`](../src/main/lib/windowState.ts). |
| `basePath/.venv` | uv‑managed Python 3.12 | `installation.adoptedPythonPath` | Used verbatim; never written to. |
| `basePath/{models,user,input,output,custom_nodes}` | data | left in place | No copy, no move, no symlink. |
| `basePath/extra_model_paths.yaml` (if present) | | left in place | ComfyUI still reads it on launch. |

### 3.1 Launch‑args derivation

```
launchArgs = [
  '--listen', server_config.listen ?? '127.0.0.1',
  '--port',   server_config.port   ?? '8000',
  '--enable-manager',                                       // legacy default
  ...flatten(extra_server_args)                             // user overrides
].join(' ')
```

Stored as one space‑separated string to match the standalone source's existing
`launchArgs` contract. The launch path already parses & extracts the port via
`parseArgs` / `extractPort`
([`standalone/index.ts#L118-L135`](../src/main/sources/standalone/index.ts#L118-L135)),
so no extra parser work is needed.

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
  promptUser: (kind: 'tcc' | 'venv-broken' | 'confirm-adopt', ctx?: unknown) => Promise<UserChoice>
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
   `fs.readdir(basePath)`. On denial, present "Open System Settings → Privacy &
   Security" CTA and abort cleanly. (`assertReadable` already classifies the
   error.)
5. **Validate the legacy `.venv`.** Spawn `python -c "import sys, torch"` with
   a 30 s timeout. On failure, surface two recoverable options via `promptUser`:
   - *"Use this install anyway (Python will be repaired on next launch)"*
   - *"Cancel adoption"*

   Cutover mode picks *use anyway* automatically and queues a one‑time
   "Repair Python" task for next launch.
6. **Capture a forensic snapshot.** Reuse
   [`captureDesktopSnapshot()`](../src/main/lib/desktopDetect.ts#L152-L183) →
   write to `basePath/.snapshots/legacy-adopted-<ts>.json` with
   `skipPipSync: true`. Never restored unless the user explicitly clicks
   "Reset Python environment" later.
7. **Derive launch args** per §3.1.
8. **Write marker.** `basePath/.comfyui-desktop-2` ← freshly minted `installId`.
9. **Carry settings** (modelsDirs from `extra_models_config.yaml`, telemetry
   consent if unset, theme, language).
10. **`installations.add(record)`** with the shape from §2.
11. **Telemetry**: `desktop2.adopt.{started,succeeded,failed}` with
    `{ trigger, legacy_version, has_venv, has_extra_models_yaml, models_dir_count,
       custom_node_count, gpu, selected_device }`.
12. **Return** the record. UI navigates to the install detail view (beta) or
    closes the splash (cutover).

In cutover mode `promptUser` returns sensible defaults non‑interactively:
`tcc` → just trigger, `venv-broken` → `use-anyway`, `confirm-adopt` → `yes`.

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
    message: t('desktop.adoptConfirmMessage'),   // same files, same Python, just registered
    confirmLabel: t('desktop.adoptConfirm'),
  },
}
```

`handleAction('adopt-in-place', …)` calls `adoptDesktopInstall({ trigger: 'beta-action', tools })`.

The existing `migrate-to-standalone` action stays as a "fresh standalone"
fallback, moved under an "Advanced" submenu for users who explicitly want a
clean Python environment.

---

## 6. Trigger B — Cutover silent first‑launch

In [`src/main/index.ts`](../src/main/index.ts), early after `app.whenReady()`:

```ts
const cutoverDone = settings.get('legacyCutoverCompleted') === true
const haveLegacyState = fs.existsSync(path.join(app.getPath('userData'), 'config.json'))
const haveInstalls = (await installations.list()).length > 0
const isCutoverFirstLaunch =
  !cutoverDone && haveLegacyState && !haveInstalls && detectDesktopInstall() != null

if (isCutoverFirstLaunch) {
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

## 7. ComfyUI updates after adoption (the git story)

Desktop 2.0 updates ComfyUI by running git fetch/checkout against
`installPath/ComfyUI/`. Legacy `basePath` is **not** a git repo, and the
adopted install reuses `basePath` directly.

Two acceptable behaviors; we ship (a) initially and add (b) when bandwidth
allows:

**a) Block ComfyUI updates for adopted installs (Phase 3 default).**
- Set `autoUpdateComfyUI: false` and `comfyUIUpdatesBlocked: true` on the
  record.
- UI shows a banner: "ComfyUI auto‑update is disabled for adopted installs.
  Switch to a managed Python environment to enable it."
- The "Switch to managed standalone" CTA runs the existing fresh‑standalone
  flow, then deletes the adopted record. Opt‑in, never automatic.

**b) Re‑init the basePath as a git repo (Phase 7 follow‑up).**
- Run `git init`, fetch the upstream tag matching the bundled legacy
  ComfyUI version, `git reset --hard <tag>`, leaving the working tree
  untouched (custom nodes, models, user data, .venv all unaffected).
- Uses Desktop 2.0's [bootstrap pygit2](../src/main/lib/ipc) — works even
  when system git is absent.
- Risks: a divergent ComfyUI version (legacy might have patched files,
  or the bundled snapshot may not match a clean tag), so we gate this
  behind a confirmation dialog and only when the diff to the matching tag
  is empty.

Implementing (a) in Phase 3 lets us ship adopt‑in‑place without solving the
git story; (b) lifts the constraint cleanly later.

---

## 8. Cutover‑release prerequisites (changes to the **legacy** repo, not this one)

Before swapping the legacy ToDesktop build payload to Desktop 2.0:

1. **Keep `productName: "ComfyUI"`** in the cutover build's `package.json`
   only, so `app.getPath('userData')` resolves to the existing legacy dir.
   (Internal `name` can stay `comfyui-desktop-2` — Electron prefers
   `productName` when packaged.)
2. **Final legacy release** (one before the swap): set
   `updateReadyAction.showNotification: 'never'` in `todesktop.init()` so the
   swap installs silently on next launch.
3. **Bundle `@todesktop/runtime` in the new build** so the *first* run after
   the swap still has ToDesktop alive for a rollback push. Disable proactive
   behavior (`autoUpdater: false`). A later release strips the dep entirely.
4. **Tag the cutover build distinctly** (e.g. `v0.6.0-legacy-cutover`) and
   detect it at runtime via a feature flag so we can surface different
   welcome copy and capture targeted telemetry.

---

## 9. Testing matrix

| Scenario | Beta mode | Cutover mode |
|---|---|---|
| Fresh legacy install, default `basePath` (Documents) | manual click → adopt | first launch → silent adopt |
| Legacy `basePath` on external volume | TCC prompt for the volume | same |
| Legacy install with broken `.venv` | "use anyway" path surfaced | "use anyway" auto, queue repair |
| Legacy `comfy.settings.json` with custom port `8188` | adopted record has `--port 8188` | same |
| Legacy `extra_models_config.yaml` with extra A1111 mount | mount added to `modelsDirs` | same |
| User had Desktop 2.0 beta previously (non‑empty `installations.json`) | adopt adds new record | **skip** silent adopt; show dashboard banner |
| Re‑run adoption | no‑op, returns existing record | no‑op, returns existing record |
| Adoption fails at step 5 (Python validation) | UI surfaces error, no record created | splash shows retry CTA |
| Mac TCC denied | clean error, link to System Settings | same |
| Legacy `basePath` already moved/renamed | detect returns `null`, action greyed out | splash explains, offers "Locate folder" |

Unit tests in `src/main/lib/desktopAdopt.test.ts` cover marker / no‑op /
settings‑mapping logic. Integration tests under `e2e/` stage a fake legacy
`basePath` + `userData/config.json` and assert the resulting installation
record + launch args + `modelsDirs`.

---

## 10. Phasing

| Phase | Scope | Effort | Ship target |
|---|---|---|---|
| **1 — Adapter layer** | `adopted: true` branching in [`envPaths.ts`](../src/main/sources/standalone/envPaths.ts) + [`standalone/index.ts`](../src/main/sources/standalone/index.ts). Pure refactor, fully unit‑tested. | ~1 day | internal |
| **2 — Orchestrator** | `desktopAdopt.ts` + settings carry‑over + marker + snapshot capture + tests. | ~2 days | internal |
| **3 — Beta UI** | `adopt-in-place` action on the [`desktop`](../src/main/sources/desktop.ts) plugin, confirm dialog, progress phases, "ComfyUI updates blocked" banner. | ~1 day | **next beta drop** |
| **4 — Cutover first‑launch** | Detection + splash + silent run + post‑adopt navigation. Gated behind `COMFY_ENABLE_LEGACY_CUTOVER=1`. | ~1.5 days | internal |
| **5 — Legacy repo prep** | `showNotification: 'never'` release, ToDesktop slot coordination. | ~0.5 day | coordinated with legacy repo |
| **6 — Cutover release** | Build Desktop 2.0 with `productName: "ComfyUI"`, ship into the legacy ToDesktop app id. Monitor `desktop2.adopt.*` telemetry. | ~0.5 day | **cutover release** |
| **7 — Cleanup & enable ComfyUI updates** | Drop `@todesktop/runtime` from Desktop 2.0; ship git re‑init flow (§7b); deprecate the `desktop` legacy source after telemetry confirms <1 % of users still hit it. | ~2 days | post‑cutover |

**Beta‑usable:** end of Phase 3 (~4 days).
**Cutover‑ready:** end of Phase 6 (~6 days).

---

## 11. Open questions

- **Adopt the `basePath` model dirs into `settings.modelsDirs`, or *only* keep
  them attached to the adopted install?** Today's plan goes with the former
  (shared across all installs) for consistency with the existing fresh‑install
  migration. Worth confirming with product.
- **What do we do when the user has multiple legacy `basePath`s over time?**
  Only the most recent (from `config.json`) is adopted; older orphans are
  invisible. We could expose a "Locate other ComfyUI folders" flow later.
- **Should the silent cutover still show a splash on macOS, where it's already
  needed for the TCC prompt anyway?** Plan currently says yes; consider a
  shorter Windows splash too for parity.
- **`Comfy-Desktop.AutoUpdate` ON in legacy** — do we honor it (silently
  start ComfyUI source updates the first time the adopted install is launched
  after Phase 7b lands) or always require explicit re‑opt‑in? Lean toward
  re‑opt‑in for safety.
