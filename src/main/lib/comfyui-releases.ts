import { lsRemoteLatestTag, lsRemoteRef } from './git'
import { getComfyUIRemoteUrl } from './github-mirror'
import * as settings from '../settings'

const REPO = 'Comfy-Org/ComfyUI'

/**
 * Short-lived cache for the latest stable tag, keyed by remote URL.
 * Avoids repeated `git ls-remote` calls when the renderer hits the
 * release dropdown, update checks, etc. in close succession.
 */
const SUCCESS_TTL_MS = 10 * 60 * 1000
const FAILURE_TTL_MS = 30_000
interface CacheEntry {
  tag: string | null
  expiresAt: number
}
const _latestTagCache = new Map<string, CacheEntry>()
let _inflight: Map<string, Promise<string | null>> = new Map()

function _getRemoteUrl(): string {
  return getComfyUIRemoteUrl(settings.get('useChineseMirrors') === true)
}

/**
 * Resolve the latest stable ComfyUI tag (e.g. `v1.19.5`) via
 * `git ls-remote --tags` (Git protocol) — no GitHub REST API calls,
 * works against both github.com and gitcode.com.
 *
 * Successful results are cached in-memory for {@link SUCCESS_TTL_MS};
 * failures use the much shorter {@link FAILURE_TTL_MS} so a flapping
 * remote isn't pounded on but recovers quickly.  Concurrent callers
 * share a single in-flight request per remote URL.  Returns `null`
 * (never throws) on failure so callers can degrade gracefully when
 * offline or pygit2 is not configured.
 *
 * Set `refresh: true` to bypass the cache.
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
      _latestTagCache.set(url, { tag, expiresAt: Date.now() + SUCCESS_TTL_MS })
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
}

export async function fetchLatestRelease(
  channel: string
): Promise<Record<string, unknown> | null> {
  const mirrorEnabled = settings.get('useChineseMirrors') === true
  const remoteUrl = getComfyUIRemoteUrl(mirrorEnabled)

  if (channel === 'latest') {
    const [headSha, latestTag] = await Promise.all([
      lsRemoteRef(remoteUrl, 'refs/heads/master'),
      getLatestStableTag(),
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
  const latestTag = await getLatestStableTag()
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
