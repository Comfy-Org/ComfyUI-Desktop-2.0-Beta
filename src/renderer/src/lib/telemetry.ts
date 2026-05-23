import type { ModelDownloadStatus } from '../../../types/ipc'

export type TelemetryValue = boolean | number | string | null | undefined
export type TelemetryContext = Record<string, TelemetryValue>

export const TELEMETRY_ACTION_EVENT_NAME = 'launcher-telemetry-action'

export interface TelemetryActionEventDetail {
  actionName: string
  context?: TelemetryContext
}

export function emitTelemetryAction(actionName: string, context: TelemetryContext = {}): void {
  window.dispatchEvent(new CustomEvent<TelemetryActionEventDetail>(TELEMETRY_ACTION_EVENT_NAME, {
    detail: { actionName, context },
  }))
}

export function toVariantBucket(variantId: string | undefined): string {
  if (!variantId) return 'unknown'
  return variantId.replace(/^(win|mac|linux)-/, '')
}

// Re-exported from `src/shared/errorBucket.ts` so renderer and main classify
// identically. Kept as `toErrorBucket` for the renderer's existing callers.
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
    'vae_approx',
  ])
  return known.has(leaf) ? leaf : 'other'
}

export function isTerminalModelDownloadStatus(status: ModelDownloadStatus): boolean {
  return status === 'completed' || status === 'error' || status === 'cancelled'
}

/**
 * Coarse hardware tier classification for cohort filtering.
 *
 * The exact thresholds live in `docs/telemetry/04-tracking-plan.md` §2.7
 * and are deliberately heuristic — the raw `gpu_model` and `gpu_vram_gb`
 * are also sent to PostHog, so finer slicing is always available. The
 * tier exists so dashboards can rank "high-end vs low-end rigs" without
 * re-deriving classification per query.
 *
 * Rules:
 *   - `apple`    — vendor is Apple (M1 / M2 / M3 unified memory; perf curve
 *                  differs from discrete cards enough to warrant a tier).
 *   - `high`     — NVIDIA / AMD with VRAM ≥ 24 GB.
 *   - `mid`      — NVIDIA / AMD with VRAM 12-23 GB.
 *   - `low`      — NVIDIA / AMD with VRAM 6-11 GB.
 *   - `sub_low`  — NVIDIA / AMD with VRAM < 6 GB, OR any non-NVIDIA-AMD
 *                  discrete card (Intel Arc, etc. — most desktop ML
 *                  workloads struggle on these).
 *   - `cpu_only` — no GPU vendor reported, or VRAM is zero / unknown.
 */
export type GpuTier = 'high' | 'mid' | 'low' | 'sub_low' | 'apple' | 'cpu_only'

export function deriveGpuTier(opts: {
  vendor: string | null | undefined
  vramGb: number | null | undefined
}): GpuTier {
  const vendor = (opts.vendor ?? '').toLowerCase()
  if (vendor === 'apple') return 'apple'
  const vram = opts.vramGb ?? 0
  if (!vendor) return 'cpu_only'
  if (vendor !== 'nvidia' && vendor !== 'amd') return 'sub_low'
  if (vram <= 0) return 'cpu_only'
  if (vram >= 24) return 'high'
  if (vram >= 12) return 'mid'
  if (vram >= 6) return 'low'
  return 'sub_low'
}
