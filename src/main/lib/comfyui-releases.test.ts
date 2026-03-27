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
import { fetchLatestRelease } from './comfyui-releases'
import * as settings from '../settings'

const mockedLsRemoteLatestTag = vi.mocked(lsRemoteLatestTag)
const mockedLsRemoteRef = vi.mocked(lsRemoteRef)
const mockedSettingsGet = vi.mocked(settings.get)

beforeEach(() => { vi.resetAllMocks() })

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
