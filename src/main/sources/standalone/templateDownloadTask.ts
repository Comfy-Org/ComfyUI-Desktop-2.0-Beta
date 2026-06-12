import fs from 'fs'
import path from 'path'
import { download } from '../../lib/download'
import { getModelsBaseDir } from '../../lib/comfyDownloadManager'
import { getDiskSpace } from '../../lib/disk'
import { resolveTemplateModels } from './templateModels'
import {
  isTerminal,
  runPool,
  withRetry,
  truncateForMaxPath,
  gbStr,
  DISK_SPACE_ERROR,
  type TemplateDownloadState,
} from './templateDownloadCore'
import type { InstallationRecord } from '../../installations'

/**
 * Background template-model download task — the stateful half (the pure logic
 * lives in `templateDownloadCore.ts`).
 *
 * The download is kicked off the moment installation begins (so bytes flow
 * concurrently with env setup) but is *displayed* later, as a launch-span
 * stepper phase. The bridge is a process-global state map keyed by
 * installationId: the task is the SOLE writer; the install handler and the
 * launch driver are pure readers.
 *
 * Performance contract:
 *  - `onChunk` is a HOT PATH (hundreds×/sec/file): ONLY O(1) counter writes —
 *    no allocations, strings, i18n, or IPC.
 *  - A single 500 ms reader in the launch process owns ALL formatting +
 *    `sendProgress`. Display cadence is decoupled from download speed.
 *  - Files download with bounded concurrency (`runPool`, cap 3).
 */

const MODEL_POOL_CONCURRENCY = 3
const DISK_HEADROOM = 1.05
/** Per-file auto-retry budget — `download()` is single-shot, so we wrap it. A
 *  transient network drop / gated-repo blip gets up to this many extra tries
 *  before the file is marked failed (non-fatal — ComfyUI's missing-model prompt
 *  is the final safety net). */
const MODEL_DOWNLOAD_RETRIES = 2

// --- Process-global state (mirrors _operationAborts). Task = sole writer. ---
const _templateDownloads = new Map<string, TemplateDownloadState>()
const _templateAborts = new Map<string, AbortController>()

export function getTemplateDownloadState(
  installationId: string,
): TemplateDownloadState | undefined {
  return _templateDownloads.get(installationId)
}

export function abortTemplateDownload(installationId: string): void {
  const ctrl = _templateAborts.get(installationId)
  if (ctrl) {
    ctrl.abort()
    _templateAborts.delete(installationId)
  }
  const state = _templateDownloads.get(installationId)
  if (state && !isTerminal(state.status)) {
    state.status = 'cancelled'
  }
}

interface StartOpts {
  /** Human-readable log sink (already wired to `comfy-output` + `appendLog`). */
  sendOutput: (text: string) => void
}

/**
 * Kick off the background download. Synchronous + fire-and-forget. No-op if a
 * non-terminal task already exists for this install (guards install retry /
 * double-mount).
 */
export function startTemplateDownload(
  installation: InstallationRecord,
  estimatedSizeBytes: number,
  opts: StartOpts,
): void {
  const installationId = installation.id
  const existing = _templateDownloads.get(installationId)
  if (existing && !isTerminal(existing.status)) return

  const state: TemplateDownloadState = {
    status: 'resolving',
    files: [],
    estimatedTotalBytes: estimatedSizeBytes,
    speedMBs: 0,
    etaSecs: -1,
  }
  _templateDownloads.set(installationId, state)
  const abort = new AbortController()
  _templateAborts.set(installationId, abort)

  // Mirror every log line to the main-process console too, so the lifecycle is
  // visible in the `pnpm dev` terminal even if the renderer log panel hiccups.
  const log = (text: string): void => {
    console.log(`[templateDownload:${installationId}] ${text.trimEnd()}`)
    opts.sendOutput(text)
  }
  const taskOpts: StartOpts = { sendOutput: log }

  // Emit a line the instant we start so "View logs" shows life immediately —
  // before the (network) resolve step that precedes the first file.
  log(
    `[templates] Starting background download for "${installation.bundledTemplateId}" (est. ${gbStr(estimatedSizeBytes)} GB)…\n`,
  )

  void runTask(installation, state, abort.signal, taskOpts).catch((err) => {
    if (!isTerminal(state.status)) {
      state.status = 'error'
      state.error = (err as Error).message
    }
    // Surface the failure in the log — without this, a resolve/setup throw left
    // the panel silent and the step stuck.
    log(`[templates] Download task failed: ${(err as Error).message}\n`)
  })
}

async function runTask(
  installation: InstallationRecord,
  state: TemplateDownloadState,
  signal: AbortSignal,
  { sendOutput }: StartOpts,
): Promise<void> {
  const templateId = installation.bundledTemplateId as string
  sendOutput(`[templates] Resolving model list for "${templateId}"…\n`)
  const models = await resolveTemplateModels(installation, templateId)

  if (signal.aborted) { state.status = 'cancelled'; return }
  if (models.length === 0) {
    state.status = 'done'
    sendOutput('[templates] No models required for this template.\n')
    return
  }
  sendOutput(`[templates] ${models.length} model(s) to download.\n`)

  state.files = models.map((m) => ({
    name: m.filename,
    directory: m.directory,
    received: 0,
    total: 0,
    done: false,
    failed: false,
  }))

  const baseDir = getModelsBaseDir()

  // Pre-flight disk guard against the coarse estimate (× headroom). Surface a
  // hard error rather than fail N writes — or silently skip — when there's
  // clearly no room. Catches the disk filling between the pick-time pre-check
  // and download-start.
  if (state.estimatedTotalBytes > 0) {
    try {
      const { free } = await getDiskSpace(baseDir)
      if (free < state.estimatedTotalBytes * DISK_HEADROOM) {
        state.status = 'error'
        state.error = DISK_SPACE_ERROR
        sendOutput(
          `[templates] Not enough disk space for template models: ~${gbStr(state.estimatedTotalBytes)} GB needed, ${gbStr(free)} GB free. Download cancelled — free up space and grab them in-app.\n`,
        )
        return
      }
    } catch {
      // Disk probe failed — proceed; per-file write errors are non-fatal.
    }
  }

  state.status = 'downloading'

  await runPool(
    state.files,
    MODEL_POOL_CONCURRENCY,
    async (f, i) => {
      if (signal.aborted) return
      const model = models[i]!
      const destDir = path.join(baseDir, f.directory)

      // Defensively fit the on-disk name within Windows MAX_PATH before any
      // write (no-op elsewhere / on short paths). A too-long name that can't be
      // shortened is a per-file failure, not a task failure.
      const safeName = truncateForMaxPath(destDir, f.name)
      if (safeName === null) {
        f.failed = true
        sendOutput(`[templates] Skipping ${f.name}: path too long for this filesystem.\n`)
        return
      }
      const destPath = path.join(destDir, safeName)

      // Already present (prior install) — count it as done at its on-disk size.
      try {
        const stat = await fs.promises.stat(destPath)
        f.total = stat.size
        f.received = stat.size
        f.done = true
        sendOutput(`[templates] Already have ${f.directory}/${f.name}, skipping.\n`)
        return
      } catch {
        // not present — download it
      }

      sendOutput(`[templates] Downloading ${f.name} (${i + 1}/${state.files.length})…\n`)
      try {
        await fs.promises.mkdir(destDir, { recursive: true })
        await withRetry(
          () => {
            // download() resumes its own `.dl-meta` partial, so a retry
            // continues from where the dropped attempt left off rather than
            // restarting the file.
            let lastLoggedPct = 0
            return download(
              model.url,
              destPath,
              (p) => {
                // HOT PATH: O(1) counter writes only.
                f.received = p.receivedBytes
                if (f.total === 0 && p.totalMB !== '?') {
                  f.total = Math.round(parseFloat(p.totalMB) * 1048576)
                }
                state.speedMBs = p.speedMBs
                state.etaSecs = p.etaSecs
                // Throttled log: only when the integer 10% bucket advances.
                if (p.percent >= lastLoggedPct + 10) {
                  lastLoggedPct = p.percent - (p.percent % 10)
                  sendOutput(
                    `[templates]   ${f.name} — ${p.receivedMB}/${p.totalMB} MB at ${p.speedMBs.toFixed(1)} MB/s\n`,
                  )
                }
              },
              { signal },
            )
          },
          MODEL_DOWNLOAD_RETRIES,
          {
            // A user cancel must not be retried — bail immediately.
            isFatal: (err) =>
              signal.aborted || (err as Error)?.message === 'Download cancelled',
            onRetry: (attempt, err) =>
              sendOutput(
                `[templates] Retrying ${f.name} (attempt ${attempt}/${MODEL_DOWNLOAD_RETRIES + 1}): ${(err as Error).message}\n`,
              ),
          },
        )
        f.done = true
        try { f.total = (await fs.promises.stat(destPath)).size } catch {}
        f.received = f.total || f.received
        sendOutput(`[templates] Saved ${f.directory}/${safeName}.\n`)
      } catch (err) {
        const msg = (err as Error).message
        if (signal.aborted || msg === 'Download cancelled') return
        f.failed = true
        sendOutput(`[templates] Failed ${f.name}: ${msg} — will fall back to in-app download.\n`)
      }
    },
    signal,
  )

  if (signal.aborted) {
    state.status = 'cancelled'
    return
  }
  // Partial success still counts as done — missing files fall back to ComfyUI's
  // own missing-model prompt. Only an all-failed set is an error.
  const anyDone = state.files.some((f) => f.done)
  state.status = anyDone ? 'done' : 'error'
  sendOutput(
    anyDone
      ? '[templates] Template models ready.\n'
      : '[templates] No template models could be downloaded.\n',
  )
}

// Re-export the read-side helpers so consumers import from one place.
export {
  summarizeTemplateState,
  formatTemplateSubStatus,
  type TemplateDownloadState,
  type TemplateDownloadSummary,
  type FileProgress,
} from './templateDownloadCore'
