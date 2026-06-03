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

function isFeatureFlagValue(v: unknown): v is FeatureFlagValue {
  return typeof v === 'string' || typeof v === 'boolean'
}

/**
 * Filter a parsed cache object to only `FeatureFlagValue` entries.
 * The cache file is user-writable JSON on disk — a corrupted entry like
 * `{ "flag.a": 42 }` would otherwise flow through `getFlag()` → exposure
 * events with `variant: 42` and renderer code that branches on
 * `value === 'treatment'` silently picks control. Per-key filter drops
 * the bad entries rather than rejecting the whole cache.
 */
function readCacheSync(): Record<string, FeatureFlagValue> | null {
  try {
    const raw = fs.readFileSync(cacheFilePath(), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const sanitised: Record<string, FeatureFlagValue> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (isFeatureFlagValue(value)) sanitised[key] = value
    }
    return sanitised
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
  // Idempotent within a process: repeated calls return without re-running
  // the cache load or the background fetch. The `opts.distinctId` and
  // `opts.personProperties` of subsequent calls are intentionally ignored
  // — identity changes mid-session (e.g. after `bindUserId`) do not
  // re-evaluate experiments. Variant stability for an installation is a
  // property we want; rotating variants when a user logs in would
  // contaminate the experiment population.
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
      // Refresh ONLY the on-disk cache — do not overwrite the in-memory
      // `cached` for the running session. Variant assignment for this
      // process is locked to what loaded synchronously at boot, so a
      // background fetch that settles mid-session can't flip a banner
      // out from under the user or change which arm of an experiment
      // a given action belongs to. New values land on disk and take
      // effect on the NEXT boot.
      //
      // Empty result is also ignored on disk: ambiguous (timeout vs
      // legitimately no flags configured), and overwriting with empty
      // would roll every cached variant back to fallback on next boot.
      if (Object.keys(flags).length > 0) {
        writeCache(flags)
      }
    })
    .catch(() => {
      /* fail closed: keep current cache on disk and in memory */
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
 * most one `comfy.desktop.experiment.exposed` event per process lifetime.
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
  mainTelemetry.capture('comfy.desktop.experiment.exposed', {
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
