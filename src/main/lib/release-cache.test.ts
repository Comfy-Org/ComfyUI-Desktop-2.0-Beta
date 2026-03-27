import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  net: { fetch: vi.fn() },
}))

import { isUpdateAvailable } from './release-cache'
import type { ReleaseCacheEntry } from './release-cache'

describe('isUpdateAvailable', () => {
  it('returns false when lastRollback channel matches and installedTag matches latestTag', () => {
    const installation = {
      version: 'v1.0.0',
      lastRollback: { channel: 'stable', postUpdateHead: 'abc1234' },
      updateInfoByChannel: { stable: { installedTag: 'v1.0.0' } },
    }
    const info: ReleaseCacheEntry = { latestTag: 'v1.0.0', installedTag: 'v1.0.0' }
    expect(isUpdateAvailable(installation, 'stable', info)).toBe(false)
  })

  it('returns true when lastRollback channel differs (cross-channel stale state)', () => {
    const installation = {
      version: 'v1.0.0',
      lastRollback: { channel: 'latest', postUpdateHead: 'abc1234' },
      updateInfoByChannel: { stable: { installedTag: 'v1.0.0' } },
    }
    const info: ReleaseCacheEntry = { latestTag: 'v1.1.0', releaseName: 'v1.1.0', installedTag: 'v1.0.0' }
    expect(isUpdateAvailable(installation, 'stable', info)).toBe(true)
  })

  it('returns false after restore resets lastRollback to match target channel', () => {
    const installation = {
      version: 'v1.0.0',
      lastRollback: { channel: 'stable', postUpdateHead: 'def5678' },
      updateInfoByChannel: { stable: { installedTag: 'v1.0.0' } },
    }
    const info: ReleaseCacheEntry = { latestTag: 'v1.0.0', releaseName: 'v1.0.0', installedTag: 'v1.0.0' }
    expect(isUpdateAvailable(installation, 'stable', info)).toBe(false)
  })

  it('returns false when no release info is available', () => {
    const installation = { version: 'v1.0.0' }
    expect(isUpdateAvailable(installation, 'stable', null)).toBe(false)
  })

  it('detects update available when installedTag differs from latestTag', () => {
    const installation = {
      version: 'v1.0.0',
      updateInfoByChannel: { stable: { installedTag: 'v1.0.0' } },
    }
    const info: ReleaseCacheEntry = { latestTag: 'v1.1.0', installedTag: 'v1.0.0' }
    expect(isUpdateAvailable(installation, 'stable', info)).toBe(true)
  })

  // Structural comfyVersion tests
  it('detects stable update via comfyVersion.commitsAhead > 0', () => {
    const installation = {
      comfyVersion: { commit: 'abc1234def5678', baseTag: 'v0.14.2', commitsAhead: 21 },
      updateInfoByChannel: { stable: { installedTag: 'abc1234' } },
    }
    const info: ReleaseCacheEntry = { latestTag: 'v0.14.2', installedTag: 'abc1234' }
    expect(isUpdateAvailable(installation, 'stable', info)).toBe(true)
  })

  it('returns false for stable when comfyVersion.commitsAhead is 0', () => {
    const installation = {
      comfyVersion: { commit: 'abc1234def5678', baseTag: 'v0.14.2', commitsAhead: 0 },
      updateInfoByChannel: { stable: { installedTag: 'v0.14.2' } },
    }
    const info: ReleaseCacheEntry = { latestTag: 'v0.14.2', installedTag: 'v0.14.2' }
    expect(isUpdateAvailable(installation, 'stable', info)).toBe(false)
  })

  it('returns false cross-channel when commit SHA matches', () => {
    const installation = {
      comfyVersion: { commit: 'abc1234def5678abc1234def5678abc1234def567', baseTag: 'v0.14.2', commitsAhead: 5 },
      lastRollback: { channel: 'stable', postUpdateHead: 'abc1234def5678abc1234def5678abc1234def567' },
    }
    const info: ReleaseCacheEntry = { latestTag: 'abc1234', commitSha: 'abc1234def5678abc1234def5678abc1234def567' }
    expect(isUpdateAvailable(installation, 'latest', info)).toBe(false)
  })

  it('returns true for stable when commitsAhead is undefined (API failure) and baseTag present', () => {
    const installation = {
      comfyVersion: { commit: 'abc1234def5678', baseTag: 'v0.14.2' },
      updateInfoByChannel: { stable: { installedTag: 'v0.14.2 (abc1234)' } },
    }
    const info: ReleaseCacheEntry = { latestTag: 'v0.14.2', installedTag: 'v0.14.2 (abc1234)' }
    expect(isUpdateAvailable(installation, 'stable', info)).toBe(true)
  })

  // Installations without comfyVersion (e.g. brand-new install before first update)
  it('detects update via installedTag mismatch when no comfyVersion', () => {
    const installation = {
      updateInfoByChannel: { stable: { installedTag: 'abc1234' } },
    }
    const info: ReleaseCacheEntry = { latestTag: 'v0.14.2', installedTag: 'abc1234' }
    expect(isUpdateAvailable(installation, 'stable', info)).toBe(true)
  })

  it('returns false when installedTag is unknown (new install before first update)', () => {
    const installation = {}
    const info: ReleaseCacheEntry = { latestTag: 'v0.14.2', installedTag: 'unknown' }
    expect(isUpdateAvailable(installation, 'stable', info)).toBe(false)
  })

  it('returns false via installedTag match when no comfyVersion', () => {
    const installation = {
      updateInfoByChannel: { stable: { installedTag: 'v0.14.2' } },
    }
    const info: ReleaseCacheEntry = { latestTag: 'v0.14.2', installedTag: 'v0.14.2' }
    expect(isUpdateAvailable(installation, 'stable', info)).toBe(false)
  })

  it('returns false for latest channel when commit SHA matches even if installedTag differs from latestTag', () => {
    const fullSha = 'abc123def456abc123def456abc123def456abc123'
    const installation = {
      comfyVersion: { commit: fullSha, baseTag: 'v0.18.3', commitsAhead: 5 },
      lastRollback: { channel: 'latest' },
      updateInfoByChannel: { latest: { installedTag: 'v0.18.3+5' } },
    }
    // latestTag is a short SHA (from fetchLatestRelease), releaseName may
    // differ from installedTag if commitsAhead enrichment hasn't run yet.
    const info: ReleaseCacheEntry = {
      latestTag: 'abc123d',
      commitSha: fullSha,
      releaseName: 'v0.18.3 (abc123d)',
      installedTag: 'v0.18.3+5',
    }
    expect(isUpdateAvailable(installation, 'latest', info)).toBe(false)
  })

  it('returns true for latest channel when commit SHA differs', () => {
    const installation = {
      comfyVersion: { commit: 'old123old456old123old456old123old456old123', baseTag: 'v0.18.3', commitsAhead: 3 },
      lastRollback: { channel: 'latest' },
      updateInfoByChannel: { latest: { installedTag: 'v0.18.3+3' } },
    }
    const info: ReleaseCacheEntry = {
      latestTag: 'abc123d',
      commitSha: 'abc123def456abc123def456abc123def456abc123',
      releaseName: 'v0.18.3+5',
      installedTag: 'v0.18.3+3',
    }
    expect(isUpdateAvailable(installation, 'latest', info)).toBe(true)
  })
})
