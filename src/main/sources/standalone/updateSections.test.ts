import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import type { InstallationRecord } from '../../installations'

// `getDetailSections` transitively imports `electron` (via paths/settings).
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp',
    getVersion: () => '0.0.0-test',
    getLocale: () => 'en',
  },
  ipcMain: { handle: vi.fn(), on: vi.fn(), off: vi.fn() },
  dialog: {},
  shell: {},
}))

/**
 * Locks the `update-comfyui` action-payload's downgrade-vs-update branch. The
 * function reads the FS (.git probe) and release-cache, both mocked. `t()`
 * returns the bare i18n key (no locale), so we assert against the key.
 */

vi.mock('../../lib/release-cache', () => ({
  getEffectiveInfo: vi.fn(),
  isUpdateAvailable: vi.fn(() => true),
}))
vi.mock('../../lib/git', () => ({
  hasGitDir: vi.fn(() => true),
}))

import * as releaseCache from '../../lib/release-cache'
import { getDetailSections, getEffectiveChannel } from './updateSections'

interface UpdateAction {
  id: string
  progressTitle: string
  data?: { channel?: string; isDowngrade?: boolean }
}
interface ChannelOption {
  value: string
  data?: { actions?: UpdateAction[] }
}
interface UpdateField { id: string; options: ChannelOption[] }
interface UpdateSection { tab: string; fields?: UpdateField[] }

function getUpdateAction(installation: InstallationRecord, channel: 'stable' | 'latest'): UpdateAction | undefined {
  const sections = getDetailSections(installation) as unknown as UpdateSection[]
  const updates = sections.find((s) => s.tab === 'update')
  const channelField = updates?.fields?.find((f) => f.id === 'updateChannel')
  const option = channelField?.options?.find((o) => o.value === channel)
  return option?.data?.actions?.find((a) => a.id === 'update-comfyui')
}

function baseInstall(overrides: Partial<InstallationRecord> = {}): InstallationRecord {
  return {
    id: 'inst-1',
    name: 'Test Install',
    sourceId: 'standalone',
    installPath: '/tmp/test-install',
    status: 'installed',
    createdAt: Date.now(),
    updateChannel: 'stable',
    comfyVersion: { commit: 'abc1234', baseTag: 'v0.3.20', commitsAhead: 0 },
    ...overrides,
  } as InstallationRecord
}

describe('updateSections — update-comfyui action payload', () => {
  beforeEach(() => {
    vi.mocked(releaseCache.getEffectiveInfo).mockReset()
    vi.mocked(releaseCache.isUpdateAvailable).mockReset().mockReturnValue(true)
    // hasGit is gated on a `.git` probe; return true so the actions are emitted.
    vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    vi.mocked(releaseCache.getEffectiveInfo).mockImplementation((_repo, channel) => ({
      installedTag: 'v0.3.20',
      commitSha: 'def5678cafebabe',
      baseTag: 'v0.3.20',
      commitsAhead: channel === 'latest' ? 12 : 0,
      latestTag: channel === 'latest' ? 'def5678' : 'v0.3.20',
      releaseName: channel === 'latest' ? 'v0.3.20+12' : 'v0.3.20',
      checkedAt: Date.now(),
    }))
  })

  it('frames a stable target as a channel switch (not a downgrade) when the install is effectively on latest', () => {
    // commitsAhead > 0 makes getEffectiveChannel report `latest`, so picking the
    // `stable` card is a channel switch.
    const action = getUpdateAction(
      baseInstall({ comfyVersion: { commit: 'abc1234', baseTag: 'v0.3.20', commitsAhead: 5 } } as Partial<InstallationRecord>),
      'stable'
    )
    expect(action).toBeDefined()
    // Backend still rolls back, but the copy is "Switching to", not "Downgrading".
    expect(action!.data?.isDowngrade).toBe(true)
    expect(action!.progressTitle).toBe('channelCards.switchingToTitle')
  })

  it('flags isDowngrade=true when commitsAhead is undefined but baseTag exists (older snapshot/install)', () => {
    const action = getUpdateAction(
      baseInstall({ comfyVersion: { commit: 'abc1234', baseTag: 'v0.3.20', commitsAhead: undefined } } as Partial<InstallationRecord>),
      'stable'
    )
    expect(action!.data?.isDowngrade).toBe(true)
    expect(action!.progressTitle).toBe('standalone.downgradingTitle')
  })

  it('flags isDowngrade=false when install is exactly on stable (commitsAhead=0)', () => {
    const action = getUpdateAction(
      baseInstall({ comfyVersion: { commit: 'abc1234', baseTag: 'v0.3.20', commitsAhead: 0 } } as Partial<InstallationRecord>),
      'stable'
    )
    expect(action!.data?.isDowngrade).toBe(false)
    expect(action!.progressTitle).toBe('standalone.updatingTitle')
  })

  it('flags isDowngrade=false when baseTag is missing (no anchor — can\'t tell direction)', () => {
    const action = getUpdateAction(
      baseInstall({ comfyVersion: { commit: 'abc1234', baseTag: undefined as unknown as string, commitsAhead: undefined } } as Partial<InstallationRecord>),
      'stable'
    )
    expect(action!.data?.isDowngrade).toBe(false)
    expect(action!.progressTitle).toBe('standalone.updatingTitle')
  })

  it('never flags isDowngrade on `latest` channel target — moving to master tip is always forward', () => {
    const action = getUpdateAction(
      baseInstall({ comfyVersion: { commit: 'abc1234', baseTag: 'v0.3.20', commitsAhead: 5 } } as Partial<InstallationRecord>),
      'latest'
    )
    expect(action!.data?.isDowngrade).toBe(false)
    expect(action!.progressTitle).toBe('standalone.updatingTitle')
  })

  it('still carries actionData.channel when switching channels (regression guard for lifecycle:705)', () => {
    const action = getUpdateAction(baseInstall({ updateChannel: 'stable' }), 'latest')
    expect(action!.data?.channel).toBe('latest')
    expect(action!.data?.isDowngrade).toBe(false)
  })

  it('always carries actionData.channel, even on a same-channel update', () => {
    // The explicit target channel must be carried so the handler never falls back
    // to a stale stored `updateChannel`.
    const action = getUpdateAction(baseInstall({ updateChannel: 'stable' }), 'stable')
    expect(action!.data?.channel).toBe('stable')
    expect(action!.data?.isDowngrade).toBeDefined()
  })
})

describe('getEffectiveChannel — de-facto channel from git state', () => {
  it('returns the stored channel when the install sits exactly on its base tag', () => {
    expect(getEffectiveChannel(baseInstall({
      updateChannel: 'stable',
      comfyVersion: { commit: 'abc1234', baseTag: 'v0.3.20', commitsAhead: 0 },
    } as Partial<InstallationRecord>))).toBe('stable')
  })

  it('reports `latest` for a stored-`stable` install whose checkout is ahead of its base tag', () => {
    // e.g. a `git pull` outside the app leaves updateChannel stale on `stable`.
    expect(getEffectiveChannel(baseInstall({
      updateChannel: 'stable',
      comfyVersion: { commit: 'abc1234', baseTag: 'v0.22.3', commitsAhead: 59 },
    } as Partial<InstallationRecord>))).toBe('latest')
  })

  it('does not infer when commitsAhead is unknown (avoids flicker before enrichment)', () => {
    expect(getEffectiveChannel(baseInstall({
      updateChannel: 'stable',
      comfyVersion: { commit: 'abc1234', baseTag: 'v0.22.3', commitsAhead: undefined },
    } as Partial<InstallationRecord>))).toBe('stable')
  })

  it('never overrides an explicit non-stable stored channel', () => {
    expect(getEffectiveChannel(baseInstall({
      updateChannel: 'latest',
      comfyVersion: { commit: 'abc1234', baseTag: 'v0.22.3', commitsAhead: 0 },
    } as Partial<InstallationRecord>))).toBe('latest')
  })
})

describe('updateSections — channel picker reflects de-facto channel', () => {
  it('marks the latest card current when a stored-stable install is ahead of its base tag', () => {
    const sections = getDetailSections(baseInstall({
      updateChannel: 'stable',
      comfyVersion: { commit: 'abc1234', baseTag: 'v0.22.3', commitsAhead: 59 },
    } as Partial<InstallationRecord>)) as unknown as UpdateSection[]
    const field = sections.find((s) => s.tab === 'update')?.fields?.find((f) => f.id === 'updateChannel')
    expect((field as unknown as { value: string }).value).toBe('latest')
  })
})
