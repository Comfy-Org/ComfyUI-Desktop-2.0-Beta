/**
 * Main-process telemetry for the launcher.
 *
 * Co-exists with the renderer-side Datadog RUM + PostHog JS pipelines.
 * Responsibilities:
 *   - PostHog Node SDK lifecycle (init, identify, shutdown flush on quit)
 *   - Capture of events that occur outside the renderer's reach:
 *       * app lifecycle (start/quit) with uptime
 *       * pre-install / installation pipeline sub-steps
 *       * migration pipeline sub-steps
 *       * execution events parsed from ComfyUI's stdout
 *   - A `trackedStep()` helper mirroring legacy desktop's `@trackEvent` decorator
 *     pattern (`<step>.start` / `<step>.end` / `<step>.error`)
 *
 * The renderer continues to be the primary telemetry funnel for UI events;
 * this module exists for the things the renderer cannot see.
 *
 * NOTE: There is intentionally no remote feature-flag system. We initially
 * shipped one with a few kill switches and a sample-rate dial, but the
 * launcher has no live use for them and the bootstrap/cache machinery
 * complicates startup. Reintroduce only if a concrete need appears.
 */
import { app, BrowserWindow } from 'electron'
import { PostHog } from 'posthog-node'
import { DEFAULT_POSTHOG_API_KEY, DEFAULT_POSTHOG_HOST, isPostHogFlagDisabled as isFlagDisabled } from '../../shared/posthogConfig'

export type TelemetryValue = boolean | number | string | null | undefined
export type TelemetryContext = Record<string, TelemetryValue | TelemetryValue[]>

interface PostHogConfig {
  apiKey: string
  host: string
  enabled: boolean
}


function readPostHogConfig(): PostHogConfig {
  const apiKey = (process.env['POSTHOG_API_KEY'] || DEFAULT_POSTHOG_API_KEY).trim()
  const host = (process.env['POSTHOG_HOST'] || DEFAULT_POSTHOG_HOST).trim()
  const enabled = !isFlagDisabled(process.env['POSTHOG_ENABLED']) && apiKey.length > 0
  return { apiKey, host, enabled }
}

let client: PostHog | null = null
let distinctId: string | null = null
let consentEnabled = true
let bootstrapTimeMs: number = Date.now()
let initialized = false

export function setConsent(enabled: boolean): void {
  consentEnabled = enabled
  if (!enabled) {
    // Best-effort flush so already-queued events still go out
    void client?.flush().catch(() => {})
  }
}

export function isInitialized(): boolean {
  return initialized && client !== null
}

export interface InitOptions {
  appVersion: string
  appEnv: string
  isPackaged: boolean
}

/**
 * Initialize PostHog Node. Safe to call before consent decision is known —
 * events are queued by setConsent(false) and dropped at capture time.
 *
 * Note: the session-start event is intentionally NOT emitted here — the
 * `distinctId` is unknown until `identify()` runs. `identify()` issues
 * the session-start event once the device id is bound.
 */
export function initTelemetry(opts: InitOptions): void {
  if (initialized) return
  initialized = true
  bootstrapTimeMs = Date.now()

  const cfg = readPostHogConfig()
  if (!cfg.enabled) return

  try {
    client = new PostHog(cfg.apiKey, {
      host: cfg.host,
      flushAt: 20,
      flushInterval: 10_000,
    })
  } catch {
    client = null
  }

  // Stash session-start parameters until identify() can attribute them.
  pendingSessionStart = {
    app_env: opts.appEnv,
    app_version: opts.appVersion,
    is_packaged: opts.isPackaged,
  }
}

let pendingSessionStart: Record<string, TelemetryValue> | null = null

/**
 * Bind the persistent device id once it is known. Emits the deferred
 * session-start event with the now-known distinctId.
 */
export function identify(
  id: string,
  properties: Record<string, TelemetryValue> = {},
): void {
  distinctId = id
  if (!client) return
  try {
    client.identify({ distinctId: id, properties: { $set: properties } })
  } catch {
    // ignore
  }
  if (pendingSessionStart) {
    capture('desktop2.session.started', pendingSessionStart)
    pendingSessionStart = null
  }
}

export function capture(event: string, properties: TelemetryContext = {}): void {
  if (!client || !distinctId) return
  if (!consentEnabled) return
  try {
    client.capture({ distinctId, event, properties })
  } catch {
    // ignore – telemetry must never break the app
  }
}

export function captureException(error: unknown, properties: TelemetryContext = {}): void {
  if (!client || !distinctId) return
  if (!consentEnabled) return
  try {
    client.captureException(error, distinctId, properties)
  } catch {
    // ignore
  }
}

/**
 * Wrap an async step with start/end/error telemetry events that mirror legacy
 * desktop's `@trackEvent` decorator. Errors are re-thrown so callers can
 * continue normal control flow.
 */
export async function trackedStep<T>(
  step: string,
  context: TelemetryContext,
  fn: () => Promise<T>,
): Promise<T> {
  capture(`${step}.start`, context)
  const t0 = Date.now()
  try {
    const result = await fn()
    capture(`${step}.end`, { ...context, duration_ms: Date.now() - t0 })
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    capture(`${step}.error`, {
      ...context,
      duration_ms: Date.now() - t0,
      error_bucket: bucketError(message),
      error_message: message.slice(0, 500),
    })
    throw err
  }
}

/**
 * Coarse error categorisation that matches the renderer-side `toErrorBucket`.
 * Kept in sync manually – when adding categories, update both.
 */
export function bucketError(input: unknown): string {
  const message = (
    input instanceof Error ? input.message : typeof input === 'string' ? input : ''
  ).toLowerCase()
  if (!message) return 'unknown'
  if (message.includes('cancel')) return 'cancelled'
  if (message.includes('timeout')) return 'timeout'
  if (message.includes('network') || message.includes('fetch')) return 'network'
  if (message.includes('disk') || message.includes('space')) return 'disk'
  if (message.includes('permission') || message.includes('access')) return 'permissions'
  if (message.includes('path')) return 'path'
  return 'other'
}

/**
 * Forward an event to the renderer so it can fan out to PostHog JS + Datadog.
 * Use this for events that should appear in both providers (most do).
 */
export function forwardToRenderer(event: string, context: TelemetryContext = {}): void {
  if (!consentEnabled) return
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try {
        win.webContents.send('telemetry-action-from-main', { event, context })
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Capture an event and forward it to the renderer in one call.
 */
export function emit(event: string, context: TelemetryContext = {}): void {
  capture(event, context)
  forwardToRenderer(event, context)
}

/**
 * Drain queued events. Safe to await during `app.before-quit`.
 */
export async function shutdown(reason: string): Promise<void> {
  if (!client) return
  const uptimeMs = Date.now() - bootstrapTimeMs
  try {
    capture('desktop2.session.ended', {
      reason,
      uptime_ms: uptimeMs,
      uptime_seconds: Math.round(uptimeMs / 1000),
    })
  } catch {
    // ignore
  }
  try {
    await client.shutdown()
  } catch {
    // ignore
  } finally {
    client = null
    initialized = false
  }
}

let beforeQuitHooked = false
let drainingForQuit = false

/**
 * Maximum time we'll block the quit on draining queued PostHog events.
 * If the network is slow / down, we still want the app to exit promptly.
 */
const SHUTDOWN_DRAIN_TIMEOUT_MS = 1500

/**
 * Wire `app.before-quit` so PostHog drains its queue before the process exits.
 *
 * Electron does NOT await async listeners on `before-quit`, so we use the
 * standard pattern of calling `event.preventDefault()`, awaiting the
 * shutdown, then re-issuing `app.exit()`. A one-shot guard prevents the
 * subsequent quit from re-entering this branch.
 *
 * Safe to call multiple times – the hook only attaches once.
 */
export function installAppHooks(): void {
  if (beforeQuitHooked) return
  beforeQuitHooked = true

  app.on('before-quit', (event) => {
    if (drainingForQuit || !client) return
    drainingForQuit = true
    event.preventDefault()
    const drainPromise = shutdown('quit').catch(() => {})
    const timeoutPromise = new Promise<void>((resolve) =>
      setTimeout(resolve, SHUTDOWN_DRAIN_TIMEOUT_MS),
    )
    void Promise.race([drainPromise, timeoutPromise]).finally(() => {
      app.exit(0)
    })
  })
}
