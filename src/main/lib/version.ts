/**
 * Ground-truth version data for an installed ComfyUI.
 *
 * Stored on the installation record as `comfyVersion`.  All display
 * strings are derived at render time via {@link formatComfyVersion}.
 */
export interface ComfyVersion {
  /** Full 40-character commit SHA. */
  commit: string
  /** Nearest stable release tag (e.g. "v0.14.2"). */
  baseTag?: string
  /** Number of commits ahead of baseTag (0 = on the tag, >0 = latest channel). */
  commitsAhead?: number
}

/**
 * Format a {@link ComfyVersion} for display.
 *
 * @param v  Structured version data (may be undefined for legacy installs).
 * @param style  `'short'` for cards (`v0.14.2+21`), `'detail'` for the
 *               Manage view (`v0.14.2 + 21 commits (a1b2c3d)`).
 */
export function formatComfyVersion(
  v: ComfyVersion | undefined,
  style: 'short' | 'detail',
): string {
  if (!v) return 'unknown'

  const { commit, baseTag, commitsAhead } = v
  const shortSha = commit.slice(0, 7)

  if (!baseTag) return shortSha

  // Exactly on the tag — display as the tag alone.
  if (commitsAhead === 0) return baseTag

  // commitsAhead is undefined when the GitHub comparison API failed.
  // We know the baseTag but not how far ahead, so show the tag + SHA to
  // indicate uncertainty rather than silently displaying the stable tag.
  if (commitsAhead === undefined) {
    return `${baseTag} (${shortSha})`
  }

  if (style === 'short') {
    return `${baseTag}+${commitsAhead}`
  }

  return `${baseTag} + ${commitsAhead} commit${commitsAhead !== 1 ? 's' : ''} (${shortSha})`
}
