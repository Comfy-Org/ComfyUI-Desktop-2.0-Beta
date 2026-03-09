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
    // Simulates the state after a snapshot restore that resets lastRollback
    // to the restored channel, preventing stale cross-channel comparisons.
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

  it('detects stable update available when on latest with short format version (v0.14.2+21)', () => {
    const installation = {
      version: 'v0.14.2+21',
      updateInfoByChannel: { stable: { installedTag: 'abc1234' } },
    }
    const info: ReleaseCacheEntry = { latestTag: 'v0.14.2', installedTag: 'abc1234' }
    expect(isUpdateAvailable(installation, 'stable', info)).toBe(true)
  })

  it('detects stable update available when on latest with legacy format version (v0.14.2 + 21 commits)', () => {
    const installation = {
      version: 'v0.14.2 + 21 commits (abc1234)',
      updateInfoByChannel: { stable: { installedTag: 'abc1234' } },
    }
    const info: ReleaseCacheEntry = { latestTag: 'v0.14.2', installedTag: 'abc1234' }
    expect(isUpdateAvailable(installation, 'stable', info)).toBe(true)
  })
})
