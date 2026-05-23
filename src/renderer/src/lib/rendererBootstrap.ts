/**
 * Renderer-side bootstrap — telemetry providers, error reporting hooks,
 * and main-process broadcast subscriptions that need to run once per
 * renderer entry-point.
 *
 * Every renderer entry-point (title bar, title menu, panel) calls
 * `initializeRendererBootstrap(rendererRole)` so telemetry fires
 * regardless of which renderer the user is interacting with — the
 * panel renderer used to be the only entry that initialised this, which
 * caused steady-state ComfyUI sessions (no panel mounted) to emit zero
 * Datadog/PostHog events. The renderer-role tag (`renderer:title-bar |
 * title-menu | panel`) is registered on every event so RUM/PostHog
 * queries can roll up or filter per surface.
 *
 * Main-emitted events are broadcast only to the title-bar relay target
 * (one per host window), with `mainAlreadyCaptured: true` set, so
 * Datadog RUM gets exactly one Action per host window and PostHog
 * isn't double-counted (PostHog Node already captured it in main).
 *
 * Call `initializeRendererBootstrap()` once at the top of each
 * renderer entry's `main.ts`, before mounting the Vue app. It is a
 * fire-and-forget initializer — internal failures are caught so a
 * misbehaving telemetry provider can't break the renderer load.
 */

import { datadogRum, type RumBeforeSend } from '@datadog/browser-rum'
import { normalizeRumErrorEvent } from './datadogPathNormalization'
import {
  TELEMETRY_ACTION_EVENT_NAME,
  type TelemetryActionEventDetail,
  type TelemetryContext,
} from './telemetry'
import {
  capturePostHog,
  captureExceptionPostHog,
  identifyPostHog,
  initPostHog,
  isInitialized as isPostHogInitialized,
  isPostHogConfigured,
  registerPostHog,
  setPostHogConsent,
} from './posthogProvider'
import { scrubAll } from '../../../shared/piiScrub'

function serializeUnknownError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message || error.name || 'Error',
      stack: error.stack,
    }
  }
  if (typeof error === 'string') {
    return { message: error }
  }
  if (error === null || error === undefined) {
    return { message: 'Unknown error' }
  }
  try {
    return { message: JSON.stringify(error) }
  } catch {
    return { message: String(error) }
  }
}

function parseSampleRate(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(0, Math.min(100, parsed))
}

function isFlagDisabled(value: string | undefined): boolean {
  return ['0', 'false', 'off'].includes((value || '').trim().toLowerCase())
}

type DatadogTrackingConsent = 'granted' | 'not-granted'

const DEFAULT_DATADOG_APPLICATION_ID = '74a97924-20d7-4890-8e55-0c2b87193373'
const DEFAULT_DATADOG_CLIENT_TOKEN = 'pub5b0afc7fe0411fcebad80bb87274d711'
const DEFAULT_DATADOG_SERVICE = 'comfyui-desktop-2'

const datadogClientToken = (
  import.meta.env.VITE_DATADOG_RUM_CLIENT_TOKEN
  || DEFAULT_DATADOG_CLIENT_TOKEN
).trim()
const datadogApplicationId = (
  import.meta.env.VITE_DATADOG_RUM_APPLICATION_ID
  || DEFAULT_DATADOG_APPLICATION_ID
).trim()
const datadogSite = (import.meta.env.VITE_DATADOG_RUM_SITE || 'us5.datadoghq.com').trim()
const datadogService = (import.meta.env.VITE_DATADOG_RUM_SERVICE || DEFAULT_DATADOG_SERVICE).trim()
const datadogEnv = (import.meta.env.VITE_DATADOG_RUM_ENV || 'prod-v2').trim()
const datadogVersion = (import.meta.env.VITE_DATADOG_RUM_VERSION || '').trim()

const isDatadogConfigured = !isFlagDisabled(import.meta.env.VITE_DATADOG_RUM_ENABLED)
  && datadogClientToken.length > 0
  && datadogApplicationId.length > 0

let isDatadogInitialized = false
let bootstrapInvoked = false

const datadogBeforeSend: RumBeforeSend = (event) => {
  if (event.type === 'error') {
    normalizeRumErrorEvent(event)
  }
  return true
}

function toDatadogTrackingConsent(enabled: boolean | undefined): DatadogTrackingConsent {
  // Three-state: only explicit `true` grants. `false` AND `undefined` (user
  // has not made a choice yet) both produce `'not-granted'` so Datadog RUM's
  // autocapture streams (views, resources, long tasks, user interactions)
  // do not collect pre-consent.
  return enabled === true ? 'granted' : 'not-granted'
}

async function getTelemetryEnabledSetting(): Promise<boolean | undefined> {
  try {
    return await window.api.getSetting('telemetryEnabled') as boolean | undefined
  } catch {
    return undefined
  }
}

function setDatadogTrackingConsent(consent: DatadogTrackingConsent): void {
  if (!isDatadogInitialized) return
  try {
    datadogRum.setTrackingConsent(consent)
  } catch {}
}

/**
 * Identifies which renderer surface emitted a given event. Tagged on every
 * Datadog Action / PostHog event so multi-renderer host windows don't blur
 * telemetry queries together. Each renderer entry-point passes its own
 * role when calling `initializeRendererBootstrap()`.
 */
export type RendererRole = 'title-bar' | 'title-menu' | 'panel'

let rendererRole: RendererRole = 'panel'

/**
 * Resolved telemetry consent state, kept in sync with the persisted
 * `telemetryEnabled` setting. `undefined` means "the user has not yet
 * decided" (first-run, before the consent step is completed). The only
 * event allowed to fire pre-decision is
 * `desktop2.first_use.consent_decision` itself — the act of recording
 * the decision. Everything else is dropped at the renderer-side gate
 * so we never even attempt to ship a payload to RUM / PostHog before
 * the user has affirmatively (or negatively) chosen.
 *
 * Updated by `initializeProviders()` at boot and by the
 * `onTelemetrySettingChanged` watcher in `initializeRendererBootstrap`.
 */
let resolvedTelemetryEnabled: boolean | undefined = undefined

/** Allow-list of event names that can fire before the user has made a
 *  consent decision. Strictly the consent decision itself — adding to
 *  this list is a privacy / compliance change, not a code change. */
const PRE_CONSENT_ALLOWED_EVENTS: ReadonlySet<string> = new Set([
  'desktop2.first_use.consent_decision',
])

function isTelemetryEmitAllowed(actionName: string): boolean {
  if (resolvedTelemetryEnabled !== undefined) return true
  return PRE_CONSENT_ALLOWED_EVENTS.has(actionName)
}

/**
 * Run every string-valued property through `scrubAll` before the
 * payload reaches Datadog / PostHog. The discipline of bucketing user
 * input (file paths, prompts, model names) into enums / IDs / numbers
 * happens at the call sites; this pass is the safety net that catches
 * accidental string leaks (error messages, IPC payloads forwarded as-is,
 * etc.). Non-string values pass through untouched.
 */
function scrubTelemetryContext(context: TelemetryContext): TelemetryContext {
  let mutated: TelemetryContext | null = null
  for (const key of Object.keys(context)) {
    const value = context[key]
    if (typeof value !== 'string') continue
    const cleaned = scrubAll(value)
    if (cleaned === value) continue
    if (!mutated) mutated = { ...context }
    mutated[key] = cleaned
  }
  return mutated ?? context
}

function trackTelemetryAction(
  actionName: string,
  context: TelemetryContext,
  options: { skipPostHog?: boolean } = {},
): void {
  if (!isTelemetryEmitAllowed(actionName)) return
  const scrubbed = scrubTelemetryContext(context)
  if (isDatadogInitialized) {
    try { datadogRum.addAction(actionName, scrubbed) } catch {}
  }
  // `mainAlreadyCaptured` events come from the main-process PostHog Node
  // SDK and would be duplicates if we recaptured them in the browser SDK.
  if (!options.skipPostHog && isPostHogInitialized()) {
    capturePostHog(actionName, scrubbed)
  }
}

function handleTelemetryActionBridgeEvent(event: Event): void {
  const detail = (event as CustomEvent<unknown>).detail as TelemetryActionEventDetail | undefined
  if (!detail || typeof detail !== 'object') return
  if (typeof detail.actionName !== 'string' || detail.actionName.length === 0) return
  const context = detail.context && typeof detail.context === 'object' ? detail.context : {}
  trackTelemetryAction(detail.actionName, context)
}

/**
 * Derive the release channel from the semver-ish app version string.
 * Stable releases have no pre-release suffix; pre-release builds carry
 * `-beta` / `-canary` / `-alpha` markers. We keep the bucket coarse so
 * a future `-rc` / `-dev` suffix that we haven't accounted for falls
 * into `unknown` rather than silently being miscategorised.
 */
function deriveAppChannel(appVersion: string): string {
  if (!appVersion) return 'unknown'
  const v = appVersion.toLowerCase()
  if (v.includes('-beta')) return 'beta'
  if (v.includes('-canary')) return 'canary'
  if (v.includes('-alpha')) return 'alpha'
  return 'stable'
}

/**
 * Tag every Datadog RUM Action and PostHog event with cohort context
 * (release channel, locale, theme, install summary, consent state, etc.)
 * so dashboards can slice by user segment without a per-event property
 * proliferation. Reads each setting independently so a single failing
 * IPC doesn't drop the rest of the cohort tags — telemetry must never
 * break boot, so every read defaults to `'unknown'` / `null` on error.
 */
async function registerCohortContext(opts: {
  appVersion: string
  telemetryEnabled: boolean
}): Promise<void> {
  const appChannel = deriveAppChannel(opts.appVersion)
  const locale = await window.api.getLocale().catch(() => 'unknown')
  const theme = await window.api.getSetting('theme')
    .then((v) => (typeof v === 'string' && v ? v : 'unknown'))
    .catch(() => 'unknown')
  const firstUseCompleted = await window.api.getSetting('firstUseCompleted')
    .then((v) => (typeof v === 'boolean' ? v : null))
    .catch(() => null)
  const installSummary = await window.api.getInstallationsSummary().catch(() => null)

  const cohort: Record<string, string | number | boolean | null> = {
    // `app_version` and `app_channel` are intentionally both registered:
    // `app_version` is also pushed as a PostHog person property in the
    // `getDeviceId` branch below, but person properties are joined at
    // query time and aren't visible on raw RUM events. Registering
    // `app_version` here puts it on every event payload so dashboards
    // can filter by exact version without joining; `app_channel` is the
    // cheap categorical filter (`stable`/`beta`/`canary`/`alpha`)
    // derived from it.
    app_version: opts.appVersion || 'unknown',
    app_channel: appChannel,
    locale,
    theme,
    telemetry_enabled: opts.telemetryEnabled,
    first_use_completed: firstUseCompleted,
    // Excludes the always-seeded Comfy Cloud entry — see
    // `get-installations-summary` in `registerInstallationHandlers.ts`.
    local_installation_count: installSummary?.localCount ?? null,
    // True only when the user has actually opened the seeded Cloud
    // entry at least once. The seeded entry's mere presence is
    // meaningless because it's force-re-seeded on every boot.
    has_launched_cloud: installSummary?.hasLaunchedCloud ?? null,
    has_legacy_install: installSummary?.hasLegacyDesktop ?? null,
  }

  if (isDatadogInitialized) {
    try {
      for (const [key, value] of Object.entries(cohort)) {
        datadogRum.setGlobalContextProperty(key, value)
      }
    } catch {}
  }
  if (isPostHogInitialized()) {
    registerPostHog(cohort)
  }
}

async function initializeProviders(): Promise<void> {
  const telemetryEnabled = await getTelemetryEnabledSetting()
  // Snapshot the resolved consent state for the renderer-side gate.
  // `undefined` here means "user has not yet decided" — only the
  // consent-decision event itself can fire until they do.
  resolvedTelemetryEnabled = telemetryEnabled
  const consent = telemetryEnabled !== false
  const appVersion = datadogVersion || 'unknown'

  if (isDatadogConfigured) {
    try {
      datadogRum.init({
        applicationId: datadogApplicationId,
        clientToken: datadogClientToken,
        site: datadogSite,
        service: datadogService,
        env: datadogEnv,
        version: datadogVersion || undefined,
        trackingConsent: toDatadogTrackingConsent(telemetryEnabled),
        beforeSend: datadogBeforeSend,
        sessionSampleRate: parseSampleRate(import.meta.env.VITE_DATADOG_RUM_SESSION_SAMPLE_RATE, 100),
        // Session replay is intentionally not configured. Datadog defaults
        // to off when the field is omitted; reintroduce only as a deliberate
        // code change in a release.
        trackResources: true,
        trackLongTasks: true,
        trackUserInteractions: true,
      })
      isDatadogInitialized = true
      // Tag every RUM event with the renderer surface so queries can
      // distinguish title-bar / title-menu / panel sessions per host window.
      try { datadogRum.setGlobalContextProperty('renderer_role', rendererRole) } catch {}
    } catch {}
  }

  if (isPostHogConfigured()) {
    initPostHog({
      appVersion,
      appEnv: datadogEnv,
      isPackaged: !import.meta.env.DEV,
      consent,
      rendererRole,
    })
  }

  if (isDatadogInitialized || isPostHogInitialized()) {
    // `desktop2.session.started` is owned by main (`identify()` in
    // `src/main/lib/telemetry.ts`) because it has to ride the deferred-
    // identify pattern that binds `distinctId` first. Firing it again
    // here would double-count every session.
    void registerCohortContext({ appVersion, telemetryEnabled: consent })
    window.api.getDeviceId().then((id) => {
      if (isDatadogInitialized) {
        try { datadogRum.setUser({ id }) } catch {}
      }
      // For PostHog we'll merge in the system_info profile properties below.
      identifyPostHog(id)
    }).catch(() => {})
    // Per-session boot census of every persisted install. Gated to
    // `'panel'` (same pattern as `installation_started` /
    // `snapshot_history` below) so it fires exactly once per session:
    // the chooser host owns the `'panel'` renderer, every other host
    // window has only the always-on `'title-bar'` renderer. Without
    // this gate the inventory would fire N times per session — once
    // per host window's title-bar bootstrap. Payload is metadata +
    // diff counts only (no per-node / per-package contents) and is
    // capped to ~200 KB main-side; arrays of objects bypass the typed
    // bridge the same way `snapshot_history` does below.
    if (rendererRole === 'panel') {
      window.api.getInstallsInventory().then((inventory) => {
        if (!inventory) return
        // Honor the pre-consent gate even on the bypass path. The
        // typed-bridge `trackTelemetryAction` route already does this;
        // we replicate the check inline here because direct
        // `addAction` / `capturePostHog` calls skip that wrapper.
        if (!isTelemetryEmitAllowed('desktop2.session.installs_inventory')) return
        if (isDatadogInitialized) {
          try {
            datadogRum.addAction(
              'desktop2.session.installs_inventory',
              inventory as unknown as Record<string, unknown>,
            )
          } catch {}
        }
        if (isPostHogInitialized()) {
          capturePostHog(
            'desktop2.session.installs_inventory',
            inventory as unknown as TelemetryContext,
          )
        }
      }).catch(() => {})
    }
    // Convention: session-wide events (one per session regardless of
    // how many host windows the user opens) are gated to `panel`
    // because the chooser host is the singleton owner of the panel
    // renderer. Per-renderer SDK setup (`registerCohortContext`,
    // `setUser`, `identifyPostHog`) is intentionally un-gated — each
    // renderer's local SDK instance needs its own configuration.
    // `installs_inventory` above follows the same rule.
    window.api.getSystemInfo().then(async (info) => {
      const ctx = info as unknown as Record<string, string | number | boolean | null | undefined>
      if (rendererRole === 'panel') {
        trackTelemetryAction('desktop2.session.system_info', ctx)
      }
      // Promote system info to PostHog profile properties so it's queryable
      // across sessions without joining against a per-session event.
      // Stays un-gated: it's an idempotent person-property upsert, not
      // an event emit, so each renderer's SDK setting the same keys
      // produces no duplication.
      try {
        const id = await window.api.getDeviceId()
        identifyPostHog(id, {
          platform: ctx['platform'],
          arch: ctx['arch'],
          os_distro: ctx['os_distro'],
          os_release: ctx['os_release'],
          gpu_vendor: ctx['gpu_vendor'],
          gpu_model: ctx['gpu_model'],
          total_memory_gb: ctx['total_memory_gb'],
          cpu_cores: ctx['cpu_cores'],
          electron_version: ctx['electron_version'],
          app_version: appVersion,
        })
      } catch {}
    }).catch(() => {})
  }
}

function reportRendererError(payload: {
  source: string
  message: string
  stack?: string
  context?: Record<string, unknown>
  /**
   * If true, the error has already been captured by main-process PostHog
   * Node and is being forwarded only so Datadog (renderer-only) sees it.
   * Suppresses the renderer-side PostHog mirror to avoid duplicates.
   */
  skipPostHog?: boolean
}): void {
  const error = new Error(payload.message || 'Unknown error')
  if (payload.stack) {
    error.stack = payload.stack
  }
  if (isDatadogInitialized) {
    try {
      datadogRum.addError(error, {
        source: 'custom',
        context: {
          origin: 'renderer',
          forwarded_source: payload.source,
          ...(payload.context || {}),
        },
      })
    } catch {}
  }
  if (!payload.skipPostHog && isPostHogInitialized()) {
    captureExceptionPostHog(error, {
      origin: 'renderer',
      forwarded_source: payload.source,
      ...(payload.context || {}),
    })
  }
}

/**
 * Initialise telemetry providers, error reporting hooks, and main-process
 * broadcast subscriptions for this renderer. Idempotent — repeated calls
 * are no-ops, so each renderer entry-point can call this safely without
 * coordinating across modules.
 *
 * @param role  Identifies the renderer surface for telemetry tagging
 *              (`'panel'`, `'title-bar'`, or `'title-menu'`). Defaults to
 *              `'panel'` for backward compatibility with the historical
 *              single-renderer entry-point.
 */
export function initializeRendererBootstrap(role: RendererRole = 'panel'): void {
  if (bootstrapInvoked) return
  bootstrapInvoked = true
  rendererRole = role

  window.api.onTelemetrySettingChanged((enabled) => {
    // Keep the renderer-side pre-consent gate in sync with the
    // persisted setting. After the user makes a consent decision in
    // `FirstUseTakeover`, this fires with `enabled: true | false`,
    // releasing the gate so subsequent events flow normally (the SDK
    // consent state set just below decides whether they actually ship).
    resolvedTelemetryEnabled = enabled
    if (isDatadogConfigured) setDatadogTrackingConsent(toDatadogTrackingConsent(enabled))
    setPostHogConsent(enabled !== false)
  })

  window.addEventListener(TELEMETRY_ACTION_EVENT_NAME, handleTelemetryActionBridgeEvent)

  // Events emitted from the main process land here. Datadog RUM always
  // mirrors them (one Action per host window via the title-bar relay
  // target). PostHog Browser is suppressed when `mainAlreadyCaptured` is
  // set, since PostHog Node already captured the event in main and we'd
  // otherwise double-count.
  window.api.onTelemetryActionFromMain((data) => {
    if (!data || typeof data.event !== 'string' || data.event.length === 0) return
    const ctx = (data.context && typeof data.context === 'object' ? data.context : {}) as TelemetryContext
    trackTelemetryAction(data.event, ctx, { skipPostHog: data.mainAlreadyCaptured === true })
  })

  void initializeProviders()

  window.addEventListener('error', (event) => {
    const serialized = serializeUnknownError(event.error || event.message)
    reportRendererError({
      source: 'renderer-window-error',
      message: serialized.message,
      stack: serialized.stack,
      context: {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      },
    })
  })

  window.addEventListener('unhandledrejection', (event) => {
    const serialized = serializeUnknownError(event.reason)
    reportRendererError({
      source: 'renderer-unhandled-rejection',
      message: serialized.message,
      stack: serialized.stack,
    })
  })

  // `dd-error` is broadcast to every extra target (title bars + panels), so
  // we gate the subscription to the title-bar role — the canonical telemetry
  // relay per host window — to avoid recording the same main-process error
  // twice on Datadog when a host window has both renderers alive.
  if (rendererRole === 'title-bar') {
    window.api.onDatadogError((data) => {
      reportRendererError({
        source: data.source || 'main-forwarded-error',
        message: data.message || 'Unknown forwarded error',
        stack: data.stack,
        context: {
          origin: 'main-process',
          level: data.level,
          ...(data.context || {}),
        },
        skipPostHog: data.skipPostHog === true,
      })
    })
  }

  // `comfy-exited` / `comfy-boot-log` / `instance-started` are install-
  // lifecycle events whose renderer-side handlers convert them into
  // telemetry Actions. These are owned by the panel renderer (which drives
  // the install/lifecycle UI) — gating them to `'panel'` prevents the
  // title-bar bootstrap from double-firing the broadcast `instance-started`
  // event on Datadog/PostHog when both renderers are mounted.
  if (rendererRole === 'panel') {
    window.api.onComfyExited((data) => {
      trackTelemetryAction('desktop2.comfyui.exited', {
        installation_id: data.installationId,
        crashed: data.crashed ?? false,
        exit_code: data.exitCode ?? null,
        last_stderr: data.lastStderr ?? null,
      })
    })

    window.api.onComfyBootLog((data) => {
      trackTelemetryAction('desktop2.comfyui.boot_log', {
        installation_id: data.installationId,
        boot_stderr: data.bootStderr,
      })
    })

    window.api.onInstanceStarted((data) => {
      const bootTimeMs = (data as unknown as Record<string, unknown>).bootTimeMs as number | undefined
      window.api.getInstallationDdContext(data.installationId).then((ctx) => {
        if (!ctx) return
        const { snapshot_diffs, ...metadata } = ctx
        trackTelemetryAction('desktop2.session.installation_started', {
          ...(metadata as unknown as Record<string, string | number | boolean | null | undefined>),
          boot_time_ms: bootTimeMs ?? null,
        })
        if (snapshot_diffs.length > 0) {
          // snapshot_diffs is an array of objects, which Datadog/PostHog handle
          // natively; bypass the typed bridge via a fresh call.
          if (isDatadogInitialized) {
            try { datadogRum.addAction('desktop2.session.snapshot_history', { installation_id: ctx.installation_id, snapshot_diffs }) } catch {}
          }
          if (isPostHogInitialized()) {
            capturePostHog('desktop2.session.snapshot_history', { installation_id: ctx.installation_id, snapshot_diffs } as unknown as TelemetryContext)
          }
        }
      }).catch(() => {})
    })
  }
}
