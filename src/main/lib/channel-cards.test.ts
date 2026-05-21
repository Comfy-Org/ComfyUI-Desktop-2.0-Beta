import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildChannelCards, type ChannelDef } from './channel-cards'
import type { InstallationRecord } from '../installations'

vi.mock('./release-cache', () => ({
  getEffectiveInfo: vi.fn(),
  isUpdateAvailable: vi.fn(() => true),
}))

import * as releaseCache from './release-cache'

const REPO = 'Comfy-Org/ComfyUI'
const DEFS: ChannelDef[] = [
  { value: 'stable', label: 'Stable', description: 'Stable releases' },
  { value: 'latest', label: 'Latest from GitHub', description: 'Bleeding-edge main' },
]

const HEAD_SHA = 'abc1234deadbeefcafebabe1234567890abcdef0'
const HEAD_SHORT = HEAD_SHA.slice(0, 7)
const BASE_TAG = 'v0.3.55'

function baseInstall(overrides: Partial<InstallationRecord> = {}): InstallationRecord {
  return {
    id: 'inst-1',
    name: 'Test Install',
    sourceId: 'standalone',
    installPath: '/tmp/install',
    status: 'installed',
    createdAt: Date.now(),
    comfyVersion: { commit: 'olderoldcommitshahere00000000000000000001', baseTag: BASE_TAG, commitsAhead: 3 },
    ...overrides,
  } as InstallationRecord
}

describe('buildChannelCards — latest channel +commits formatting', () => {
  beforeEach(() => {
    vi.mocked(releaseCache.getEffectiveInfo).mockReset()
    vi.mocked(releaseCache.isUpdateAvailable).mockReset().mockReturnValue(true)
  })

  it('renders `tag + N commits (sha)` when commitsAhead is enriched', () => {
    vi.mocked(releaseCache.getEffectiveInfo).mockImplementation((_repo, channel) => {
      if (channel === 'stable') return null
      return {
        installedTag: `${BASE_TAG}+3`,
        commitSha: HEAD_SHA,
        baseTag: BASE_TAG,
        commitsAhead: 12,
        latestTag: HEAD_SHORT,
        releaseName: `${BASE_TAG}+12`,
        checkedAt: Date.now(),
      }
    })
    const cards = buildChannelCards(REPO, DEFS, baseInstall())
    const latest = cards.find((c) => c.value === 'latest')!
    expect(latest.data?.latestVersion).toBe(`${BASE_TAG} + 12 commits (${HEAD_SHORT})`)
  })

  it('renders the bare `tag` when the install is exactly on the latest commit', () => {
    vi.mocked(releaseCache.getEffectiveInfo).mockImplementation((_repo, channel) => {
      if (channel === 'stable') return null
      return {
        installedTag: BASE_TAG,
        commitSha: HEAD_SHA,
        baseTag: BASE_TAG,
        commitsAhead: 0,
        latestTag: HEAD_SHORT,
        checkedAt: Date.now(),
      }
    })
    // Install is sitting on the latest commit — the cv === info.commitSha
    // branch in buildChannelCards reuses the install's own version data.
    const install = baseInstall({
      comfyVersion: { commit: HEAD_SHA, baseTag: BASE_TAG, commitsAhead: 0 },
    } as Partial<InstallationRecord>)
    const cards = buildChannelCards(REPO, DEFS, install)
    const latest = cards.find((c) => c.value === 'latest')!
    expect(latest.data?.latestVersion).toBe(BASE_TAG)
  })

  it('falls back to `tag (sha)` only when commitsAhead is undefined (enrichment skipped/failed)', () => {
    // Regression for the original bug: without enrichment, info.commitsAhead
    // is undefined and formatComfyVersion emits the uncertainty form.
    vi.mocked(releaseCache.getEffectiveInfo).mockImplementation((_repo, channel) => {
      if (channel === 'stable') return null
      return {
        installedTag: `${BASE_TAG}+3`,
        commitSha: HEAD_SHA,
        baseTag: BASE_TAG,
        commitsAhead: undefined,
        latestTag: HEAD_SHORT,
        checkedAt: Date.now(),
      }
    })
    const cards = buildChannelCards(REPO, DEFS, baseInstall())
    const latest = cards.find((c) => c.value === 'latest')!
    expect(latest.data?.latestVersion).toBe(`${BASE_TAG} (${HEAD_SHORT})`)
  })
})
