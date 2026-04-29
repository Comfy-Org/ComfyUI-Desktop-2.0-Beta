/**
 * Best-effort PII scrubbing for telemetry payloads.
 *
 * Strips usernames out of Windows / macOS / Linux home directory paths so
 * tracebacks and error messages can be safely forwarded to Datadog and
 * PostHog. Centralized so the renderer-bound `forwardDatadogError` and the
 * main-process `executionTap` apply the same rules.
 */

const PII_PATH_PATTERNS: RegExp[] = [
  /([A-Za-z]:[\\/]Users[\\/])[^\\/]+?(?=[\\/]|$)/g,
  /(\/Users\/)[^\\/]+?(?=\/|$)/g,
  /(\/home\/)[^\\/]+?(?=\/|$)/g,
]

export function scrubPII(value: string): string {
  let scrubbed = value
  for (const pattern of PII_PATH_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, (_match, prefix: string) => `${prefix}[REDACTED]`)
  }
  return scrubbed
}
