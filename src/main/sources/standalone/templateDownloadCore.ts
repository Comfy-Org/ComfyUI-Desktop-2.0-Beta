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
}

export function isTerminal(status: TemplateDownloadStatus): boolean {
  return status === 'done' || status === 'error' || status === 'cancelled'
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
  }
}

export function gbStr(bytes: number): string {
  return (bytes / (1024 * 1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 * 1024 ? 0 : 1)
}

/**
 * Build the rich, localized substatus line shown under the active step. Pure
 * (state → string); called only by the 500 ms reader, never the hot path.
 */
export function formatTemplateSubStatus(s: TemplateDownloadSummary): string {
  if (s.status === 'resolving') return t('standalone.templateModelsResolving')
  if (s.status === 'done') return t('standalone.templateModelsDone')
  if (s.status === 'error') return t('standalone.templateModelsError')
  if (s.status === 'cancelled') return t('standalone.templateModelsCancelled')
  const speed = s.speedMBs > 0 ? s.speedMBs.toFixed(1) : '0.0'
  const eta = s.etaSecs >= 0 ? formatTime(s.etaSecs) : '—'
  return t('standalone.templateModelsDownloading', {
    file: s.currentFile,
    index: s.fileIndex,
    count: s.fileCount,
    doneGb: gbStr(s.receivedBytes),
    totalGb: gbStr(s.totalBytes),
    speed,
    eta,
  })
}
