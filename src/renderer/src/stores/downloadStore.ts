import { defineStore } from 'pinia'
import { computed, reactive } from 'vue'
import type { ModelDownloadProgress, Unsubscribe } from '../types/ipc'
import {
  emitTelemetryAction,
  isTerminalModelDownloadStatus,
  toFileExtension,
  toModelDirectoryBucket,
  toSizeBucket
} from '../lib/telemetry'

export const useDownloadStore = defineStore('downloads', () => {
  const downloads = reactive(new Map<string, ModelDownloadProgress>())
  /** Active main-process subscriptions (progress + removed +
   * cleared-finished). Populated on `init()`, kept so a future
   * `teardown()` could detach them — and so the idempotent
   * `init()` guard has something to check. */
  const unsubs: Unsubscribe[] = []

  function upsert(progress: ModelDownloadProgress, opts: { isSeed?: boolean } = {}): void {
    const previous = downloads.get(progress.url)
    downloads.set(progress.url, { ...progress })

    // `isSeed` suppresses telemetry on the initial replay from
    // `listModelDownloads` — those downloads already fired their start /
    // result events in the session they actually happened in. Replaying
    // them here would double-count.
    if (opts.isSeed) return

    // emit `model_download.started` on the FIRST live
    // sighting of a non-terminal download. Today only `.result` exists,
    // so attempt-vs-success rate is unknowable.
    if (!previous && !isTerminalModelDownloadStatus(progress.status)) {
      emitTelemetryAction('comfy.desktop.model_download.started', {
        directory_bucket: toModelDirectoryBucket(progress.directory),
        file_ext: toFileExtension(progress.filename),
        size_bucket: toSizeBucket(progress.totalBytes)
      })
    }

    if (
      isTerminalModelDownloadStatus(progress.status) &&
      (!previous || previous.status !== progress.status)
    ) {
      emitTelemetryAction('comfy.desktop.model_download.result', {
        result: progress.status,
        directory_bucket: toModelDirectoryBucket(progress.directory),
        file_ext: toFileExtension(progress.filename),
        size_bucket: toSizeBucket(progress.totalBytes)
      })
    }
  }

  function init(): void {
    if (unsubs.length > 0) return

    // Seed with any in-flight + recently-finished downloads. Backed by
    // main's `getAllDownloads()` so the Settings tab + popup history
    // are non-empty on first paint after a window opens mid-flow.
    // `isSeed: true` suppresses telemetry (start/result events fired
    // in the original session, not this one).
    window.api.listModelDownloads().then((list) => {
      for (const p of list) upsert(p, { isSeed: true })
    })

    // Subscribe to live progress + main-driven removals. Single-source
    // of truth lives in main so dismissals issued from one surface
    // propagate to every other (popup ↔ Settings tab).
    unsubs.push(
      window.api.onModelDownloadProgress((p) => upsert(p)),
      window.api.onModelDownloadRemoved(({ url }) => {
        downloads.delete(url)
      }),
      window.api.onModelDownloadsClearedFinished(({ urls }) => {
        for (const url of urls) downloads.delete(url)
      })
    )
  }

  /** Dismiss a terminal entry. Routes through main so every other
   * surface drops it via the broadcast — local state is updated by
   * the `model-download-removed` listener registered in `init()`,
   * not by this function, so the two surfaces stay in lockstep. */
  function dismiss(url: string): void {
    void window.api.dismissModelDownload(url)
  }

  /** Bulk-dismiss every terminal entry. Same broadcast contract as
   * `dismiss()`. */
  function clearFinished(): void {
    void window.api.clearFinishedModelDownloads()
  }

  const activeDownloads = computed(() => {
    const result: ModelDownloadProgress[] = []
    downloads.forEach((d) => {
      if (d.status === 'pending' || d.status === 'downloading' || d.status === 'paused') {
        result.push(d)
      }
    })
    return result
  })

  const finishedDownloads = computed(() => {
    const result: ModelDownloadProgress[] = []
    downloads.forEach((d) => {
      if (d.status === 'completed' || d.status === 'error' || d.status === 'cancelled') {
        result.push(d)
      }
    })
    return result
  })

  const hasDownloads = computed(() => downloads.size > 0)

  return {
    downloads,
    init,
    upsert,
    dismiss,
    clearFinished,
    activeDownloads,
    finishedDownloads,
    hasDownloads
  }
})
