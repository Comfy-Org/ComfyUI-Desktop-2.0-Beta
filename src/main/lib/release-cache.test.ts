// @vitest-environment node
// Force Node: the default happy-dom env resolves `fs` to a browser stub, so the
// `vi.importActual('fs')` in the mock factory below would throw.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as FsModule from 'fs'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  net: { fetch: vi.fn() },
}))

// Stub the git helpers so tests don't spawn real `git`; each test sets its own behaviour.
vi.mock('./git', () => ({
  fetchTags: vi.fn(async () => true),
  fetchCommitSha: vi.fn(async () => true),
  countCommitsAhead: vi.fn(async () => 0),
  findNearestTag: vi.fn(async () => undefined),
}))

// Stub `comfyui-releases` so the baseTag-recovery path doesn't do real network work.
vi.mock('./comfyui-releases', () => ({
  fetchLatestRelease: vi.fn(),
  getLatestStableTag: vi.fn(async () => null),
  truncateNotes: vi.fn((text: string) => text),
}))

// Stub existsSync so tests can simulate a `.git` checkout without touching the filesystem.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof FsModule>('fs')
  return { ...actual, default: { ...actual, existsSync: vi.fn(() => true) } }
})

import { isUpdateAvailable, set, enrichCommitsAhead, onEnriched, get } from './release-cache'
import type { ReleaseCacheEntry } from './release-cache'
import * as gitMock from './git'
import * as releasesMock from './comfyui-releases'

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

  // v-prefix tolerance: legacy code paths (notably the legacy-desktop
  // adoption pre-fix) persisted bare version strings like "0.24.0" via
  // installation.version while GitHub tag names are "v"-prefixed. The
  // comparison must treat them as equal.
  it('returns false when installedTag is bare and latestTag is "v"-prefixed', () => {
    const installation = {}
    const info: ReleaseCacheEntry = { latestTag: 'v0.24.0', installedTag: '0.24.0' }
    expect(isUpdateAvailable(installation, 'stable', info)).toBe(false)
  })

  it('returns false when installedTag is "v"-prefixed and latestTag is bare', () => {
    const installation = {}
    const info: ReleaseCacheEntry = { latestTag: '0.24.0', installedTag: 'v0.24.0' }
    expect(isUpdateAvailable(installation, 'stable', info)).toBe(false)
  })

  it('still detects real updates across v-prefix variants', () => {
    const installation = {}
    const info: ReleaseCacheEntry = { latestTag: 'v0.25.0', installedTag: '0.24.0' }
    expect(isUpdateAvailable(installation, 'stable', info)).toBe(true)
  })

  it('returns false cross-channel when displayVersion is bare and latestTag is "v"-prefixed', () => {
    const installation = {
      comfyVersion: { commit: 'abc1234def5678', baseTag: '0.14.2', commitsAhead: 0 },
      lastRollback: { channel: 'latest', postUpdateHead: 'abc1234' },
    }
    const info: ReleaseCacheEntry = { latestTag: 'v0.14.2', releaseName: 'v0.14.2', installedTag: '0.14.2' }
    expect(isUpdateAvailable(installation, 'stable', info)).toBe(false)
  })

  it('returns false for latest channel when commit SHA matches even if installedTag differs from latestTag', () => {
    const fullSha = 'abc123def456abc123def456abc123def456abc123'
    const installation = {
      comfyVersion: { commit: fullSha, baseTag: 'v0.18.3', commitsAhead: 5 },
      lastRollback: { channel: 'latest' },
      updateInfoByChannel: { latest: { installedTag: 'v0.18.3+5' } },
    }
    // latestTag is a short SHA; releaseName may differ from installedTag pre-enrichment.
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

describe('enrichCommitsAhead', () => {
  // Unique repo key per test so the module-level `_entries` cache doesn't leak state.
  let suffix = 0
  function newRepo(): string {
    suffix += 1
    return `Test-Org/Repo-${suffix}`
  }

  beforeEach(() => {
    vi.mocked(gitMock.fetchTags).mockReset().mockResolvedValue(true)
    vi.mocked(gitMock.fetchCommitSha).mockReset().mockResolvedValue(true)
    vi.mocked(gitMock.countCommitsAhead).mockReset().mockResolvedValue(0)
    vi.mocked(gitMock.findNearestTag).mockReset().mockResolvedValue(undefined)
    vi.mocked(releasesMock.getLatestStableTag).mockReset().mockResolvedValue(null)
  })

  it('fires onEnriched listeners exactly once when a new commitsAhead is written', async () => {
    const repo = newRepo()
    set(repo, 'latest', {
      commitSha: 'deadbeef00000000',
      baseTag: 'v1.0.0',
    })
    vi.mocked(gitMock.countCommitsAhead).mockResolvedValue(7)

    const listener = vi.fn()
    const off = onEnriched(listener)
    try {
      await enrichCommitsAhead(repo, '/tmp/fake-repo')
    } finally {
      off()
    }

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(repo)
    expect(get(repo, 'latest')?.commitsAhead).toBe(7)
  })

  it('does not fire onEnriched listeners on the no-op short-circuit (commitsAhead already set)', async () => {
    const repo = newRepo()
    set(repo, 'latest', {
      commitSha: 'deadbeef00000000',
      baseTag: 'v1.0.0',
      commitsAhead: 3,
    })

    const listener = vi.fn()
    const off = onEnriched(listener)
    try {
      await enrichCommitsAhead(repo, '/tmp/fake-repo')
    } finally {
      off()
    }

    expect(listener).not.toHaveBeenCalled()
    // No git work proves the guard runs at the top, before the fetches.
    expect(gitMock.fetchTags).not.toHaveBeenCalled()
  })

  it('dedupes concurrent calls for the same (repo, comfyuiDir) into one inflight promise', async () => {
    const repo = newRepo()
    set(repo, 'latest', {
      commitSha: 'deadbeef00000000',
      baseTag: 'v1.0.0',
    })
    // Stall the local count so both invocations pile up while it's pending — the window
    // where the dedupe Map must suppress the second.
    let releaseStall!: () => void
    const stall = new Promise<void>((resolve) => { releaseStall = resolve })
    vi.mocked(gitMock.countCommitsAhead).mockImplementation(async () => {
      await stall
      return 2
    })

    const p1 = enrichCommitsAhead(repo, '/tmp/fake-repo')
    const p2 = enrichCommitsAhead(repo, '/tmp/fake-repo')
    releaseStall()
    await Promise.all([p1, p2])

    // One shared execution: the local count ran once and resolved, so no network fetch.
    expect(gitMock.countCommitsAhead).toHaveBeenCalledTimes(1)
    expect(gitMock.fetchTags).not.toHaveBeenCalled()
    expect(gitMock.fetchCommitSha).not.toHaveBeenCalled()
  })

  it('skips the network fetch when the local commits-ahead count succeeds', async () => {
    const repo = newRepo()
    set(repo, 'latest', { commitSha: 'deadbeef00000000', baseTag: 'v1.0.0' })
    vi.mocked(gitMock.countCommitsAhead).mockResolvedValue(5)

    await enrichCommitsAhead(repo, '/tmp/fake-repo')

    expect(gitMock.fetchTags).not.toHaveBeenCalled()
    expect(gitMock.fetchCommitSha).not.toHaveBeenCalled()
    expect(get(repo, 'latest')?.commitsAhead).toBe(5)
  })

  it('falls back to a network fetch + retry when the commit is missing locally', async () => {
    const repo = newRepo()
    set(repo, 'latest', { commitSha: 'deadbeef00000000', baseTag: 'v1.0.0' })
    // First local count fails (objects absent), then succeeds after the fetch.
    vi.mocked(gitMock.countCommitsAhead)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(9)

    await enrichCommitsAhead(repo, '/tmp/fake-repo')

    expect(gitMock.fetchTags).toHaveBeenCalledTimes(1)
    expect(gitMock.fetchCommitSha).toHaveBeenCalledTimes(1)
    expect(get(repo, 'latest')?.commitsAhead).toBe(9)
  })

  it('clears the inflight slot on settle so a follow-up call after completion runs fresh', async () => {
    const repo = newRepo()
    set(repo, 'latest', {
      commitSha: 'deadbeef00000000',
      baseTag: 'v1.0.0',
    })
    vi.mocked(gitMock.countCommitsAhead).mockResolvedValue(4)

    await enrichCommitsAhead(repo, '/tmp/fake-repo')
    // The second call must re-evaluate the entry (and hit the no-op guard), which only
    // works if the inflight slot was cleared. Verify by asserting no git work re-runs.
    vi.mocked(gitMock.fetchTags).mockClear()
    await enrichCommitsAhead(repo, '/tmp/fake-repo')
    expect(gitMock.fetchTags).not.toHaveBeenCalled()
  })

  it('stamps a settle (and fires listeners) when countCommitsAhead returns undefined (failed enrichment)', async () => {
    // The renderer relies on this broadcast to drop the spinner; the cache still has
    // commitsAhead undefined so the picker falls back to `tag (sha)`.
    const repo = newRepo()
    set(repo, 'latest', {
      commitSha: 'deadbeef00000000',
      baseTag: 'v1.0.0',
    })
    vi.mocked(gitMock.countCommitsAhead).mockResolvedValue(undefined)

    const listener = vi.fn()
    const off = onEnriched(listener)
    try {
      await enrichCommitsAhead(repo, '/tmp/fake-repo')
    } finally {
      off()
    }

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(repo)
    const after = get(repo, 'latest')
    expect(after?.commitsAhead).toBeUndefined()
    expect(after?.lastEnrichAttemptAt).toBeTypeOf('number')
  })

  it('recovers a missing baseTag from getLatestStableTag, persists it, and completes enrichment', async () => {
    const repo = newRepo()
    set(repo, 'latest', { commitSha: 'deadbeef00000000' })
    vi.mocked(releasesMock.getLatestStableTag).mockResolvedValue('v1.2.3')
    vi.mocked(gitMock.countCommitsAhead).mockResolvedValue(4)

    await enrichCommitsAhead(repo, '/tmp/fake-repo')

    expect(releasesMock.getLatestStableTag).toHaveBeenCalledWith({ refresh: true })
    // Local-tag fallback shouldn't run when the remote refresh worked.
    expect(gitMock.findNearestTag).not.toHaveBeenCalled()
    const after = get(repo, 'latest')
    expect(after?.baseTag).toBe('v1.2.3')
    expect(after?.commitsAhead).toBe(4)
    expect(after?.lastEnrichAttemptAt).toBeTypeOf('number')
    // releaseName reflects the resolved (tag, commitsAhead) pair for the "+N commits" suffix.
    expect(after?.releaseName).toContain('v1.2.3')
  })

  it('falls back to findNearestTag when getLatestStableTag still returns null', async () => {
    const repo = newRepo()
    set(repo, 'latest', { commitSha: 'deadbeef00000000' })
    vi.mocked(releasesMock.getLatestStableTag).mockResolvedValue(null)
    vi.mocked(gitMock.findNearestTag).mockResolvedValue('v1.1.0')
    vi.mocked(gitMock.countCommitsAhead).mockResolvedValue(2)

    await enrichCommitsAhead(repo, '/tmp/fake-repo')

    expect(gitMock.findNearestTag).toHaveBeenCalledWith('/tmp/fake-repo', 'deadbeef00000000')
    const after = get(repo, 'latest')
    expect(after?.baseTag).toBe('v1.1.0')
    expect(after?.commitsAhead).toBe(2)
  })

  it('stamps a settle (and fires listeners) when no baseTag can be recovered', async () => {
    const repo = newRepo()
    set(repo, 'latest', { commitSha: 'deadbeef00000000' })
    // Both recovery paths return nothing; the helper must still settle the renderer.
    vi.mocked(releasesMock.getLatestStableTag).mockResolvedValue(null)
    vi.mocked(gitMock.findNearestTag).mockResolvedValue(undefined)

    const listener = vi.fn()
    const off = onEnriched(listener)
    try {
      await enrichCommitsAhead(repo, '/tmp/fake-repo')
    } finally {
      off()
    }

    expect(listener).toHaveBeenCalledTimes(1)
    const after = get(repo, 'latest')
    expect(after?.baseTag).toBeUndefined()
    expect(after?.commitsAhead).toBeUndefined()
    expect(after?.lastEnrichAttemptAt).toBeTypeOf('number')
    // rev-list never ran — nothing to count from.
    expect(gitMock.countCommitsAhead).not.toHaveBeenCalled()
  })

  it('throttles retries: a recent failed-settle stamp short-circuits before any git work runs', async () => {
    const repo = newRepo()
    // Fresh failed-settle: commitsAhead unresolved, stamp 5s ago (within the 30s cooldown).
    set(repo, 'latest', {
      commitSha: 'deadbeef00000000',
      baseTag: 'v1.0.0',
      lastEnrichAttemptAt: Date.now() - 5_000,
    })

    await enrichCommitsAhead(repo, '/tmp/fake-repo')

    // No recovery, no git work — the cooldown short-circuits everything.
    expect(releasesMock.getLatestStableTag).not.toHaveBeenCalled()
    expect(gitMock.findNearestTag).not.toHaveBeenCalled()
    expect(gitMock.countCommitsAhead).not.toHaveBeenCalled()
    expect(gitMock.fetchTags).not.toHaveBeenCalled()
  })

  it('allows retries once the throttle window has elapsed', async () => {
    const repo = newRepo()
    // Stamp older than the 30s throttle, so the full recovery + count chain runs again.
    set(repo, 'latest', {
      commitSha: 'deadbeef00000000',
      baseTag: 'v1.0.0',
      lastEnrichAttemptAt: Date.now() - 60_000,
    })
    vi.mocked(gitMock.countCommitsAhead).mockResolvedValue(11)

    await enrichCommitsAhead(repo, '/tmp/fake-repo')

    expect(gitMock.countCommitsAhead).toHaveBeenCalled()
    const after = get(repo, 'latest')
    expect(after?.commitsAhead).toBe(11)
    // The fresh success refreshes the stamp.
    expect(after?.lastEnrichAttemptAt).toBeGreaterThan(Date.now() - 5_000)
  })

  it('isolates listener errors — one throwing subscriber does not break others', async () => {
    const repo = newRepo()
    set(repo, 'latest', {
      commitSha: 'deadbeef00000000',
      baseTag: 'v1.0.0',
    })
    vi.mocked(gitMock.countCommitsAhead).mockResolvedValue(1)

    // Suppress the expected console.warn so output stays clean. Spy before registering
    // listeners; the source reads console.warn at call time.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const bad = vi.fn(() => { throw new Error('subscriber blew up') })
    const good = vi.fn()
    const offBad = onEnriched(bad)
    const offGood = onEnriched(good)
    try {
      await enrichCommitsAhead(repo, '/tmp/fake-repo')
    } finally {
      offBad()
      offGood()
      warnSpy.mockRestore()
    }

    // Every listener is invoked (no early break on throw) and the cache update still landed.
    expect(bad).toHaveBeenCalledTimes(1)
    expect(good).toHaveBeenCalledTimes(1)
    expect(get(repo, 'latest')?.commitsAhead).toBe(1)
  })
})
