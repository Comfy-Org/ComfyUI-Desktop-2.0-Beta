import { lsRemoteLatestTag, lsRemoteRef, lsRemoteStableTags } from './git'
import { getComfyUIRemoteUrl } from './github-mirror'
import * as settings from '../settings'

const REPO = 'Comfy-Org/ComfyUI'

/** Short-lived cache for the latest stable tag, keyed by remote URL, to avoid
 *  repeated `git ls-remote` calls in close succession. */
const SUCCESS_TTL_MS = 10 * 60 * 1000
const FAILURE_TTL_MS = 30_000
interface CacheEntry {
  tag: string | null
  expiresAt: number
}
const _latestTagCache = new Map<string, CacheEntry>()
let _inflight: Map<string, Promise<string | null>> = new Map()

interface StableTagsCacheEntry {
  tags: string[]
  expiresAt: number
}
const _stableTagsCache = new Map<string, StableTagsCacheEntry>()
let _stableTagsInflight: Map<string, Promise<string[]>> = new Map()

function _getRemoteUrl(): string {
  return getComfyUIRemoteUrl(settings.get('useChineseMirrors') === true)
}

/**
 * Resolve the latest stable ComfyUI tag via `git ls-remote --tags` (no REST
 * API; works against github.com and gitcode.com). Concurrent callers share one
 * in-flight request per remote. Returns `null` (never throws) on failure.
 * `refresh: true` bypasses the cache.
 */
export async function getLatestStableTag(opts?: { refresh?: boolean }): Promise<string | null> {
  const url = _getRemoteUrl()
  const now = Date.now()
  if (!opts?.refresh) {
    const hit = _latestTagCache.get(url)
    if (hit && now < hit.expiresAt) return hit.tag
  }
  const existing = _inflight.get(url)
  if (existing) return existing
  const promise = (async () => {
    try {
      const tag = (await lsRemoteLatestTag(url)) ?? null
      // A `null` tag means no git backend was configured; cache it as a failure
      // (short TTL) rather than poisoning SUCCESS_TTL_MS, which would strand new
      // standalone installs on the bundled version.
      const ttl = tag === null ? FAILURE_TTL_MS : SUCCESS_TTL_MS
      _latestTagCache.set(url, { tag, expiresAt: Date.now() + ttl })
      return tag
    } catch {
      _latestTagCache.set(url, { tag: null, expiresAt: Date.now() + FAILURE_TTL_MS })
      return null
    } finally {
      _inflight.delete(url)
    }
  })()
  _inflight.set(url, promise)
  return promise
}

/** Test-only: clear the in-memory cache. */
export function _clearLatestStableTagCache(): void {
  _latestTagCache.clear()
  _inflight = new Map()
  _stableTagsCache.clear()
  _stableTagsInflight = new Map()
}

/**
 * Resolve every stable ComfyUI tag via `git ls-remote --tags`. "Stable" means
 * strict `vMAJOR.MINOR.PATCH` (no prerelease / suffix). Tags are returned
 * newest-first. Cached per remote URL with the same TTLs as
 * {@link getLatestStableTag}; concurrent callers share one in-flight request.
 * Returns an empty array (never throws) on failure. `refresh: true` bypasses
 * the cache.
 */
export async function getStableTags(opts?: { refresh?: boolean }): Promise<string[]> {
  const url = _getRemoteUrl()
  const now = Date.now()
  if (!opts?.refresh) {
    const hit = _stableTagsCache.get(url)
    if (hit && now < hit.expiresAt) return hit.tags
  }
  const existing = _stableTagsInflight.get(url)
  if (existing) return existing
  const promise = (async () => {
    try {
      const tags = await lsRemoteStableTags(url)
      const ttl = tags.length === 0 ? FAILURE_TTL_MS : SUCCESS_TTL_MS
      _stableTagsCache.set(url, { tags, expiresAt: Date.now() + ttl })
      return tags
    } catch {
      _stableTagsCache.set(url, { tags: [], expiresAt: Date.now() + FAILURE_TTL_MS })
      return []
    } finally {
      _stableTagsInflight.delete(url)
    }
  })()
  _stableTagsInflight.set(url, promise)
  return promise
}

export async function fetchLatestRelease(
  channel: string,
  opts?: { refresh?: boolean },
): Promise<Record<string, unknown> | null> {
  const mirrorEnabled = settings.get('useChineseMirrors') === true
  const remoteUrl = getComfyUIRemoteUrl(mirrorEnabled)

  if (channel === 'latest') {
    const [headSha, latestTag] = await Promise.all([
      lsRemoteRef(remoteUrl, 'refs/heads/master'),
      getLatestStableTag(opts),
    ])
    if (!headSha) return null
    return {
      tag_name: headSha.slice(0, 7),
      commitSha: headSha,
      baseTag: latestTag || undefined,
      // commitsAhead is resolved locally after git fetch
      body: '',
      html_url: `https://github.com/${REPO}/commit/${headSha}`,
      _commit: true,
    }
  }

  // Stable channel: build synthetic release from latest tag
  const latestTag = await getLatestStableTag(opts)
  if (!latestTag) return null
  return {
    tag_name: latestTag,
    name: latestTag,
    body: '',
    html_url: `https://github.com/${REPO}/releases/tag/${latestTag}`,
    baseTag: latestTag,
    commitsAhead: 0,
  }
}

export function truncateNotes(text: string, maxLen: number): string {
  if (!text) return ''
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + '\n\n… (truncated)'
}
