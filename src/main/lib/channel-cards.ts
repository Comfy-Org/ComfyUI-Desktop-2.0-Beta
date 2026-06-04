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
  /** True while the upstream commit is known but `commitsAhead` hasn't been computed yet
   *  (background `enrichCommitsAhead` in flight); drives the "Computing commits ahead…" hint.
   *  False on cloud / no-git installs and already-enriched entries. */
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
  // Without a `.git` dir there's no enrichment to wait for, so only show the hint when a
  // real enrichment is possible.
  const installHasGit = !!installation.installPath
    && hasGitDir(path.join(installation.installPath, 'ComfyUI'))
  return channelDefs.map((def) => {
    const info = releaseCache.getEffectiveInfo(repo, def.value, installation)
    // When latest matches installed, reuse the cherry-pick-aware git-resolved version
    // instead of the raw GitHub API comparison.
    const latestCv = info?.commitSha
      ? (cv && cv.commit === info.commitSha && cv.baseTag
        ? cv
        : { commit: info.commitSha, baseTag: info.baseTag, commitsAhead: info.commitsAhead } as ComfyVersion)
      : undefined
    // Don't gate on `baseTag` (enrichCommitsAhead recovers a missing one), so the spinner
    // stays through that window. Once `lastEnrichAttemptAt` records a settle, suppress the
    // hint forever for that entry so a failed settle doesn't re-flash on every picker reopen.
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
