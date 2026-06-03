/**
 * Fetches the stargazer count for a GitHub repo via the unauthenticated
 * REST API and caches it in-memory for the lifetime of the main process
 * (24h soft TTL). Unauthenticated rate limit is 60 req/hr per IP — the
 * cache makes that effectively free.
 *
 * Returns `null` on any failure (network, non-2xx, parse error, timeout)
 * so callers can hide the chip rather than render a broken placeholder.
 */

interface CacheEntry {
  count: number
  fetchedAt: number
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 6000

const cache = new Map<string, CacheEntry>()

export async function getGithubStarCount(repo: string): Promise<number | null> {
  const cached = cache.get(repo)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.count
  }

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
