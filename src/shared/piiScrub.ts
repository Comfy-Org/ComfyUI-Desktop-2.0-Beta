/**
 * Best-effort PII and secret scrubbing for telemetry payloads.
 *
 * Strips usernames out of Windows / macOS / Linux home directory paths and
 * redacts well-known credential shapes (Bearer tokens, OpenAI / Hugging Face
 * keys, basic-auth in URLs, `*KEY=…` / `*SECRET=…` env-style assignments) so
 * tracebacks and error messages can be safely forwarded to Datadog and
 * PostHog.
 *
 * Centralized so that every telemetry / off-box forwarder — the
 * main-process `forwardDatadogError`, the `executionTap` traceback emitter,
 * and the renderer-side `scrubTelemetryContext` safety net — applies
 * identical rules. Adding a pattern here updates every call site at once.
 *
 * Not applied to logs displayed locally to the user (e.g. the crashed-state
 * lifecycle view or the console modal) — those need to be readable for
 * debugging and never leave the user's machine.
 *
 * Lives in `src/shared/` because both main and renderer import it; the
 * file has no runtime dependencies on Electron, Node, or the DOM so it
 * is safe to bundle into either side.
 */

const PII_PATH_PATTERNS: RegExp[] = [
  /([A-Za-z]:[\\/]Users[\\/])[^\\/]+?(?=[\\/]|$)/gi,
  /(\/Users\/)[^\\/]+?(?=\/|$)/gi,
  /(\/home\/)[^\\/]+?(?=\/|$)/gi,
]

const SECRET_REPLACEMENTS: [RegExp, string | ((...args: string[]) => string)][] = [
  [/sk-[A-Za-z0-9_-]{20,}/g, '[REDACTED]'],
  [/hf_[A-Za-z0-9]{20,}/g, '[REDACTED]'],
  [/Bearer\s+[A-Za-z0-9._\-/+]{20,}/g, 'Bearer [REDACTED]'],
  [/\/\/[^\s@/]*:[^\s@/]*@/g, '//[REDACTED]@'],
  [/(API_KEY|TOKEN|SECRET|PASSWORD)=[^\s]+/gi, '$1=[REDACTED]'],
]

export function scrubPII(value: string): string {
  let scrubbed = value
  for (const pattern of PII_PATH_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, (_match, prefix: string) => `${prefix}[REDACTED]`)
  }
  return scrubbed
}

export function scrubSecrets(value: string): string {
  let scrubbed = value
  for (const [pattern, replacement] of SECRET_REPLACEMENTS) {
    scrubbed = scrubbed.replace(pattern, replacement as string)
  }
  return scrubbed
}

/**
 * Apply every scrubber in one pass. Use this for any text leaving the
 * process boundary (telemetry, error reports, log forwarding) — it is the
 * single source of truth for "what gets redacted before going off-box".
 */
export function scrubAll(value: string): string {
  return scrubSecrets(scrubPII(value))
}
