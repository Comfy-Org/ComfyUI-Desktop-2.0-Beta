/**
 * Shared release info cache.
 *
 * Stores the latest release metadata (latestTag, releaseName, releaseNotes, etc.)
 * keyed by remote identity (repo + channel), so multiple installations pointing at
 * the same upstream share a single check result.
 *
 * The cache is kept in memory for fast synchronous reads (getDetailSections,
 * getStatusTag) and persisted to release-cache.json asynchronously.
 */

import path from 'path'
import fs from 'fs'
import { dataDir } from './paths'
import { writeFileSafe } from './safe-file'
import { fetchLatestRelease, getLatestStableTag, truncateNotes } from './comfyui-releases'
import { fetchTags, countCommitsAhead, fetchCommitSha, findNearestTag } from './git'
import { formatComfyVersion } from './version'
import type { ComfyVersion } from './version'

export interface ReleaseCacheEntry {
  checkedAt?: number
  latestTag?: string
  releaseName?: string
  releaseNotes?: string
  releaseUrl?: string
  publishedAt?: string
  installedTag?: string
  /** Raw version data for the latest release (latest channel). */
  commitSha?: string
  baseTag?: string
  commitsAhead?: number
  /** Wall-clock timestamp of the most recent `enrichCommitsAhead` settle
   *  (success or failure) for this entry. Lets the renderer drop the
   *  "Computing commits ahead…" hint as soon as enrichment gives up
   *  instead of waiting for the safety-net timer, and prevents the hint
   *  from re-appearing on every picker reopen when the underlying state
   *  is structurally broken (e.g. no `baseTag` recoverable). Cleared
   *  implicitly whenever `buildCacheEntry` writes a fresh entry. */
  lastEnrichAttemptAt?: number
  [key: string]: unknown
}

const CACHE_FILE = path.join(dataDir(), 'release-cache.json')

// In-memory state, loaded once at startup
let _entries: Record<string, ReleaseCacheEntry> = {}
let _loaded: boolean = false

function _ensureLoaded(): void {
  if (_loaded) return
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'))
    _entries = (raw.entries as Record<string, ReleaseCacheEntry>) || {}
  } catch {
    _entries = {}
  }
  _loaded = true
}

function _persist(): void {
  try {
    writeFileSafe(CACHE_FILE, JSON.stringify({ schemaVersion: 1, entries: _entries }, null, 2))
  } catch {
    // ignore persist errors
  }
}

/**
 * Test-only: force every cached entry's `checkedAt` to `maxCheckedAt` so the
 * renderer-side stale-cache watcher fires on next picker open. Only invoked
 * via `__e2e.ageReleaseCache` when `process.env['E2E'] === '1'`.
 */
export function _test_ageEntries(maxCheckedAt: number): void {
  _ensureLoaded()
  for (const key of Object.keys(_entries)) {
    const entry = _entries[key]
    if (entry) entry.checkedAt = maxCheckedAt
  }
  _persist()
}

/**
 * Build a cache key from a remote identity.
 * Today: "github:Comfy-Org/ComfyUI:stable"
 * Future: could include branch/ref overrides per installation.
 */
export function makeKey(repo: string, channel: string): string {
  return `github:${repo}:${channel}`
}

/**
 * Get cached release info (synchronous — reads from memory).
 * Returns the entry object or null.
 */
export function get(repo: string, channel: string): ReleaseCacheEntry | null {
  _ensureLoaded()
  return _entries[makeKey(repo, channel)] ?? null
}

/**
 * Store release info and persist to disk.
 */
export function set(repo: string, channel: string, entry: ReleaseCacheEntry): void {
  _ensureLoaded()
  _entries[makeKey(repo, channel)] = entry
  _persist()
}

// Single-flight deduplication: key -> Promise
const _inFlight: Map<string, Promise<ReleaseCacheEntry | null>> = new Map()

// Minimum interval between forced refetches for the same key (in ms).
// Prevents spamming the GitHub API and triggering secondary rate limits.
const MIN_RECHECK_INTERVAL = 10_000

/**
 * Fetch release info, deduplicating concurrent calls for the same key.
 * @param repo - e.g. "Comfy-Org/ComfyUI"
 * @param channel - "stable" or "latest"
 * @param fetchFn - async () => entry (calls the GitHub API)
 * @param force - bypass cache
 * @returns the release entry
 */
export async function getOrFetch(
  repo: string,
  channel: string,
  fetchFn: () => Promise<ReleaseCacheEntry | null>,
  force: boolean = false
): Promise<ReleaseCacheEntry | null> {
  const key = makeKey(repo, channel)
  _ensureLoaded()

  const cached = _entries[key]
  if (!force) {
    if (cached) return cached
  } else if (cached?.checkedAt && Date.now() - cached.checkedAt < MIN_RECHECK_INTERVAL) {
    return cached
  }

  // Single-flight: if another call is already fetching this key, wait for it
  if (_inFlight.has(key)) {
    return _inFlight.get(key)!
  }

  const promise = (async () => {
    try {
      const entry = await fetchFn()
      if (entry) {
        _entries[key] = entry
        _persist()
      }
      return entry ?? cached ?? null
    } catch {
      return cached ?? null
    } finally {
      _inFlight.delete(key)
    }
  })()

  _inFlight.set(key, promise)
  return promise
}

/**
 * Build effective update info by merging the shared release cache (remote info)
 * with per-installation state (installedTag).
 */
export function getEffectiveInfo(
  repo: string,
  channel: string,
  installation: Record<string, unknown>
): (ReleaseCacheEntry & { installedTag: string }) | null {
  const cached = get(repo, channel)
  if (!cached) return null
  const updateInfoByChannel = installation.updateInfoByChannel as
    | Record<string, Record<string, unknown>>
    | undefined
  const perInstall = updateInfoByChannel?.[channel]
  const cv = installation.comfyVersion as ComfyVersion | undefined
  const installedTag =
    (perInstall?.installedTag as string | undefined) ??
    (cv ? formatComfyVersion(cv, 'short') : undefined) ??
    (installation.version as string | undefined) ??
    'unknown'
  return { ...cached, installedTag }
}

/**
 * Build a cache entry from the raw release object returned by fetchLatestRelease.
 * Shared by all callers (auto-check, manual check-update, cross-channel prefetch).
 */
export function buildCacheEntry(release: Record<string, unknown>): ReleaseCacheEntry {
  const commitSha = release.commitSha as string | undefined
  const baseTag = release.baseTag as string | undefined
  const commitsAhead = release.commitsAhead as number | undefined
  const cv: ComfyVersion | undefined = commitSha
    ? { commit: commitSha, baseTag, commitsAhead }
    : undefined
  return {
    checkedAt: Date.now(),
    latestTag: release.tag_name as string,
    releaseName: cv ? formatComfyVersion(cv, 'short') : ((release.name as string) || (release.tag_name as string)),
    commitSha,
    baseTag,
    commitsAhead,
    releaseNotes: truncateNotes(release.body as string, 4000),
    releaseUrl: release.html_url as string,
    publishedAt: release.published_at as string,
  }
}

/**
 * Shared check-update action handler. Fetches the latest release info into the
 * cache and persists the per-installation installedTag.
 */
export async function checkForUpdate(
  repo: string,
  channel: string,
  installation: Record<string, unknown>,
  update: (data: Record<string, unknown>) => Promise<void>
): Promise<{ ok: boolean; navigate?: string; message?: string }> {
  const entry = await getOrFetch(
    repo,
    channel,
    async () => {
      const release = await fetchLatestRelease(channel)
      if (!release) return null
      return buildCacheEntry(release)
    },
    /* force */ true
  )
  if (!entry) {
    return { ok: false, message: 'Could not fetch releases from GitHub.' }
  }

  const existing = (installation.updateInfoByChannel as Record<string, Record<string, unknown>>) || {}
  const prevChannelInfo = existing[channel]
  const cv = installation.comfyVersion as ComfyVersion | undefined
  const installedTag =
    (cv ? formatComfyVersion(cv, 'short') : undefined) ??
    (prevChannelInfo?.installedTag as string | undefined) ??
    (installation.version as string | undefined) ??
    'unknown'
  await update({
    updateInfoByChannel: {
      ...existing,
      [channel]: { installedTag },
    },
  })
  return { ok: true, navigate: 'detail' }
}

/**
 * Inflight dedupe for `enrichCommitsAhead`. Keyed by `repo::comfyuiDir` so
 * rapid install switches in the picker can't fan out N parallel `git fetch`
 * processes against the same checkout — concurrent callers share the same
 * promise. Cleared on settle.
 */
const _enrichInflight = new Map<string, Promise<void>>()

/** Minimum interval between *failed* enrichment retries for the same
 *  cache entry.  The inflight dedupe already coalesces concurrent
 *  callers, but each picker reopen and each auto-check tick fires a
 *  fresh `enrichCommitsAhead` call after the previous one has settled.
 *  Without this throttle a structurally broken entry (no recoverable
 *  `baseTag`, persistent rev-list failure) would re-run the full
 *  recovery + fetch chain on every reopen for no gain.  30s is short
 *  enough to recover quickly when the user comes back online, long
 *  enough that rapid picker toggling doesn't spam git. */
const ENRICH_RETRY_THROTTLE_MS = 30_000

/** Listeners notified when `enrichCommitsAhead` actually writes a new
 *  `commitsAhead` value into the cache (not on no-op short-circuits). The
 *  IPC layer wires a broadcast here so renderers can refresh affected
 *  sections in place — see `wireReleaseCacheBroadcast` callers. */
const _enrichedListeners = new Set<(repo: string) => void>()

export function onEnriched(cb: (repo: string) => void): () => void {
  _enrichedListeners.add(cb)
  return () => _enrichedListeners.delete(cb)
}

/**
 * Enrich the "latest" channel cache entry with locally-computed commitsAhead.
 * ls-remote cannot compute this, so we resolve it from a local git repo.
 * No-op if commitsAhead is already set or the entry lacks the required fields.
 * Concurrent calls for the same `(repo, comfyuiDir)` share one in-flight promise.
 *
 * Always stamps `lastEnrichAttemptAt` and fires `onEnriched` on settle —
 * success or failure — so the renderer can drop the "Computing commits
 * ahead…" hint as soon as we give up, rather than waiting for the
 * safety-net timer.
 */
export async function enrichCommitsAhead(repo: string, comfyuiDir: string): Promise<void> {
  const key = `${repo}::${comfyuiDir}`
  const existing = _enrichInflight.get(key)
  if (existing) return existing

  const run = (async () => {
    const entry = get(repo, 'latest')
    if (!entry?.commitSha || entry.commitsAhead !== undefined) return
    if (!fs.existsSync(path.join(comfyuiDir, '.git'))) return
    // Retry throttle: a recent failed attempt (`lastEnrichAttemptAt`
    // set but `commitsAhead` still undefined) means the recovery /
    // count chain just ran and produced nothing.  Don't re-run it on
    // every picker reopen — the underlying state is unlikely to change
    // in the next few seconds, and we already broadcast a settle so
    // the renderer dropped its spinner.
    if (entry.lastEnrichAttemptAt !== undefined
      && Date.now() - entry.lastEnrichAttemptAt < ENRICH_RETRY_THROTTLE_MS) return

    // Recover a missing baseTag before bailing.  When
    // `fetchLatestRelease('latest')` runs while `getLatestStableTag`
    // is failing (offline / mirror flap / pygit2 not yet configured
    // at boot), the cached entry is persisted with `commitSha` but no
    // `baseTag` — and without it the rev-list range below has no
    // anchor to count from.  Try the network tag refresh first; if
    // that still fails, derive a tag from the local clone so the
    // user isn't stranded with "Computing commits ahead…" forever.
    let baseTag = entry.baseTag
    if (!baseTag) {
      const refreshed = await getLatestStableTag({ refresh: true }).catch(() => null)
      if (refreshed) baseTag = refreshed
    }
    if (!baseTag) {
      // Local fallback: ensure tags are present, then describe the
      // target commit's nearest ancestor tag.  Cheap when tags are
      // already there, single fetch when they aren't.
      await fetchTags(comfyuiDir)
      const local = await findNearestTag(comfyuiDir, entry.commitSha).catch(() => undefined)
      if (local) baseTag = local
    }
    if (!baseTag) {
      _stampEnrichAttempt(repo, entry.commitSha)
      return
    }

    // Persist the recovered baseTag so future enrichments (and the
    // channel-cards `enriching` guard) see the actual structural state
    // instead of having to recover it again.
    if (entry.baseTag !== baseTag) {
      const current = get(repo, 'latest')
      if (current && current.commitSha === entry.commitSha) {
        set(repo, 'latest', { ...current, baseTag })
      }
    }

    // Fast path: when the base tag and target commit are already in the
    // local clone (the common case for an up-to-date install), count
    // locally and skip the network entirely. Only fall back to the slow
    // `git fetch --unshallow` + single-commit fetch when the objects are
    // missing (shallow clone, or master has advanced past what we have).
    let ahead = await countCommitsAhead(comfyuiDir, baseTag, entry.commitSha)
    if (ahead === undefined) {
      await fetchTags(comfyuiDir)
      // The commit SHA may not exist locally (e.g. Stable install on a tag).
      // Fetch it explicitly so rev-list can resolve the range.
      await fetchCommitSha(comfyuiDir, entry.commitSha)
      ahead = await countCommitsAhead(comfyuiDir, baseTag, entry.commitSha)
    }
    if (ahead === undefined) {
      _stampEnrichAttempt(repo, entry.commitSha)
      return
    }

    const current = get(repo, 'latest')
    if (!current || current.commitSha !== entry.commitSha) return
    const resolvedBase = current.baseTag ?? baseTag
    const releaseName = formatComfyVersion({ commit: current.commitSha!, baseTag: resolvedBase, commitsAhead: ahead }, 'short')
    set(repo, 'latest', {
      ...current,
      baseTag: resolvedBase,
      commitsAhead: ahead,
      releaseName,
      lastEnrichAttemptAt: Date.now(),
    })
    _notifyEnriched(repo)
  })().finally(() => _enrichInflight.delete(key))

  _enrichInflight.set(key, run)
  return run
}

/** Stamp a failed enrichment attempt so the renderer can stop showing
 *  the spinner.  Skips the write (and broadcast) if the cache entry has
 *  been swapped out from under us — that means another flow already
 *  refreshed and any state we'd write is stale. */
function _stampEnrichAttempt(repo: string, commitSha: string): void {
  const current = get(repo, 'latest')
  if (!current || current.commitSha !== commitSha) return
  set(repo, 'latest', { ...current, lastEnrichAttemptAt: Date.now() })
  _notifyEnriched(repo)
}

function _notifyEnriched(repo: string): void {
  for (const cb of _enrichedListeners) {
    try {
      cb(repo)
    } catch (err) {
      // Listener errors must not break enrichment (the cache is already
      // updated at this point), but log so a misbehaving subscriber is
      // visible during development.
      console.warn('[release-cache] onEnriched listener threw:', err)
    }
  }
}

/**
 * Determine if an update is available for the given channel, using local data only.
 * Handles cross-channel switches (e.g. last update was on "latest" but viewing "stable").
 */
export function isUpdateAvailable(
  installation: Record<string, unknown>,
  channel: string,
  info: ReleaseCacheEntry | null
): boolean {
  if (!info || !info.latestTag) return false
  // Structural check: if we have comfyVersion and are viewing stable,
  // any commits ahead means the installed version is newer than stable.
  // When commitsAhead is undefined (API failure), we know the commit differs
  // from the tag, so conservatively report an update is available.
  const cv = installation.comfyVersion as ComfyVersion | undefined
  if (cv && channel === 'stable' && cv.commitsAhead !== undefined && cv.commitsAhead > 0) return true
  if (cv && channel === 'stable' && cv.commitsAhead === undefined && cv.baseTag) return true

  // Cross-channel: last update was on a different channel, so this channel's installedTag is stale;
  // fall back to comparing the current display version against this channel's latest tag.
  const lastRollback = installation.lastRollback as
    | Record<string, unknown>
    | undefined
  const lastUpdateChannel = lastRollback?.channel as string | undefined
  if (lastUpdateChannel && lastUpdateChannel !== channel) {
    // Structural: compare commit SHA against latest
    if (cv && info.commitSha && cv.commit === info.commitSha) return false
    const postHead = (lastRollback?.postUpdateHead as string | undefined) || ''
    const shortHead = postHead.slice(0, 7)
    const displayVersion = cv ? formatComfyVersion(cv, 'short') : ''
    if (displayVersion === info.latestTag || displayVersion === info.releaseName) return false
    if (shortHead && (shortHead === info.latestTag || info.releaseName?.includes(shortHead))) return false
    return true
  }
  // Direct commit SHA comparison — most reliable for the "latest" channel
  // where latestTag is a short SHA and releaseName depends on enrichment timing.
  if (cv && info.commitSha && cv.commit === info.commitSha) return false

  // Raw tag/sha mismatch (also check releaseName since the latest channel uses a SHA as latestTag).
  // Skip if installedTag is 'unknown' (brand-new install before first update).
  if (info.installedTag && info.installedTag !== 'unknown' && info.installedTag !== info.latestTag && info.installedTag !== info.releaseName) return true
  return false
}
