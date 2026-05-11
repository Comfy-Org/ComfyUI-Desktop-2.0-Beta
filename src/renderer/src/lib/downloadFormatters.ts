/**
 * Shared formatting + status-class helpers for the model-download UIs.
 *
 * Both the title-bar popup `DownloadsView` (transient, no Pinia / no
 * vue-i18n) and the Settings tab `DownloadsView` (full renderer) call
 * these. The popup's tsconfig slice can't reach the renderer's view
 * layer directly, but it CAN import from `src/renderer/src/lib`, so
 * this is the de-duplication seam.
 *
 * Keep these pure — no Pinia, no IPC, no DOM. The function inputs are
 * the minimal shape both surfaces share (URL + filename + progress +
 * the in-flight byte / speed / ETA + status), expressed as a
 * structural type so the popup's locally-mirrored `DownloadEntry` and
 * the renderer's `ModelDownloadProgress` both fit.
 */

export interface DownloadFormatInput {
  filename: string
  directory?: string
  progress: number
  receivedBytes?: number
  totalBytes?: number
  speedBytesPerSec?: number
  etaSeconds?: number
  status: 'pending' | 'downloading' | 'paused' | 'completed' | 'error' | 'cancelled'
  error?: string
}

export function fileLabel(d: Pick<DownloadFormatInput, 'filename' | 'directory'>): string {
  return d.directory ? `${d.directory} / ${d.filename}` : d.filename
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`
  return `${(bytes / 1073741824).toFixed(2)} GB`
}

export function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec < 1048576) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`
  return `${(bytesPerSec / 1048576).toFixed(1)} MB/s`
}

export function formatEta(seconds: number): string {
  if (seconds < 60) return `${Math.ceil(seconds)}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s`
  const h = Math.floor(seconds / 3600)
  const m = Math.ceil((seconds % 3600) / 60)
  return `${h}h ${m}m`
}

/** Single-line status summary suitable for the compact popup row.
 *  The Settings tab uses the same string for the in-flight states and
 *  appends the total size to the `'completed'` line — pass
 *  `{ completedShowsSize: true }` to opt into that variant. */
export function statusLine(
  d: DownloadFormatInput,
  opts: { completedShowsSize?: boolean } = {},
): string {
  const pct = Math.round(d.progress * 100)
  switch (d.status) {
    case 'pending':
      return 'Waiting…'
    case 'downloading': {
      const parts: string[] = []
      if (d.totalBytes && d.totalBytes > 0 && d.receivedBytes != null) {
        parts.push(`${formatBytes(d.receivedBytes)} / ${formatBytes(d.totalBytes)}`)
      }
      parts.push(`${pct}%`)
      if (d.speedBytesPerSec && d.speedBytesPerSec > 0) {
        parts.push(formatSpeed(d.speedBytesPerSec))
      }
      if (d.etaSeconds != null && d.etaSeconds > 0 && isFinite(d.etaSeconds)) {
        parts.push(formatEta(d.etaSeconds))
      }
      return parts.join(' · ')
    }
    case 'paused':
      return `Paused at ${pct}%`
    case 'completed':
      return opts.completedShowsSize && d.totalBytes
        ? `Completed · ${formatBytes(d.totalBytes)}`
        : 'Completed'
    case 'error':
      return d.error || 'Error'
    case 'cancelled':
      return 'Cancelled'
    default:
      return ''
  }
}

export function statusKindClass(d: Pick<DownloadFormatInput, 'status'>): string {
  switch (d.status) {
    case 'completed':
      return 'is-completed'
    case 'error':
      return 'is-error'
    case 'cancelled':
      return 'is-cancelled'
    case 'paused':
      return 'is-paused'
    default:
      return 'is-active'
  }
}
