import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  ipcMain: { handle: vi.fn() },
}))

vi.mock('../../lib/fetch', () => ({
  fetchJSON: vi.fn(),
}))

import { standalone } from './index'
import { fetchJSON } from '../../lib/fetch'
import type { FieldOption } from '../../types/sources'

const mockedFetchJSON = vi.mocked(fetchJSON)

// --- Helpers ---

type R2Release = { tag: string; comfyui_version: string; comfyui_commit: string; build: number; date: string; file: string; size: number; python_version: string; torch_version: string }

function makeR2Releases(tags: string[], options?: { vendorPrefix?: string; comfyuiVersion?: string }) {
  const prefix = options?.vendorPrefix ?? 'win'
  const version = options?.comfyuiVersion ?? '0.18.3'
  const releases: R2Release[] = tags.map((tag) => ({
    tag,
    comfyui_version: version,
    comfyui_commit: 'abc123',
    build: 1,
    date: '2026-03-15T00:00:00Z',
    file: `${prefix}-nvidia-${tag}.tar.gz`,
    size: 1048576,
    python_version: '3.13.12',
    torch_version: '2.7.0',
  }))
  // latest.json: vendor_id → newest release
  const latest: Record<string, R2Release> = { [`${prefix}-nvidia`]: releases[0]! }
  // per-vendor releases.json
  const vendorReleases: Record<string, { releases: R2Release[] }> = { [`${prefix}-nvidia`]: { releases } }
  return { latest, vendorReleases }
}

// --- buildInstallation ---

describe('standalone.buildInstallation', () => {
  const makeRelease = (value: string, tag?: string): FieldOption => ({
    value,
    label: value,
    data: { tag: tag || value, vendorReleases: {} } as unknown as Record<string, unknown>,
  })

  const makeVariant = (variantId: string): FieldOption => ({
    value: variantId,
    label: variantId,
    data: {
      variantId,
      manifest: { id: variantId, comfyui_ref: '0.18.3', python_version: '3.13.12' },
      downloadUrl: 'https://example.com/download.tar.gz',
      downloadFiles: [{ url: 'https://example.com/download.tar.gz', filename: 'download.tar.gz', size: 1000 }],
      r2Release: { tag: 'v0.18.2-env1', comfyui_version: '0.18.2', comfyui_commit: 'abc123', build: 1, date: '2026-03-15T00:00:00Z', file: 'download.tar.gz', size: 1000, python_version: '3.13.12', torch_version: '2.7.0' },
    } as unknown as Record<string, unknown>,
  })

  it('sets autoUpdateComfyUI when release value is "latest"', () => {
    const result = standalone.buildInstallation({
      release: makeRelease('latest', 'v0.18.2-env1'),
      variant: makeVariant('win-nvidia'),
    })
    expect(result.autoUpdateComfyUI).toBe(true)
  })

  it('does NOT set autoUpdateComfyUI for a specific release tag', () => {
    const result = standalone.buildInstallation({
      release: makeRelease('v0.18.2-env1'),
      variant: makeVariant('win-nvidia'),
    })
    expect(result.autoUpdateComfyUI).toBeUndefined()
  })

  it('uses r2Release tag as releaseTag when "latest" is selected', () => {
    const result = standalone.buildInstallation({
      release: makeRelease('latest', 'v0.18.2-env1'),
      variant: makeVariant('win-nvidia'),
    })
    expect(result.releaseTag).toBe('v0.18.2-env1')
  })

  it('uses the release value directly as releaseTag for specific releases', () => {
    const result = standalone.buildInstallation({
      release: makeRelease('v0.18.2-env1'),
      variant: makeVariant('win-nvidia'),
    })
    expect(result.releaseTag).toBe('v0.18.2-env1')
  })
})

// --- getFieldOptions('release') ---

describe('standalone.getFieldOptions release', () => {
  function setupMockReleases() {
    const { latest, vendorReleases } = makeR2Releases(['v0.18.3-env1', 'v0.18.2-env1'])
    // Make the first tag newer
    vendorReleases['win-nvidia']!.releases[0]!.date = '2026-04-01T00:00:00Z'
    vendorReleases['win-nvidia']!.releases[1]!.date = '2026-03-15T00:00:00Z'
    vendorReleases['win-nvidia']!.releases[1]!.comfyui_version = '0.18.2'
    latest['win-nvidia'] = vendorReleases['win-nvidia']!.releases[0]!
    mockedFetchJSON.mockImplementation((url: string) => {
      if (url.includes('latest.json')) return Promise.resolve(latest)
      return Promise.resolve(vendorReleases['win-nvidia']!)
    })
  }

  it('includes "Latest Stable" when includeLatestStable is true', async () => {
    setupMockReleases()
    const options = await standalone.getFieldOptions!('release', {}, { includeLatestStable: true })
    expect(options[0]!.value).toBe('latest')
    expect(options[0]!.recommended).toBe(true)
    // Real releases follow
    expect(options[1]!.value).toBe('v0.18.3-env1')
    expect(options[2]!.value).toBe('v0.18.2-env1')
  })

  it('excludes "Latest Stable" by default (no context flag)', async () => {
    setupMockReleases()
    const options = await standalone.getFieldOptions!('release', {}, {})
    expect(options.every((o) => o.value !== 'latest')).toBe(true)
    expect(options[0]!.value).toBe('v0.18.3-env1')
  })

  it('excludes "Latest Stable" when includeLatestStable is false', async () => {
    setupMockReleases()
    const options = await standalone.getFieldOptions!('release', {}, { includeLatestStable: false })
    expect(options.every((o) => o.value !== 'latest')).toBe(true)
  })

  it('"Latest Stable" entry uses the newest release tag', async () => {
    setupMockReleases()
    const options = await standalone.getFieldOptions!('release', {}, { includeLatestStable: true })
    const latestEntry = options.find((o) => o.value === 'latest')!
    const underlyingData = latestEntry.data as Record<string, unknown>
    expect(underlyingData.tag).toBe('v0.18.3-env1')
  })
})
