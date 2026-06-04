import type { ModelDownloadStatus } from '../../../types/ipc'

export type TelemetryValue = boolean | number | string | null | undefined
export type TelemetryContext = Record<string, TelemetryValue>

export const TELEMETRY_ACTION_EVENT_NAME = 'launcher-telemetry-action'

export interface TelemetryActionEventDetail {
  actionName: string
  context?: TelemetryContext
}

export function emitTelemetryAction(actionName: string, context: TelemetryContext = {}): void {
  window.dispatchEvent(
    new CustomEvent<TelemetryActionEventDetail>(TELEMETRY_ACTION_EVENT_NAME, {
      detail: { actionName, context }
    })
  )
}

export function toVariantBucket(variantId: string | undefined): string {
  if (!variantId) return 'unknown'
  return variantId.replace(/^(win|mac|linux)-/, '')
}

// Re-exported so renderer and main classify errors identically.
export { bucketError as toErrorBucket } from '../../../shared/errorBucket'

export function toCountBucket(count: number): string {
  if (count <= 0) return '0'
  if (count === 1) return '1'
  if (count <= 2) return '2'
  if (count <= 4) return '3_4'
  if (count <= 9) return '5_9'
  return '10_plus'
}

export function toSizeBucket(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return 'unknown'
  if (bytes < 10 * 1024 * 1024) return 'lt_10mb'
  if (bytes < 100 * 1024 * 1024) return '10_99mb'
  if (bytes < 1024 * 1024 * 1024) return '100mb_1gb'
  return 'gte_1gb'
}

export function toFileExtension(filename: string | undefined): string {
  if (!filename) return 'unknown'
  const idx = filename.lastIndexOf('.')
  if (idx < 0 || idx === filename.length - 1) return 'none'
  return filename.slice(idx + 1).toLowerCase()
}

export function toModelDirectoryBucket(directory: string | undefined): string {
  if (!directory) return 'unknown'
  const normalized = directory.replace(/\\/g, '/').toLowerCase()
  const parts = normalized.split('/').filter(Boolean)
  const leaf = parts[parts.length - 1] || 'unknown'
  const known = new Set([
    'checkpoints',
    'loras',
    'vae',
    'controlnet',
    'embeddings',
    'upscale_models',
    'diffusion_models',
    'clip_vision',
    'clip',
    'text_encoders',
    'unet',
    'vae_approx'
  ])
  return known.has(leaf) ? leaf : 'other'
}

export function isTerminalModelDownloadStatus(status: ModelDownloadStatus): boolean {
  return status === 'completed' || status === 'error' || status === 'cancelled'
}

/** Coarse hardware tier for cohort filtering; raw gpu_model / gpu_vram_gb are also sent for finer slicing. */
export type GpuTier = 'high' | 'mid' | 'low' | 'sub_low' | 'apple' | 'cpu_only'

export function deriveGpuTier(opts: {
  vendor: string | null | undefined
  vramGb: number | null | undefined
}): GpuTier {
  const vendor = (opts.vendor ?? '').toLowerCase()
  // Main reports 'mps' for Apple Silicon; also accept literal 'apple'.
  if (vendor === 'apple' || vendor === 'mps') return 'apple'
  const vram = opts.vramGb ?? 0
  if (!vendor) return 'cpu_only'
  if (vendor !== 'nvidia' && vendor !== 'amd') return 'sub_low'
  if (vram <= 0) return 'cpu_only'
  if (vram >= 24) return 'high'
  if (vram >= 12) return 'mid'
  if (vram >= 6) return 'low'
  return 'sub_low'
}
