import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  ipcMain: { handle: vi.fn() },
}))

vi.mock('../../lib/fetch', () => ({
  fetchJSON: vi.fn(),
}))

vi.mock('../../lib/comfyui-releases', () => ({
  getLatestStableTag: vi.fn(),
}))

import { standalone } from './index'
import { fetchJSON } from '../../lib/fetch'
import { getLatestStableTag } from '../../lib/comfyui-releases'
import { PLATFORM_PREFIX } from './envPaths'
import type { FieldOption } from '../../types/sources'
import type { InstallationRecord } from '../../installations'

const mockedFetchJSON = vi.mocked(fetchJSON)
const mockedGetLatestStableTag = vi.mocked(getLatestStableTag)

// Use the running platform's vendor prefix so tests work on win32/darwin/linux CI runners.
const VENDOR_ID = `${PLATFORM_PREFIX[process.platform] || 'win-'}nvidia`

// --- Helpers ---

type R2Release = { tag: string; comfyui_version: string; comfyui_commit: string; build: number; date: string; file: string; size: number; python_version: string; torch_version: string }

function makeR2Releases(tags: string[], options?: { vendorId?: string; comfyuiVersion?: string }) {
  const vendorId = options?.vendorId ?? VENDOR_ID
  const version = options?.comfyuiVersion ?? '0.18.3'
  const releases: R2Release[] = tags.map((tag) => ({
    tag,
    comfyui_version: version,
    comfyui_commit: 'abc123',
    build: 1,
    date: '2026-03-15T00:00:00Z',
    file: `${vendorId}-${tag}.tar.gz`,
    size: 1048576,
    python_version: '3.13.12',
    torch_version: '2.7.0',
  }))
  // latest.json: vendor_id → newest release
  const latest: Record<string, R2Release> = { [vendorId]: releases[0]! }
  // per-vendor releases.json
  const vendorReleases: Record<string, { releases: R2Release[] }> = { [vendorId]: { releases } }
  return { latest, vendorReleases, vendorId }
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
      variant: makeVariant(VENDOR_ID),
    })
    expect(result.autoUpdateComfyUI).toBe(true)
  })

  it('does NOT set autoUpdateComfyUI for a specific release tag', () => {
    const result = standalone.buildInstallation({
      release: makeRelease('v0.18.2-env1'),
      variant: makeVariant(VENDOR_ID),
    })
    expect(result.autoUpdateComfyUI).toBeUndefined()
  })

  it('uses r2Release tag as releaseTag when "latest" is selected', () => {
    const result = standalone.buildInstallation({
      release: makeRelease('latest', 'v0.18.2-env1'),
      variant: makeVariant(VENDOR_ID),
    })
    expect(result.releaseTag).toBe('v0.18.2-env1')
  })

  it('uses the release value directly as releaseTag for specific releases', () => {
    const result = standalone.buildInstallation({
      release: makeRelease('v0.18.2-env1'),
      variant: makeVariant(VENDOR_ID),
    })
    expect(result.releaseTag).toBe('v0.18.2-env1')
  })

  it('freezes originalBuild and originalTorchVersion from r2Release on the installation', () => {
    const result = standalone.buildInstallation({
      release: makeRelease('v0.18.2-env1'),
      variant: makeVariant(VENDOR_ID),
    })
    expect(result.originalBuild).toBe(1)
    expect(result.originalTorchVersion).toBe('2.7.0')
  })
})

// --- getFieldOptions('release') ---

describe('standalone.getFieldOptions release', () => {
  function setupMockReleases() {
    const { latest, vendorReleases, vendorId } = makeR2Releases(['v0.18.3-env1', 'v0.18.2-env1'])
    // Make the first tag newer
    vendorReleases[vendorId]!.releases[0]!.date = '2026-04-01T00:00:00Z'
    vendorReleases[vendorId]!.releases[1]!.date = '2026-03-15T00:00:00Z'
    vendorReleases[vendorId]!.releases[1]!.comfyui_version = '0.18.2'
    latest[vendorId] = vendorReleases[vendorId]!.releases[0]!
    mockedFetchJSON.mockImplementation((url: string) => {
      if (url.includes('latest.json')) return Promise.resolve(latest)
      return Promise.resolve(vendorReleases[vendorId]!)
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

  it('"Latest Stable" entry shows the upstream ComfyUI tag in description when resolved', async () => {
    setupMockReleases()
    mockedGetLatestStableTag.mockResolvedValue('v1.19.5')
    const options = await standalone.getFieldOptions!('release', {}, { includeLatestStable: true })
    const latestEntry = options.find((o) => o.value === 'latest')!
    expect(latestEntry.description).toBe('v1.19.5')
  })

  it('"Latest Stable" entry omits description when the tag lookup fails', async () => {
    setupMockReleases()
    mockedGetLatestStableTag.mockResolvedValue(null)
    const options = await standalone.getFieldOptions!('release', {}, { includeLatestStable: true })
    const latestEntry = options.find((o) => o.value === 'latest')!
    expect(latestEntry.description).toBeUndefined()
  })
})

// --- getLaunchCommand: adopted Legacy Desktop installs ---

describe('standalone.getLaunchCommand for adopted Legacy Desktop installs', () => {
  const installPath = path.join('C:', 'fake', 'installs', 'adopted')
  const adoptedBaseDir = path.join('C:', 'Users', 'me', 'Documents', 'ComfyUI')
  const adoptedPythonPath = path.join(adoptedBaseDir, '.venv', 'Scripts', 'python.exe')

  // Pretend every path the source checks is on disk — we're only exercising
  // arg construction, not file resolution.
  beforeEach(() => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function makeAdoptedRecord(overrides: Partial<InstallationRecord> = {}): InstallationRecord {
    return {
      id: 'inst-1',
      name: 'Adopted from Legacy Desktop',
      createdAt: new Date().toISOString(),
      sourceId: 'standalone',
      installPath,
      adopted: true,
      adoptedBaseDir,
      adoptedPythonPath,
      useSharedPaths: false,
      launchArgs: '--listen 127.0.0.1 --port 8188',
      ...overrides,
    } as InstallationRecord
  }

  it('uses adoptedPythonPath for the cmd instead of standalone-env python', () => {
    const cmd = standalone.getLaunchCommand!(makeAdoptedRecord())
    expect(cmd).not.toBeNull()
    expect(cmd!.cmd).toBe(adoptedPythonPath)
  })

  it('runs ComfyUI/main.py from installPath (not from adoptedBaseDir)', () => {
    const cmd = standalone.getLaunchCommand!(makeAdoptedRecord())!
    expect(cmd.cwd).toBe(installPath)
    expect(cmd.args![0]).toBe('-s')
    expect(cmd.args![1]).toBe(path.join('ComfyUI', 'main.py'))
  })

  it('injects --base-directory / --user-directory / --input-directory / --output-directory rooted at adoptedBaseDir', () => {
    const cmd = standalone.getLaunchCommand!(makeAdoptedRecord())!
    const args = cmd.args!
    const idx = (flag: string) => args.indexOf(flag)
    expect(args[idx('--base-directory') + 1]).toBe(adoptedBaseDir)
    expect(args[idx('--user-directory') + 1]).toBe(path.join(adoptedBaseDir, 'user'))
    expect(args[idx('--input-directory') + 1]).toBe(path.join(adoptedBaseDir, 'input'))
    expect(args[idx('--output-directory') + 1]).toBe(path.join(adoptedBaseDir, 'output'))
  })

  it('places adopt CLI args before user launchArgs so user values win on conflict', () => {
    const cmd = standalone.getLaunchCommand!(makeAdoptedRecord({
      launchArgs: '--listen 0.0.0.0 --port 9000 --base-directory /custom/override',
    }))!
    const args = cmd.args!
    // Two --base-directory occurrences; user override comes after the adopt-injected one
    const positions = args
      .map((value, index) => value === '--base-directory' ? index : -1)
      .filter((index) => index >= 0)
    expect(positions.length).toBe(2)
    expect(positions[0]!).toBeLessThan(positions[1]!)
    expect(args[positions[1]! + 1]).toBe('/custom/override')
  })

  it('extracts the port from user launchArgs', () => {
    const cmd = standalone.getLaunchCommand!(makeAdoptedRecord())!
    expect(cmd.port).toBe(8188)
  })

  it('returns null when adoptedPythonPath is missing', () => {
    const cmd = standalone.getLaunchCommand!(makeAdoptedRecord({ adoptedPythonPath: undefined }))
    expect(cmd).toBeNull()
  })

  it('does not inject adopt args when adopted flag is absent', () => {
    const record = makeAdoptedRecord({ adopted: undefined })
    const cmd = standalone.getLaunchCommand!(record)
    // adoptedPythonPath is ignored for non-adopted; getActivePythonPath would
    // return a standalone-env path which our existsSync mock also accepts.
    expect(cmd).not.toBeNull()
    expect(cmd!.args!.includes('--base-directory')).toBe(false)
    expect(cmd!.args!.includes('--user-directory')).toBe(false)
  })
})
