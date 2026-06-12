# Starter Templates — Engineering Handoff

> **Goal of the feature:** when a user picks a starter ComfyUI template during install, they land on a **ready-to-run** canvas — the template auto-opens *and* its required models were pre-downloaded — instead of a blank canvas / "missing model X" errors.

**Original design/plan:** the full step-by-step plan lived at `~/.claude/plans/so-i-want-you-jiggly-toucan.md` on the author's machine (Claude Code plan file — not in the repo). **This doc is the durable, in-repo record** and supersedes it.

**Status:** Phase 1 (deeplink) + Phase 1.5 (background model download with rich progress + logs) **implemented & statically verified**. Not committed; not yet runtime-tested via `pnpm dev`. Phase 2 (UX, gating, all entry points) **not started**.

---

## What's DONE

### A. Template auto-opens on first launch (the "deeplink half")

> **⚠️ Live constants ≠ Phase-2 picks.** The ids currently in `bundledTemplates.ts` are the **Phase-1 test set** (3 zero-model + 3 small: `templates_purz_image_glitch`, `templates_purz_pixel_sort_image`, `utility_interpolation_image_upscale`, `default`, `utility_birefnet_remove_background`, `utility_image_segment_sam3`). The **per-modality picks** in the Phase-2 "Decisions locked" table (Z-Image / Stable Audio / TripoSplat / Wan, or lighter) are **decided but not yet wired in** — swapping the constant is Phase-2 checklist item **A**.

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
| 5   | Where the step shows                | **Launch span**, after security scan               | Install span (before "Starting ComfyUI")         | User wanted it after "Starting ComfyUI"; bytes already flowing so it usually flashes done |
| 6   | Install↔launch bridge               | Process-global state `Map` keyed by installationId | Re-plumb download through launch / event emitter | Same idiom as `_operationAborts`; both ops are pure readers; simplest robust              |
| 7   | Cumulative total denominator        | Index `sizeBytes` estimate                         | HEAD each URL for Content-Length                 | No upfront latency → bytes start instantly; reconciled to real totals as files finish     |
| 8   | Hot path cost                       | Counter-only; 500 ms reader formats                | Format+emit in chunk cb (throttled)              | `download()` fires 100s×/sec; keep throughput decoupled from display                      |
| 9   | Download concurrency                | Rolling pool cap 3                                 | Sequential / fixed batches                       | Saturates link; no head-of-line block from a large file                                   |
| 10  | Log continuity across spans         | Seed launch op from `appendLog` ring buffer        | Only log during launch / accept gap              | `terminalOutput` resets per-op; reuses existing durable buffer (1 IPC at op start)        |
| 11  | Teardown                            | Abort on install-cancel + window-close             | Let downloads survive close                      | Cancel removes the install → models have nowhere to go; avoid orphans                     |
| 12  | Partial failure                     | Per-file skip + log, task still "done"             | Fail the whole launch                            | ComfyUI's missing-model prompt is the safety net; never block boot                        |
| 13  | Disk safety                         | Pre-check `getDiskSpace` × 1.05 vs estimate        | Let writes fail                                  | Avoids N failed writes + confusing error row                                              |
| 14  | Consent                             | Single checkbox "(~X GB)", default on              | Per-model list / no prompt                       | Ships fast, testable; per-model breakdown is Phase 2                                      |


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

**Codebase facts:** `getModelsBaseDir()` = `settings.modelsDirs[0]` (default `~/ComfyUI-Shared/models`), all `path.join`. `getDiskSpace()` = `fs.promises.statfs` (cross-platform). `detectGPU()` returns **vendor only — no VRAM yet** (we'll add it via `nvidia-smi --query-gpu=memory.total`; `mps`→`os.totalmem()`). Template index carries a per-template `vram` estimate. The in-window **downloads tray** (`startModelDownload`→`tray-state-changed`→title bar) is tied to the **running comfy window** and **does NOT resume `.dl-meta` partials** (it only skips if the final file exists) — so a naive hand-off would restart; our `download()` *does* resume. No download-lock contention with the installer.

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
| Gated HF repo (401/403) | Clearer "requires login/license" line; counts toward 2× retry, non-fatal. |
| Duplicate filename across templates/dirs | Dedup `(directory,name)` + skip-if-exists. Keep. |
| `.dl-meta` resume / size mismatch | Handled by `download()`. Keep. |
| Models dir changed (settings) mid-download | Captured once at start; document only. |
| Models dir on network/removable drive | Per-file failure → missing-model prompt; document only. |
| Two installs of same template concurrently | **Ignore** (decided). |
| Antivirus / file lock on Windows during rename | **Ignore** (decided). |
| Template JSON changed upstream | Resolve-once snapshot; fine. |
| Disk fills DURING download | Caught by upgraded in-task disk guard + per-file failure. |
| User unchecks consent | No task; template opens; runtime prompt. ✅ as-is. |
| Windows MAX_PATH (259) long filename | Add `startModelDownload`'s truncation guard before our `download()` write. |
| FD limit / bandwidth contention | Watch-items; mitigate only if observed (lower copy/pool concurrency, or defer template DL until bundle DL done). |

#### Build checklist (living — tick across chats)
> `[ ]` todo · `[~]` in progress · `[x]` done · `[-]` decided-not-doing

**A. Templates & data**
- [x] Confirm 4 modality ids resolve + carry model URLs
- [ ] Set `bundledTemplates.ts` to chosen (lighter) per-modality picks + sizes
- [ ] Per-modality picker metadata (title, thumbnail id, size, modality label)

**B. Resource gating**
- [ ] Disk hard-block at **pick/pre-install** (install+model size vs free) + message
- [ ] Upgrade in-task disk pre-check: silent-skip → **surfaced hard error**
- [ ] **VRAM detection**: `vramBytes` in `detectGPU()` (nvidia-smi memory.total; mps→os.totalmem; else undefined) + IPC
- [ ] **VRAM warn-but-allow** in picker (warn when detected < template `vram`; never block; silent when unknown)

**C. Download behavior**
- [x] Background download at install-begin; non-fatal; trailing step
- [x] Stepper no-jump fix
- [ ] Per-file **2× auto-retry** wrapper
- [ ] Error substatus **red + bold + X icon**
- [ ] Windows MAX_PATH guard before write

**D. Skip → tray hand-off**
- [ ] "Skip model download" button (footer center; gated active=template-models && others done)
- [ ] Mirror `TemplateDownloadState` into title-bar tray (no restart)
- [ ] Verify continue-from-where-left-off + ComfyUI reachable immediately

**E. Picker step + entry points**
- [ ] `step: 'configure' | 'template'` screen in `InstallWizardModal.vue`
- [ ] CTAs "Skip & Install" / "Install" (copy TBD), template pre-selected
- [ ] Dashboard "Add New Instance" inherits + verify
- [ ] Gate Express Install path
- [ ] `skipTemplatePickerStep` setting + "Don't show again" (only when ≥1 local install)
- [ ] Auto-skip for opted-out returning users

**F. Failure UX**
- [ ] Whole-task failure: message + proceed (substatus error is the surface)
- [ ] App-quit-mid-download → alert dialog on close

**G. Verification / tests**
- [ ] Unit tests: retry wrapper, tray-mirror mapping, disk-block + VRAM-warn decisions (pure fns)
- [ ] Live `pnpm dev`: each modality, slow-download skip→tray, disk-block, VRAM-warn, returning-user skip
- [ ] typecheck (node+web) · localeCoverage · progressStore/launch · eslint green

---

## Mental model for the next engineer

Three layers, cleanly separated:

1. **Task** (`templateDownloadTask.ts`) — owns bytes + logs; sole writer of the shared state Map; hot path is counter-only.
2. **Core** (`templateDownloadCore.ts`) — pure math/formatting; unit-tested; no Electron.
3. **Reader** (`launch.ts driveTemplatePhase`) — 500 ms poll that turns state → stepper substatus.

If you change progress display, touch the **reader/core**. If you change *what/how* downloads, touch the **task**. They communicate only through `getTemplateDownloadState()`.