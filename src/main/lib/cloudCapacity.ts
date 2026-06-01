/**
 * Cloud capacity-protection switch.
 *
 * Reads the `desktop-cloud-capacity` PostHog flag (variants: `normal` |
 * `degraded` | `disabled`) at boot via the existing `experiments` cache
 * and exposes the resolved status to the renderer via the
 * `get-cloud-capacity` IPC handler.
 *
 * Why no mid-session refresh: the flag mechanism reuses `experiments.ts`,
 * which deliberately locks variant assignment for the running process to
 * what loaded synchronously at boot. For a capacity switch the trade is
 * acceptable: most new cloud sessions originate from a fresh app open,
 * and users on next restart pick up the new value. A separate live-push
 * mechanism is the natural follow-up if an incident demands sub-minute
 * propagation.
 *
 * Consent: `experiments.getFlag` returns whatever was cached. The cache
 * is only populated when telemetry consent is `granted` (see
 * `loadFeatureFlagsImmediate` in `telemetry.ts`). Users who have not
 * granted consent see `normal` — they bypass the throttle. This is a
 * deliberate trade vs. issuing a non-consented network call from the
 * desktop client.
 */
import { getFlag } from './experiments'

export const CLOUD_CAPACITY_FLAG_KEY = 'desktop-cloud-capacity'

export type CloudCapacityStatus = 'normal' | 'degraded' | 'disabled'

const VALID: ReadonlySet<CloudCapacityStatus> = new Set(['normal', 'degraded', 'disabled'])

/**
 * Resolve the current capacity status from the experiments cache.
 *
 * Returns `'normal'` (safe default) when:
 *   - the flag is not present (no cache, user has not consented, etc.)
 *   - the cached value is malformed / not one of the three known variants
 *   - the experiments module is not yet initialised
 *
 * The default is deliberately `'normal'` (no UI changes) so a missing
 * flag never accidentally degrades or blocks the cloud entry points.
 */
export function getCloudCapacityStatus(): CloudCapacityStatus {
  const raw = getFlag(CLOUD_CAPACITY_FLAG_KEY)
  if (typeof raw !== 'string') return 'normal'
  return VALID.has(raw as CloudCapacityStatus) ? (raw as CloudCapacityStatus) : 'normal'
}
