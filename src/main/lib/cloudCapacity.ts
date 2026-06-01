/**
 * Cloud capacity-protection switch.
 *
 * Reads the `desktop-cloud-capacity` PostHog flag (variants: `normal` |
 * `degraded` | `disabled`) at boot via `mainTelemetry.getOpsFlag`, which
 * deliberately BYPASSES the telemetry consent gate. Rationale: a
 * capacity kill-switch is server config pushed *to* the client to
 * protect service availability for everyone — not analytics collected
 * *from* the user. A user who declined telemetry should still get the
 * benefit of cloud being throttled when GPUs are saturated. The only
 * data leaving the device is the anonymous distinct id and the flag
 * key; no person properties are sent. See `telemetry.ts → getOpsFlag`.
 *
 * Why a separate path from `experiments.ts`: that module is purpose-
 * built for A/B experiments — variant assignment is locked for the
 * running process (no mid-session flips), and the on-disk cache is
 * intended to drive the NEXT boot, not this one. Reusing it for a
 * kill-switch would smuggle two unrelated semantics into one module
 * and silently consent-gate a feature that has no business being
 * gated on consent.
 *
 * Boot-only refresh stays: the flag is fetched once at startup. Users
 * with the app already running pick up new values on next restart.
 * Acceptable for the launch use case (most new cloud sessions come
 * from a fresh app open). A live-push path is the natural follow-up
 * if an incident demands sub-restart propagation.
 */
import * as mainTelemetry from './telemetry'

export const CLOUD_CAPACITY_FLAG_KEY = 'desktop-cloud-capacity'

export type CloudCapacityStatus = 'normal' | 'degraded' | 'disabled'

const VALID: ReadonlySet<CloudCapacityStatus> = new Set(['normal', 'degraded', 'disabled'])

const DEFAULT_TIMEOUT_MS = 2000

let cached: CloudCapacityStatus = 'normal'
let initStarted = false

/**
 * Boot-time fetch. Synchronously sets the cache to `'normal'`, then
 * issues a single non-blocking PostHog flag-fetch in the background to
 * replace it. The IPC handler (`get-cloud-capacity`) reads whatever is
 * currently in the cache — so a renderer query that lands before the
 * fetch settles receives the safe `'normal'` default.
 *
 * Idempotent within a process; subsequent calls return without
 * re-issuing the fetch.
 */
export function initCloudCapacity(opts: {
  distinctId: string
  timeoutMs?: number
}): Promise<void> {
  if (initStarted) return Promise.resolve()
  initStarted = true
  return mainTelemetry
    .getOpsFlag(CLOUD_CAPACITY_FLAG_KEY, opts.distinctId, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    .then((value) => {
      if (typeof value === 'string' && VALID.has(value as CloudCapacityStatus)) {
        cached = value as CloudCapacityStatus
      }
      // Else keep `'normal'` — covers undefined (no client, timeout,
      // missing flag), boolean values, and unknown strings.
    })
    .catch(() => {
      /* fail-safe: keep `'normal'` */
    })
}

/**
 * Synchronous accessor for the IPC handler. Returns the cached status,
 * which is always one of the three known variants (defaults to
 * `'normal'` until / unless the boot fetch replaces it).
 */
export function getCloudCapacityStatus(): CloudCapacityStatus {
  return cached
}

/** @internal — exposed for tests. */
export function _resetForTest(): void {
  cached = 'normal'
  initStarted = false
}
