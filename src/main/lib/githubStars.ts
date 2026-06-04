// Stargazer count via the unauthenticated GitHub REST API, cached in-memory
// (24h TTL) to stay under the 60 req/hr limit. null on any failure.
interface CacheEntry {
  count: number
  fetchedAt: number
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 6000

const cache = new Map<string, CacheEntry>()

// Synchronous, network-free read of the cached count. Returns null when the
// entry is missing or stale, so callers can open instantly off the cache and
// warm it in the background via getGithubStarCount().
export function getCachedGithubStarCount(repo: string): number | null {
  const cached = cache.get(repo)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.count
  }
  return null
}

export async function getGithubStarCount(repo: string): Promise<number | null> {
  const fresh = getCachedGithubStarCount(repo)
  if (fresh != null) return fresh

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Comfy-Desktop',
      },
      signal: controller.signal,
    })
    if (!res.ok) return null
    const data = (await res.json()) as { stargazers_count?: unknown }
    const count = typeof data.stargazers_count === 'number' ? data.stargazers_count : null
    if (count == null) return null
    cache.set(repo, { count, fetchedAt: Date.now() })
    return count
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
