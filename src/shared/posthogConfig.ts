/**
 * Cross-process PostHog defaults.
 *
 * Imported by both the renderer (lib/posthogProvider.ts) and the main process
 * (lib/telemetry.ts) so the project key, host, and shared flag-disabled
 * predicate live in exactly one place.
 *
 * The API key is a public, write-only ingest key for the comfyui-desktop-2
 * PostHog project — safe to embed, same trust level as the Datadog client
 * token. Override at build time / runtime via VITE_POSTHOG_API_KEY (renderer)
 * or POSTHOG_API_KEY (main process).
 */

export const DEFAULT_POSTHOG_API_KEY = 'phc_iKfK86id4xVYws9LybMje0h44eGtfwFgRPIBehmy8rO'

export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com'

export function isPostHogFlagDisabled(value: string | undefined): boolean {
  return ['0', 'false', 'off'].includes((value || '').trim().toLowerCase())
}
