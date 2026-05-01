/**
 * Best-effort PII and secret scrubbing for telemetry payloads.
 *
 * Strips usernames out of Windows / macOS / Linux home directory paths and
 * redacts well-known credential shapes (Bearer tokens, OpenAI / Hugging Face
 * keys, basic-auth in URLs, `*KEY=…` / `*SECRET=…` env-style assignments) so
 * tracebacks and error messages can be safely forwarded to Datadog and
 * PostHog.
 *
 * Centralized so that everything which forwards user-visible text — the
 * renderer-bound `forwardDatadogError`, the main-process `executionTap`,
 * and the boot-log scrubber — applies identical rules. Adding a pattern
 * here updates every call site at once.
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
