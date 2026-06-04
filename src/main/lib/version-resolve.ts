import { findNearestTag, findLatestVersionTag, countCommitsAhead, countUniqueCommits, isAncestorOf, findMergeBase } from './git'
import type { ComfyVersion } from './version'

/** Pre-resolved latest tag info, shared across repos with the same origin. */
export interface LatestTagOverride {
  /** Tag name, e.g. "v0.17.1". */
  name: string
  /** Full commit SHA the tag points to. */
  sha: string
}

/** Resolved-version cache keyed by "repoPath\0commitSha". Stores git-derived
 *  data only (no fallbackTag) so callers with different fallbacks share entries
 *  safely. */
const _cache = new Map<string, ComfyVersion>()

/** Short-lived cache for the latest version tag per repo path. */
let _latestTagCache: { repoPath: string; tag: string | undefined; ts: number } | null = null
const LATEST_TAG_TTL_MS = 5_000

async function getCachedLatestTag(repoPath: string): Promise<string | undefined> {
  if (_latestTagCache && _latestTagCache.repoPath === repoPath && Date.now() - _latestTagCache.ts < LATEST_TAG_TTL_MS) {
    return _latestTagCache.tag
  }
  const tag = await findLatestVersionTag(repoPath)
  _latestTagCache = { repoPath, tag, ts: Date.now() }
  return tag
}

/** Maximum number of tags to walk backward on a release branch. */
const MAX_BACKPORT_WALK = 10

/**
 * Walk the release branch backward from `startRef` to find the highest tag
 * whose content is fully represented in `commit` (cherry-pick–aware). A tag
 * qualifies when its unique commits don't exceed the branch distance from
 * `stopTag` (accommodating version bumps + release-only cherry-picks).
 *
 * @returns The qualifying tag name and cherry-pick–aware "+N" count, or
 *          undefined if none qualifies before reaching `stopTag`.
 */
async function findBestBackportTag(
  repoPath: string,
  startRef: string,
  commit: string,
  stopTag: string,
  ancestorDist?: number,
): Promise<{ tag: string; commitsAhead: number } | undefined> {
  // Collect candidate tags by walking backward from startRef.
  const candidates: string[] = []
  let ref = startRef
  for (let i = 0; i < MAX_BACKPORT_WALK; i++) {
    const tag = await findNearestTag(repoPath, ref)
    if (!tag || tag === stopTag) break
    candidates.push(tag)
    ref = `${tag}~1`
  }
  if (candidates.length === 0) return undefined

  // Evaluate lowest-to-highest. In shallow clones (and the pygit2 fallback,
  // which can't honour `--cherry-pick`) countUniqueCommits inflates wildly, so
  // bail when any result exceeds ancestorDist and let the caller use merge-base.
  let best: { tag: string; commitsAhead: number } | undefined
  for (let pos = candidates.length - 1; pos >= 0; pos--) {
    const tag = candidates[pos]!
    const branchDist = await countCommitsAhead(repoPath, stopTag, tag)
    if (branchDist === undefined) break
    const unique = await countUniqueCommits(repoPath, tag, commit)
    if (unique === undefined) break
    if (ancestorDist !== undefined && unique > ancestorDist) return undefined
    // Too many unique commits — stop ascending (higher tags have even more);
    // any `best` from a lower tag is still valid.
    if (unique > branchDist) break
    const ahead = await countUniqueCommits(repoPath, commit, tag)
    if (ahead === undefined) break
    best = { tag, commitsAhead: ahead }
  }
  return best
}

/**
 * Resolve a {@link ComfyVersion} from local git state. Uses the nearest
 * ancestor tag as a base, upgrading to a newer version tag when one is a direct
 * ancestor or a cherry-pick–aware match on a parallel release branch. Results
 * are cached by (repoPath, commit).
 *
 * @param comfyuiDir         Path to the ComfyUI git working tree.
 * @param commit             The commit SHA to resolve.
 * @param fallbackTag        Tag to use when no git tags exist (e.g. manifest comfyui_ref).
 * @param latestTagOverride  Pre-resolved latest tag from a sibling repo sharing
 *                           the same origin; its SHA is used directly (works
 *                           even if the tag ref doesn't exist locally).
 */
export async function resolveLocalVersion(
  comfyuiDir: string,
  commit: string,
  fallbackTag?: string,
  latestTagOverride?: LatestTagOverride,
): Promise<ComfyVersion> {
  const overrideKey = latestTagOverride ? `\0${latestTagOverride.name}\0${latestTagOverride.sha}` : ''
  const cacheKey = `${comfyuiDir}\0${commit}${overrideKey}`
  const cached = _cache.get(cacheKey)
  if (cached) {
    // Apply fallbackTag at read time without mutating the git-only cache entry.
    if (fallbackTag && !cached.baseTag) {
      return { ...cached, baseTag: fallbackTag }
    }
    return cached
  }

  const latestTagName = latestTagOverride?.name ?? await getCachedLatestTag(comfyuiDir)
  const latestTagRef = latestTagOverride?.sha ?? latestTagName

  const ancestorTag = await findNearestTag(comfyuiDir, commit)
  const ancestorDist = ancestorTag ? await countCommitsAhead(comfyuiDir, ancestorTag, commit) : undefined

  // Try to upgrade the ancestor tag to a newer one. Direct-ancestor case: use
  // latestTag directly. Backport case (latestTag not an ancestor, but ancestorTag
  // is an ancestor of latestTag): walk the release branch backward for the
  // highest cherry-pick–aware match.
  let baseTag: string | undefined
  let commitsAhead: number | undefined

  const shouldUpgrade = latestTagName && latestTagName !== ancestorTag && ancestorDist !== undefined && ancestorDist > 0
  let upgraded = false

  if (shouldUpgrade) {
    const ancestorIsParent = ancestorTag ? await isAncestorOf(comfyuiDir, ancestorTag, latestTagRef!) : false

    if (ancestorIsParent && await isAncestorOf(comfyuiDir, latestTagRef!, commit)) {
      // Direct ancestor — count from tag to commit directly.
      const dist = await countCommitsAhead(comfyuiDir, latestTagRef!, commit)
      if (dist !== undefined) {
        baseTag = latestTagName
        commitsAhead = dist
        upgraded = true
      }
    } else if (ancestorIsParent) {
      const found = await findBestBackportTag(comfyuiDir, latestTagRef!, commit, ancestorTag!, ancestorDist)
      if (found) {
        baseTag = found.tag
        commitsAhead = found.commitsAhead
        upgraded = true
      } else {
        // Cherry-pick detection failed (shallow clone). Fall back to merge-base:
        // less precise (+N includes cherry-picks) but still reasonable.
        const mergeBase = await findMergeBase(comfyuiDir, latestTagRef!, commit)
        const dist = mergeBase && mergeBase !== commit
          ? await countCommitsAhead(comfyuiDir, mergeBase, commit)
          : undefined
        if (dist !== undefined) {
          baseTag = latestTagName
          commitsAhead = dist
          upgraded = true
        }
      }
    }
  }

  if (!upgraded) {
    baseTag = ancestorTag
    commitsAhead = ancestorDist
  }

  // Cache git-only data (no fallbackTag) so callers sharing (repoPath, commit)
  // don't poison each other.
  const result: ComfyVersion = { commit, baseTag, commitsAhead }
  _cache.set(cacheKey, result)

  if (fallbackTag && !baseTag) {
    return { ...result, baseTag: fallbackTag }
  }
  return result
}


/** Clear the version cache (e.g. after an update changes tags). */
export function clearVersionCache(): void {
  _cache.clear()
  _latestTagCache = null
}
