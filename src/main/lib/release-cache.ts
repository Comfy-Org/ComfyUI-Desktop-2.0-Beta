/**
 * Shared release-info cache keyed by remote identity (repo + channel), so installations
 * pointing at the same upstream share one check result. In-memory for fast synchronous reads,
 * persisted to release-cache.json.
 */

import path from 'path'
import fs from 'fs'
import { dataDir } from './paths'
import { writeFileSafe } from './safe-file'
import { fetchLatestRelease, getLatestStableTag, truncateNotes } from './comfyui-releases'
import { fetchTags, countCommitsAhead, fetchCommitSha, findNearestTag } from './git'
import { formatComfyVersion, tagsEqual } from './version'
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
  /** Timestamp of the most recent `enrichCommitsAhead` settle (success or failure), so the
   *  renderer can drop the "Computing commits ahead…" hint when enrichment gives up and not
   *  re-show it on every picker reopen for a structurally-broken entry. */
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

/** Test-only: force every entry's `checkedAt` to `maxCheckedAt` so the stale-cache watcher
 *  fires on next picker open. Called only via `__e2e.ageReleaseCache`. */
export function _test_ageEntries(maxCheckedAt: number): void {
  _ensureLoaded()
  for (const key of Object.keys(_entries)) {
    const entry = _entries[key]
    if (entry) entry.checkedAt = maxCheckedAt
  }
  _persist()
}

/** Build a cache key, e.g. "github:Comfy-Org/ComfyUI:stable". */
export function makeKey(repo: string, channel: string): string {
  return `github:${repo}:${channel}`
}

/** Synchronous cached read from memory; null if absent. */
export function get(repo: string, channel: string): ReleaseCacheEntry | null {
  _ensureLoaded()
  return _entries[makeKey(repo, channel)] ?? null
}

export function set(repo: string, channel: string, entry: ReleaseCacheEntry): void {
  _ensureLoaded()
  _entries[makeKey(repo, channel)] = entry
  _persist()
}

const _inFlight: Map<string, Promise<ReleaseCacheEntry | null>> = new Map()

// Min interval between forced refetches for the same key, to avoid GitHub rate limits.
const MIN_RECHECK_INTERVAL = 10_000

/**
 * Fetch release info, deduplicating concurrent calls for the same key.
 * @param fetchFn - calls the GitHub API
 * @param force - bypass cache
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

/** Merge the shared release cache (remote info) with per-installation state (installedTag). */
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

/** Build a cache entry from the raw release object returned by fetchLatestRelease. */
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

/** Shared check-update handler: fetch latest release into the cache, persist installedTag. */
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

/** Inflight dedupe for `enrichCommitsAhead`, keyed by `repo::comfyuiDir` so rapid picker
 *  switches don't fan out N parallel `git fetch` against one checkout. Cleared on settle. */
const _enrichInflight = new Map<string, Promise<void>>()

/** Min interval between FAILED enrichment retries for the same entry, so a structurally
 *  broken entry doesn't re-run the full recovery+fetch chain on every picker reopen. */
const ENRICH_RETRY_THROTTLE_MS = 30_000

/** Listeners notified when `enrichCommitsAhead` writes a new `commitsAhead` (not on no-op
 *  short-circuits), so renderers can refresh affected sections in place. */
const _enrichedListeners = new Set<(repo: string) => void>()

export function onEnriched(cb: (repo: string) => void): () => void {
  _enrichedListeners.add(cb)
  return () => _enrichedListeners.delete(cb)
}

/**
 * Enrich the "latest" channel entry with locally-computed commitsAhead (ls-remote can't
 * compute this). No-op if already set or the entry lacks required fields. Always stamps
 * `lastEnrichAttemptAt` and fires `onEnriched` on settle so the renderer can drop its spinner.
 */
export async function enrichCommitsAhead(repo: string, comfyuiDir: string): Promise<void> {
  const key = `${repo}::${comfyuiDir}`
  const existing = _enrichInflight.get(key)
  if (existing) return existing

  const run = (async () => {
    const entry = get(repo, 'latest')
    if (!entry?.commitSha || entry.commitsAhead !== undefined) return
    if (!fs.existsSync(path.join(comfyuiDir, '.git'))) return
    // Skip if a recent attempt just failed; the state won't change in the next few seconds
    // and the renderer already dropped its spinner on the prior settle.
    if (entry.lastEnrichAttemptAt !== undefined
      && Date.now() - entry.lastEnrichAttemptAt < ENRICH_RETRY_THROTTLE_MS) return

    // Recover a missing baseTag (entries persisted with commitSha but no baseTag when
    // getLatestStableTag was failing) since the rev-list range needs an anchor. Try a network
    // tag refresh, then a local-clone derivation, so the user isn't stranded forever.
    let baseTag = entry.baseTag
    if (!baseTag) {
      const refreshed = await getLatestStableTag({ refresh: true }).catch(() => null)
      if (refreshed) baseTag = refreshed
    }
    if (!baseTag) {
      // Local fallback: ensure tags exist, then describe the commit's nearest ancestor tag.
      await fetchTags(comfyuiDir)
      const local = await findNearestTag(comfyuiDir, entry.commitSha).catch(() => undefined)
      if (local) baseTag = local
    }
    if (!baseTag) {
      _stampEnrichAttempt(repo, entry.commitSha)
      return
    }

    // Persist the recovered baseTag so future enrichments don't recover it again.
    if (entry.baseTag !== baseTag) {
      const current = get(repo, 'latest')
      if (current && current.commitSha === entry.commitSha) {
        set(repo, 'latest', { ...current, baseTag })
      }
    }

    // Fast path: count locally when base tag + target commit are already present (common for
    // up-to-date installs); fall back to a fetch only when the objects are missing.
    let ahead = await countCommitsAhead(comfyuiDir, baseTag, entry.commitSha)
    if (ahead === undefined) {
      await fetchTags(comfyuiDir)
      // The commit SHA may not exist locally; fetch it so rev-list can resolve the range.
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

/** Stamp a failed enrichment so the renderer drops the spinner. Skips the write if the entry
 *  was swapped out from under us (another flow refreshed; our state would be stale). */
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
      // Listener errors must not break enrichment (cache is already updated); log them.
      console.warn('[release-cache] onEnriched listener threw:', err)
    }
  }
}

/** Whether an update is available for the channel, using local data only. Handles
 *  cross-channel switches (e.g. last update on "latest" but viewing "stable"). */
export function isUpdateAvailable(
  installation: Record<string, unknown>,
  channel: string,
  info: ReleaseCacheEntry | null
): boolean {
  if (!info || !info.latestTag) return false
  // On stable: any commits ahead means installed is newer than stable. When commitsAhead is
  // undefined (API failure) but the commit differs, conservatively report an update.
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
    if (cv && info.commitSha && cv.commit === info.commitSha) return false
    const postHead = (lastRollback?.postUpdateHead as string | undefined) || ''
    const shortHead = postHead.slice(0, 7)
    const displayVersion = cv ? formatComfyVersion(cv, 'short') : ''
    if (tagsEqual(displayVersion, info.latestTag) || tagsEqual(displayVersion, info.releaseName)) return false
    if (shortHead && (shortHead === info.latestTag || info.releaseName?.includes(shortHead))) return false
    return true
  }
  // Most reliable for "latest", where latestTag is a short SHA and releaseName depends on
  // enrichment timing.
  if (cv && info.commitSha && cv.commit === info.commitSha) return false

  // Raw tag/sha mismatch (releaseName too, since latest uses a SHA as latestTag). Skip when
  // installedTag is 'unknown' (brand-new install before first update).
  if (
    info.installedTag &&
    info.installedTag !== 'unknown' &&
    !tagsEqual(info.installedTag, info.latestTag) &&
    !tagsEqual(info.installedTag, info.releaseName)
  )
    return true
  return false
}
