/**
 * Renderer-side PostHog provider.
 *
 * Used alongside Datadog RUM. Both providers consume events from the same
 * `TELEMETRY_ACTION_EVENT_NAME` CustomEvent bridge, so Vue components don't
 * need to know either SDK exists.
 *
 * Mirrors the shape of `datadogRum.init` / `setUser` / `setTrackingConsent`
 * so callers in `renderer/src/main.ts` stay symmetric.
 */
import posthog, { type PostHog } from 'posthog-js'
import type { TelemetryContext } from './telemetry'
import { DEFAULT_POSTHOG_API_KEY, DEFAULT_POSTHOG_HOST, isPostHogFlagDisabled as isFlagDisabled } from '../../../shared/posthogConfig'

interface PosthogInitOptions {
  appVersion: string
  appEnv: string
  isPackaged: boolean
  consent: boolean
}

let initialized = false
let client: PostHog | null = null

function readApiKey(): string {
  return (import.meta.env.VITE_POSTHOG_API_KEY || DEFAULT_POSTHOG_API_KEY).trim()
}

function readHost(): string {
  return (import.meta.env.VITE_POSTHOG_HOST || DEFAULT_POSTHOG_HOST).trim()
}

export function isPostHogConfigured(): boolean {
  if (isFlagDisabled(import.meta.env.VITE_POSTHOG_ENABLED)) return false
  return readApiKey().length > 0
}

export function initPostHog(opts: PosthogInitOptions): void {
  if (initialized || !isPostHogConfigured()) return
  initialized = true
  try {
    client = posthog.init(readApiKey(), {
      api_host: readHost(),
      opt_out_capturing_by_default: !opts.consent,
      capture_pageview: false,
      autocapture: false,
      // Session recording is intentionally never enabled. The recorder script
      // is also blocked at the CSP layer.
      disable_session_recording: true,
      // Surveys are remotely toggleable via the PostHog dashboard, but only
      // when the user has consented to telemetry. This is enforced by
      // tracking consent in `disable_surveys` here and in setPostHogConsent
      // below — PostHog's surveys do NOT honor `opt_out_capturing()` outside
      // of `cookieless_mode`, so we have to wire the gate ourselves.
      disable_surveys: !opts.consent,
      persistence: 'localStorage+cookie',
      loaded: (ph) => {
        ph.register({
          app_env: opts.appEnv,
          app_version: opts.appVersion,
          is_packaged: opts.isPackaged,
        })
      },
    }) as PostHog
  } catch {
    client = null
  }
}

export function isInitialized(): boolean {
  return client !== null
}

/**
 * Bind device id + persistent profile properties (mirrors legacy desktop's
 * Mixpanel people profile — platform, arch, gpus, app_version, etc.).
 */
export function identifyPostHog(id: string, properties: Record<string, unknown> = {}): void {
  if (!client) return
  try {
    client.identify(id, properties)
  } catch {
    // ignore
  }
}

export function capturePostHog(event: string, context: TelemetryContext = {}): void {
  if (!client) return
  try {
    client.capture(event, context as Record<string, unknown>)
  } catch {
    // ignore
  }
}

export function captureExceptionPostHog(error: unknown, context: Record<string, unknown> = {}): void {
  if (!client) return
  try {
    if (error instanceof Error) {
      client.captureException(error, context)
    } else {
      client.captureException(new Error(String(error)), context)
    }
  } catch {
    // ignore
  }
}

export function setPostHogConsent(enabled: boolean): void {
  if (!client) return
  try {
    if (enabled) client.opt_in_capturing()
    else client.opt_out_capturing()
  } catch {
    // ignore
  }
  // Keep `disable_surveys` in lock-step with consent. PostHog's surveys
  // module ignores `opt_out_capturing()` outside cookieless mode, so the
  // only reliable way to suppress dashboard-defined surveys for an
  // opted-out user is to flip the config flag on every consent change.
  // When opting back in, ask the surveys module to (re-)load so dashboard
  // surveys can appear without requiring a relaunch.
  try {
    client.set_config({ disable_surveys: !enabled })
    if (enabled) {
      const surveys = (client as unknown as { surveys?: { loadIfEnabled?: () => void } }).surveys
      surveys?.loadIfEnabled?.()
    }
  } catch {
    // ignore – telemetry must never break the app
  }
}

