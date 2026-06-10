/**
 * Coarse error categorisation for telemetry, shared by main + renderer so both classify identically. Small vocabulary keeps the Errors dashboard low-cardinality; raw message is sent alongside for drill-down.
 * Order matters in `bucketError`: more-specific patterns are checked first.
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
  | 'source_missing'
  | 'other'
  | 'unknown'

export function bucketError(input: unknown): ErrorBucket {
  const raw = input instanceof Error ? input.message : typeof input === 'string' ? input : ''
  if (!raw) return 'unknown'
  const message = raw.toLowerCase()
  // Cancellation wins even if the message also mentions cancel-triggered failures.
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
  // Tensor / shape mismatch (torch "size mismatch", "shape '[...]' is invalid", "expected ... got ...").
  if (
    message.includes('size mismatch') ||
    message.includes('shape mismatch') ||
    /shape '?\[.+\]'? is invalid/.test(message) ||
    /expected .+ (got|but got|to be) /.test(message) ||
    /\bdimensions?\b.*\b(mismatch|must match|do not match)\b/.test(message)
  ) {
    return 'shape_mismatch'
  }
  // Model load: corrupt / wrong-format / missing-key checkpoints & safetensors.
  if (
    message.includes('safetensors') ||
    message.includes('error while deserializing') ||
    /\b(missing|unexpected) key\(s\)/.test(message) ||
    /\b(checkpoint|state_?dict)\b.*\b(load|loading|corrupt)/.test(message)
  ) {
    return 'model_load'
  }
  // Rejected by ComfyUI's prompt validator (`error_class: 'validation_failed'`).
  if (
    message.includes('validation_failed') ||
    message.includes('prompt outputs failed validation')
  ) {
    return 'validation'
  }
  // Migration `source` phase — adoption couldn't obtain the ComfyUI
  // source: the legacy tree is gone and the replacement clone from a git
  // mirror also failed ("source-missing: Downloading ComfyUI source
  // from …"). Bucketed before `network` because the mirror-clone
  // failures also reach a fetch site and would otherwise bucket as
  // network.
  if (
    message.includes('source-missing') ||
    message.includes('source_missing') ||
    /source.*clone.*fail/.test(message)
  ) {
    return 'source_missing'
  }
  if (message.includes('network') || message.includes('fetch')) return 'network'
  if (message.includes('disk') || message.includes('space') || message.includes('enospc'))
    return 'disk'
  if (message.includes('permission') || message.includes('access') || message.includes('eacces'))
    return 'permissions'
  if (message.includes('path') || message.includes('enoent')) return 'path'
  // Python exception class shape ("FooError"/"FooException"). Matched case-sensitively on `raw` (uppercase first letter) so lowercase noise like "module.error" doesn't false-positive.
  if (/\b[A-Z][A-Za-z0-9_.]*(?:Error|Exception)\b/.test(raw)) return 'python'
  return 'other'
}
