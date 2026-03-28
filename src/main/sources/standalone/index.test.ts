import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  ipcMain: { handle: vi.fn() },
}))

import { standalone } from './index'
import type { FieldOption } from '../../types/sources'

// --- buildInstallation ---

describe('standalone.buildInstallation', () => {
  const makeRelease = (value: string, tagName?: string): FieldOption => ({
    value,
    label: value,
    data: { id: 1, tag_name: tagName || value, name: null, assets: [] } as unknown as Record<string, unknown>,
  })

  const makeVariant = (variantId: string): FieldOption => ({
    value: variantId,
    label: variantId,
    data: {
      variantId,
      manifest: { id: variantId, comfyui_ref: 'v0.18.3', python_version: '3.13.12' },
      downloadUrl: 'https://example.com/download.tar.gz',
      downloadFiles: [{ url: 'https://example.com/download.tar.gz', filename: 'download.tar.gz', size: 1000 }],
    } as unknown as Record<string, unknown>,
  })

  it('sets autoUpdate when release value is "latest"', () => {
    const result = standalone.buildInstallation({
      release: makeRelease('latest', 'standalone-v0.1.24'),
      variant: makeVariant('win-nvidia'),
    })
    expect(result.autoUpdate).toBe(true)
  })

  it('does NOT set autoUpdate for a specific release tag', () => {
    const result = standalone.buildInstallation({
      release: makeRelease('standalone-v0.1.24'),
      variant: makeVariant('win-nvidia'),
    })
    expect(result.autoUpdate).toBeUndefined()
  })

  it('uses underlying tag_name as releaseTag when "latest" is selected', () => {
    const result = standalone.buildInstallation({
      release: makeRelease('latest', 'standalone-v0.1.24'),
      variant: makeVariant('win-nvidia'),
    })
    expect(result.releaseTag).toBe('standalone-v0.1.24')
  })

  it('uses the release value directly as releaseTag for specific releases', () => {
    const result = standalone.buildInstallation({
      release: makeRelease('standalone-v0.1.20'),
      variant: makeVariant('win-nvidia'),
    })
    expect(result.releaseTag).toBe('standalone-v0.1.20')
  })
})
