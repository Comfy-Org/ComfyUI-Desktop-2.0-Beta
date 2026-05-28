// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./git', () => ({
  lsRemoteLatestTag: vi.fn(),
  lsRemoteRef: vi.fn(),
  isPygit2Configured: vi.fn(() => false),
}))

vi.mock('./github-mirror', () => ({
  getComfyUIRemoteUrl: vi.fn((enabled: boolean) =>
    enabled ? 'https://gitcode.com/gh_mirrors/co/ComfyUI.git' : 'https://github.com/Comfy-Org/ComfyUI.git'
  ),
}))

vi.mock('../settings', () => ({
  get: vi.fn(() => undefined),
}))

import { lsRemoteLatestTag, lsRemoteRef } from './git'
import { fetchLatestRelease, getLatestStableTag, _clearLatestStableTagCache } from './comfyui-releases'
import * as settings from '../settings'

const mockedLsRemoteLatestTag = vi.mocked(lsRemoteLatestTag)
const mockedLsRemoteRef = vi.mocked(lsRemoteRef)
const mockedSettingsGet = vi.mocked(settings.get)

beforeEach(() => {
  vi.resetAllMocks()
  _clearLatestStableTagCache()
})

describe('fetchLatestRelease', () => {
  describe('latest channel', () => {
    it('returns commit-based release with baseTag', async () => {
      mockedLsRemoteRef.mockResolvedValue('abc123def456abc123def456abc123def456abc123')
      mockedLsRemoteLatestTag.mockResolvedValue('v0.18.3')
      const result = await fetchLatestRelease('latest')
      expect(result).not.toBeNull()
      expect(result!.tag_name).toBe('abc123d')
      expect(result!.commitSha).toBe('abc123def456abc123def456abc123def456abc123')
      expect(result!.baseTag).toBe('v0.18.3')
      expect(result!._commit).toBe(true)
      expect(result!.body).toBe('')
    })

    it('returns null when ls-remote-ref fails', async () => {
      mockedLsRemoteRef.mockResolvedValue(null)
      mockedLsRemoteLatestTag.mockResolvedValue('v0.18.3')
      expect(await fetchLatestRelease('latest')).toBeNull()
    })

    it('returns release without baseTag when ls-remote-tags fails', async () => {
      mockedLsRemoteRef.mockResolvedValue('abc123def456abc123def456abc123def456abc123')
      mockedLsRemoteLatestTag.mockResolvedValue(undefined)
      const result = await fetchLatestRelease('latest')
      expect(result).not.toBeNull()
      expect(result!.baseTag).toBeUndefined()
    })

    it('does not include commitsAhead (computed locally)', async () => {
      mockedLsRemoteRef.mockResolvedValue('abc123def456abc123def456abc123def456abc123')
      mockedLsRemoteLatestTag.mockResolvedValue('v0.18.3')
      const result = await fetchLatestRelease('latest')
      expect(result!.commitsAhead).toBeUndefined()
    })

    it('does not include published_at', async () => {
      mockedLsRemoteRef.mockResolvedValue('abc123def456abc123def456abc123def456abc123')
      mockedLsRemoteLatestTag.mockResolvedValue('v0.18.3')
      const result = await fetchLatestRelease('latest')
      expect(result!.published_at).toBeUndefined()
    })

    it('does not call api.github.com', async () => {
      mockedLsRemoteRef.mockResolvedValue('abc123def456abc123def456abc123def456abc123')
      mockedLsRemoteLatestTag.mockResolvedValue('v0.18.3')
      await fetchLatestRelease('latest')
      // Verify only git-based functions were called
      expect(mockedLsRemoteRef).toHaveBeenCalled()
      expect(mockedLsRemoteLatestTag).toHaveBeenCalled()
    })
  })

  describe('stable channel', () => {
    it('returns synthetic release from latest tag', async () => {
      mockedLsRemoteLatestTag.mockResolvedValue('v0.18.3')
      const result = await fetchLatestRelease('stable')
      expect(result).not.toBeNull()
      expect(result!.tag_name).toBe('v0.18.3')
      expect(result!.name).toBe('v0.18.3')
      expect(result!.baseTag).toBe('v0.18.3')
      expect(result!.commitsAhead).toBe(0)
      expect(result!.body).toBe('')
    })

    it('returns null when no tags found', async () => {
      mockedLsRemoteLatestTag.mockResolvedValue(undefined)
      expect(await fetchLatestRelease('stable')).toBeNull()
    })

    it('does not include published_at', async () => {
      mockedLsRemoteLatestTag.mockResolvedValue('v0.18.3')
      const result = await fetchLatestRelease('stable')
      expect(result!.published_at).toBeUndefined()
    })
  })

  describe('getLatestStableTag cache', () => {
    it('caches successful lookups within the TTL', async () => {
      mockedLsRemoteLatestTag.mockResolvedValue('v1.19.5')
      const a = await getLatestStableTag()
      const b = await getLatestStableTag()
      expect(a).toBe('v1.19.5')
      expect(b).toBe('v1.19.5')
      expect(mockedLsRemoteLatestTag).toHaveBeenCalledTimes(1)
    })

    it('refresh: true bypasses the cache', async () => {
      mockedLsRemoteLatestTag.mockResolvedValueOnce('v1.19.5').mockResolvedValueOnce('v1.19.6')
      const a = await getLatestStableTag()
      const b = await getLatestStableTag({ refresh: true })
      expect(a).toBe('v1.19.5')
      expect(b).toBe('v1.19.6')
      expect(mockedLsRemoteLatestTag).toHaveBeenCalledTimes(2)
    })

    it('returns null when the lookup fails and never throws', async () => {
      mockedLsRemoteLatestTag.mockRejectedValue(new Error('boom'))
      await expect(getLatestStableTag()).resolves.toBeNull()
    })

    it('returns null when no tags found', async () => {
      mockedLsRemoteLatestTag.mockResolvedValue(undefined)
      await expect(getLatestStableTag()).resolves.toBeNull()
    })

    it('keys cache by remote URL — flipping the mirror setting refetches', async () => {
      mockedLsRemoteLatestTag.mockResolvedValueOnce('v1.19.5').mockResolvedValueOnce('v1.19.5-mirror')
      mockedSettingsGet.mockReturnValue(undefined as never)
      const a = await getLatestStableTag()
      mockedSettingsGet.mockReturnValue(true as never)
      const b = await getLatestStableTag()
      expect(a).toBe('v1.19.5')
      expect(b).toBe('v1.19.5-mirror')
      expect(mockedLsRemoteLatestTag).toHaveBeenCalledTimes(2)
    })

    it('coalesces concurrent in-flight requests', async () => {
      let resolve: (v: string) => void = () => {}
      mockedLsRemoteLatestTag.mockReturnValue(new Promise((r) => { resolve = r as (v: string) => void }))
      const p1 = getLatestStableTag()
      const p2 = getLatestStableTag()
      resolve('v1.19.5')
      const [a, b] = await Promise.all([p1, p2])
      expect(a).toBe('v1.19.5')
      expect(b).toBe('v1.19.5')
      expect(mockedLsRemoteLatestTag).toHaveBeenCalledTimes(1)
    })

    it('fetchLatestRelease("stable") shares the cache', async () => {
      mockedLsRemoteLatestTag.mockResolvedValue('v1.19.5')
      await getLatestStableTag()
      const result = await fetchLatestRelease('stable')
      expect(result!.tag_name).toBe('v1.19.5')
      expect(mockedLsRemoteLatestTag).toHaveBeenCalledTimes(1)
    })

    it('a null tag uses the short failure TTL, not the long success TTL', async () => {
      // A null result (e.g. no git backend configured) used to be cached
      // for SUCCESS_TTL_MS = 10 min, indistinguishable from a confirmed
      // empty repo. The post-install update step then read that poisoned
      // null on every subsequent call within 10 minutes and falsely showed
      // "Already up to date", stranding new installs on the bundled
      // ComfyUI version. Pin behavior: a null result must expire on the
      // failure cadence so the next caller refetches.
      vi.useFakeTimers()
      try {
        mockedLsRemoteLatestTag.mockResolvedValueOnce(undefined).mockResolvedValueOnce('v1.19.5')
        const a = await getLatestStableTag()
        // Advance past the failure TTL (30 s) but well within the success
        // TTL (10 min) so we can tell the two apart.
        vi.setSystemTime(Date.now() + 60_000)
        const b = await getLatestStableTag()
        expect(a).toBeNull()
        expect(b).toBe('v1.19.5')
        expect(mockedLsRemoteLatestTag).toHaveBeenCalledTimes(2)
      } finally {
        vi.useRealTimers()
      }
    })

    it('fetchLatestRelease forwards refresh through to the tag lookup', async () => {
      mockedLsRemoteLatestTag.mockResolvedValueOnce('v1.19.5').mockResolvedValueOnce('v1.19.6')
      const a = await fetchLatestRelease('stable')
      const b = await fetchLatestRelease('stable', { refresh: true })
      expect(a!.tag_name).toBe('v1.19.5')
      expect(b!.tag_name).toBe('v1.19.6')
      expect(mockedLsRemoteLatestTag).toHaveBeenCalledTimes(2)
    })
  })

  describe('mirror setting', () => {
    it('uses gitcode URL when useChineseMirrors is true', async () => {
      mockedSettingsGet.mockReturnValue(true as never)
      mockedLsRemoteLatestTag.mockResolvedValue('v0.18.3')
      mockedLsRemoteRef.mockResolvedValue('abc123def456abc123def456abc123def456abc123')
      await fetchLatestRelease('latest')
      expect(mockedLsRemoteRef).toHaveBeenCalledWith(
        'https://gitcode.com/gh_mirrors/co/ComfyUI.git',
        'refs/heads/master'
      )
    })

    it('uses github URL when useChineseMirrors is false', async () => {
      mockedSettingsGet.mockReturnValue(undefined as never)
      mockedLsRemoteLatestTag.mockResolvedValue('v0.18.3')
      mockedLsRemoteRef.mockResolvedValue('abc123def456abc123def456abc123def456abc123')
      await fetchLatestRelease('latest')
      expect(mockedLsRemoteRef).toHaveBeenCalledWith(
        'https://github.com/Comfy-Org/ComfyUI.git',
        'refs/heads/master'
      )
    })
  })
})
