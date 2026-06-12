# Starter Templates — Engineering Reference

> **What it does:** when a user picks a starter ComfyUI template during install, they land on a **ready-to-run** canvas — the template auto-opens *and* its required models were pre-downloaded — instead of a blank canvas or "missing model X" errors.

This is the durable, in-repo record of the feature: its architecture, the decisions behind it, the edge-case dispositions, and how it's tested. It's the source of truth — keep it in sync when you change the feature.

**Status:** shipped on `feat/starter-templates`. Logic + UI complete; full unit/component suite + all typechecks + eslint green. The only thing that can't be covered headlessly — a live `pnpm dev` pass over the [human-review matrix](#human-review-matrix) — is the manual gate before merge.

---

## How it works (mental model)

The feature spans two flows — **pick at install** and **download + open at launch** — built on three cleanly separated layers:

1. **Task** ([templateDownloadTask.ts](../src/main/sources/standalone/templateDownloadTask.ts)) — owns bytes + logs; the **sole writer** of a process-global state `Map` keyed by `installationId`. Hot path (the per-chunk `download()` callback) is counter-only.
2. **Core** ([templateDownloadCore.ts](../src/main/sources/standalone/templateDownloadCore.ts)) — pure math/formatting/decisions; unit-tested; no Electron.
3. **Reader** (the 500 ms poll in [launch.ts](../src/main/lib/ipc/sessionActions/launch.ts)) — turns state → stepper substatus.

They communicate **only** through `getTemplateDownloadState()`. Rule of thumb: change *progress display* → touch the reader/core; change *what/how downloads* → touch the task.

### Pick at install

- The standalone source exposes a `bundledTemplate` field ([bundledTemplates.ts](../src/main/sources/standalone/bundledTemplates.ts)): one verified showcase per modality — Image `flux_schnell`, Video `text_to_video_wan`, Audio `audio_stable_audio_example`, 3D `3d_hunyuan3d_image_to_model`. Title/description/size/VRAM are copied verbatim from the live template index.
- A dedicated picker step ([TemplatePickerStep.vue](../src/renderer/src/components/TemplatePickerStep.vue)) renders after Configure in [InstallWizardModal.vue](../src/renderer/src/views/InstallWizardModal.vue). See [Picker UI](#picker-ui).
- The pick is persisted as `bundledTemplateId` + a one-shot `pendingTemplateOpen` (`buildInstallation` in [index.ts](../src/main/sources/standalone/index.ts)). On first launch [attach.ts](../src/main/host/attach.ts) appends `?template=<id>&source=default` to the comfy URL — the frontend's existing `useTemplateUrlLoader` opens it, **zero frontend changes**. The one-shot is cleared (`clearPendingTemplateOpen`) so relaunches start blank.

### Download + open at launch

- **Resolution:** [templateModels.ts](../src/main/sources/standalone/templateModels.ts) `resolveTemplateModels()` reads the template's workflow JSON (install-tree site-packages first — probing all `…_media_<modality>` sub-packages — then GitHub-raw fallback via the Electron `net.request` helper `fetchJSON`), scans top-level + node-level + subgraph `models[]`, whitelists hosts (HF/Civitai), strips query params, dedupes `(directory, name)`.
- **Starts at install-begin** ([registerInstallationHandlers.ts](../src/main/lib/ipc/registerInstallationHandlers.ts)) so bytes overlap env setup — `startTemplateDownload(inst, sizeBytes, { sendOutput })`, fire-and-forget.
- **Shown as the LAST launch phase.** `template-models` is appended after `startingServer` ([launchPhases.ts](../src/main/lib/launchPhases.ts)); the reader paces its substatus (speed, ETA, file N-of-M, cumulative GB). See [Stepper ordering + launch gate](#stepper-ordering--launch-gate).
- **Logs:** per-file start / every-10% / finish lines stream into "View logs" (`comfy-output` + the durable `appendLog` ring buffer, seeded into the launch op via `logs-snapshot` so install-leg lines survive the span boundary), and mirror to the main-process console as `[templateDownload:<id>]`.

### Performance contract

- **Hot-path/reader split** — the per-chunk callback does only O(1) counter writes (no strings/i18n/IPC); a single 500 ms reader owns all formatting + emits, so display cadence is decoupled from download speed.
- **Bounded-concurrency pool** (`runPool`, cap 3) — saturates the link; rolling, so one big file can't head-of-line-block.

---

## Picker UI

[TemplatePickerStep.vue](../src/renderer/src/components/TemplatePickerStep.vue) — a **compact selectable row list** (reuses `brand-variant-list`):

- Each row: bundled thumbnail (40×40, modality-glyph fallback on `@error`) + title (+ "Recommended" tag on the first/Image row) + a meta line `modality · ~size · VRAM ~x`. The **description expands inside the selected row** (CSS `grid-template-rows 0fr→1fr`); unselected rows stay terse.
- **Full keyboard nav** — `role="radiogroup"`/`radio`/`aria-checked`; Arrow/Home/End move + select.
- **No "None" tile, no consent toggle** — the host footer's **"Skip & Install"** is the blank-canvas / no-download path. Choosing a template always pre-downloads (`buildInstallation` derives `downloadTemplateModels: true` from the template id; the renderer syncs no separate consent field).
- **Thumbnails bundled in-repo** (`src/renderer/public/images/templates/<id>.webp`, served at `./images/templates/<id>.webp`) — **not** fetched remotely, because the renderer CSP (`img-src 'self' data:`) blocks remote images and a first-ever user has no local template package yet. Each is a downscaled (~600 px, ~6–33 KB) representative frame from the template's animated `-1.webp` preview.

### Live resource gating

- **Disk hard-block.** The picker compares free disk vs the selected template's model size **as you select**, shows an inline error, and the host's **Install button is disabled** while blocked (no "continue anyway"). All three disk checks — picker alert, disabled-Install, and the save-time hard gate `checkTemplateDiskOrBlock` — call the **one shared pure decision** `isTemplateDiskBlocked(diskSpace, modelBytes)` in [installHelpers.ts](../src/renderer/src/lib/installHelpers.ts), so they can't drift. The disk helper chain there: `templateDiskRequiredBytes` (size × 1.1 headroom) → `isTemplateDiskBlocked` (the shared boolean) → `checkTemplateDiskOrBlock` (the async save-time alert+gate).
- **VRAM warn-but-allow.** Warns (amber, never blocks) when `detectedVramBytes < recommendedVramBytes`; **silent** when VRAM is unknown (AMD/Intel/undetected — never false-warns). VRAM comes from `detectGPU().vramBytes` (nvidia-smi → `os.totalmem()` for Apple `mps` → `systeminformation` fallback), fetched on wizard open.

### Entry points & gating

- Dashboard "Add New Instance" reuses the same `InstallWizardModal` → inherits the step for free.
- **Express Install** picks the `recommended` option, which is the `none` sentinel → installs with no template + no picker by construction (intentional; no extra guard).
- `skipTemplatePickerStep` setting + a **"Don't show again"** checkbox shown only when `getInstallationsSummary().localCount > 0`; persisted on Install/Skip. Opted-out returning users skip the step (`shouldShowPickerStep` false → Continue installs directly).

---

## Stepper ordering + launch gate

`template-models` is the **last** launch phase. Two mechanisms keep that honest:

1. **`serverUp`-gated reader.** The bar derives "prior steps done" from the active phase *index* (`progressStore.globalProgressFor`). If the always-on 500 ms reader emitted `template-models` (the last phase) during the real phases, it would jump the active row to the end and falsely mark gpu/startingServer done. So the reader holds **silent** (keeps polling, emits nothing) until `serverUp` flips — the main tracker owns the bar through every real phase — and only then drives the trailing download row. `serverUp` is set right after port-ready.

2. **Launch gate.** The launch op normally resolves the instant the server is reachable and reveals ComfyUI; it does *not* block on a multi-GB download. To avoid flashing past a still-running download, `handleLaunch` calls **`waitForTemplateDownloadGate()`** just before `_onLaunch`: it sets `serverUp`, then — if the download is still running — `await awaitTemplateDownloadSettled(...)`. While waiting, the reader keeps the substatus live and the **"Skip & open ComfyUI"** footer button is actionable (Skip → `requestSkipTemplateDownload` → mirror to tray + release). It resolves immediately on done/skip/cancel/abort; on **error** (after the task's 2× retries) it shows a "download failed — retry in-app" line + a 3·2·1 countdown, then opens ComfyUI.

The gate lives in **one place** (`handleLaunch`); the settle condition is **one pure primitive** (`awaitTemplateDownloadSettled`, returning `done | error | cancelled | skipped | aborted | absent`). Window-close during the wait releases it via `abortTemplateDownload` → state `cancelled` → settle.

---

## Decisions

| #   | Decision | Chosen | Why |
| --- | --- | --- | --- |
| 1 | Open template without touching frontend | URL deeplink `?template=` | Frontend already has `useTemplateUrlLoader`; zero coupling, no timing fragility |
| 2 | Which templates offered | Curated hardcoded ids (1/modality), verified against the live on-disk index | Control over quality/weight; authentic metadata |
| 3 | Which models a template needs | **Dynamic** from workflow JSON | Authentic data, zero manual transcription (a hardcoded id already 404'd) |
| 4 | When models download | **Background, starts at install-begin** | Overlaps slow env work → less wall-clock wait |
| 5 | Where the step shows | **Launch span, LAST step** (after `startingServer`) | Real steps fill the bar first (no jump); Skip only shows when nothing else is left |
| 6 | Install↔launch bridge | Process-global state `Map` keyed by `installationId` | Same idiom as `_operationAborts`; both ops are pure readers |
| 7 | Cumulative total denominator | Index `sizeBytes` estimate | No upfront HEAD latency; reconciled to real totals as files finish |
| 8 | Hot path cost | Counter-only; 500 ms reader formats | `download()` fires 100s×/sec; keep throughput decoupled from display |
| 9 | Download concurrency | Rolling pool, cap 3 | Saturates link; no head-of-line block from a large file |
| 10 | Log continuity across spans | Seed launch op from `appendLog` ring buffer | `terminalOutput` resets per-op; reuses the durable buffer (1 IPC at op start) |
| 11 | Teardown | Abort on install-cancel + window-close | Cancelled install → models have nowhere to go; avoid orphans |
| 12 | Partial failure | Per-file skip + log, task still "done" | ComfyUI's missing-model prompt is the safety net; never block boot |
| 13 | Storage too small | **Hard-block** at pick-time (disabled Install + alert) AND in-task pre-check at download-start | One clear stop; avoids N failed writes |
| 14 | GPU / VRAM | **Detect, warn, allow** (never block); silent when unknown | ComfyUI offloads dynamically; never false-warn on AMD/Intel |
| 15 | Download failure | Substatus error (red/bold/X) + proceed to ComfyUI; 2× per-file auto-retry first | Missing-model prompt is the fallback; never fail the launch |
| 16 | Slow download → user wants in | **"Skip & open ComfyUI"** → keep the resume-capable task running + mirror to title-bar tray | True continue-where-left-off (don't re-issue via `startModelDownload` — it restarts) |
| 17 | Consent | **No toggle** — a chosen template always pre-downloads; **"Skip & Install"** is the no-download path | One clear escape hatch beats a redundant per-template toggle |

---

## Edge cases & dispositions

| Edge case | Disposition |
|---|---|
| App quit mid-download | Confirm dialog on `before-quit` (`hasActiveTemplateDownloads()` + `showMessageBoxSync`; "Quit Anyway" / "Keep Downloading", default keep). No resume. |
| Window close mid-download | `abortTemplateDownload` → state `cancelled` → releases the launch gate. |
| Network drop mid-download | 2× per-file auto-retry (`withRetry`; `.dl-meta` resume means a retry *continues*, not restarts) → then per-file failure → substatus error + missing-model fallback. |
| Gated HF repo (401/403) | `describeDownloadFailure()` maps it to a clearer "requires a login or license — open in ComfyUI to sign in" log line (word-boundary guarded so `4012` etc. don't false-match); counts toward retry, non-fatal. |
| Disk fills during download | In-task disk guard (`getDiskSpace` × headroom) → surfaced hard error; otherwise per-file failure. |
| Windows MAX_PATH (259) | `truncateForMaxPath` before write; too-long-to-fit → per-file skip + log. |
| Duplicate filename across templates/dirs | Dedup `(directory, name)` + skip-if-exists. |
| Models dir changed (settings) mid-download | Captured once at start; documented, not handled. |
| Models dir on network/removable drive | Per-file failure → missing-model prompt; documented, not handled. |
| Two installs of same template concurrently | Ignored (decided). |
| Antivirus / file lock on Windows during rename | Ignored (decided). |
| Template JSON changed upstream | Resolve-once snapshot; fine. |

---

## Test coverage

The branchy logic is **pure and unit-covered**; the picker is **component-tested**; only the live GUI pass is manual.

| Area | Where | What it pins |
|---|---|---|
| Download core | [templateDownloadCore.test.ts](../src/main/sources/standalone/templateDownloadCore.test.ts) (29) | cumulative math, `runPool` concurrency/abort/isolation, `withRetry` budget + fatal-cancel, `truncateForMaxPath`, `templateStateToTrayEntries`, `formatTemplateSubStatus`, **`describeDownloadFailure`** (401/403 vs generic, no-false-match) |
| **Launch gate** | [templateDownloadGate.test.ts](../src/main/sources/standalone/templateDownloadGate.test.ts) (8) | `awaitTemplateDownloadSettled` resolves the right reason for done / error (incl. disk-space pre-flight) / cancelled / skipped / aborted / absent; skip flag cleared on settle (no stale pre-skip) |
| **Skip-path build** | [index.test.ts](../src/main/sources/standalone/index.test.ts) → `starter template` (3) | `buildInstallation` with template = `none` (or absent) builds **no** `downloadTemplateModels`; a real pick sets `bundledTemplateId` + `pendingTemplateOpen` + `downloadTemplateModels: true` |
| **Picker UI** | [TemplatePickerStep.test.ts](../src/renderer/src/components/TemplatePickerStep.test.ts) (14) | rows render (none excluded), Recommended on first only, aria-checked, select emit, ArrowDown nav, meta line, **disk-block alert** (loading/below/above/model-free), **VRAM warning** (below/meets/undetected), thumbnail `@error` → glyph |
| Disk helpers | [installHelpers.test.ts](../src/renderer/src/lib/installHelpers.test.ts) (6) | `templateDiskRequiredBytes` headroom, `isTemplateDiskBlocked` (unknown/model-free/below/above) |

**Not automated (and why):** the **download error → 3·2·1 countdown** and **skip → tray hand-off** end-to-end need a live ComfyUI server launch + a real (failing) download — the e2e harness never launches real ComfyUI, so a GUI e2e of those would be flaky for little gain. The gate's *decision* logic that drives them is covered by `templateDownloadGate.test.ts`; the *visible* behavior is row 7 + row 12 of the manual matrix.

Run: `pnpm run typecheck && pnpm run lint && npx vitest run`.

---

## Human-review matrix

The manual gate before merge. Run `pnpm dev`. To re-test a fresh install, clear prior models first:
`rm -f ~/ComfyUI-Shared/models/**/*.safetensors && find ~/ComfyUI-Shared/models -name '*.dl-meta' -delete`.

| # | Scenario | Steps | Expected |
|---|---|---|---|
| 1 | **Picker appears (first install)** | New Install → Standalone → Configure → Continue | A dedicated **template step** (compact rows): Image (Flux, "Recommended", pre-selected) / Video (Wan) / Audio (Stable Audio) / 3D (HunYuan3D). Each row: thumbnail, title, `modality · ~size · VRAM ~x`. |
| 2 | **Thumbnails render** | Look at all 4 rows | Real preview images (bundled, offline-safe). No broken-image glyph, no title bleeding into the image. |
| 3 | **Select + expand** | Click each row; try ↑/↓/Home/End | Selected row gets a **yellow ring + check**; its **description expands**; others stay terse. Keyboard moves + selects. |
| 4 | **Install a template** | Pick Image → **Install** | Install proceeds; on first launch **"Downloading template models" is the LAST step**, then ComfyUI opens with the Flux template on canvas. |
| 5 | **Stepper does not jump** | Watch the loader bar | Advances smoothly securityScan→gpu→…→startingServer **without leaping**; the model-download step becomes active only at the very end. |
| 6 | **Skip & Install (blank canvas)** | Picker → **Skip & Install** | Installs with **no template**, no model download (`[templateDownload]` lines absent), ComfyUI opens blank. |
| 7 | **Slow download → gate + Skip → tray** | Pick a heavy template; watch launch | Launch **holds** on the last "Downloading models" step (server up, download running) instead of opening. Footer **"Skip & open ComfyUI"** → ComfyUI opens; the **title-bar tray** shows the same download continuing (not restarted). Or let it finish → opens on its own. |
| 8 | **VRAM warning** | On a GPU below a pick's recommendation (or temporarily lower its `recommendedVramBytes`), select that row | Amber **"may run slowly"** warning under the list; **Install stays enabled** (warn-but-allow). Silent on AMD/Intel/unknown VRAM. |
| 9 | **Disk hard-block** | Point install at a near-full volume (or pick a heavy template on a small disk) | Selecting it shows a **red disk error** + **Install disabled**; no "continue anyway". "Skip & Install" still works. |
| 10 | **Don't-show-again (returning user)** | With ≥1 existing install, open the wizard → template step | A **"Don't show this again"** checkbox appears (absent for a first-ever user). Tick + Install → next New Install **skips the step**. |
| 11 | **Quit mid-download** | Start a heavy-template install; while downloading, ⌘Q | **Confirm dialog** ("Quit Anyway / Keep Downloading", default Keep). Keep → stays; Quit → closes (download dropped). |
| 12 | **Download error → countdown** | Force a failure (go offline mid-download, or a gated repo) | Substatus **red + bold + X**; a **gated repo (401/403)** logs the clearer "requires login/license" line. At the gate: a **"download failed — retry in-app" line + 3·2·1 countdown**, then ComfyUI opens automatically. |
| 13 | **Responsive** | Resize the wizard narrow→wide | Rows reflow cleanly; no overflow/overlap; footer actions stay reachable. |

> Anything failing here is a UI/runtime bug — the logic + pure helpers are unit/component-covered (full suite green); rows 1–13 are the human-eyes pass.
