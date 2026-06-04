/**
 * Cloud capacity-protection switch.
 *
 * Reads the `desktop-cloud-capacity` PostHog flag at boot via `getOpsFlag`, which
 * deliberately BYPASSES the consent gate: this is server config pushed TO the client to
 * protect service availability, not analytics collected FROM the user, so a user who
 * declined telemetry still benefits when GPUs are saturated. Only the anonymous distinct id
 * and flag key leave the device.
 *
 * Kept separate from `experiments.ts` (locked variant assignment, next-boot cache) so a
 * kill-switch isn't accidentally consent-gated. Fetched once at boot; running apps pick up
 * new values on restart.
 */
import * as mainTelemetry from './telemetry'

export const CLOUD_CAPACITY_FLAG_KEY = 'desktop-cloud-capacity'

export type CloudCapacityStatus = 'normal' | 'degraded' | 'disabled'

const VALID: ReadonlySet<CloudCapacityStatus> = new Set(['normal', 'degraded', 'disabled'])

const DEFAULT_TIMEOUT_MS = 2000

let cached: CloudCapacityStatus = 'normal'
let initPromise: Promise<void> | null = null

/**
 * Boot-time fetch. The returned promise is cached so the IPC handler can await it: a
 * renderer query landing before the fetch settles sees the resolved value, not the default.
 * Idempotent within a process.
 */
export function initCloudCapacity(opts: {
  distinctId: string
  timeoutMs?: number
}): Promise<void> {
  if (initPromise) return initPromise
  initPromise = mainTelemetry
    .getOpsFlag(CLOUD_CAPACITY_FLAG_KEY, opts.distinctId, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    .then((value) => {
      if (typeof value === 'string' && VALID.has(value as CloudCapacityStatus)) {
        cached = value as CloudCapacityStatus
      }
      // Else keep `'normal'` (undefined, boolean, or unknown string).

      console.log('[cloud-capacity] init: fetched=', value, '→ cached=', cached)
    })
    .catch((err) => {
       
      console.log('[cloud-capacity] init error:', err)
      // fail-safe: keep `'normal'`
    })
  return initPromise
}

/** Awaits the in-flight init fetch so renderer queries landing before it settles still get
 *  the resolved status, not the `'normal'` default. */
export async function getCloudCapacityStatusAsync(): Promise<CloudCapacityStatus> {
  if (initPromise) {
    try {
      await initPromise
    } catch {
      /* keep cached */
    }
  }
  return cached
}

/** Synchronous accessor returning the current cache. Prefer the async variant from the IPC
 *  handler so the first call doesn't race the boot fetch. */
export function getCloudCapacityStatus(): CloudCapacityStatus {
  return cached
}

/** @internal — exposed for tests. */
export function _resetForTest(): void {
  cached = 'normal'
  initPromise = null
}
