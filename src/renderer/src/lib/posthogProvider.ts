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

const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com'

interface PosthogInitOptions {
  appVersion: string
  appEnv: string
  isPackaged: boolean
  consent: boolean
  enableSessionRecording: boolean
}

let initialized = false
let client: PostHog | null = null

function isFlagDisabled(value: string | undefined): boolean {
  return ['0', 'false', 'off'].includes((value || '').trim().toLowerCase())
}

function readApiKey(): string {
  return (import.meta.env.VITE_POSTHOG_API_KEY || '').trim()
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
      // Session recording is gated behind a remote feature flag — see main.ts
      disable_session_recording: !opts.enableSessionRecording,
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
}

export function isFeatureFlagEnabled(name: string, fallback = false): boolean {
  if (!client) return fallback
  try {
    const value = client.isFeatureEnabled(name)
    return value === undefined ? fallback : value
  } catch {
    return fallback
  }
}

export function reloadPostHogFeatureFlags(): void {
  if (!client) return
  try {
    client.reloadFeatureFlags()
  } catch {
    // ignore
  }
}
