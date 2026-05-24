/**
 * Coarse error categorisation for telemetry. Shared between main
 * (`bucketError` in `telemetry.ts`) and renderer (`toErrorBucket` in
 * `lib/telemetry.ts`) so both surfaces classify identically.
 *
 * Used by:
 * - `execution.error` events from `executionTap.ts` (Python tracebacks
 * parsed from ComfyUI stdout).
 * - `trackedStep().error` events from `mainTelemetry.trackedStep()`
 * (install / migrate / snapshot-restore pipelines).
 * - `app_update.error` and any other failure event with a free-form
 * `error_message` that needs a stable categorical column.
 *
 * The bucket vocabulary is intentionally small so the Errors dashboard
 * can rank "what kind of failure is most common" without exploding
 * cardinality. Raw `error_class` / `error_message` are still sent
 * alongside the bucket for drill-down.
 *
 * Expansion (was 7 buckets, now 12):
 * - oom — CUDA / system / Linux OOM-killer signals
 * - python — generic Python exceptions not in a more specific bucket
 * - node_missing — ComfyUI custom-node not found
 * - import_error — ImportError / ModuleNotFoundError
 * - cuda_init — CUDA not available / no CUDA-capable device
 *
 * Order matters in `bucketError`: more-specific patterns are checked
 * first so e.g. `'ImportError: ...'` lands in `import_error`, not
 * `python`.
 */

export type ErrorBucket =
  | 'cancelled'
  | 'timeout'
  | 'network'
  | 'disk'
  | 'permissions'
  | 'path'
  | 'oom'
  | 'node_missing'
  | 'import_error'
  | 'cuda_init'
  | 'python'
  | 'other'
  | 'unknown'

export function bucketError(input: unknown): ErrorBucket {
  const raw = input instanceof Error ? input.message : typeof input === 'string' ? input : ''
  if (!raw) return 'unknown'
  const message = raw.toLowerCase()
  // User cancellation should win even if the message also mentions other
  // failures triggered by the cancel.
  if (message.includes('cancel')) return 'cancelled'
  if (message.includes('timeout')) return 'timeout'
  if (
    message.includes('out of memory') ||
    message.includes('outofmemoryerror') ||
    /\bkilled\b/.test(message)
  ) {
    return 'oom'
  }
  if (
    message.includes('cuda not available') ||
    message.includes('no cuda-capable device') ||
    message.includes('cuda runtime error')
  ) {
    return 'cuda_init'
  }
  if (message.includes('importerror') || message.includes('modulenotfounderror')) {
    return 'import_error'
  }
  if (
    /\bnode (not found|missing)\b/.test(message) ||
    message.includes('unknown node type') ||
    message.includes('nodenotfound')
  ) {
    return 'node_missing'
  }
  if (message.includes('network') || message.includes('fetch')) return 'network'
  if (message.includes('disk') || message.includes('space') || message.includes('enospc'))
    return 'disk'
  if (message.includes('permission') || message.includes('access') || message.includes('eacces'))
    return 'permissions'
  if (message.includes('path') || message.includes('enoent')) return 'path'
  // Final catch-all for a known Python exception class shape ("FooError" /
  // "FooException" at message start) that doesn't match any specific bucket.
  if (/^[a-z][a-z0-9_.]*(error|exception)\b/.test(message)) return 'python'
  return 'other'
}
