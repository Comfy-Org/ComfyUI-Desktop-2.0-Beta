// @vitest-environment node
// release-cache.ts pulls in Node's `fs` module (main-process code). The
// repo-wide default test environment is happy-dom, where `fs` resolves
// to `__vite-browser-external` and the `vi.importActual('fs')` inside
// the mock factory below throws. Force Node here so the real module is
// available for the wrapper.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as FsModule from 'fs'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  net: { fetch: vi.fn() },
}))

// Stub the git helpers `enrichCommitsAhead` shells out to so the tests
// don't spawn real `git` processes. Each test installs its own behaviour
// via `mockImplementation` / `mockResolvedValue`.
vi.mock('./git', () => ({
  fetchTags: vi.fn(async () => true),
  fetchCommitSha: vi.fn(async () => true),
  countCommitsAhead: vi.fn(async () => 0),
  findNearestTag: vi.fn(async () => undefined),
}))

// Stub `comfyui-releases` so the baseTag-recovery path in
// `enrichCommitsAhead` doesn't trigger real `lsRemoteLatestTag` work.
// Only `getLatestStableTag` is invoked from the helper under test;
// the rest of the surface area is unused here.
vi.mock('./comfyui-releases', () => ({
  fetchLatestRelease: vi.fn(),
  getLatestStableTag: vi.fn(async () => null),
  truncateNotes: vi.fn((text: string) => text),
}))

// `enrichCommitsAhead` short-circuits when `${comfyuiDir}/.git` doesn't
// exist on disk. Stub the existsSync check so tests can simulate a git
// checkout without touching the filesystem.
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

describe('enrichCommitsAhead', () => {
  // Each test uses a unique repo key so the module-level `_entries` cache
  // doesn't leak state across tests and a leftover `commitsAhead` from a
  // prior run can't short-circuit a new run.
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
    // The git helpers are short-circuited before the spawn — proves the
    // guard runs at the top, not after the fetches.
    expect(gitMock.fetchTags).not.toHaveBeenCalled()
  })

  it('dedupes concurrent calls for the same (repo, comfyuiDir) into one inflight promise', async () => {
    const repo = newRepo()
    set(repo, 'latest', {
      commitSha: 'deadbeef00000000',
      baseTag: 'v1.0.0',
    })
    // Stall the first git call (the local commits-ahead count) so both
    // `enrichCommitsAhead` invocations pile up while it's still pending —
    // that's the window where the dedupe Map has to suppress the second.
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

    // One shared execution: the local count ran once, and because it
    // resolved a value the network fetch was never reached.
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
    // First (local) count fails — objects aren't present — then succeeds
    // after the fetch pulls them in.
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
    // Cache now has commitsAhead populated, so the no-op guard fires on
    // the second call. The dedupe map cleanup is what lets us reach that
    // guard at all — a leftover inflight promise would resolve to
    // `undefined` without re-evaluating the entry. We check by verifying
    // the second call doesn't re-spawn any git work.
    vi.mocked(gitMock.fetchTags).mockClear()
    await enrichCommitsAhead(repo, '/tmp/fake-repo')
    expect(gitMock.fetchTags).not.toHaveBeenCalled()
  })

  it('stamps a settle (and fires listeners) when countCommitsAhead returns undefined (failed enrichment)', async () => {
    // Used to assert no listener fires, but the renderer relies on
    // exactly that broadcast to drop the "Computing commits ahead…"
    // spinner without waiting on the 10s safety timer.  The cache
    // still has `commitsAhead === undefined` so the picker falls back
    // to `tag (sha)`; the listener firing is just the "we tried and
    // gave up" signal.
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
    // Local-tag fallback shouldn't run if the remote tag refresh worked.
    expect(gitMock.findNearestTag).not.toHaveBeenCalled()
    const after = get(repo, 'latest')
    expect(after?.baseTag).toBe('v1.2.3')
    expect(after?.commitsAhead).toBe(4)
    expect(after?.lastEnrichAttemptAt).toBeTypeOf('number')
    // releaseName should reflect the resolved (tag, commitsAhead) pair
    // so the picker can render the "+N commits" suffix on next refresh.
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
    // Both recovery paths return nothing — the helper must not leave
    // the renderer stuck on "Computing commits ahead…".
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
    // rev-list was never attempted — there was nothing to count from.
    expect(gitMock.countCommitsAhead).not.toHaveBeenCalled()
  })

  it('throttles retries: a recent failed-settle stamp short-circuits before any git work runs', async () => {
    const repo = newRepo()
    // Simulate a fresh failed-settle: commitsAhead unresolved but
    // lastEnrichAttemptAt within the throttle window (5s ago, well
    // under the 30s cooldown).
    set(repo, 'latest', {
      commitSha: 'deadbeef00000000',
      baseTag: 'v1.0.0',
      lastEnrichAttemptAt: Date.now() - 5_000,
    })

    await enrichCommitsAhead(repo, '/tmp/fake-repo')

    // No recovery, no git work — the cooldown beats everything else.
    expect(releasesMock.getLatestStableTag).not.toHaveBeenCalled()
    expect(gitMock.findNearestTag).not.toHaveBeenCalled()
    expect(gitMock.countCommitsAhead).not.toHaveBeenCalled()
    expect(gitMock.fetchTags).not.toHaveBeenCalled()
  })

  it('allows retries once the throttle window has elapsed', async () => {
    const repo = newRepo()
    // Stamp is older than the 30s throttle, so the helper should run
    // the full recovery + count chain again.
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

    // Suppress the expected `console.warn` from the listener-isolation
    // catch so test output stays clean. Set up the spy BEFORE
    // registering listeners — vitest's spies replace the property
    // descriptor, and the source picks up `console.warn` at call time,
    // so anything later in the call chain reads the spied version.
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

    // The two key invariants: every listener gets invoked (no early
    // break on throw) and the cache update still landed (already
    // verified implicitly by ordering — `set()` runs before the
    // listener loop).
    expect(bad).toHaveBeenCalledTimes(1)
    expect(good).toHaveBeenCalledTimes(1)
    expect(get(repo, 'latest')?.commitsAhead).toBe(1)
  })
})
