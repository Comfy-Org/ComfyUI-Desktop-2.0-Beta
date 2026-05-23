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
import { app } from 'electron'
import { PostHog } from 'posthog-node'
import { DEFAULT_POSTHOG_API_KEY, DEFAULT_POSTHOG_HOST, isPostHogFlagDisabled as isFlagDisabled } from '../../shared/posthogConfig'

export type TelemetryValue = boolean | number | string | null | undefined
export type TelemetryContext = Record<string, TelemetryValue | TelemetryValue[]>

/**
 * Long-lived renderer WebContents that receive main-emitted telemetry events
 * for fan-out to renderer-side Datadog RUM. Registered exactly once per host
 * window — the title-bar WebContents, which is built unconditionally for
 * every host window in `createHostWindow()` and survives mode flips, so
 * Datadog RUM gets a session per host window regardless of whether the
 * panelView is currently mounted.
 *
 * The panelView is intentionally NOT registered here because (a) it may not
 * exist in steady-state `comfy` mode and (b) when it does exist we don't
 * want events to fire twice on Datadog. PostHog Node already captures these
 * events directly in main, so the relay payload sets `mainAlreadyCaptured:
 * true` to suppress renderer-side PostHog re-capture.
 *
 * Kept here (rather than in `lib/ipc/shared.ts`) so this module stays
 * lightweight and unit-testable without dragging in shared.ts's heavy
 * dependency graph.
 */
const _telemetryRelayTargets = new Set<Electron.WebContents>()

export function registerTelemetryRelayTarget(wc: Electron.WebContents): void {
  _telemetryRelayTargets.add(wc)
  wc.once('destroyed', () => _telemetryRelayTargets.delete(wc))
}

export function unregisterTelemetryRelayTarget(wc: Electron.WebContents): void {
  _telemetryRelayTargets.delete(wc)
}

/** @internal — exposed for tests. */
export function _resetTelemetryRelayTargets(): void {
  _telemetryRelayTargets.clear()
}

/** @internal — exposed for tests. */
export function _telemetryRelayTargetCount(): number {
  return _telemetryRelayTargets.size
}

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
 * Issue a one-shot alias to merge a legacy distinct id into the current one.
 *
 * Used by the boot-time identity migration (random-UUID `device-id.txt` ->
 * SHA-256(machine_id + salt)) so PostHog reconciles historical events under
 * the new identity. Uses `aliasImmediate` so the promise resolves once
 * PostHog has accepted the call; failures are swallowed.
 *
 * Skipped when consent has not been granted so a `'denied'` / `'undecided'`
 * user does not ship a network call that names their legacy id.
 */
export async function aliasImmediate(distinctId: string, alias: string): Promise<void> {
  if (!client) return
  if (!consentEnabled) return
  try {
    await client.aliasImmediate({ distinctId, alias })
  } catch {
    // ignore – telemetry must never break the app
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
 * Forward an event to renderer-side Datadog RUM via the registered
 * telemetry relay targets (title bars). PostHog is intentionally NOT
 * fanned out here — `capture()` already sent the event from PostHog Node,
 * and the `mainAlreadyCaptured: true` flag in the payload tells the
 * renderer-side bootstrap to skip its PostHog Browser mirror so events
 * aren't double-counted.
 *
 * If no relay target is currently registered (no host window open yet),
 * the broadcast is a silent no-op — PostHog Node still captures the event
 * via `capture()`, so the event isn't lost; only its Datadog RUM mirror
 * is dropped, which is acceptable for the brief window before the first
 * host window opens.
 */
export function forwardToRenderer(event: string, context: TelemetryContext = {}): void {
  if (!consentEnabled) return
  const payload = { event, context, mainAlreadyCaptured: true }
  for (const wc of _telemetryRelayTargets) {
    if (!wc.isDestroyed()) {
      try {
        wc.send('telemetry-action-from-main', payload)
      } catch {
        // ignore – telemetry must never break the app
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
