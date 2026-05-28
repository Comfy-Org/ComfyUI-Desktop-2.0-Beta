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
    // Stall the first git call so both `enrichCommitsAhead` invocations
    // can pile up while it's still pending — that's the window where
    // the dedupe Map has to suppress the second.
    let releaseStall!: () => void
    const stall = new Promise<void>((resolve) => { releaseStall = resolve })
    vi.mocked(gitMock.fetchTags).mockImplementation(async () => {
      await stall
      return true
    })
    vi.mocked(gitMock.countCommitsAhead).mockResolvedValue(2)

    const p1 = enrichCommitsAhead(repo, '/tmp/fake-repo')
    const p2 = enrichCommitsAhead(repo, '/tmp/fake-repo')
    releaseStall()
    await Promise.all([p1, p2])

    expect(gitMock.fetchTags).toHaveBeenCalledTimes(1)
    expect(gitMock.fetchCommitSha).toHaveBeenCalledTimes(1)
    expect(gitMock.countCommitsAhead).toHaveBeenCalledTimes(1)
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

  it('does not fire listeners when countCommitsAhead returns undefined (failed enrichment)', async () => {
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

    expect(listener).not.toHaveBeenCalled()
    expect(get(repo, 'latest')?.commitsAhead).toBeUndefined()
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
