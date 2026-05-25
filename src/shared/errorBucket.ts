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
 * Bucket vocabulary:
 * - oom — CUDA / system / Linux OOM-killer signals
 * - shape_mismatch — torch tensor / dimension errors (dominant ML
 * failure mode after OOM)
 * - model_load — corrupt or wrong-format checkpoints, missing keys
 * - cuda_init — CUDA not available / no CUDA-capable device
 * - import_error — ImportError / ModuleNotFoundError
 * - node_missing — ComfyUI custom-node not found
 * - validation — ComfyUI prompt validator rejected the workflow
 * - python — Python exception class shape not in a more specific bucket
 *
 * Order matters in `bucketError`: more-specific patterns are checked
 * first so e.g. `'ImportError: ...'` lands in `import_error`, not
 * `python`, and `'shape mismatch'` lands in `shape_mismatch`, not
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
  | 'shape_mismatch'
  | 'model_load'
  | 'validation'
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
  // Tensor / shape mismatch — dominant non-OOM failure mode in ComfyUI
  // workflows where nodes don't compose. Catches torch's "size mismatch
  // for ...", "shape '[1, 4, 64]' is invalid for input of size ...",
  // and "expected ... got ..." phrasings.
  if (
    message.includes('size mismatch') ||
    message.includes('shape mismatch') ||
    /shape '?\[.+\]'? is invalid/.test(message) ||
    /expected .+ (got|but got|to be) /.test(message) ||
    /\bdimensions?\b.*\b(mismatch|must match|do not match)\b/.test(message)
  ) {
    return 'shape_mismatch'
  }
  // Model load — corrupt / wrong-format / missing-key checkpoints &
  // safetensors. ComfyUI surfaces these as "Error while deserializing",
  // "missing key(s)", "unexpected key(s)", "no such file or directory:
  // *.safetensors", etc.
  if (
    message.includes('safetensors') ||
    message.includes('error while deserializing') ||
    /\b(missing|unexpected) key\(s\)/.test(message) ||
    /\b(checkpoint|state_?dict)\b.*\b(load|loading|corrupt)/.test(message)
  ) {
    return 'model_load'
  }
  // Workflow validation rejected by ComfyUI's prompt validator. The
  // executionTap emits these with `error_class: 'validation_failed'`.
  if (
    message.includes('validation_failed') ||
    message.includes('prompt outputs failed validation')
  ) {
    return 'validation'
  }
  if (message.includes('network') || message.includes('fetch')) return 'network'
  if (message.includes('disk') || message.includes('space') || message.includes('enospc'))
    return 'disk'
  if (message.includes('permission') || message.includes('access') || message.includes('eacces'))
    return 'permissions'
  if (message.includes('path') || message.includes('enoent')) return 'path'
  // Python exception class shape ("FooError" / "FooException"). Match
  // against the ORIGINAL (case-sensitive) `raw` — requires an uppercase
  // first letter — so we don't false-positive on lowercase noise like
  // "module.error", "user.exception", "see foo.error.somefile". scrubAll
  // can still strip a path prefix and leave the class name mid-message,
  // which is fine — no `^` anchor.
  if (/\b[A-Z][A-Za-z0-9_.]*(?:Error|Exception)\b/.test(raw)) return 'python'
  return 'other'
}
