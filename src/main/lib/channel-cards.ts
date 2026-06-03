import path from 'path'
import * as releaseCache from './release-cache'
import { formatComfyVersion } from './version'
import type { ComfyVersion } from './version'
import { hasGitDir } from './git'
import type { InstallationRecord } from '../installations'

export interface ChannelDef {
  value: string
  label: string
  description: string
  recommended?: boolean
}

export interface ChannelCardData {
  installedVersion: string
  latestVersion: string
  /** Localized human string for display (e.g. "11/24/2025, 4:32 PM"). */
  lastChecked: string
  lastCheckedAt?: number
  updateAvailable: boolean
  actions?: Record<string, unknown>[]
  /** True while we know the upstream commit (`commitSha` cached) but
   *  haven't yet computed `commitsAhead` against the install's local
   *  `.git` checkout — `enrichCommitsAhead` runs in the background and
   *  fills this in. The renderer surfaces a muted "Computing commits
   *  ahead…" hint under the Latest row so the eventual `tag (sha)` →
   *  `tag + N commits (sha)` label upgrade doesn't look like a silent
   *  glitch. False on cloud / no-git installs (they have no
   *  enrichment to wait for) and on already-enriched entries. */
  enriching?: boolean
}

export interface ChannelCard extends ChannelDef {
  data?: ChannelCardData
}

/**
 * Build the data portion of channel cards (installed/latest versions, update status).
 * Callers supply their own actions per card after calling this.
 */
export function buildChannelCards(
  repo: string,
  channelDefs: ChannelDef[],
  installation: InstallationRecord,
): ChannelCard[] {
  const cv = installation.comfyVersion as ComfyVersion | undefined
  // `enrichCommitsAhead` reads from the install's own ComfyUI checkout.
  // Without a `.git` dir there's no enrichment in flight, so the fallback
  // `tag (sha)` is the final state — surface the hint only when a real
  // enrichment is possible.
  const installHasGit = !!installation.installPath
    && hasGitDir(path.join(installation.installPath, 'ComfyUI'))
  return channelDefs.map((def) => {
    const info = releaseCache.getEffectiveInfo(repo, def.value, installation)
    // When the latest release commit matches the installed commit, reuse
    // the git-resolved version (which is cherry-pick–aware) instead of the
    // raw GitHub API comparison data.
    const latestCv = info?.commitSha
      ? (cv && cv.commit === info.commitSha && cv.baseTag
        ? cv
        : { commit: info.commitSha, baseTag: info.baseTag, commitsAhead: info.commitsAhead } as ComfyVersion)
      : undefined
    // Show the "Computing commits ahead…" hint while enrichment is
    // genuinely in flight.  `enrichCommitsAhead` now recovers a
    // missing `baseTag` on its own (forced `getLatestStableTag` →
    // local `findNearestTag` fallback), so we deliberately do NOT
    // gate on `baseTag` here — the spinner should remain visible
    // through that recovery window.  Once the helper records a settle
    // via `lastEnrichAttemptAt` we suppress the hint forever for that
    // cached entry: a successful follow-up swaps `commitsAhead` in
    // and the label upgrades silently; a failed settle stays on the
    // documented `tag (sha)` fallback without re-flashing the spinner
    // on every picker reopen.
    const enriching = !!info?.commitSha
      && info.commitsAhead === undefined
      && info.lastEnrichAttemptAt === undefined
      && installHasGit
    return {
      ...def,
      data: info ? {
        installedVersion: cv ? formatComfyVersion(cv, 'detail') : (info.installedTag || 'unknown'),
        latestVersion: latestCv ? formatComfyVersion(latestCv, 'detail') : (info.releaseName || info.latestTag || '—'),
        lastChecked: info.checkedAt ? new Date(info.checkedAt).toLocaleString() : '—',
        lastCheckedAt: info.checkedAt ?? undefined,
        updateAvailable: releaseCache.isUpdateAvailable(installation, def.value, info),
        ...(enriching ? { enriching: true } : {}),
      } : undefined,
    }
  })
}

/** Build a label lookup map from channel defs. */
export function buildChannelLabelMap(defs: ChannelDef[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const def of defs) map[def.value] = def.label
  return map
}
