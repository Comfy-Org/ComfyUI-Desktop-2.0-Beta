/**
 * Per-installation crash error buffer.
 *
 * When ComfyUI exits with a non-zero code we capture the last chunk of
 * raw stderr alongside the exit code (the same payload main already
 * broadcasts via `comfy-exited`). PII scrubbing happens on the telemetry
 * path; this buffer feeds the user-visible crashed-state lifecycle view
 * and must stay readable. The renderer's lifecycle view picks up
 * the live event for a crash that happens while the panel is mounted, but
 * a crashed instance whose Comfy Instance window is then refreshed (or
 * whose panel view is recreated by main) needs to re-fetch the same
 * detail to render the crashed-state body. This module is the source of
 * truth for that "last crash, even after a refresh" lookup.
 *
 * The buffer clears on the next launch attempt for that installation —
 * the user has implicitly acknowledged the previous failure by trying
 * again. Each entry is also size-capped (`MAX_BUFFER_BYTES` of stderr
 * tail) so a chatty ComfyUI process can't pin unbounded text in main.
 */
import type { ComfyExitedData } from '../../types/ipc'

/** Hard cap on the stderr tail we retain per installation (bytes). */
export const MAX_BUFFER_BYTES = 8 * 1024

const _crashes = new Map<string, ComfyExitedData>()

/**
 * Record a crash for an installation. The `lastStderr` field, if present,
 * is truncated from the front to honour `MAX_BUFFER_BYTES` so we always
 * keep the most recent (and usually most informative) tail.
 */
export function recordCrash(data: ComfyExitedData): void {
  const trimmed: ComfyExitedData = { ...data }
  if (trimmed.lastStderr && trimmed.lastStderr.length > MAX_BUFFER_BYTES) {
    trimmed.lastStderr = trimmed.lastStderr.slice(-MAX_BUFFER_BYTES)
  }
  // Stamp the recording time so a later hydration (panel WebContents
  // recreated, etc.) can compute crash-to-relaunch latency. Honour an
  // already-set value if the caller pre-stamped — fold the live-event
  // timestamp through if present.
  if (trimmed.crashedAtMs === undefined) {
    trimmed.crashedAtMs = Date.now()
  }
  _crashes.set(data.installationId, trimmed)
}

/** Clear the stored crash for an installation (e.g. on next launch). */
export function clearCrash(installationId: string): void {
  _crashes.delete(installationId)
}

/** Read back the last crash for an installation, if any. */
export function getCrash(installationId: string): ComfyExitedData | null {
  return _crashes.get(installationId) ?? null
}

/** Test-only reset hook. */
export function _resetCrashBuffer(): void {
  _crashes.clear()
}
