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

  it('Stable: sets autoUpdateComfyUI + updateChannel="stable" so post-install checks out the latest stable tag', () => {
    const result = standalone.buildInstallation({
      release: makeRelease('stable', 'v0.18.2-env1'),
      variant: makeVariant(VENDOR_ID),
    })
    expect(result.autoUpdateComfyUI).toBe(true)
    expect(result.updateChannel).toBe('stable')
  })

  it('Latest on GitHub: sets autoUpdateComfyUI + updateChannel="latest" so post-install fast-forwards to master HEAD', () => {
    const result = standalone.buildInstallation({
      release: makeRelease('latest', 'v0.18.2-env1'),
      variant: makeVariant(VENDOR_ID),
    })
    // Both channels run the post-install update step — the bundle's
    // checked-in commit is necessarily behind both stable AND master,
    // so picking "Latest on GitHub" without an update would leave the
    // user on an OLD master commit, not the actual latest one.
    expect(result.autoUpdateComfyUI).toBe(true)
    expect(result.updateChannel).toBe('latest')
  })

  it('uses r2Release tag as releaseTag for both channels', () => {
    const stable = standalone.buildInstallation({
      release: makeRelease('stable', 'v0.18.2-env1'),
      variant: makeVariant(VENDOR_ID),
    })
    const latest = standalone.buildInstallation({
      release: makeRelease('latest', 'v0.18.2-env1'),
      variant: makeVariant(VENDOR_ID),
    })
    expect(stable.releaseTag).toBe('v0.18.2-env1')
    expect(latest.releaseTag).toBe('v0.18.2-env1')
  })

  it('freezes originalBuild and originalTorchVersion from r2Release on the installation', () => {
    const result = standalone.buildInstallation({
      release: makeRelease('stable', 'v0.18.2-env1'),
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

  it('returns exactly the two IPP channel options (Stable + Latest on GitHub)', async () => {
    setupMockReleases()
    const options = await standalone.getFieldOptions!('release', {}, { includeLatestStable: true })
    // No per-tag entries — only the two channel options surface, in
    // the same order + with the same value ids the IPP Update tab uses.
    expect(options.length).toBe(2)
    expect(options[0]!.value).toBe('stable')
    expect(options[0]!.recommended).toBe(true)
    expect(options[1]!.value).toBe('latest')
    expect(options[1]!.recommended).toBeUndefined()
  })

  it('returns no options when includeLatestStable is omitted', async () => {
    setupMockReleases()
    const options = await standalone.getFieldOptions!('release', {}, {})
    expect(options).toEqual([])
  })

  it('both entries point data.tag at the newest available bundle', async () => {
    setupMockReleases()
    const options = await standalone.getFieldOptions!('release', {}, { includeLatestStable: true })
    const stableData = options.find((o) => o.value === 'stable')!.data as Record<string, unknown>
    const latestData = options.find((o) => o.value === 'latest')!.data as Record<string, unknown>
    expect(stableData.tag).toBe('v0.18.3-env1')
    expect(latestData.tag).toBe('v0.18.3-env1')
  })

  it('Stable entry threads the upstream stable tag through data.latestStableTag', async () => {
    // The variant card reads `data.latestStableTag` to show the version
    // the user lands on after post-install update — that survived the
    // IPP-label cleanup so issue #708 stays fixed.
    setupMockReleases()
    mockedGetLatestStableTag.mockResolvedValue('v1.19.5')
    const options = await standalone.getFieldOptions!('release', {}, { includeLatestStable: true })
    const stableData = options.find((o) => o.value === 'stable')!.data as Record<string, unknown>
    expect(stableData.latestStableTag).toBe('v1.19.5')
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
      name: 'ComfyUI',
      createdAt: new Date().toISOString(),
      sourceId: 'standalone',
      installPath,
      adopted: true,
      adoptedBaseDir,
      adoptedPythonPath,
      // Adopted records ship with shared models on (legacy `models/` is
      // registered in the global modelsDirs list) and shared input/output
      // off — the workspace is pinned to legacy basePath via the
      // per-install inputDir/outputDir fields, which launch.ts handles.
      useSharedModels: true,
      useSharedInputOutput: false,
      inputDir: path.join(adoptedBaseDir, 'input'),
      outputDir: path.join(adoptedBaseDir, 'output'),
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

  it('injects only --base-directory / --user-directory rooted at adoptedBaseDir', () => {
    // --input-directory / --output-directory are NOT injected here anymore;
    // they're first-class per-install fields handled by launch.ts'
    // shared-input-output branch.
    const cmd = standalone.getLaunchCommand!(makeAdoptedRecord())!
    const args = cmd.args!
    const idx = (flag: string) => args.indexOf(flag)
    expect(args[idx('--base-directory') + 1]).toBe(adoptedBaseDir)
    expect(args[idx('--user-directory') + 1]).toBe(path.join(adoptedBaseDir, 'user'))
    expect(args.includes('--input-directory')).toBe(false)
    expect(args.includes('--output-directory')).toBe(false)
  })

  it('pins --database-url at the legacy user dir so SQLite can open it', () => {
    // ComfyUI's default --database-url resolves to <source>/../user/comfyui.db,
    // which for an adopted install lives in the empty new install dir — the
    // parent `user/` doesn't exist there, so SQLite raised "unable to open
    // database file" on launch. Anchor the URL at the legacy user folder.
    const cmd = standalone.getLaunchCommand!(makeAdoptedRecord())!
    const args = cmd.args!
    const idx = args.indexOf('--database-url')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe(
      `sqlite:///${path.join(adoptedBaseDir, 'user', 'comfyui.db')}`
    )
  })

  it('does not override a user-supplied --database-url', () => {
    const userUrl = 'sqlite:///D:/custom/path/my.db'
    const cmd = standalone.getLaunchCommand!(
      makeAdoptedRecord({ launchArgs: `--port 8188 --database-url ${userUrl}` })
    )!
    const args = cmd.args!
    // Only one --database-url, and it's the user's value.
    const positions = args
      .map((value, index) => (value === '--database-url' ? index : -1))
      .filter((index) => index >= 0)
    expect(positions.length).toBe(1)
    expect(args[positions[0]! + 1]).toBe(userUrl)
  })

  it('does not override a user-supplied --database-url=VALUE form', () => {
    const cmd = standalone.getLaunchCommand!(
      makeAdoptedRecord({ launchArgs: '--port 8188 --database-url=sqlite:///:memory:' })
    )!
    const args = cmd.args!
    // Adopt branch must not inject its own --database-url alongside the
    // `=`-style override.
    expect(args.includes('--database-url')).toBe(false)
    expect(args.some((a) => a === '--database-url=sqlite:///:memory:')).toBe(true)
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

// --- getFieldOptions('variant') — version-display consistency (issue #708) ---

describe('standalone.getFieldOptions variant version display', () => {
  // The newest R2 standalone bundle ships an OLDER ComfyUI (0.20.1) than the
  // upstream stable tag the wizard auto-updates to (v0.22.3). Set up that gap.
  function setupVersionGap() {
    const { latest, vendorReleases, vendorId } = makeR2Releases(
      ['v0.20.1-env1'],
      { comfyuiVersion: '0.20.1' },
    )
    mockedFetchJSON.mockImplementation((url: string) => {
      if (url.includes('latest.json')) return Promise.resolve(latest)
      return Promise.resolve(vendorReleases[vendorId]!)
    })
    return { vendorId }
  }

  async function getReleaseOption(value: string) {
    const releaseOptions = await standalone.getFieldOptions!(
      'release',
      {},
      { includeLatestStable: true },
    )
    return releaseOptions.find((o) => o.value === value)!
  }

  it('variant card shows the upstream stable version (not the bundled one) when "Stable" is selected', async () => {
    const { vendorId } = setupVersionGap()
    mockedGetLatestStableTag.mockResolvedValue('v0.22.3')
    const release = await getReleaseOption('stable')

    const variants = await standalone.getFieldOptions!('variant', { release }, {})
    const card = variants.find((o) => o.value === vendorId)!
    // The card and the dropdown must agree: both surface 0.22.3.
    expect(card.description).toContain('ComfyUI 0.22.3')
    expect(card.description).not.toContain('ComfyUI 0.20.1')
  })

  it('variant card falls back to the bundled version when the upstream tag is unresolved', async () => {
    const { vendorId } = setupVersionGap()
    mockedGetLatestStableTag.mockResolvedValue(null)
    const release = await getReleaseOption('stable')

    const variants = await standalone.getFieldOptions!('variant', { release }, {})
    const card = variants.find((o) => o.value === vendorId)!
    expect(card.description).toContain('ComfyUI 0.20.1')
  })

  it('variant card shows the bundled version when "Latest on GitHub" is selected', async () => {
    const { vendorId } = setupVersionGap()
    mockedGetLatestStableTag.mockResolvedValue('v0.22.3')
    const release = await getReleaseOption('latest')

    const variants = await standalone.getFieldOptions!('variant', { release }, {})
    const card = variants.find((o) => o.value === vendorId)!
    // Latest-on-GitHub leaves the install on whatever the bundle
    // shipped with (master-ish HEAD); the card advertises that, not
    // the stable tag the OTHER channel would land on.
    expect(card.description).toContain('ComfyUI 0.20.1')
  })
})
