import { formatTime } from '../../lib/util'
import { t } from '../../lib/i18n'

/**
 * Pure core of the template-download feature: state shape, the read-side
 * aggregation, the bounded-concurrency pool, and the substatus formatter.
 *
 * Deliberately free of Electron/IPC/fs imports so it is unit-testable in
 * isolation (the stateful task in `templateDownloadTask.ts` composes these).
 * These are the pieces that carry the correctness-critical math, so they're
 * the ones worth testing without a window.
 */

export interface FileProgress {
  name: string
  directory: string
  /** Bytes written so far (hot-path target). */
  received: number
  /** Real total once known (0 until the first chunk / completion). */
  total: number
  done: boolean
  failed: boolean
}

export type TemplateDownloadStatus =
  | 'resolving'
  | 'downloading'
  | 'done'
  | 'error'
  | 'cancelled'

export interface TemplateDownloadState {
  status: TemplateDownloadStatus
  /** One entry per required model — the sole mutation target of the hot path. */
  files: FileProgress[]
  /** Index `sizeBytes` estimate; the cumulative-bar denominator until real
   *  per-file totals are known. */
  estimatedTotalBytes: number
  /** Latest instantaneous speed/ETA snapshot. Written O(1) on each chunk. */
  speedMBs: number
  etaSecs: number
  error?: string
}

export interface TemplateDownloadSummary {
  status: TemplateDownloadStatus
  receivedBytes: number
  totalBytes: number
  doneCount: number
  fileCount: number
  fileIndex: number
  currentFile: string
  speedMBs: number
  etaSecs: number
  /** 0–100, clamped; -1 when no denominator is known yet. */
  percent: number
  /** Carried through from the state so the formatter can pick error-specific
   *  copy (e.g. the disk-space message) without re-reading the state. */
  error?: string
}

export function isTerminal(status: TemplateDownloadStatus): boolean {
  return status === 'done' || status === 'error' || status === 'cancelled'
}

/**
 * Turn a per-file `download()` failure message into a human log line. A gated
 * Hugging Face / Civitai repo answers 401/403 — surface a clearer "requires
 * login or a license" hint instead of the raw `HTTP 401`, since the fix (sign
 * in / accept the license in ComfyUI) is different from a transient failure.
 * Pure → unit-testable. `filename` names the file the line is about.
 */
export function describeDownloadFailure(filename: string, message: string): string {
  if (/\b(401|403)\b/.test(message)) {
    return `[templates] Couldn't download ${filename}: the model repo requires a login or license. Open the template in ComfyUI to sign in / accept it, then it'll download in-app.\n`
  }
  return `[templates] Failed ${filename}: ${message} — will fall back to in-app download.\n`
}

/** One downloads-tray row mirrored from our task. Structurally a subset of
 *  `comfyDownloadManager`'s `DownloadProgress`, declared here so the mapper
 *  stays Electron-free and unit-testable. */
export interface TemplateTrayEntry {
  url: string
  filename: string
  directory: string
  progress: number
  status: 'downloading' | 'completed' | 'error'
  receivedBytes: number
  totalBytes: number
  speedBytesPerSec: number
  etaSeconds: number
}

/**
 * Map the task's per-file state into downloads-tray rows so the title-bar tray
 * can continue showing the SAME download after the user skips ahead to ComfyUI
 * — no restart (our resume-capable task keeps running; the tray only mirrors
 * it). One row per file, keyed by a stable synthetic url so the tray dedupes /
 * updates in place across ticks. Pure — no Electron, so the mapping is
 * unit-testable. Speed/ETA come from the shared snapshot and ride on the first
 * still-running row (the tray shows one active row at a time).
 */
export function templateStateToTrayEntries(
  state: TemplateDownloadState,
  urlPrefix = 'template-model://',
): TemplateTrayEntry[] {
  const speedBytesPerSec = state.speedMBs > 0 ? Math.round(state.speedMBs * 1048576) : 0
  const etaSeconds = state.etaSecs >= 0 ? state.etaSecs : 0
  let liveRowAssigned = false

  return state.files.map((file) => {
    const status: TemplateTrayEntry['status'] = file.failed
      ? 'error'
      : file.done
        ? 'completed'
        : 'downloading'
    const progress = file.total > 0 ? Math.min(1, file.received / file.total) : 0
    const isLiveRow = status === 'downloading' && !liveRowAssigned
    if (isLiveRow) liveRowAssigned = true
    return {
      url: `${urlPrefix}${file.directory}/${file.name}`,
      filename: file.name,
      directory: file.directory,
      progress,
      status,
      receivedBytes: file.received,
      totalBytes: file.total,
      speedBytesPerSec: isLiveRow ? speedBytesPerSec : 0,
      etaSeconds: isLiveRow ? etaSeconds : 0,
    }
  })
}

/**
 * Run `attempt` up to `1 + retries` times, returning the first success. Rethrows
 * the last error once all tries are exhausted. Stops early (no retry) when
 * `isFatal` returns true — used so a user cancel isn't retried. `onRetry(next,
 * err)` fires before each re-attempt for logging. Pure (no module state) so the
 * retry policy is unit-testable without a real download.
 */
export async function withRetry<T>(
  attempt: () => Promise<T>,
  retries: number,
  opts?: {
    isFatal?: (err: unknown) => boolean
    onRetry?: (nextAttempt: number, err: unknown) => void
  },
): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i <= retries; i++) {
    try {
      return await attempt()
    } catch (err) {
      lastErr = err
      if (opts?.isFatal?.(err)) throw err
      if (i < retries) opts?.onRetry?.(i + 2, err)
    }
  }
  throw lastErr
}

/** Windows MAX_PATH is 260 chars (259 usable + null terminator). */
const WIN_MAX_PATH = 259

/**
 * Defensively shorten a model filename so `<dir>/<stem><ext>` stays within the
 * Windows MAX_PATH limit (no-op on other platforms / short paths). Mirrors the
 * truncation `startModelDownload` applies, so our `download()` write can't fail
 * on a long upstream filename. Returns the (possibly shortened) filename, or
 * null when even an empty stem wouldn't fit. Pure — `platform` is injected so it
 * can be unit-tested off Windows.
 */
export function truncateForMaxPath(
  destDir: string,
  filename: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== 'win32') return filename
  const sep = '\\'
  const fullLen = destDir.length + sep.length + filename.length
  if (fullLen <= WIN_MAX_PATH) return filename
  const dot = filename.lastIndexOf('.')
  const ext = dot > 0 ? filename.slice(dot) : ''
  const stem = dot > 0 ? filename.slice(0, dot) : filename
  const available = WIN_MAX_PATH - destDir.length - sep.length - ext.length
  if (available <= 0) return null
  return stem.slice(0, available) + ext
}

/**
 * Run `worker` over `items` with at most `concurrency` in flight at once. A
 * rolling pool (not fixed batches) so a single large item can't stall the
 * others. Never rejects — each item's outcome is the worker's responsibility;
 * an aborted signal stops scheduling further items. Pure (no module state).
 */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (items.length === 0) return
  const cap = Math.max(1, Math.min(concurrency, items.length))
  let next = 0
  async function runner(): Promise<void> {
    for (;;) {
      if (signal?.aborted) return
      const i = next++
      if (i >= items.length) return
      await worker(items[i] as T, i)
    }
  }
  await Promise.all(Array.from({ length: cap }, () => runner()))
}

/**
 * Derive cumulative progress from the per-file counters. Pure — the single
 * place the "X of Y" math lives, so it's unit-testable without a download.
 */
export function summarizeTemplateState(
  state: TemplateDownloadState,
): TemplateDownloadSummary {
  const fileCount = state.files.length
  let receivedBytes = 0
  let knownTotal = 0
  let doneCount = 0
  let activeIndex = 0
  for (let i = 0; i < fileCount; i++) {
    const f = state.files[i]!
    receivedBytes += f.received
    knownTotal += f.total
    if (f.done || f.failed) doneCount++
    else if (activeIndex === 0) activeIndex = i + 1 // first not-finished file
  }
  const fileIndex = activeIndex === 0 ? fileCount : activeIndex
  const current = fileCount > 0 ? state.files[Math.min(fileIndex, fileCount) - 1] : undefined
  const totalBytes = knownTotal > 0 ? Math.max(knownTotal, receivedBytes) : state.estimatedTotalBytes
  const percent =
    state.status === 'done'
      ? 100
      : totalBytes > 0
        ? Math.min(99, Math.round((receivedBytes / totalBytes) * 100))
        : -1
  return {
    status: state.status,
    receivedBytes,
    totalBytes,
    doneCount,
    fileCount,
    fileIndex,
    currentFile: current?.name ?? '',
    speedMBs: state.speedMBs,
    etaSecs: state.etaSecs,
    percent,
    error: state.error,
  }
}

export function gbStr(bytes: number): string {
  return (bytes / (1024 * 1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 * 1024 ? 0 : 1)
}

/** Internal task error codes that map to a dedicated substatus message. */
export const DISK_SPACE_ERROR = 'insufficient-disk'

/** i18n key for each non-downloading status (the `downloading` line is built
 *  separately since it interpolates per-file figures). */
const STATUS_MESSAGE_KEY: Record<
  Exclude<TemplateDownloadStatus, 'downloading'>,
  string
> = {
  resolving: 'standalone.templateModelsResolving',
  done: 'standalone.templateModelsDone',
  error: 'standalone.templateModelsError',
  cancelled: 'standalone.templateModelsCancelled',
}

/**
 * Build the rich, localized substatus line shown under the active step. Pure
 * (state → string); called only by the 500 ms reader, never the hot path.
 */
export function formatTemplateSubStatus(summary: TemplateDownloadSummary): string {
  const { status } = summary

  if (status === 'error' && summary.error === DISK_SPACE_ERROR) {
    return t('standalone.templateModelsNoSpace')
  }
  if (status !== 'downloading') {
    return t(STATUS_MESSAGE_KEY[status])
  }

  const speed = summary.speedMBs > 0 ? summary.speedMBs.toFixed(1) : '0.0'
  const eta = summary.etaSecs >= 0 ? formatTime(summary.etaSecs) : '—'
  return t('standalone.templateModelsDownloading', {
    file: summary.currentFile,
    index: summary.fileIndex,
    count: summary.fileCount,
    doneGb: gbStr(summary.receivedBytes),
    totalGb: gbStr(summary.totalBytes),
    speed,
    eta,
  })
}
