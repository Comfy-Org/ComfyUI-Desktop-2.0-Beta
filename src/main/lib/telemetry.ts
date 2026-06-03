/**
 * Main-process telemetry — single capture point for the launcher.
 *
 * =========================================================================
 * REFERENCE FOR ANYONE ADDING NEW TELEMETRY
 * =========================================================================
 *
 * ## Architecture (one paragraph)
 *
 * `posthog-node` runs here in main. Renderer events flow over IPC
 * (`window.api.captureTelemetry` / `captureExceptionTelemetry` /
 * `registerTelemetryProperties` / `telemetryBindUserId` /
 * `telemetryUnbindUserId` / `telemetryGetExperimentFlag` /
 * `telemetryRecordExposure`) to handlers in `ipc/registerTelemetryHandlers.ts`.
 * Datadog RUM still runs in the renderer (browser-only) but is gated to a
 * small failure-event allow-list in `src/shared/datadogMirroredEvents.ts`.
 *
 * ## Adding a product event — checklist
 *
 *   1. Pick a name. Convention: `desktop2.<area>.<verb>` snake_case
 *      (e.g. `desktop2.instance.switched`). Add to whichever code path
 *      naturally owns the event.
 *   2. Use `capture(event, properties)` in main, or
 *      `emitTelemetryAction(event, props)` in a Vue component. Never call
 *      `posthog.capture` directly.
 *   3. Bucket / enumerate user values at the call site. Free-form strings
 *      get scrubbed by `scrubAll()` as a safety net, but the discipline is
 *      to send `directory_bucket: 'checkpoints'` not raw `directory: '/Users/x/foo'`.
 *      Use helpers in `src/renderer/src/lib/telemetry.ts` (`toSizeBucket`,
 *      `toCountBucket`, `toErrorBucket`, `toModelDirectoryBucket`,
 *      `deriveGpuTier`, etc.) — extend them instead of inlining new bucketing.
 *   4. If the event is a *failure* (`*.error`, crash, install failure, etc.),
 *      add the event name to `DATADOG_MIRRORED_EVENT_NAMES` so it also
 *      reaches Datadog and a monitor can fire on it.
 *   5. Add an insight to the relevant PostHog dashboard. Don't ship events
 *      that don't end up on a dashboard or in a saved query — that's how
 *      telemetry rots into noise.
 *
 * ## Identity model
 *
 *   - `installation_id` = `SHA-256(machine_id + salt)`, computed in
 *     `deviceId.ts`. Deterministic per machine; can be matched against
 *     the same hash computed by other Comfy products on the same machine.
 *     Bound at boot via `identify(installation_id)`.
 *   - `download_token` (TODO): web-session → desktop bridge for acquisition
 *     attribution. Set as a person property on first launch from a
 *     tokenised installer download.
 *   - `user_id`: set on successful login via `bindUserId(user_id)`.
 *     Aliases `installation_id` → `user_id` so historical anonymous events
 *     merge under the user. Clear on logout via `unbindUserId()` —
 *     DO NOT call `posthog.reset()`; it would clobber `installation_id`
 *     and `download_token`.
 *
 * ## Consent (three-state)
 *
 *   - `'granted'`   — collect everything.
 *   - `'denied'`    — collect nothing.
 *   - `'undecided'` — fresh install or Desktop-1 migrator; collect ONLY
 *                     `desktop2.first_use.consent_decision` until the
 *                     user makes a choice.
 *
 *   Every capture path here is consent-gated. `setConsentState(state)` is
 *   the single source of truth; `setConsent(bool)` is a legacy adapter.
 *
 * ## Provider split
 *
 *   PostHog gets everything. Datadog only mirrors the failure / reliability
 *   allow-list in `src/shared/datadogMirroredEvents.ts`. Datadog is for
 *   alerting, not analysis — adding a name to the allow-list is a
 *   deliberate ops decision ("I want a monitor on this"). PostHog
 *   dashboards + ad-hoc HogQL are the source of truth for everything else.
 *
 * ## A/B experiments
 *
 *   `experiments.ts` owns the flag cache. Read with `getFlag(key)` in main
 *   or `window.api.telemetryGetExperimentFlag(key)` from the renderer
 *   (cache-first; first-ever boot fails closed to control). Record
 *   exposure with `recordExposure(key, variant, source)` or its IPC
 *   equivalent — per-session dedup is enforced main-side. Outcome events
 *   are normal product events; PostHog joins them to the exposure at query
 *   time via the standard experiment view.
 *
 * ## What NOT to do
 *
 *   - Don't ship raw file paths, prompts, model filenames, user-typed
 *     strings. Bucket or hash them first.
 *   - Don't call `posthog.reset()` on logout.
 *   - Don't add events that nobody is going to look at in PostHog. Add
 *     them to a dashboard or skip them.
 *   - Don't bypass `bucketError`; if you need a new error category, extend
 *     `src/shared/errorBucket.ts` so main and renderer classify the same way.
 *   - Don't fire events synchronously inside hot loops (e.g. every render
 *     of a Vue list). Throttle / dedup at the call site.
 *
 * =========================================================================
 *
 * NOTE: There is intentionally no remote kill-switch / sample-rate system
 * (that grab-bag was deliberately removed). `experiments.ts` brought back
 * the flag-evaluation subset only, for A/B testing. Don't recreate the
 * kill-switch without a concrete need.
 */
import { app } from 'electron'
import { PostHog } from 'posthog-node'

// PostHog's `FeatureFlagValue` lives in `@posthog/core` and is not
// re-exported by `posthog-node`. Inlining the shape we actually use.
export type FeatureFlagValue = string | boolean
import {
  DEFAULT_POSTHOG_API_KEY,
  DEFAULT_POSTHOG_HOST,
  isPostHogFlagDisabled as isFlagDisabled
} from '../../shared/posthogConfig'
import { isDatadogMirroredEvent } from '../../shared/datadogMirroredEvents'
import { bucketError as sharedBucketError } from '../../shared/errorBucket'

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

/**
 * @internal — exposed for tests. Resets module-level identity / consent /
 * pending state so consecutive test suites don't share state. Does not
 * close an in-flight PostHog client — tests bring their own mocked one.
 */
export function _resetForTest(): void {
  client = null
  distinctId = null
  installationDeviceId = null
  consentState = 'undecided'
  pendingSessionStart = null
  pendingIdentifyProperties = null
  pendingMigrationAlias = null
  defaultEventProperties = {}
  initialized = false
  drainingForQuit = false
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
let bootstrapTimeMs: number = Date.now()
let initialized = false
/** When `true`, all PostHog WRITE paths (capture, identify, alias*,
 *  captureException, person-property updates) short-circuit. Set in
 *  `initTelemetry` based on `isPackaged`. Read paths (`getOpsFlag`,
 *  `loadFeatureFlagsImmediate`, `shutdown`) deliberately ignore this
 *  so devs can still resolve feature flags in `pnpm dev`. */
let suppressEmit = false

/** Short-circuit guard for all PostHog emission paths. Centralized so
 *  the dev-mode suppression and a missing client are checked
 *  identically across every callsite. */
function canEmit(): boolean {
  return !suppressEmit && client !== null
}

/**
 * Default properties merged into every `capture()` payload. Set once at
 * `initTelemetry()` time from `InitOptions`. Holds `app_version`,
 * `app_channel`, `app_env`, `platform`, `arch`, and `is_packaged` so
 * per-event filters / breakdowns work without a join against the person
 * profile (PostHog person properties are joined at query time and are
 * point-in-time as of write — releasing a new app version while the user
 * still has events from the old one would mis-attribute without this).
 *
 * Per-call properties take precedence on key collision.
 */
let defaultEventProperties: Record<string, TelemetryValue> = {}

/**
 * Coarse release-channel classification derived from a semver-ish
 * `appVersion`. `-beta` / `-canary` / `-alpha` markers map to their
 * channel; a missing suffix is `stable`; an unrecognised suffix is
 * `unknown` (kept coarse so future `-rc` / `-dev` builds fall into
 * `unknown` rather than silently being misclassified). Mirrors the
 * renderer's `deriveAppChannel` so both surfaces agree.
 */
function deriveAppChannel(appVersion: string): string {
  if (!appVersion) return 'unknown'
  const v = appVersion.toLowerCase()
  if (v.includes('-beta')) return 'beta'
  if (v.includes('-canary')) return 'canary'
  if (v.includes('-alpha')) return 'alpha'
  if (/[a-z]/.test(v.split('+')[0]?.split('-').slice(1).join('-') || '')) return 'unknown'
  return 'stable'
}

/**
 * Three-state consent.
 *
 * - `'granted'` — user opted in. Everything ships.
 * - `'denied'` — user opted out. Nothing ships, EXCEPT the
 *   `PRE_CONSENT_ALLOWED_EVENTS` set — see the next paragraph for why.
 * - `'undecided'` — user has not chosen yet (fresh install OR a Desktop-1
 *   migrator whose `telemetryEnabled` setting was never set).
 *   Only events in `PRE_CONSENT_ALLOWED_EVENTS` ship; everything
 *   else is suppressed until the user makes a choice. Mirrors
 *   the renderer's pre-consent gate in `rendererBootstrap.ts`.
 *
 * **Why `PRE_CONSENT_ALLOWED_EVENTS` survive `'denied'`**: the consent
 * decision event itself races the state flip. The renderer's "Continue"
 * handler in `FirstUseTakeover.vue` awaits the telemetryEnabled setting
 * write (which propagates to `setConsentState('denied')` here) and only
 * then calls `emitTelemetryAction('first_use.consent_decision', { decision: 'decline' })`.
 * If `isAllowedToFire` short-circuited on `'denied'` without consulting the
 * allow-list, every decline would be dropped — meaning we'd have 100%
 * accept-rate signal and zero ability to measure decline. The allow-list
 * is intentionally the FIRST check so the decision event survives the
 * exact state it triggers.
 *
 * Default at module load is `'undecided'`: if `setConsentState` is never
 * called (test paths, mis-wired boot), we fail closed for everything that
 * isn't in the allow-list.
 */
export type ConsentState = 'granted' | 'denied' | 'undecided'

let consentState: ConsentState = 'undecided'

const PRE_CONSENT_ALLOWED_EVENTS: ReadonlySet<string> = new Set([
  'desktop2.first_use.consent_decision'
])

function isAllowedToFire(event: string): boolean {
  // Allow-list takes precedence over every state, including 'denied'.
  // See the ConsentState docstring above for the full reasoning — short
  // version: the consent decision event races the 'denied' state flip
  // and would otherwise be dropped by its own decision.
  if (PRE_CONSENT_ALLOWED_EVENTS.has(event)) return true
  if (consentState === 'granted') return true
  return false
}

/**
 * SDK-level volume safety net — two layers, both belt-and-braces around
 * the per-call-site dedup guards that individual emit paths add.
 *
 * Motivation: the 2026-06-02 volume incident shipped 3M+ events of the
 * same four `desktop2.app_update.*` names in 24h before anyone noticed.
 * The per-call fix in `updater.ts` prevents *that specific* loop, but
 * any future emit-in-a-tight-loop bug (a Vue watcher that fires on
 * every render, an IPC handler called every animation frame, a
 * setInterval misconfigured to 100ms instead of 10min) would do the
 * same damage. These two limits make the WORST case bounded even when
 * the call site is buggy.
 *
 * Layer 1: per-event-name sliding window.
 *   Drop further emits of the same event name once 60 fire in 60s.
 *   60/min is well above any legitimate product event rate (the
 *   loudest healthy event was `execution.completed` at ~36/user/day)
 *   and well below any loop signature (the incident was ~2/sec).
 *   One `desktop2.telemetry.rate_limited` warning fires per (event ×
 *   process) so dashboards surface that it happened.
 *
 * Layer 2: per-process total cap.
 *   After 5000 events captured this process, every further capture
 *   no-ops. 5000 covers a heavy multi-hour workflow user (~500–1000
 *   events) with 5–10x headroom, and turns "millions of events" into
 *   "at most 5000" for any single runaway install. One
 *   `desktop2.telemetry.session_cap_hit` warning fires once when the
 *   cap is crossed.
 *
 * `*.error` events bypass Layer 1 — error volume is exactly the signal
 * we need most during incidents, and `*.error` events are not the
 * shape of any loop we've seen. Layer 2 still applies (a runaway
 * error loop would still hit the cap).
 */
const RATE_LIMIT_COUNT = 60
const RATE_LIMIT_WINDOW_MS = 60_000
const SESSION_EVENT_CAP = 5_000
const _rateLimitStamps: Map<string, number[]> = new Map()
const _rateLimitWarned: Set<string> = new Set()
let _eventsCapturedThisProcess = 0
let _sessionCapWarned = false

function _bypassRateLimit(event: string): boolean {
  // Failure events are reliability signal we never want to silently
  // throttle. Telemetry-self events bypass to avoid recursion when
  // we emit the warning events below.
  return event.endsWith('.error') || event.startsWith('desktop2.telemetry.')
}

function _emitWarning(event: string, properties: TelemetryContext): void {
  if (!canEmit() || !distinctId) return
  try {
    client!.capture({
      distinctId,
      event,
      properties: { ...defaultEventProperties, ...properties }
    })
  } catch {
    // ignore – the warning is best-effort
  }
}

function _checkRateLimit(event: string): boolean {
  if (_eventsCapturedThisProcess >= SESSION_EVENT_CAP) {
    if (!_sessionCapWarned) {
      _sessionCapWarned = true
      _emitWarning('desktop2.telemetry.session_cap_hit', {
        cap: SESSION_EVENT_CAP,
        last_event: event
      })
    }
    return false
  }
  if (_bypassRateLimit(event)) return true
  const now = Date.now()
  let stamps = _rateLimitStamps.get(event)
  if (!stamps) {
    stamps = []
    _rateLimitStamps.set(event, stamps)
  }
  while (stamps.length > 0 && stamps[0]! < now - RATE_LIMIT_WINDOW_MS) {
    stamps.shift()
  }
  if (stamps.length >= RATE_LIMIT_COUNT) {
    if (!_rateLimitWarned.has(event)) {
      _rateLimitWarned.add(event)
      _emitWarning('desktop2.telemetry.rate_limited', {
        event_name: event,
        limit: RATE_LIMIT_COUNT,
        window_ms: RATE_LIMIT_WINDOW_MS
      })
    }
    return false
  }
  stamps.push(now)
  return true
}

/**
 * Test-only: reset the SDK rate-limit + session-cap state so each test
 * starts from a clean slate. Not exported via index.ts; reached by
 * tests via direct module import.
 */
export function _test_resetVolumeGuards(): void {
  _rateLimitStamps.clear()
  _rateLimitWarned.clear()
  _eventsCapturedThisProcess = 0
  _sessionCapWarned = false
}

/**
 * Set the current consent state. The deferred `desktop2.session.started`
 * event (and the deferred `identify` person-property update) fire as soon
 * as state transitions to `'granted'`.
 */
export function setConsentState(state: ConsentState): void {
  const previous = consentState
  consentState = state
  if (state !== 'granted') {
    // Best-effort flush so already-queued events still go out before we
    // start suppressing.
    void client?.flush().catch(() => {})
    return
  }
  // Transitioned to granted. Ship anything we held back.
  if (previous !== 'granted') {
    tryFlushDeferred()
  }
}

/**
 * Legacy two-state adapter. Existing callers can keep using `setConsent(bool)`
 * during the Phase-1 transition; new code calls `setConsentState` directly.
 * Note: this maps `false → 'denied'` (NOT `'undecided'`). Pass `'undecided'`
 * explicitly via `setConsentState` for the first-use case.
 */
export function setConsent(enabled: boolean): void {
  setConsentState(enabled ? 'granted' : 'denied')
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

  // Set the per-event defaults BEFORE the early-return so disabled
  // telemetry still gets a coherent snapshot (useful when tests stub
  // the client out but still inspect `defaultEventProperties`).
  defaultEventProperties = {
    app_version: opts.appVersion,
    app_channel: deriveAppChannel(opts.appVersion),
    app_env: opts.appEnv,
    is_packaged: opts.isPackaged,
    platform: process.platform,
    arch: process.arch
  }

  // Suppress event capture on unpackaged (developer / `pnpm dev`) runs.
  // Two reasons: (a) every hot-reload + every dev-tool action would
  // otherwise pollute the same production project we read for product
  // analytics, (b) dev-mode app-update behavior tends to produce
  // pathological event shapes (e.g. the updater repeatedly
  // "discovering" the staged build). Beta / canary / stable channels
  // still emit normally — only the unpackaged local-source case is
  // gated.
  //
  // FLAG READS are NOT suppressed: a dev working on a feature gated by
  // a PostHog flag (e.g. `desktop-cloud-capacity`) needs to actually
  // see the flag's resolved value at boot. Previously the entire
  // PostHog client was skipped in dev, which made `getOpsFlag` /
  // `loadFeatureFlagsImmediate` return defaults and stranded any
  // capacity-protection or experiment testing. Now the client is
  // always created so reads work; only the emission paths
  // (`capture`, `identify`, `alias*`, `captureException`,
  // `registerPersonProperties`) bail when `suppressEmit` is set.
  suppressEmit = !opts.isPackaged

  const cfg = readPostHogConfig()
  if (!cfg.enabled) return

  try {
    client = new PostHog(cfg.apiKey, {
      host: cfg.host,
      flushAt: 20,
      flushInterval: 10_000,
      // posthog-node defaults `disableGeoip: true` (it assumes a server
      // whose IP isn't the user's). Here posthog-node runs in the
      // desktop main process ON the user's machine, so the request IP is
      // the real user IP — opt back into GeoIP so PostHog derives
      // `$geoip_country_name` / region / city for geo cohorts. Only
      // consented users emit at all (capture() is consent-gated), and we
      // surface country/region for analytics, not the raw `$ip`.
      disableGeoip: false
    })
  } catch {
    client = null
  }

  // Stash session-start parameters until identify() can attribute them.
  // The session-start payload duplicates the defaults so an event-only
  // reader (no defaults yet) still sees them on the first event.
  pendingSessionStart = {
    app_env: opts.appEnv,
    app_version: opts.appVersion,
    is_packaged: opts.isPackaged
  }
}

let pendingSessionStart: Record<string, TelemetryValue> | null = null
let pendingIdentifyProperties: Record<string, TelemetryValue> | null = null

/**
 * Deferred legacy-id alias. Set by `deferMigrationAlias()` at boot if
 * there's a pending migration; fired by `tryFlushDeferred()` once
 * consent transitions to granted. The `onAliased` callback clears the
 * persisted pending state in `deviceId.ts` so we never re-fire the
 * alias on subsequent boots once it has shipped.
 */
let pendingMigrationAlias: {
  legacyId: string
  installationId: string
  idClass: string
  onAliased: () => void
} | null = null

/**
 * The anonymous device identity bound at boot (typically `installation_id =
 * SHA-256(machine_id + salt)`). Kept separately from `distinctId` so the
 * logout path can switch the active distinct id back to this baseline
 * without re-deriving anything.
 *
 * On logout we explicitly do NOT call `posthog.reset()` (which would
 * generate a fresh anonymous id and clobber the deterministic
 * `installation_id` plus the acquisition `download_token`). Instead, we
 * switch `distinctId` back to this remembered baseline.
 */
let installationDeviceId: string | null = null

function tryFlushDeferred(): void {
  if (!canEmit() || !distinctId) return
  if (consentState !== 'granted') return
  if (pendingIdentifyProperties) {
    try {
      client!.identify({ distinctId, properties: { $set: pendingIdentifyProperties } })
    } catch {
      // ignore
    }
    pendingIdentifyProperties = null
  }
  if (pendingMigrationAlias) {
    // Snapshot + clear before await so a re-entrant flush doesn't double-fire.
    const m = pendingMigrationAlias
    pendingMigrationAlias = null
    void (async () => {
      await aliasImmediate(m.installationId, m.legacyId)
      // Intentionally NOT publishing `from_id` (the legacy random UUID)
      // as an event property. The `alias` call above already merges
      // the legacy person record into the new one in PostHog, so the
      // legacy id is already linked where it needs to be. Shipping it
      // again on a regular event would scatter it across the event
      // properties column where it shows up in every export and
      // ad-hoc query — unnecessary proliferation of an identifier.
      capture('desktop2.identity.migrated', {
        installation_id: m.installationId,
        id_class: m.idClass
      })
      try {
        m.onAliased()
      } catch {
        // onAliased is the on-disk pending-alias / migration-guard cleanup
        // — best-effort; a failure leaves the alias to re-fire next boot.
      }
    })()
  }
  if (pendingSessionStart) {
    capture('desktop2.session.started', pendingSessionStart)
    pendingSessionStart = null
  }
}

/**
 * Queue a legacy-id alias to fire as soon as consent is granted. If
 * consent is already granted, fires synchronously via `tryFlushDeferred`.
 * If denied or undecided, the alias sits in module state and ships on
 * the next `setConsentState('granted')` transition.
 *
 * `onAliased` runs after the alias call resolves — the caller passes a
 * one-shot cleanup (clear the persisted pending-alias file + mark the
 * migration guard) so the alias does not re-fire on subsequent boots.
 * It is the caller's job to make `onAliased` idempotent — `tryFlushDeferred`
 * may run multiple times across a session.
 */
export function deferMigrationAlias(opts: {
  legacyId: string
  installationId: string
  idClass: string
  onAliased: () => void
}): void {
  pendingMigrationAlias = opts
  tryFlushDeferred()
}

/**
 * Bind the persistent device id once it is known. If consent is granted,
 * fires the deferred session-start event and ships person-property updates.
 * If consent is `'denied'` or `'undecided'`, the binding happens in module
 * state (so `capture` works once consent flips to granted) but no network
 * calls are made until `setConsentState('granted')` is called.
 */
export function identify(id: string, properties: Record<string, TelemetryValue> = {}): void {
  distinctId = id
  installationDeviceId = id
  pendingIdentifyProperties = properties
  if (!canEmit()) return
  tryFlushDeferred()
}

/**
 * Bind a `user_id` after a successful login.
 *
 * identity lifecycle.
 * Aliases the current anonymous `installation_id` into the new `user_id`
 * (PostHog merges histories), switches the active `distinct_id` to the
 * user id, sets `is_authenticated: true` as a person property, and emits
 * the canonical `app:user_logged_in` event.
 *
 * Suppressed unless consent is `'granted'` — auth signals are
 * identifying data and must not ship pre-consent.
 *
 * Caller responsibility (renderer): also call
 * `datadogRum.setUser({ id: userId })` so RUM tags subsequent events
 * with the user identity. (Datadog is browser-only; main cannot do
 * this from here.)
 */
export function bindUserId(userId: string, properties: Record<string, TelemetryValue> = {}): void {
  if (!canEmit() || !installationDeviceId) return
  if (consentState !== 'granted') return
  const anonymousId = installationDeviceId
  distinctId = userId
  try {
    client!.alias({ distinctId: userId, alias: anonymousId })
  } catch {
    // ignore
  }
  try {
    client!.identify({
      distinctId: userId,
      properties: { $set: { ...properties, is_authenticated: true } }
    })
  } catch {
    // ignore
  }
  capture('app:user_logged_in', { user_id: userId })
}

/**
 * Switch back to the anonymous `installation_id` after a logout.
 *
 * **Not** `posthog.reset()`: that would generate a brand-new anonymous
 * device id and clobber the deterministic `installation_id` plus the
 * acquisition `download_token`. Instead, we restore `distinct_id` to
 * the remembered baseline so subsequent events ride under the device
 * identity (not the prior user).
 *
 * Person-property `is_authenticated` is flipped back to `false` on the
 * anonymous identity so cohort filters reading it stay consistent.
 *
 * Caller responsibility (renderer): also clear Datadog
 * (`datadogRum.setUser({})` / `clearUser`) so RUM stops tagging events
 * with the prior user.
 */
export function unbindUserId(): void {
  if (!installationDeviceId) return
  distinctId = installationDeviceId
  if (canEmit() && consentState === 'granted') {
    try {
      client!.identify({
        distinctId: installationDeviceId,
        properties: { $set: { is_authenticated: false } }
      })
    } catch {
      // ignore
    }
  }
}

export function capture(event: string, properties: TelemetryContext = {}): void {
  if (!canEmit() || !distinctId) return
  if (!isAllowedToFire(event)) return
  if (!_checkRateLimit(event)) return
  _eventsCapturedThisProcess++
  try {
    // Per-call properties override defaults on key collision — callers
    // that explicitly pass `app_version` (e.g. session-start payload,
    // legacy event re-emitters) win.
    client!.capture({
      distinctId,
      event,
      properties: { ...defaultEventProperties, ...properties }
    })
  } catch {
    // ignore – telemetry must never break the app
  }
}

/**
 * Update PostHog person properties for the current distinct id (`$set`).
 *
 * Used by the renderer's cohort-context register pass and any other
 * caller that wants to attach durable user-level properties without
 * firing an event. Honors three-state consent: queued in
 * `pendingIdentifyProperties` until consent grants, at which point
 * `tryFlushDeferred()` ships the merged set in one identify call.
 *
 * Repeated calls in the queued state merge (latest write wins per key).
 */
export function registerPersonProperties(properties: Record<string, TelemetryValue>): void {
  if (!canEmit()) return
  if (consentState !== 'granted' || !distinctId) {
    pendingIdentifyProperties = { ...(pendingIdentifyProperties || {}), ...properties }
    return
  }
  try {
    client!.identify({ distinctId, properties: { $set: properties } })
  } catch {
    // ignore – telemetry must never break the app
  }
}

export function captureException(error: unknown, properties: TelemetryContext = {}): void {
  if (!canEmit() || !distinctId) return
  // Exceptions are reliability data; suppress them outside `'granted'`.
  if (consentState !== 'granted') return
  try {
    client!.captureException(error, distinctId, properties)
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
 * Suppressed unless consent is `'granted'`. Aliases ship identifying data
 * (the legacy id), so we never even attempt the network call when consent
 * is `'denied'` or `'undecided'`.
 */
export async function aliasImmediate(distinctId: string, alias: string): Promise<void> {
  if (!canEmit()) return
  if (consentState !== 'granted') return
  try {
    await client!.aliasImmediate({ distinctId, alias })
  } catch {
    // ignore – telemetry must never break the app
  }
}

/**
 * Fetch every feature flag for the current user with a hard timeout.
 *
 * Used by the experiments module's boot-time refresh. Returns `{}` on
 * timeout / failure so the caller can fall back to its cached values
 * without distinguishing failure modes. Suppressed unless consent is
 * `'granted'` — flag evaluation requests carry the distinct id and
 * person properties to PostHog, so they must not ship pre-consent.
 *
 * The returned record's keys are PostHog flag/experiment names; values
 * are the assigned variant (string for multivariate, boolean for
 * single-flag). See `src/main/lib/experiments.ts` for the cache wrapper.
 */
export async function loadFeatureFlagsImmediate(
  distinctId: string,
  personProperties: Record<string, string>,
  timeoutMs: number
): Promise<Record<string, FeatureFlagValue>> {
  if (!client) return {}
  if (consentState !== 'granted') return {}
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const flagsPromise = client.getAllFlags(distinctId, { personProperties })
    const timeoutPromise = new Promise<Record<string, FeatureFlagValue>>((resolve) => {
      timer = setTimeout(() => resolve({}), timeoutMs)
    })
    return await Promise.race([flagsPromise, timeoutPromise])
  } catch {
    return {}
  } finally {
    // Clear the timer when the flags promise wins the race so we don't
    // keep the event loop alive for the remainder of `timeoutMs`.
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Fetch a single OPERATIONAL feature flag value with a hard timeout.
 *
 * Bypasses the telemetry consent gate by design: this entry point is
 * reserved for kill-switches and capacity-protection flags (e.g.
 * `desktop-cloud-capacity`), not A/B experiments or analytics. Those
 * are server-config pushed *to* the client to protect service
 * availability for everyone — distinct from analytics data collected
 * *from* the user, which `loadFeatureFlagsImmediate` correctly gates on
 * consent. The only data leaving the device is the anonymous distinct
 * id and the flag key; no person properties are sent.
 *
 * Returns `undefined` when:
 *   - the PostHog client is not yet initialised
 *   - the network call times out or errors
 *   - the flag is missing on the server
 * Callers must default-fail-safe (e.g. `cloudCapacity.ts` defaults to
 * `'normal'`) so a fetch miss never accidentally degrades the product.
 */
export async function getOpsFlag(
  key: string,
  distinctId: string,
  timeoutMs: number
): Promise<FeatureFlagValue | undefined> {
  if (!client) return undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // No `personProperties` — ops flags are global, not user-keyed.
    const flagPromise = client.getFeatureFlag(key, distinctId)
    const timeoutPromise = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs)
    })
    const result = await Promise.race([flagPromise, timeoutPromise])
    if (typeof result === 'string' || typeof result === 'boolean') return result
    return undefined
  } catch {
    return undefined
  } finally {
    if (timer !== undefined) clearTimeout(timer)
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
  fn: () => Promise<T>
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
      error_message: message.slice(0, 500)
    })
    throw err
  }
}

/**
 * Coarse error categorisation. Re-exported from `src/shared/errorBucket.ts`
 * so main and renderer classify identically (dedup).
 */
export const bucketError = sharedBucketError

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
  if (!isAllowedToFire(event)) return
  // only mirror events on the Datadog allow-list.
  // Product / funnel events are PostHog-only; main already captured them via
  // `capture()` and forwarding them to the renderer for Datadog mirror is
  // pure overhead.
  if (!isDatadogMirroredEvent(event)) return
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
      uptime_seconds: Math.round(uptimeMs / 1000)
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
      setTimeout(resolve, SHUTDOWN_DRAIN_TIMEOUT_MS)
    )
    void Promise.race([drainPromise, timeoutPromise]).finally(() => {
      app.exit(0)
    })
  })
}
