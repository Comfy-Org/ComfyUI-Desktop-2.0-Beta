/**
 * Cross-process PostHog defaults.
 *
 * Imported by both the renderer (lib/posthogProvider.ts) and the main process
 * (lib/telemetry.ts) so the project key, host, and shared validation /
 * flag-disabled predicates live in exactly one place.
 *
 * The API key is a public, write-only ingest key for the comfyui-desktop-2
 * PostHog project — safe to embed, same trust level as the Datadog client
 * token. Override at build time / runtime via VITE_POSTHOG_API_KEY (renderer)
 * or POSTHOG_API_KEY (main process).
 *
 * The constant below is intentionally a placeholder so a bare repo build is
 * inert: `isValidPostHogApiKey()` rejects anything that isn't a real
 * `phc_…` PostHog project key. Replace the placeholder (or wire the env
 * vars in the release pipeline) to actually emit events.
 */

export const DEFAULT_POSTHOG_API_KEY = 'phc_iKfK86id4xVYws9LybMje0h44eGtfwFgRPIBehmy8rO'

export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com'

/**
 * PostHog public project keys are always `phc_` + opaque payload. This guard
 * stops a placeholder string from silently passing an `apiKey.length > 0`
 * check and shipping events to an invalid key, where PostHog drops them
 * server-side and the pipeline appears healthy.
 */
export function isValidPostHogApiKey(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.startsWith('phc_') && value.length > 'phc_'.length
}

export function isPostHogFlagDisabled(value: string | undefined): boolean {
  return ['0', 'false', 'off'].includes((value || '').trim().toLowerCase())
}
