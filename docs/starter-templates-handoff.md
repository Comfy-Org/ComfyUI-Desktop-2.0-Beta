# Starter Templates — Engineering Handoff

> **Goal of the feature:** when a user picks a starter ComfyUI template during install, they land on a **ready-to-run** canvas — the template auto-opens *and* its required models were pre-downloaded — instead of a blank canvas / "missing model X" errors.

**Original design/plan:** the full step-by-step plan lived at `~/.claude/plans/so-i-want-you-jiggly-toucan.md` on the author's machine (Claude Code plan file — not in the repo). **This doc is the durable, in-repo record** and supersedes it.

**Status:** Phase 1 (deeplink) + Phase 1.5 (background model download with rich progress + logs) **+ Phase 2 (groups A–F: real per-modality picks, resource gating, retry/MAX_PATH/error UX incl. gated-repo line, skip→tray hand-off, dedicated picker step + gating, quit warning) implemented & statically verified** — full suite + all typechecks + eslint green. The picker UI was **redesigned once after a live review** (card grid → compact rows; thumbnails bundled in-repo; consent toggle dropped in favour of "Skip & Install"; live disk-block) — see **"Picker UI (shipped)"** for the final shape. The one open item is **live `pnpm dev` runtime testing** (G), interactive, left for the engineer.

---

## What's DONE

### A. Template auto-opens on first launch (the "deeplink half")

> **✅ Constants now hold the real per-modality picks** (Phase-2 item A done). `bundledTemplates.ts` ships one verified showcase per modality: Image `flux_schnell`, Video `text_to_video_wan`, Audio `audio_stable_audio_example`, 3D `3d_hunyuan3d_image_to_model` — title/description/size/vram copied verbatim from the live index, each confirmed to embed a downloadable `models[]`. (Z-Image and the doc's Stable-Audio-3 / TripoSplat ids were dropped: Z-Image embeds no models; the other two don't exist in the current index.)

- Wizard picker: a `bundledTemplate` card field on the standalone source renders in the install wizard's **Advanced** section. **(Phase-1 placement — the dedicated post-Configure step is Phase-2 item E.)**
- Pick persisted on the install record as `bundledTemplateId` + one-shot `pendingTemplateOpen`; consumed on first launch in `[src/main/host/attach.ts](../src/main/host/attach.ts)` which appends `?template=<id>&source=default` to the comfy URL. ComfyUI frontend's existing `useTemplateUrlLoader` opens it — **zero frontend changes**.
- One-shot cleared via `clearPendingTemplateOpen` (`[src/main/installations.ts](../src/main/installations.ts)`) so relaunches start blank.

### B. Models pre-download in the BACKGROUND, displayed in the LAUNCH span (the "models half")

- **Dynamic model resolution:** `[templateModels.ts](../src/main/sources/standalone/templateModels.ts)` → `resolveTemplateModels()` reads the template's workflow JSON (install-tree site-packages first, GitHub-raw fallback), scans top-level **and** node-level **and** subgraph `models[]`, whitelists hosts (HF/Civitai), strips query params, dedupes.
- **Download starts at install-begin** (`[registerInstallationHandlers.ts](../src/main/lib/ipc/registerInstallationHandlers.ts)`) so bytes overlap env setup — `startTemplateDownload(inst, sizeBytes, { sendOutput })`, fire-and-forget.
- **Displayed as a launch-span phase** after "Starting ComfyUI → security scan": synthetic `template-models` phase spliced by `buildLaunchPhases` (`[launchPhases.ts](../src/main/lib/launchPhases.ts)`); a 500 ms reader in `[launch.ts](../src/main/lib/ipc/sessionActions/launch.ts)` (`driveTemplatePhase`) paces the substatus from shared state.
- **Rich progress:** speed, ETA, current file (N of M), cumulative "X GB of Y GB" — `summarizeTemplateState` + `formatTemplateSubStatus`.
- **Logs:** per-file start / every-10% / finish lines stream into "View logs" via `comfy-output` + the durable `appendLog` ring buffer; the launch op's terminal is **seeded** from that buffer (new `logs-snapshot` IPC) so install-leg lines survive the span boundary.

### Performance engineering (the "marvel" asks)

- **Hot-path/reader split:** the per-chunk `download()` callback (fires 100s×/sec) does only O(1) counter writes — no strings/i18n/IPC. A single 500 ms reader owns all formatting + emits.
- **Bounded-concurrency pool** (`runPool`, cap 3): saturates the link; rolling (not batched) so one big file can't head-of-line-block.
- **Pure, unit-tested core** (`[templateDownloadCore.ts](../src/main/sources/standalone/templateDownloadCore.ts)` + `[.test.ts](../src/main/sources/standalone/templateDownloadCore.test.ts)`, 12 tests): cumulative math, pool concurrency/abort/isolation, formatter. Split from the Electron-coupled task so it tests without a window.

### Verification done

`typecheck:node` ✅ · `typecheck:web` ✅ · 12 core unit tests ✅ · `localeCoverage` ✅ · `progressStore` (29) ✅ · `launch` tests ✅ · `eslint` on all touched files ✅.

---

## Decision matrix


| #   | Decision                            | Chosen                                             | Alternatives rejected                            | Why                                                                                       |
| --- | ----------------------------------- | -------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| 1   | Open template w/o touching frontend | URL deeplink `?template=`                          | executeJavaScript injection                      | Frontend already has `useTemplateUrlLoader`; zero coupling, no timing fragility           |
| 2   | Which templates offered             | Curated hardcoded list of ~6 real ids              | Fully dynamic index fetch                        | Control over lightweight/quality; ids verified against live repo                          |
| 3   | Which models a template needs       | **Dynamic** from workflow JSON                     | Hardcode URLs per template                       | Authentic data, zero manual transcription (a hardcoded id already 404'd)                  |
| 4   | When models download                | **Background, starts at install-begin**            | In `postInstall` (blocking) / after first launch | Overlaps slow env work → less wall-clock wait; user's explicit ask                        |
| 5   | Where the step shows                | **Launch span, as the LAST step** (after `startingServer`) | Install span / after security scan          | Bytes flow in the background; trailing it means real steps fill the bar first (no jump) and Skip only shows when nothing else is left |
| 6   | Install↔launch bridge               | Process-global state `Map` keyed by installationId | Re-plumb download through launch / event emitter | Same idiom as `_operationAborts`; both ops are pure readers; simplest robust              |
| 7   | Cumulative total denominator        | Index `sizeBytes` estimate                         | HEAD each URL for Content-Length                 | No upfront latency → bytes start instantly; reconciled to real totals as files finish     |
| 8   | Hot path cost                       | Counter-only; 500 ms reader formats                | Format+emit in chunk cb (throttled)              | `download()` fires 100s×/sec; keep throughput decoupled from display                      |
| 9   | Download concurrency                | Rolling pool cap 3                                 | Sequential / fixed batches                       | Saturates link; no head-of-line block from a large file                                   |
| 10  | Log continuity across spans         | Seed launch op from `appendLog` ring buffer        | Only log during launch / accept gap              | `terminalOutput` resets per-op; reuses existing durable buffer (1 IPC at op start)        |
| 11  | Teardown                            | Abort on install-cancel + window-close             | Let downloads survive close                      | Cancel removes the install → models have nowhere to go; avoid orphans                     |
| 12  | Partial failure                     | Per-file skip + log, task still "done"             | Fail the whole launch                            | ComfyUI's missing-model prompt is the safety net; never block boot                        |
| 13  | Disk safety                         | Pre-check `getDiskSpace` × 1.05 vs estimate        | Let writes fail                                  | Avoids N failed writes + confusing error row                                              |
| 14  | Consent (Phase 2 final)             | **No toggle** — a chosen template always pre-downloads; **"Skip & Install"** is the no-download path | Phase-1's "(~X GB)" checkbox / per-model list    | One clear escape hatch (Skip) beats a redundant per-template toggle; size shown in the row meta |


---

## Files touched (this work)

**New:** `templateDownloadCore.ts` (+ `.test.ts`), `templateDownloadTask.ts`, `templateModels.ts`, `bundledTemplates.ts`.
**Changed:** `install.ts`, `index.ts` (standalone), `registerInstallationHandlers.ts`, `registerLogsHandlers.ts`, `launchPhases.ts`, `sessionActions/launch.ts`, `attach.ts`, `installations.ts`, `comfyDownloadManager.ts` (exported `getModelsBaseDir`), `progressStore.ts` (+ test), `preload/api.ts`, `types/ipc.ts`, `InstallWizardModal.vue`, `locales/en.json`, `locales/zh.json`.
**Deleted:** `templateModelsInstall.ts` (logic moved into the task/core).

---

## What's PENDING / pick-up points

### Fixed after first live test (branch `feat/starter-templates`)

First `pnpm dev` run showed the model step **starting at 0** and logs **stuck at "model loading", nothing else** → the background download wasn't progressing. Root cause: `templateModels.ts` used **global `fetch`** for the remote template-JSON fallback, which can **hang in the Electron main process**; since the venv site-packages don't exist at install-begin, resolution *always* takes that remote path → the task sat in `resolving` forever, emitting no logs. Fixes:

- Remote fallback now uses the codebase's Electron `net.request` helper (`fetchJSON`) instead of global `fetch` — same proven network stack/timeout as all other main-side HTTP.
- The task now emits a log line **immediately on start** and **on resolve**, surfaces the **failure reason** in the log (the old `.catch` was silent), and mirrors all lines to the **main-process console** (`[templateDownload:<id>]`) so the `pnpm dev` terminal shows the lifecycle even if the renderer panel hiccups.

**Progress-bar leap (70→99) fix.** When models were already downloaded by launch time, the step emitted `percent: 100` instantly → filled its whole slot, the monotonic floor locked it high, then the heavy silent `gpu` phase's baseline absorbed it → a double jump. Fixes (in `launchPhases.ts` + `launch.ts` reader):

- Phase weight `0.10`→`0.05` (matches the other light launch phases) so a *live* download fills its slot smoothly and a pre-done one barely affects `gpu`'s baseline.
- Reader decides on the **first tick**: if the download was **already complete** → report **indeterminate** (`-1`, no slot fill, no leap); if **still running** → report the **real percent** (clamped 0→99) so the bar advances *with* the bytes; the tracker's real milestones still own 100. The two cases are why the bar now moves during a genuine download but doesn't jump when models were pre-fetched.

### Immediate (re-test on branch)

1. **Re-run `pnpm dev`** — install `default` (SD1.5 2 GB) with consent ON → watch the `pnpm dev` terminal for `[templateDownload:…]` lines (should appear during install, not just launch); confirm the `template-models` step shows non-zero progress in the launch span, "View logs" shows download lines (incl. install-leg lines via seeding), models land in the shared models dir, template opens populated.
2. **Verify curated ids against the *installed package*** — ids were checked against live GitHub; the pip package on disk could differ. Read `{installPath}/ComfyUI/.venv/.../site-packages/comfyui_workflow_templates/templates/index.json` and drop any non-resolving id.

### Known edges (flagged, accepted for now)

- **Tracker skip-advance:** when ComfyUI's `gpu` log lines arrive, the launch tracker moves `activePhase` off `template-models`. If the download is *still* running on a slow link, its substatus stops being the active row (bar still correct via weight). Common case (done before `gpu`) → invisible. **Verify the genuinely-slow-link case manually.**
- `**download()` resume:** `.dl-meta` sidecars are preserved per file — a re-run continues partial files. Confirm a mid-download cancel + reinstall resumes cleanly.

### Phase 2 — DECIDED scope + living checklist (not yet built)

> Product decisions are **made**. This is the running source of truth — **update the checklist at the bottom every chat** so no edge case is lost. Only minor visual copy (exact CTA text, gallery layout) is still open.

**Codebase facts:** `getModelsBaseDir()` = `settings.modelsDirs[0]` (default `~/ComfyUI-Shared/models`), all `path.join`. `getDiskSpace()` = `fs.promises.statfs` (cross-platform). `detectGPU()` now also returns **`vramBytes`** cross-OS (nvidia-smi → `os.totalmem()` for mps → `systeminformation` fallback for AMD/Intel/discrete; undefined only when truly unknown). Pure `shouldWarnVram()` lives in `bundledTemplates.ts`. Per-template recommended VRAM is `BundledTemplate.recommendedVramBytes` (to be filled in item A). The in-window **downloads tray** (`startModelDownload`→`tray-state-changed`→title bar) is tied to the **running comfy window** and **does NOT resume `.dl-meta` partials** (it only skips if the final file exists) — so a naive hand-off would restart; our `download()` *does* resume. No download-lock contention with the installer.

#### Decisions locked
| Topic | Decision |
|---|---|
| **Templates (1/modality, hardcoded ids in `bundledTemplates.ts`)** | Verified to resolve + carry model URLs: Image `image_z_image_turbo` (~19 GB) or lighter `gsl_starter_1_1` (SD1.5 ~2 GB); Audio `audio_stable_audio_3_medium` (~15 GB) or lighter `audio_stable_audio_example` (~5.3 GB); 3D `3d_triposplat_image_to_gaussian_splat` (~3.7 GB); Video `text_to_video_wan` (Wan 2.1 ~9 GB). **Ship lighter defaults now; final showcase picks are a product call — swap the constant.** |
| **Storage too small** | **HARD-BLOCK + message**, in **both** places: early at pick/pre-install (free disk vs install+model size) AND the in-task pre-check at download-start (upgraded from silent-skip → surfaced error). |
| **GPU / VRAM** | **Detect VRAM, WARN but allow** (never block). NVIDIA via `nvidia-smi --query-gpu=memory.total`; Apple Silicon (`mps`) ≈ `os.totalmem()`; AMD/Intel/unknown → no number, **no warning** (never false-warn). Warn only when real VRAM < template `vram`; user proceeds (ComfyUI dynamically offloads; `--lowvram` deprecated). |
| **Stepper order** | Model-download is the **last** step (already true via background download). |
| **Download failure** | Message + let user proceed to ComfyUI. Error in **substatus only**: **red, bold, X icon**. |
| **Slow download → Skip** | When all other install+launch steps done but download still running → **"Skip model download"** button, footer center. On skip → **keep our resume-capable task running** + **mirror its progress into the title-bar tray** (true continue-where-left-off; do NOT re-issue via `startModelDownload` — it restarts). User proceeds to ComfyUI. |
| **Auto-retry** | Per-file **2× auto-retry** in the task (wrap `download()` — it's single-shot). |
| **Where to show** | Dedicated full-screen step **after "Configure my Desktop", before install**, in `InstallWizardModal`. CTAs: **"Skip & Install"** / **"Install"** (copy TBD), template pre-selected. Same step in onboarding **and** "Add New Instance". **"Don't show again"** checkbox shown **only when ≥1 local install already exists**; auto-skip for opted-out returning users. |

#### Key integration seams
- **Picker insert:** `InstallWizardModal.vue handleSave()` between `addInstallation()` and `show-progress` (~L603-605); add `step: 'configure' | 'template'` in the same `BrandTakeoverLayout`. Dashboard "New Install" uses the same modal → inherits. Express (`useFirstUseChain.runExpressInstall`) must gate separately.
- **Gating:** `skipTemplatePickerStep` boolean in `settings.ts`; ≥1-local-install via `firstUseDetection.ts`/`installations.list()`.
- **Skip→tray mirror:** publish `TemplateDownloadState` into `comfyDownloadManager` tray channel (`pendingDownloads`/`reportProgress`/`tray-state-changed`); title-bar renders it (`TitleBarApp.vue`). No `startModelDownload` for the same file.
- **Footer Skip + error style:** `ProgressModal.vue .brand-progress__footer-left`; `BrandProgressView.vue .bpv__detail` + `is-error` (red/bold) variant + X glyph.
- **VRAM detect:** add `vramBytes?` to `gpu.ts detectGPU()` (mirror the existing `nvidia-smi --query-gpu` driver query ~L176); expose via GPU IPC.
- **Disk/retry:** reuse `getDiskSpace()`/`checkDiskSpaceOrWarn` (`installHelpers.ts`); wrap per-file `download()` in `runPool` worker with 2× retry.

#### Edge cases — final dispositions
| Edge case | Disposition |
|---|---|
| App quit (not window close) mid-download | **Alert dialog on close, then let them close.** No resume, nothing fancy. |
| Network drop mid-download | **2× auto-retry** → then failed → substatus error + missing-model fallback. |
| Gated HF repo (401/403) | **Done** — `describeDownloadFailure()` (core) maps a 401/403 to a clearer "requires a login or license — open in ComfyUI to sign in" log line (word-boundary guarded so `4012` etc. don't false-match); counts toward 2× retry, non-fatal. |
| Duplicate filename across templates/dirs | Dedup `(directory,name)` + skip-if-exists. Keep. |
| `.dl-meta` resume / size mismatch | Handled by `download()`. Keep. |
| Models dir changed (settings) mid-download | Captured once at start; document only. |
| Models dir on network/removable drive | Per-file failure → missing-model prompt; document only. |
| Two installs of same template concurrently | **Ignore** (decided). |
| Antivirus / file lock on Windows during rename | **Ignore** (decided). |
| Template JSON changed upstream | Resolve-once snapshot; fine. |
| Disk fills DURING download | Caught by upgraded in-task disk guard + per-file failure. |
| ~~User unchecks consent~~ → **"Skip & Install"** | **Superseded.** The per-template consent toggle was removed; choosing a template always pre-downloads (`buildInstallation` sets `downloadTemplateModels: true` from the template id). The "no download" intent is now the picker's **"Skip & Install"** → template = None → no task → blank canvas + runtime prompt. ✅ |
| Windows MAX_PATH (259) long filename | Add `startModelDownload`'s truncation guard before our `download()` write. |
| FD limit / bandwidth contention | Watch-items; mitigate only if observed (lower copy/pool concurrency, or defer template DL until bundle DL done). |

#### Build checklist (living — tick across chats)
> `[ ]` todo · `[~]` in progress · `[x]` done · `[-]` decided-not-doing

**A. Templates & data**
- [x] Confirm 4 modality ids resolve + carry model URLs — **verified against the live on-disk index**; two doc picks didn't exist / didn't embed models, so final set is: Image `flux_schnell` (Z-Image carried 0 embedded models), Video `text_to_video_wan`, Audio `audio_stable_audio_example`, 3D `3d_hunyuan3d_image_to_model`. All resolve real `models[]`.
- [x] Set `bundledTemplates.ts` to the per-modality picks + sizes — title/description/size/vram **copied verbatim from the index** (the gallery's source of truth), keyed by curated `{id, modality}`.
- [x] Per-modality picker metadata (title, thumbnail, size, modality) — `BundledTemplate` carries `modality` + `thumbnailUrl` + `recommendedVramBytes`; passed through `getFieldOptions('bundledTemplate').data`. **Thumbnails are bundled in-repo** (`src/renderer/public/images/templates/<id>.webp`, served at `./images/templates/<id>.webp`) — NOT fetched from `raw.githubusercontent.com`, because the renderer CSP (`img-src 'self' data:`) blocks remote images and a first-ever user has no local package yet. The webps are a downscaled (~600px, ~6–33 KB each) representative frame extracted from each template's animated `-1.webp` gallery preview (frame 1 was blank for the video/3D ones).
- [x] **Fix (found here):** the templates package was split into `…_media_<modality>` sub-packages — `templateModels.ts loadTemplateJson` now probes all of them, so local resolution stops always-missing → falling back to the slow remote path.

**B. Resource gating**
- [x] Disk hard-block at **pick/pre-install** (`checkTemplateDiskOrBlock` in `installHelpers.ts`, wired into `InstallWizardModal.handleSave`): free disk vs template-model size × 1.1 headroom; **no continue-anyway** (alert + block), only when a template-with-models is chosen. Also surfaced **live in the picker** (disables Install) via the shared `isTemplateDiskBlocked` — see "Picker UI (shipped)". Install-bundle disk stays the existing soft warn.
- [x] Upgrade in-task disk pre-check: silent-skip → **surfaced hard error** (distinct `insufficient-disk` code → `templateModelsNoSpace` substatus, rendered via the `is-error` style)
- [x] **VRAM detection**: `vramBytes` in `detectGPU()` — nvidia-smi `memory.total` (authoritative) → mps `os.totalmem()` → **cross-OS `systeminformation` `si.graphics()` fallback** (AMD/Intel/discrete, any OS); undefined only when no real number. Flows through the existing `detect-gpu` IPC + `GPUInfo.vramBytes`. Pure `shouldWarnVram(detected, recommended)` decision helper added + tested (silent on undefined / no-recommendation; never false-warns).
- [ ] **VRAM warn-but-allow** in picker (warn via `shouldWarnVram`; never block; silent when unknown) — **coupled to the picker UI (item E)**; needs per-template `recommendedVramBytes` (item A)

**C. Download behavior**
- [x] Background download at install-begin; non-fatal; trailing step
- [x] Stepper no-jump fix
- [x] Per-file **2× auto-retry** wrapper (`withRetry` in core; cancel is fatal/no-retry; `.dl-meta` resume means a retry continues, not restarts)
- [x] Error substatus **red + bold + X icon** (`ProgressData.error` → `phaseErrors` map → `ProgressStepVM.isError` → `BrandProgressView` `.bpv__detail.is-error`)
- [x] Windows MAX_PATH guard before write (`truncateForMaxPath` in core; too-long-to-fit → per-file skip)

**D. Skip → tray hand-off**
- [x] "Skip & open ComfyUI" button (`ProgressModal` footer center; gated on active=`template-models` && not-errored && <100% — which, with the launch gate, is exactly while the gate holds at port-ready). `skip-template-download` IPC → `requestSkipTemplateDownload` (releases the launch gate + mirrors to tray).
- [x] Mirror `TemplateDownloadState` into title-bar tray (no restart): **separate mirror registry** in `comfyDownloadManager` (`setTemplateTrayMirror`/`clearTemplateTrayMirror`) merged into `getDownloadsTrayState()` active/recent — does NOT touch `pendingDownloads`' DownloadItem lifecycle, so cancel/retry/temp-rename stay intact. Task keeps running (resume-capable); a 500 ms poll reflects it via the pure `templateStateToTrayEntries`. Torn down in `attach.ts _installCleanup` (`stopTemplateTrayMirror`).
- [ ] Verify continue-from-where-left-off + ComfyUI reachable immediately *(needs live `pnpm dev` — group G)*

**E. Picker step + entry points** *(UI reworked after first review — see "Picker UI (shipped)" below)*
- [x] `step: 'configure' | 'template'` screen in `InstallWizardModal.vue` — `TemplatePickerStep.vue` renders a **compact selectable row list** (reusing `brand-variant-list`): thumbnail + title + meta (`modality · ~size · VRAM ~x`), with the **description expanding inside the selected row**. Configure's Continue → picker step (or installs directly when gated off); Back returns to Configure. `bundledTemplate` Advanced card hidden when the picker step is active.
- [x] CTAs **"Skip & Install" / "Install"** (in the host wizard footer), template pre-selected (first real = Image, tagged "Recommended"). **No "None" tile** — Skip & Install IS the blank-canvas path. **No consent toggle** — a chosen template always pre-downloads.
- [x] Dashboard "Add New Instance" inherits — same `InstallWizardModal`, so it gets the step for free
- [x] Gate Express Install path — Express picks the `recommended` option, which is the "None" sentinel, so it installs with no template + no picker by construction (intentional; no extra guard needed)
- [x] `skipTemplatePickerStep` setting (`settings.ts`) + "Don't show again" checkbox shown only when `getInstallationsSummary().localCount > 0`; persisted via `setSetting` on Install/Skip
- [x] Auto-skip for opted-out returning users — `pickerEnabled` reads `skipTemplatePickerStep` on open; `shouldShowPickerStep` false → Continue installs directly

**B (picker-coupled)**
- [x] **VRAM warn-but-allow** in the picker — `TemplatePickerStep` warns (never blocks) when `detectedVramBytes < recommendedVramBytes`; silent when VRAM unknown. VRAM fetched via `detectGPU()` on wizard open. Rendered in the picker's alerts region alongside the live disk-block error.

**F. Failure UX**
- [x] Whole-task failure: message + proceed — substatus error (red/bold/X) is the surface; launch never fails on it (already true via the non-fatal task)
- [x] App-quit-mid-download → confirm dialog on `before-quit` (`hasActiveTemplateDownloads()` + synchronous `showMessageBoxSync`; "Quit Anyway" / "Keep Downloading", default = keep). No resume.

**G. Verification / tests**
- [x] Unit tests: `withRetry`, `truncateForMaxPath`, disk-error formatter branch, `templateStateToTrayEntries`, `shouldWarnVram`, `templateDiskRequiredBytes`, `isTemplateDiskBlocked`, `describeDownloadFailure` (all pure)
- [ ] Live `pnpm dev`: the **13-row human-reviewer test matrix above** *(interactive — left for the engineer)*
- [x] typecheck (node+web+e2e+integration) · localeCoverage · progressStore/launch/ProgressModal/comfyDownloadManager/gpu · eslint — full suite green

---

## Picker UI (shipped — final shape)

The dedicated step (`TemplatePickerStep.vue`) went through one redesign after a live review. **Final shape:**

- **Compact selectable rows**, not a card grid — reuses the existing `brand-variant-list` styling. Each row: bundled thumbnail (40×40, modality-glyph fallback on `@error`) + title (+ "Recommended" tag on the first/Image row) + a meta line `modality · ~size · VRAM ~x`. The **description expands inside the selected row** (CSS `grid-template-rows 0fr→1fr`), so unselected rows stay terse.
- **Full keyboard nav** — `role="radiogroup"`/`radio`/`aria-checked`; Arrow/Home/End move + select (`onRowKeydown`).
- **Live disk-block** — the picker compares free disk vs the selected template's model size *as you select* (not just at save). Shown as an inline error in the alerts region; the host's **Install button is disabled** while blocked. All three disk checks (picker alert, disabled-Install, save-time hard gate `checkTemplateDiskOrBlock`) call the **one shared pure decision `isTemplateDiskBlocked(diskSpace, modelBytes)`** in `installHelpers.ts` so they can't drift.
- **No "None" tile, no consent toggle** — "Skip & Install" (host footer) is the blank-canvas / no-download path; choosing a template always pre-downloads (`buildInstallation` derives `downloadTemplateModels: true` from the template id — the renderer syncs **no** separate consent field).
- **Thumbnails bundled in-repo** (CSP-safe `'self'`), see group A.

**Three-caller disk rule + helpers** live in `installHelpers.ts`: `templateDiskRequiredBytes` (size×1.1 headroom) → `isTemplateDiskBlocked` (the shared boolean) → `checkTemplateDiskOrBlock` (the async save-time alert+gate).

### Stepper ordering + launch gate (template download is the LAST step)

`template-models` is appended as the **final** launch phase (`launchPhases.ts` — after `startingServer`). Two mechanisms make this honest:

1. **`serverUp`-gated reader.** The bar derives "prior steps done" from the active phase *index* (`progressStore globalProgressFor`), so if the always-on 500 ms reader emitted `template-models` (the last phase) during the real phases, it would jump the active row to the end and falsely mark gpu/startingServer done. So the reader holds **silent** (keeps polling, emits nothing) until `serverUp` flips — the main tracker owns the bar through every real phase — and only then drives the trailing download row. `serverUp` is set right after port-ready.

2. **Launch gate.** The op normally resolves the moment the server is reachable and reveals ComfyUI; it does *not* block on a multi-GB download. But that would flash past a still-running download. So `handleLaunch` calls **`waitForTemplateDownloadGate()`** just before `_onLaunch`: it sets `serverUp`, then — if the download is still running — `await awaitTemplateDownloadSettled(...)`. While waiting, the reader keeps the substatus live and the **"Skip & open ComfyUI"** footer button is actionable (Skip → `requestSkipTemplateDownload` → mirror to tray + release). Resolves on done/skip/cancel/abort immediately; on **error** (after the task's 2× retries) shows a "failed, retry in-app" line + a 3·2·1 countdown, then opens ComfyUI.

The gate lives in **one place** (`handleLaunch`); the settle condition is **one pure primitive** (`awaitTemplateDownloadSettled`). Window-close during the wait releases it via `abortTemplateDownload` → state `cancelled` → settle.

---

## ✅ Human-reviewer test matrix (frontend, `pnpm dev`)

Run `pnpm dev`. Before each fresh-install run, clear prior models if needed:
`rm -f ~/ComfyUI-Shared/models/**/*.safetensors && find ~/ComfyUI-Shared/models -name '*.dl-meta' -delete`.

| # | Scenario | Steps | Expected |
|---|---|---|---|
| 1 | **Picker appears (first install)** | New Install → Standalone → Configure → Continue | A dedicated **template step** appears (compact rows): Image (Flux, "Recommended", pre-selected) / Video (Wan) / Audio (Stable Audio) / 3D (HunYuan3D). Each row shows a **thumbnail** (not broken), title, `modality · ~size · VRAM ~x`. |
| 2 | **Thumbnails render** | Look at all 4 rows | Real preview images load (bundled, offline-safe). No broken-image glyph, no title bleeding into the image. |
| 3 | **Select + expand** | Click each row | Selected row gets a **yellow ring + check**; its **description expands** inside the row; others stay terse. Keyboard: ↑/↓/Home/End move + select. |
| 4 | **Install a template** | Pick Image → **Install** | Install proceeds; on first launch the stepper runs all phases, **"Downloading template models" is the LAST step**, then ComfyUI opens with the Flux template already on canvas. |
| 5 | **Stepper does not jump** | Watch the loader bar during launch | The bar advances smoothly through securityScan→gpu→…→startingServer **without leaping**; the model-download step only becomes the active row at the very end. |
| 6 | **Skip & Install (blank canvas)** | Picker → **Skip & Install** | Installs with **no template**, no model download starts (`[templateDownload]` lines absent), ComfyUI opens on a blank canvas. |
| 7 | **Slow download → gate + Skip → tray** | Pick a heavy template (Image ~16 GB). Watch the launch: real steps run, then it **holds on the last "Downloading models" step** (server is up but download still running) instead of opening ComfyUI | The launch **does not** flash past — it waits, showing the download as the active last step + footer **"Skip & open ComfyUI"**. Click → ComfyUI opens immediately; the **title-bar downloads tray** shows the same download continuing (not restarted). Or let it finish → ComfyUI opens on its own. |
| 8 | **VRAM warning** | On a GPU with less VRAM than a pick's recommendation (or temporarily lower a pick's `recommendedVramBytes`), select that row | An amber **"may run slowly / offload"** warning shows under the list. **Install stays enabled** (warn-but-allow). Silent on AMD/Intel/unknown VRAM. |
| 9 | **Disk hard-block** | Point the install at a near-full volume (or pick the ~19 GB-class template on a small disk) | Selecting it shows a **red disk error** in the picker and the **Install button is disabled**; trying to proceed is blocked (no "continue anyway"). "Skip & Install" still works. |
| 10 | **Don't-show-again (returning user)** | With ≥1 existing local install, open the wizard → template step | A **"Don't show this again"** checkbox appears (absent for a first-ever user). Tick it + Install → next New Install **skips the template step** entirely (Continue installs directly). |
| 11 | **Quit mid-download** | Start a heavy-template install; while models are downloading, quit the app (⌘Q) | A **confirm dialog** ("Quit Anyway / Keep Downloading", default Keep) appears. Keep → app stays; Quit → app closes (download dropped, no resume). |
| 12 | **Download error → countdown** | Force a failure (go offline mid-download, or a gated repo) | The substatus shows **red + bold + X**; a **gated repo (401/403)** logs a clearer "requires login/license — open in ComfyUI" line. At the gate, the error shows a **"download failed — retry in-app" line + a 3·2·1 countdown**, then ComfyUI opens automatically. Missing-model prompt is the fallback. |
| 13 | **Responsive** | Resize the wizard window narrow→wide | The picker rows reflow cleanly; no overflow/overlap; footer actions stay reachable. |

> Anything failing here is a UI/runtime bug — the logic + pure helpers are unit-covered (full suite green), but rows 1–13 are the human-eyes pass.

---

## Mental model for the next engineer

Three layers, cleanly separated:

1. **Task** (`templateDownloadTask.ts`) — owns bytes + logs; sole writer of the shared state Map; hot path is counter-only.
2. **Core** (`templateDownloadCore.ts`) — pure math/formatting; unit-tested; no Electron.
3. **Reader** (the 500 ms poll in `launch.ts`, in the `showTemplatePhase` block) — turns state → stepper substatus; held silent until `serverUp` so the trailing row only activates once the real launch phases are done. `waitForTemplateDownloadGate()` (also in `launch.ts`) holds the ComfyUI reveal until the download settles or the user skips.

If you change progress display, touch the **reader/core**. If you change *what/how* downloads, touch the **task**. They communicate only through `getTemplateDownloadState()`.