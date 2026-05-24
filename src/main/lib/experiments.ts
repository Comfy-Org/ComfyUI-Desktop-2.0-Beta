/**
 * A/B experiment foundation.
 *
 * Owns the on-disk flag cache, a synchronous `getFlag(key)` accessor,
 * the boot-time background refresh, and the `experiment.exposed` event
 * helper (with per-session dedup).
 *
 * Architecture: every renderer flag query is cache-first via
 * `getFlag()`. The cache lives at `<configDir>/experiment-flags.json`
 * and is refreshed in the background after boot — the current process
 * uses what it loaded synchronously; the refreshed values land on disk
 * for the NEXT boot. This trade keeps boot fast (no network on the
 * critical path) at the cost of one-boot-of-lag for variant changes.
 *
 * The previous in-tree experiment-flag system was deliberately removed
 * (the old `feature-flags.ts` plus a sample-rate dial). This module
 * brings back only the experiment-evaluation subset, not the
 * kill-switch grab-bag.
 *
 * Consent: `loadFeatureFlagsImmediate` is already suppressed unless
 * consent is `'granted'`, so the boot refresh never ships a network
 * call pre-consent. Cached flags from a prior consented session WILL
 * still drive variant assignment if the user later revokes consent —
 * acceptable, because (a) no event ships pre-consent so no analysis
 * happens, and (b) the cache is wiped on the user's next reinstall.
 */
import fs from 'fs'
import path from 'path'
import { configDir } from './paths'
import * as mainTelemetry from './telemetry'
import type { FeatureFlagValue } from './telemetry'

const DEFAULT_TIMEOUT_MS = 1500

export type ExperimentExposureSource = 'cache' | 'remote' | 'fallback'

function cacheFilePath(): string {
  return path.join(configDir(), 'experiment-flags.json')
}

let cached: Record<string, FeatureFlagValue> | null = null
let initStarted = false
const exposedThisSession = new Set<string>()

function readCacheSync(): Record<string, FeatureFlagValue> | null {
  try {
    const raw = fs.readFileSync(cacheFilePath(), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, FeatureFlagValue>
    }
  } catch {
    // file missing or unreadable; treat as no cache
  }
  return null
}

function writeCache(flags: Record<string, FeatureFlagValue>): void {
  try {
    fs.mkdirSync(path.dirname(cacheFilePath()), { recursive: true })
    fs.writeFileSync(cacheFilePath(), JSON.stringify(flags))
  } catch {
    // best effort — cache is a perf optimization, not correctness
  }
}

/**
 * Initialise the experiments module. Synchronously loads the on-disk
 * cache so `getFlag()` is usable immediately, then kicks off a background
 * fetch (does NOT await) to refresh the cache for the next boot.
 *
 * Returns a promise that resolves when the background fetch settles, so
 * tests can deterministically observe the refresh. Production callers
 * can ignore the returned promise.
 *
 * Idempotent within a process.
 */
export function initExperiments(opts: {
  distinctId: string
  personProperties: Record<string, string>
  timeoutMs?: number
}): Promise<void> {
  if (initStarted) return Promise.resolve()
  initStarted = true
  cached = readCacheSync() ?? {}
  return mainTelemetry
    .loadFeatureFlagsImmediate(
      opts.distinctId,
      opts.personProperties,
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    )
    .then((flags) => {
      // Only overwrite cache on a non-empty response. An empty result is
      // ambiguous (could be timeout, could be "no flags configured"); the
      // safer move is to keep the previously-cached values so a user who
      // has been assigned a variant doesn't flip back to control on a
      // single bad fetch.
      if (flags && Object.keys(flags).length > 0) {
        cached = flags
        writeCache(flags)
      }
    })
    .catch(() => {
      /* fail closed: keep current cache */
    })
}

/**
 * Synchronous flag accessor. Returns the cached value, or `undefined` if
 * the flag is not present in the cache. Callers should default to the
 * control branch when the result is undefined.
 *
 * Must only be called after `initExperiments` has been invoked at boot
 * (subsequent calls before the background fetch settles return the
 * synchronously-loaded cache values, which is intended).
 */
export function getFlag(key: string): FeatureFlagValue | undefined {
  return cached?.[key]
}

/**
 * Record an exposure event for a given experiment / variant.
 *
 * Per-session dedup: the same `(experimentKey, variant)` pair fires at
 * most one `desktop2.experiment.exposed` event per process lifetime.
 * Reset on next boot.
 *
 * `source` tells dashboards how the assignment was obtained:
 * - `'cache'` — from the on-disk cache (most common)
 * - `'remote'` — from a fresh fetch (rare, happens if the renderer
 * queries between cache load and refresh)
 * - `'fallback'` — control branch picked because no value was cached
 * AND no fresh value was available (first-ever boot
 * with no network)
 */
export function recordExposure(
  experimentKey: string,
  variant: string,
  source: ExperimentExposureSource
): void {
  const dedupKey = `${experimentKey}:${variant}`
  if (exposedThisSession.has(dedupKey)) return
  exposedThisSession.add(dedupKey)
  mainTelemetry.capture('desktop2.experiment.exposed', {
    experiment_key: experimentKey,
    variant,
    source
  })
}

/** @internal — exposed for tests. */
export function _resetForTest(): void {
  cached = null
  initStarted = false
  exposedThisSession.clear()
}
