import os from 'os'
import path from 'path'
import fs from 'fs'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import type * as pathsModule from './paths'
import type * as pipModule from './pip'
import type * as gitModule from './git'

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'home' ? os.tmpdir() : os.tmpdir()) }
}))

vi.mock('./paths', async (importOriginal) => {
  const actual = await importOriginal<typeof pathsModule>()
  return {
    ...actual,
    defaultInstallDir: () => path.join(os.tmpdir(), 'desktopAdopt-installs')
  }
})

vi.mock('../settings', () => {
  const store: Record<string, unknown> = {}
  return {
    defaults: { modelsDirs: ['/shared/models'] },
    get: vi.fn((key: string) => store[key]),
    set: vi.fn((key: string, value: unknown) => {
      if (value === undefined) delete store[key]
      else store[key] = value
    }),
    // Mirrors the real "explicitly persisted" semantics: defaults aren't user choices.
    has: vi.fn((key: string) => store[key] !== undefined && store[key] !== null),
    getAll: vi.fn(() => ({ ...store })),
    getMirrorConfig: vi.fn(() => ({ pypiMirror: undefined, useChineseMirrors: false })),
    __store: store
  }
})

// Stub the latest-stable-tag lookup + git checkout so adoption tests
// don't need network access or a real ComfyUI git tree.
const {
  getLatestStableTagMock,
  gitCheckoutCommitMock,
  readGitHeadMock,
  fetchTagsMock,
  isGitAvailableMock,
  isPygit2ConfiguredMock,
  tryConfigurePygit2FallbackMock,
  resolveLocalVersionMock
} = vi.hoisted(() => ({
  getLatestStableTagMock: vi.fn<() => Promise<string | null>>(),
  gitCheckoutCommitMock:
    vi.fn<(...args: unknown[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>>(),
  readGitHeadMock: vi.fn<(repoPath: string) => string | null>(),
  fetchTagsMock: vi.fn<(repoPath: string) => Promise<boolean>>(),
  isGitAvailableMock: vi.fn<() => Promise<boolean>>(),
  isPygit2ConfiguredMock: vi.fn<() => boolean>(),
  tryConfigurePygit2FallbackMock: vi.fn<(installPath: string) => Promise<boolean>>(),
  resolveLocalVersionMock:
    vi.fn<
      (
        comfyuiDir: string,
        commit: string,
        fallbackTag?: string
      ) => Promise<{ commit: string; baseTag?: string; commitsAhead?: number } | undefined>
    >()
}))

vi.mock('./comfyui-releases', () => ({
  getLatestStableTag: getLatestStableTagMock
}))

vi.mock('./git', async () => {
  const actual = await vi.importActual<typeof gitModule>('./git')
  return {
    ...actual,
    gitCheckoutCommit: gitCheckoutCommitMock,
    readGitHead: readGitHeadMock,
    fetchTags: fetchTagsMock,
    isGitAvailable: isGitAvailableMock,
    isPygit2Configured: isPygit2ConfiguredMock,
    tryConfigurePygit2Fallback: tryConfigurePygit2FallbackMock
  }
})

vi.mock('./version-resolve', () => ({
  resolveLocalVersion: resolveLocalVersionMock
}))

// Stub the pip helpers so adoption tests don't need a real uv binary on disk.
const { installFilteredRequirementsMock, runUvPipMock } = vi.hoisted(() => ({
  installFilteredRequirementsMock: vi.fn<(...args: unknown[]) => Promise<number>>(),
  runUvPipMock: vi.fn<(...args: unknown[]) => Promise<number>>()
}))

vi.mock('./pip', async (importOriginal) => {
  const actual = await importOriginal<typeof pipModule>()
  return {
    ...actual,
    installFilteredRequirements: installFilteredRequirementsMock,
    runUvPip: runUvPipMock
  }
})

vi.mock('../installations', () => {
  const records: Record<string, unknown>[] = []
  let nextSeq = 0
  return {
    add: vi.fn(async (data: Record<string, unknown>) => {
      const entry = { id: `inst-test-${++nextSeq}`, createdAt: new Date().toISOString(), ...data }
      records.unshift(entry)
      return entry
    }),
    list: vi.fn(async () => records.slice()),
    get: vi.fn(async (id: string) => records.find((r) => r.id === id) ?? null),
    update: vi.fn(),
    remove: vi.fn(async (id: string) => {
      const idx = records.findIndex((r) => r.id === id)
      if (idx >= 0) records.splice(idx, 1)
    }),
    __records: records,
    __reset: () => {
      records.length = 0
      nextSeq = 0
    }
  }
})

vi.mock('./telemetry', () => ({
  capture: vi.fn(),
  bucketError: vi.fn(() => 'other'),
  trackedStep: vi.fn(async (_step: string, _ctx: unknown, fn: () => Promise<unknown>) => fn())
}))

vi.mock('./github-mirror', () => ({
  getComfyUIRemoteUrl: vi.fn(() => 'https://github.com/Comfy-Org/ComfyUI.git')
}))

import {
  adoptDesktopInstall,
  parseExtraModelsYaml,
  deriveLaunchArgs,
  computeModelsDirsToCarry,
  getLegacyVenvUvPath,
  type AdoptTools,
  type AdoptDeps,
  type UserChoice
} from './desktopAdopt'

import type { DesktopInstallInfo } from './desktopDetect'
import * as settings from '../settings'
import * as installations from '../installations'
import * as telemetry from './telemetry'

// Test-only helpers exposed by the mock factories above.
interface SettingsMock {
  __store: Record<string, unknown>
  set: ReturnType<typeof vi.fn>
  get: ReturnType<typeof vi.fn>
  getAll: ReturnType<typeof vi.fn>
}
interface InstallationsMock {
  __records: Record<string, unknown>[]
  __reset: () => void
  add: ReturnType<typeof vi.fn>
  list: ReturnType<typeof vi.fn>
}
const settingsMock = settings as unknown as SettingsMock
const installationsMock = installations as unknown as InstallationsMock

function mkdtemp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function buildSilentTools(promptUser?: AdoptTools['promptUser']): AdoptTools {
  return {
    sendProgress: vi.fn(),
    sendOutput: vi.fn(),
    signal: new AbortController().signal,
    promptUser:
      promptUser ??
      vi.fn(async () => {
        throw new Error('promptUser unexpectedly called')
      })
  }
}

function writeFakeStagedSource(stagingDir: string, version: string): void {
  fs.mkdirSync(stagingDir, { recursive: true })
  fs.writeFileSync(path.join(stagingDir, 'main.py'), '# placeholder')
  fs.writeFileSync(path.join(stagingDir, 'comfyui_version.py'), `__version__ = "${version}"\n`)
}

interface FakeLegacy {
  basePath: string
  configDir: string
  info: DesktopInstallInfo
  cleanup: () => void
}

function buildFakeLegacy(
  opts: {
    configFiles?: Record<string, string>
    baseFiles?: Record<string, string>
    hasVenv?: boolean
  } = {}
): FakeLegacy {
  const root = mkdtemp('adopt-test-')
  const basePath = path.join(root, 'data')
  const configDir = path.join(root, 'userData')
  fs.mkdirSync(basePath, { recursive: true })
  fs.mkdirSync(configDir, { recursive: true })
  fs.mkdirSync(path.join(basePath, 'models'), { recursive: true })
  fs.mkdirSync(path.join(basePath, 'user'), { recursive: true })
  if (opts.hasVenv !== false) {
    const venvBin =
      process.platform === 'win32'
        ? path.join(basePath, '.venv', 'Scripts')
        : path.join(basePath, '.venv', 'bin')
    fs.mkdirSync(venvBin, { recursive: true })
    const pyName = process.platform === 'win32' ? 'python.exe' : 'python3'
    fs.writeFileSync(path.join(venvBin, pyName), '')
  }
  for (const [name, content] of Object.entries(opts.configFiles ?? {})) {
    fs.writeFileSync(path.join(configDir, name), content)
  }
  for (const [name, content] of Object.entries(opts.baseFiles ?? {})) {
    const target = path.join(basePath, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  const info: DesktopInstallInfo = {
    configDir,
    basePath,
    executablePath: null,
    hasVenv: opts.hasVenv !== false
  }
  return {
    basePath,
    configDir,
    info,
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true })
      } catch {}
    }
  }
}

function buildDeps(overrides: Partial<AdoptDeps>, info: DesktopInstallInfo): Partial<AdoptDeps> {
  return {
    detectDesktopInstall: () => info,
    validateLegacyVenv: async () => ({ ok: true }),
    copyStagedSource: async (src, dest) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.cpSync(src, dest, { recursive: true })
    },
    cloneSourceFromGit: async (_url, dest) => {
      fs.mkdirSync(dest, { recursive: true })
      fs.writeFileSync(path.join(dest, 'main.py'), '# cloned placeholder')
      return { ok: true }
    },
    captureDesktopSnapshot: vi.fn(async () => ({
      version: 1 as const,
      createdAt: new Date().toISOString(),
      trigger: 'manual' as const,
      label: 'Legacy Desktop adopt',
      comfyui: { ref: 'Legacy Desktop', commit: null, releaseTag: '', variant: '' },
      customNodes: [],
      pipPackages: {},
      skipPipSync: true
    })),
    now: () => new Date('2026-05-19T12:00:00.000Z'),
    ...overrides
  }
}

beforeEach(() => {
  installationsMock.__reset()
  for (const key of Object.keys(settingsMock.__store)) delete settingsMock.__store[key]
  vi.clearAllMocks()
  installFilteredRequirementsMock.mockResolvedValue(0)
  runUvPipMock.mockResolvedValue(0)
  // Default "no tag available" makes the one-shot update a no-op for unrelated tests.
  getLatestStableTagMock.mockResolvedValue(null)
  gitCheckoutCommitMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
  // Default git helpers to "git is available, no HEAD, no resolved
  // version" so the comfyVersion-resolution branch is a no-op for
  // tests that don't opt in. Specific tests override these as needed.
  readGitHeadMock.mockReturnValue(null)
  fetchTagsMock.mockResolvedValue(true)
  isGitAvailableMock.mockResolvedValue(true)
  isPygit2ConfiguredMock.mockReturnValue(true)
  tryConfigurePygit2FallbackMock.mockResolvedValue(true)
  resolveLocalVersionMock.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('parseExtraModelsYaml', () => {
  it('extracts base_path values across multiple sections', () => {
    const yaml =
      `# header\n` +
      `comfyui_desktop:\n` +
      `  base_path: /data/ComfyUI\n` +
      `  is_default: true\n` +
      `a1111:\n` +
      `  base_path: "/extra/A1111"\n` +
      `  other_key: value\n`
    expect(parseExtraModelsYaml(yaml)).toEqual(['/data/ComfyUI', '/extra/A1111'])
  })

  it('strips inline comments and surrounding quotes', () => {
    const yaml = `s1:\n  base_path: '/with spaces/dir' # comment\n`
    expect(parseExtraModelsYaml(yaml)).toEqual(['/with spaces/dir'])
  })

  it('ignores per-folder overrides (only matches base_path)', () => {
    const yaml = `s1:\n  base_path: /a\n  checkpoints: /override/cp\n`
    expect(parseExtraModelsYaml(yaml)).toEqual(['/a'])
  })

  it('returns [] for empty or malformed input', () => {
    expect(parseExtraModelsYaml('')).toEqual([])
    expect(parseExtraModelsYaml('garbage::::')).toEqual([])
  })
})

describe('deriveLaunchArgs', () => {
  it('synthesizes --port 8000 + --enable-manager when LaunchArgs is empty', () => {
    const { launchArgs, pathOverrides } = deriveLaunchArgs({})
    expect(launchArgs).toBe('--port 8000 --enable-manager')
    expect(pathOverrides).toEqual({})
  })

  it('reads Comfy.Server.LaunchArgs (not server_config.*)', () => {
    const { launchArgs } = deriveLaunchArgs({
      'Comfy.Server.LaunchArgs': { listen: '0.0.0.0', port: '7860', lowvram: '' },
      // server_config.* are never read by adoption; included to confirm the parser ignores them.
      'server_config.listen': '1.2.3.4',
      'server_config.port': 1234
    })
    expect(launchArgs).toContain('--listen 0.0.0.0')
    expect(launchArgs).toContain('--port 7860')
    expect(launchArgs).toContain('--lowvram')
    expect(launchArgs).not.toContain('1.2.3.4')
    expect(launchArgs).not.toContain('1234')
  })

  it('does NOT synthesize --listen (legacy implicit matches ComfyUI native)', () => {
    const { launchArgs } = deriveLaunchArgs({ 'Comfy.Server.LaunchArgs': {} })
    expect(launchArgs).not.toContain('--listen')
  })

  it('preserves user-set --listen verbatim', () => {
    const { launchArgs } = deriveLaunchArgs({
      'Comfy.Server.LaunchArgs': { listen: '0.0.0.0' }
    })
    expect(launchArgs).toContain('--listen 0.0.0.0')
  })

  it('keeps --enable-manager always (idempotent if already present)', () => {
    const { launchArgs } = deriveLaunchArgs({
      'Comfy.Server.LaunchArgs': { 'enable-manager': '' }
    })
    expect((launchArgs.match(/--enable-manager/g) ?? []).length).toBe(1)
  })

  it('promotes input-directory / output-directory into pathOverrides', () => {
    const { launchArgs, pathOverrides } = deriveLaunchArgs({
      'Comfy.Server.LaunchArgs': {
        'input-directory': 'D:\\my-input',
        'output-directory': 'D:\\my-output'
      }
    })
    expect(pathOverrides).toEqual({ inputDir: 'D:\\my-input', outputDir: 'D:\\my-output' })
    expect(launchArgs).not.toContain('--input-directory')
    expect(launchArgs).not.toContain('--output-directory')
  })

  it('keeps user-set --base-directory and --user-directory in the string', () => {
    const { launchArgs } = deriveLaunchArgs({
      'Comfy.Server.LaunchArgs': {
        'base-directory': 'D:\\my-comfy',
        'user-directory': 'D:\\my-comfy\\user'
      }
    })
    expect(launchArgs).toContain('--base-directory D:\\my-comfy')
    expect(launchArgs).toContain('--user-directory D:\\my-comfy\\user')
  })

  it('drops v2 plumbing keys (extra-model-paths-config, front-end-root, log-stdout, database-url)', () => {
    const { launchArgs } = deriveLaunchArgs({
      'Comfy.Server.LaunchArgs': {
        'extra-model-paths-config': 'C:\\legacy.yaml',
        'front-end-root': 'C:\\legacy-fe',
        'log-stdout': '',
        'database-url': 'sqlite:///legacy.db',
        // preserved control: real CLI flag stays
        cpu: ''
      }
    })
    expect(launchArgs).not.toContain('--extra-model-paths-config')
    expect(launchArgs).not.toContain('--front-end-root')
    expect(launchArgs).not.toContain('--log-stdout')
    expect(launchArgs).not.toContain('--database-url')
    expect(launchArgs).toContain('--cpu')
  })

  it('user-set --port wins over the synthesized 8000', () => {
    const { launchArgs } = deriveLaunchArgs({
      'Comfy.Server.LaunchArgs': { port: '9999' }
    })
    expect(launchArgs).toContain('--port 9999')
    expect(launchArgs).not.toContain('--port 8000')
  })
})

describe('computeModelsDirsToCarry', () => {
  it('adds basePath/models plus extra YAML mounts and dedupes against existing', () => {
    const basePath = '/data/ComfyUI'
    const yaml = `c1:\n  base_path: /data/ComfyUI\nc2:\n  base_path: /extra/A1111\n`
    const existing = [path.resolve('/data/ComfyUI')]
    const result = computeModelsDirsToCarry(basePath, yaml, existing)
    expect(result).toContain(path.resolve('/data/ComfyUI/models'))
    expect(result).toContain(path.resolve('/extra/A1111'))
    expect(result).not.toContain(path.resolve('/data/ComfyUI'))
  })
})

describe('adoptDesktopInstall', () => {
  it('throws no-legacy-install when detection returns null', async () => {
    const tools = buildSilentTools()
    await expect(
      adoptDesktopInstall({
        tools,
        deps: { detectDesktopInstall: () => null }
      })
    ).rejects.toThrow('no-legacy-install')
    expect(telemetry.capture).toHaveBeenCalledWith(
      'comfy.desktop.adopt.failed',
      expect.objectContaining({
        error_bucket: 'no-legacy-install'
      })
    )
  })

  it('prefers pre-swap-copy when staged source is valid', async () => {
    const legacy = buildFakeLegacy({
      configFiles: {
        'comfy.settings.json': JSON.stringify({
          'Comfy.Server.LaunchArgs': { listen: '0.0.0.0', port: '8188' }
        })
      }
    })
    try {
      writeFakeStagedSource(path.join(legacy.configDir, 'legacy-staging', 'comfyui'), '0.3.45')
      const copyFn = vi.fn(async (src: string, dest: string) => {
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.cpSync(src, dest, { recursive: true })
      })
      const cloneFn = vi.fn(async () => ({ ok: true as const }))
      const tools = buildSilentTools()
      const record = await adoptDesktopInstall({
        tools,
        deps: buildDeps({ copyStagedSource: copyFn, cloneSourceFromGit: cloneFn }, legacy.info)
      })
      expect(copyFn).toHaveBeenCalledOnce()
      expect(cloneFn).not.toHaveBeenCalled()
      expect(record.adoptedSourceMode).toBe('pre-swap-copy')
      expect(record.launchArgs).toContain('--listen 0.0.0.0')
      expect(record.launchArgs).toContain('--port 8188')
      expect(record.launchArgs).toContain('--enable-manager')
      // Marker written
      const marker = fs.readFileSync(path.join(legacy.basePath, '.comfyui-desktop-2'), 'utf-8')
      expect(marker).toBe(record.id)
    } finally {
      legacy.cleanup()
    }
  })

  it('falls back to git clone when staged source is missing', async () => {
    const legacy = buildFakeLegacy({
      configFiles: { 'comfy.settings.json': '{}' }
    })
    try {
      const cloneFn = vi.fn(async (_url: string, dest: string) => {
        fs.mkdirSync(dest, { recursive: true })
        fs.writeFileSync(path.join(dest, 'main.py'), '# clone')
        fs.writeFileSync(path.join(dest, 'comfyui_version.py'), '__version__ = "0.9.9"\n')
        return { ok: true as const }
      })
      const tools = buildSilentTools()
      const record = await adoptDesktopInstall({
        tools,
        deps: buildDeps({ cloneSourceFromGit: cloneFn }, legacy.info)
      })
      expect(cloneFn).toHaveBeenCalledOnce()
      expect(record.adoptedSourceMode).toBe('git-clone-fallback')
      expect(record.version).toBe('0.9.9')
    } finally {
      legacy.cleanup()
    }
  })

  it('merges modelsDirs from extra_models_config.yaml and basePath/models', async () => {
    const yaml = `comfyui_desktop:\n  base_path: /shared/A\n  is_default: true\nA1111:\n  base_path: /shared/B\n`
    const legacy = buildFakeLegacy({
      configFiles: {
        'comfy.settings.json': '{}',
        'extra_models_config.yaml': yaml
      }
    })
    try {
      const tools = buildSilentTools()
      await adoptDesktopInstall({
        tools,
        deps: buildDeps({}, legacy.info)
      })
      const finalDirs = settingsMock.__store['modelsDirs'] as string[] | undefined
      expect(finalDirs).toBeDefined()
      expect(finalDirs).toEqual(
        expect.arrayContaining([
          path.resolve(path.join(legacy.basePath, 'models')),
          path.resolve('/shared/A'),
          path.resolve('/shared/B')
        ])
      )
    } finally {
      legacy.cleanup()
    }
  })

  it('continues adoption when validateLegacyVenv fails and user picks use-anyway', async () => {
    const legacy = buildFakeLegacy({ configFiles: { 'comfy.settings.json': '{}' } })
    try {
      const prompt = vi.fn(
        async (_kind, _ctx): Promise<UserChoice> => ({ kind: 'venv-broken', choice: 'use-anyway' })
      )
      const tools = buildSilentTools(prompt)
      const validate = vi.fn(async () => ({ ok: false as const, message: 'no torch' }))
      const record = await adoptDesktopInstall({
        tools,
        deps: buildDeps({ validateLegacyVenv: validate }, legacy.info)
      })
      expect(validate).toHaveBeenCalledOnce()
      expect(prompt).toHaveBeenCalledWith(
        'venv-broken',
        expect.objectContaining({ message: 'no torch' })
      )
      expect(record.id).toMatch(/^inst-test-/)
    } finally {
      legacy.cleanup()
    }
  })

  it('aborts adoption when validateLegacyVenv fails and user cancels', async () => {
    const legacy = buildFakeLegacy({ configFiles: { 'comfy.settings.json': '{}' } })
    try {
      const prompt = vi.fn(
        async (): Promise<UserChoice> => ({ kind: 'venv-broken', choice: 'cancel' })
      )
      const tools = buildSilentTools(prompt)
      const validate = vi.fn(async () => ({ ok: false as const, message: 'no torch' }))
      await expect(
        adoptDesktopInstall({
          tools,
          deps: buildDeps({ validateLegacyVenv: validate }, legacy.info)
        })
      ).rejects.toThrow(/venv-broken-cancelled/)
      // No installation created
      expect(installationsMock.__records).toHaveLength(0)
    } finally {
      legacy.cleanup()
    }
  })

  it('writes the marker and registers an installation with the expected shape', async () => {
    const legacy = buildFakeLegacy({
      configFiles: {
        'comfy.settings.json': JSON.stringify({
          'Comfy.Server.LaunchArgs': {
            port: '8188',
            'use-pytorch-cross-attention': ''
          },
          'Comfy-Desktop.SendStatistics': false
        })
      }
    })
    try {
      const tools = buildSilentTools()
      const record = await adoptDesktopInstall({
        tools,
        deps: buildDeps({}, legacy.info)
      })
      expect(record).toMatchObject({
        sourceId: 'standalone',
        adopted: true,
        adoptedBaseDir: legacy.basePath,
        adoptedSourceMode: 'git-clone-fallback',
        releaseTag: 'legacy-adopted',
        variant: 'legacy-uv-py312',
        pythonVersion: '3.12',
        launchMode: 'window',
        browserPartition: 'unique',
        portConflict: 'auto',
        autoUpdateComfyUI: false,
        // New shared-paths schema — `useSharedPaths` is gone.
        useSharedModels: true,
        useSharedInputOutput: false,
        inputDir: path.join(legacy.basePath, 'input'),
        outputDir: path.join(legacy.basePath, 'output'),
        copiedFrom: 'legacy-desktop',
        copyReason: 'in-place-adoption',
        status: 'installed'
      })
      expect(record).not.toHaveProperty('useSharedPaths')
      expect(record.launchArgs as string).toContain('--port 8188')
      expect(record.launchArgs as string).toContain('--use-pytorch-cross-attention')
      // Marker stamped with the freshly minted install id
      const marker = fs.readFileSync(path.join(legacy.basePath, '.comfyui-desktop-2'), 'utf-8')
      expect(marker).toBe(record.id)
      // Telemetry succeeded
      expect(telemetry.capture).toHaveBeenCalledWith(
        'comfy.desktop.adopt.succeeded',
        expect.objectContaining({
          adopted_source_mode: 'git-clone-fallback',
          carried_keys: expect.arrayContaining(['telemetryEnabled', 'firstUseCompleted'])
        })
      )
      // Telemetry consent carried from legacy SendStatistics
      expect(settingsMock.__store['telemetryEnabled']).toBe(false)
      // First-use takeover skipped for adopted users.
      expect(settingsMock.__store['firstUseCompleted']).toBe(true)
      // Global shared dirs seeded to legacy workspace (v2 had nothing set).
      expect(settingsMock.__store['inputDir']).toBe(path.join(legacy.basePath, 'input'))
      expect(settingsMock.__store['outputDir']).toBe(path.join(legacy.basePath, 'output'))
    } finally {
      legacy.cleanup()
    }
  })

  it('removes the auto-tracked legacy desktop card after successful adoption', async () => {
    const legacy = buildFakeLegacy()
    try {
      // Pre-seed the auto-tracked legacy card; adoption must drop it (one card per workspace).
      await installations.add({
        name: 'ComfyUI Legacy Desktop',
        sourceId: 'desktop',
        installPath: legacy.info.basePath,
        launchMode: 'external',
        status: 'installed'
      })
      // Unrelated desktop-source records at other paths must NOT be touched.
      const unrelated = await installations.add({
        name: 'Other Legacy',
        sourceId: 'desktop',
        installPath: path.join(legacy.info.basePath, '..', 'elsewhere'),
        launchMode: 'external',
        status: 'installed'
      })

      const tools = buildSilentTools()
      const record = await adoptDesktopInstall({
        tools,
        deps: buildDeps({}, legacy.info)
      })

      const after = await installations.list()
      // Adopted standalone present, legacy card at this basePath gone,
      // unrelated desktop record preserved.
      expect(after.find((r) => r.id === record.id)).toBeTruthy()
      expect(
        after.some((r) => r.sourceId === 'desktop' && r.installPath === legacy.info.basePath)
      ).toBe(false)
      expect(after.find((r) => r.id === unrelated.id)).toBeTruthy()
    } finally {
      legacy.cleanup()
    }
  })

  it('promotes legacy input-directory / output-directory into per-install fields', async () => {
    const legacy = buildFakeLegacy({
      configFiles: {
        'comfy.settings.json': JSON.stringify({
          'Comfy.Server.LaunchArgs': {
            'input-directory': 'D:\\custom-input',
            'output-directory': 'D:\\custom-output'
          }
        })
      }
    })
    try {
      const tools = buildSilentTools()
      const record = await adoptDesktopInstall({ tools, deps: buildDeps({}, legacy.info) })
      expect(record.inputDir).toBe('D:\\custom-input')
      expect(record.outputDir).toBe('D:\\custom-output')
      // Promoted out of the editable string.
      expect(record.launchArgs as string).not.toContain('--input-directory')
      expect(record.launchArgs as string).not.toContain('--output-directory')
      // Telemetry notes which dirs were overridden.
      expect(telemetry.capture).toHaveBeenCalledWith(
        'comfy.desktop.adopt.succeeded',
        expect.objectContaining({
          adopted_path_override_input: true,
          adopted_path_override_output: true
        })
      )
    } finally {
      legacy.cleanup()
    }
  })

  it('force-enables autoInstallUpdates regardless of legacy value, carries pypiMirror and infers Chinese mirror flags', async () => {
    const legacy = buildFakeLegacy({
      configFiles: {
        'comfy.settings.json': JSON.stringify({
          'Comfy.ColorPalette': 'dark',
          // Legacy Desktop auto-update OFF must NOT carry, else they'd miss future updates.
          'Comfy-Desktop.AutoUpdate': false,
          'Comfy-Desktop.UV.PypiInstallMirror': 'https://mirrors.aliyun.com/pypi/simple/',
          'Comfy-Desktop.UV.TorchInstallMirror': 'https://download.pytorch.org/whl/cu121'
        })
      }
    })
    try {
      const tools = buildSilentTools()
      const record = await adoptDesktopInstall({ tools, deps: buildDeps({}, legacy.info) })
      // ColorPalette is a frontend setting, not v2's launcher `theme` — never carried.
      expect(settingsMock.__store).not.toHaveProperty('theme')
      // Force-on at adoption regardless of legacy value.
      expect(settingsMock.__store['autoInstallUpdates']).toBe(true)
      expect(settingsMock.__store['pypiMirror']).toBe('https://mirrors.aliyun.com/pypi/simple/')
      expect(settingsMock.__store['useChineseMirrors']).toBe(true)
      expect(settingsMock.__store['chineseMirrorsPrompted']).toBe(true)
      // TorchInstallMirror has no v2 consumer, never stashed on the record.
      expect(record).not.toHaveProperty('adoptedTorchMirror')
    } finally {
      legacy.cleanup()
    }
  })

  it('respects a pre-existing v2 autoInstallUpdates choice on reconcile', async () => {
    // A reconcile pass must not silently flip a user's explicit v2 choice back on.
    settingsMock.__store['autoInstallUpdates'] = false
    const legacy = buildFakeLegacy({
      configFiles: {
        'comfy.settings.json': JSON.stringify({
          'Comfy-Desktop.AutoUpdate': true
        })
      }
    })
    try {
      const tools = buildSilentTools()
      await adoptDesktopInstall({ tools, deps: buildDeps({}, legacy.info) })
      expect(settingsMock.__store['autoInstallUpdates']).toBe(false)
    } finally {
      legacy.cleanup()
    }
  })

  it('respects pre-existing v2 settings under the "v2 user choice wins" rule', async () => {
    // Adoption must NOT overwrite a pre-configured v2 choice.
    settingsMock.__store['pypiMirror'] = 'https://pypi.org/simple/'
    settingsMock.__store['inputDir'] = '/v2/chosen/input'
    const legacy = buildFakeLegacy({
      configFiles: {
        'comfy.settings.json': JSON.stringify({
          'Comfy-Desktop.UV.PypiInstallMirror': 'https://mirrors.aliyun.com/pypi/simple/'
        })
      }
    })
    try {
      const tools = buildSilentTools()
      await adoptDesktopInstall({ tools, deps: buildDeps({}, legacy.info) })
      expect(settingsMock.__store['pypiMirror']).toBe('https://pypi.org/simple/')
      expect(settingsMock.__store['inputDir']).toBe('/v2/chosen/input')
      // outputDir was NOT pre-set → it should still get carried.
      expect(settingsMock.__store['outputDir']).toBe(path.join(legacy.basePath, 'output'))
      expect(telemetry.capture).toHaveBeenCalledWith(
        'comfy.desktop.adopt.succeeded',
        expect.objectContaining({
          carry_skipped_keys: expect.arrayContaining(['pypiMirror', 'inputDir'])
        })
      )
    } finally {
      legacy.cleanup()
    }
  })

  it('runs a one-shot ComfyUI checkout to the latest stable tag', async () => {
    getLatestStableTagMock.mockResolvedValue('v0.99.99')
    const legacy = buildFakeLegacy({ configFiles: { 'comfy.settings.json': '{}' } })
    try {
      const tools = buildSilentTools()
      const cloneFn = vi.fn(async (_url: string, dest: string) => {
        fs.mkdirSync(dest, { recursive: true })
        // Make destSource look like a real git checkout so the update
        // step's `.git` precondition fires.
        fs.mkdirSync(path.join(dest, '.git'), { recursive: true })
        fs.writeFileSync(path.join(dest, 'main.py'), '# clone')
        return { ok: true as const }
      })
      const record = await adoptDesktopInstall({
        tools,
        deps: buildDeps({ cloneSourceFromGit: cloneFn }, legacy.info)
      })
      expect(getLatestStableTagMock).toHaveBeenCalledOnce()
      expect(gitCheckoutCommitMock).toHaveBeenCalledWith(
        expect.stringContaining('ComfyUI'),
        'v0.99.99',
        expect.any(Function),
        expect.any(Object)
      )
      expect(record.adoptedComfyTagAtMigration).toBe('v0.99.99')
      // autoUpdateComfyUI stays false — one-shot, not ongoing.
      expect(record.autoUpdateComfyUI).toBe(false)
      expect(telemetry.capture).toHaveBeenCalledWith(
        'comfy.desktop.adopt.succeeded',
        expect.objectContaining({
          adopted_comfy_tag_at_migration: 'v0.99.99'
        })
      )
    } finally {
      legacy.cleanup()
    }
  })

  it('one-shot ComfyUI update is non-fatal when checkout fails', async () => {
    getLatestStableTagMock.mockResolvedValue('v0.99.99')
    gitCheckoutCommitMock.mockResolvedValue({ exitCode: 128, stdout: '', stderr: 'boom' })
    const legacy = buildFakeLegacy({ configFiles: { 'comfy.settings.json': '{}' } })
    try {
      const cloneFn = vi.fn(async (_url: string, dest: string) => {
        fs.mkdirSync(dest, { recursive: true })
        fs.mkdirSync(path.join(dest, '.git'), { recursive: true })
        fs.writeFileSync(path.join(dest, 'main.py'), '# clone')
        return { ok: true as const }
      })
      const tools = buildSilentTools()
      const record = await adoptDesktopInstall({
        tools,
        deps: buildDeps({ cloneSourceFromGit: cloneFn }, legacy.info)
      })
      // Adoption still succeeded; tag-at-migration is omitted because
      // the checkout didn't actually land.
      expect(record).not.toHaveProperty('adoptedComfyTagAtMigration')
      expect(telemetry.capture).toHaveBeenCalledWith(
        'comfy.desktop.adopt.succeeded',
        expect.objectContaining({
          adopted_comfy_tag_at_migration: null
        })
      )
    } finally {
      legacy.cleanup()
    }
  })

  it('populates comfyVersion from the freshly checked-out source so update checks see the real git tag', async () => {
    // Without comfyVersion, the release-cache falls back to comparing
    // installation.version ("0.24.0", bare) against latestTag ("v0.24.0",
    // "v"-prefixed) and reports a false "update available" forever.
    readGitHeadMock.mockReturnValue('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
    resolveLocalVersionMock.mockResolvedValue({
      commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      baseTag: 'v0.24.0',
      commitsAhead: 0
    })
    getLatestStableTagMock.mockResolvedValue('v0.24.0')
    const legacy = buildFakeLegacy({ configFiles: { 'comfy.settings.json': '{}' } })
    try {
      const cloneFn = vi.fn(async (_url: string, dest: string) => {
        fs.mkdirSync(dest, { recursive: true })
        fs.mkdirSync(path.join(dest, '.git'), { recursive: true })
        fs.writeFileSync(path.join(dest, 'main.py'), '# clone')
        fs.writeFileSync(path.join(dest, 'comfyui_version.py'), '__version__ = "0.24.0"\n')
        return { ok: true as const }
      })
      const tools = buildSilentTools()
      const record = await adoptDesktopInstall({
        tools,
        deps: buildDeps({ cloneSourceFromGit: cloneFn }, legacy.info)
      })
      // resolveLocalVersion was invoked against the destination ComfyUI
      // dir with the fallback tag threaded through from updateInfo.
      expect(resolveLocalVersionMock).toHaveBeenCalledWith(
        expect.stringContaining('ComfyUI'),
        'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        'v0.24.0'
      )
      expect(fetchTagsMock).toHaveBeenCalledWith(expect.stringContaining('ComfyUI'))
      expect(record.comfyVersion).toEqual({
        commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        baseTag: 'v0.24.0',
        commitsAhead: 0
      })
      // The bare-string `version` field is still set (used as the
      // human-friendly display in the manage view) — both coexist.
      expect(record.version).toBe('0.24.0')
    } finally {
      legacy.cleanup()
    }
  })

  it('omits comfyVersion when no .git directory exists in the source tree', async () => {
    // Pre-swap-copy mode often delivers a tarball with no .git. We can't
    // resolve a real tag in that case, and falling back to the bare
    // __version__ string is intentional — the release-cache change
    // tolerates that mismatch on the comparison side.
    readGitHeadMock.mockReturnValue('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
    resolveLocalVersionMock.mockResolvedValue({
      commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      baseTag: 'v0.24.0',
      commitsAhead: 0
    })
    const legacy = buildFakeLegacy({ configFiles: { 'comfy.settings.json': '{}' } })
    try {
      writeFakeStagedSource(path.join(legacy.configDir, 'legacy-staging', 'comfyui'), '0.24.0')
      const tools = buildSilentTools()
      const record = await adoptDesktopInstall({
        tools,
        deps: buildDeps({}, legacy.info)
      })
      expect(resolveLocalVersionMock).not.toHaveBeenCalled()
      expect(record).not.toHaveProperty('comfyVersion')
      expect(record.version).toBe('0.24.0')
    } finally {
      legacy.cleanup()
    }
  })

  it('adoption is non-fatal when comfyVersion resolution throws', async () => {
    readGitHeadMock.mockReturnValue('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
    resolveLocalVersionMock.mockRejectedValue(new Error('pygit2 not configured'))
    const legacy = buildFakeLegacy({ configFiles: { 'comfy.settings.json': '{}' } })
    try {
      const cloneFn = vi.fn(async (_url: string, dest: string) => {
        fs.mkdirSync(dest, { recursive: true })
        fs.mkdirSync(path.join(dest, '.git'), { recursive: true })
        fs.writeFileSync(path.join(dest, 'main.py'), '# clone')
        return { ok: true as const }
      })
      const tools = buildSilentTools()
      const record = await adoptDesktopInstall({
        tools,
        deps: buildDeps({ cloneSourceFromGit: cloneFn }, legacy.info)
      })
      expect(record).not.toHaveProperty('comfyVersion')
      // Warning surfaced to the user-facing output stream
      expect(tools.sendOutput).toHaveBeenCalledWith(
        expect.stringContaining('could not resolve adopted ComfyUI version: pygit2 not configured')
      )
    } finally {
      legacy.cleanup()
    }
  })

  it('registers human-readable step labels for the progress UI', async () => {
    const legacy = buildFakeLegacy({ configFiles: { 'comfy.settings.json': '{}' } })
    try {
      const tools = buildSilentTools()
      await adoptDesktopInstall({
        tools,
        deps: buildDeps({}, legacy.info)
      })
      // The very first sendProgress call must announce the step list so
      // the renderer can replace its phase-id fallback with the real
      // labels (issue: "Migration progress is weird").
      const stepsCalls = (tools.sendProgress as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([phase]) => phase === 'steps'
      )
      expect(stepsCalls).toHaveLength(1)
      const stepList = (stepsCalls[0]![1] as { steps: Array<{ phase: string; label: string }> }).steps
      const phases = stepList.map((s) => s.phase)
      // All adoption phases that emit sendProgress(...) below must be
      // represented so the renderer never falls back to displaying the
      // raw phase id like "source".
      expect(phases).toContain('backup')
      expect(phases).toContain('venv')
      expect(phases).toContain('snapshot')
      expect(phases).toContain('allocate')
      expect(phases).toContain('source')
      expect(phases).toContain('comfy-update')
      expect(phases).toContain('requirements')
      expect(phases).toContain('settings')
      expect(phases).toContain('register')
      // `tcc` is darwin-only — assert symmetry with the actual platform.
      if (process.platform === 'darwin') {
        expect(phases).toContain('tcc')
      } else {
        expect(phases).not.toContain('tcc')
      }
      // Every registered step has a non-empty label string.
      for (const step of stepList) {
        expect(typeof step.label).toBe('string')
        expect(step.label.length).toBeGreaterThan(0)
        expect(step.label).not.toBe(step.phase)
      }
    } finally {
      legacy.cleanup()
    }
  })

  it('does not overwrite telemetryEnabled when already set', async () => {
    const legacy = buildFakeLegacy({
      configFiles: {
        'comfy.settings.json': JSON.stringify({ 'Comfy-Desktop.SendStatistics': false })
      }
    })
    try {
      settingsMock.__store['telemetryEnabled'] = true
      const tools = buildSilentTools()
      await adoptDesktopInstall({
        tools,
        deps: buildDeps({}, legacy.info)
      })
      expect(settingsMock.__store['telemetryEnabled']).toBe(true)
    } finally {
      legacy.cleanup()
    }
  })

  it('captures forensic snapshot under basePath/.snapshots', async () => {
    const legacy = buildFakeLegacy({ configFiles: { 'comfy.settings.json': '{}' } })
    try {
      const tools = buildSilentTools()
      await adoptDesktopInstall({
        tools,
        deps: buildDeps({}, legacy.info)
      })
      const snapshotDir = path.join(legacy.basePath, '.snapshots')
      const entries = fs.readdirSync(snapshotDir)
      expect(entries.some((f) => f.startsWith('legacy-adopted-') && f.endsWith('.json'))).toBe(true)
    } finally {
      legacy.cleanup()
    }
  })

  it('backs up legacy userData files into legacy-backup/<ts>', async () => {
    const legacy = buildFakeLegacy({
      configFiles: {
        'config.json': '{"basePath":"x"}',
        'comfy.settings.json': '{}',
        'extra_models_config.yaml': 'c:\n  base_path: /a\n',
        'window.json': '{}'
      }
    })
    try {
      const tools = buildSilentTools()
      await adoptDesktopInstall({
        tools,
        deps: buildDeps({}, legacy.info)
      })
      const backupDirs = fs.readdirSync(path.join(legacy.configDir, 'legacy-backup'))
      expect(backupDirs).toHaveLength(1)
      const files = fs.readdirSync(path.join(legacy.configDir, 'legacy-backup', backupDirs[0]!))
      expect(files.sort()).toEqual([
        'comfy.settings.json',
        'config.json',
        'extra_models_config.yaml',
        'window.json'
      ])
    } finally {
      legacy.cleanup()
    }
  })

  it('installs ComfyUI requirements via the legacy venv uv when present', async () => {
    const legacy = buildFakeLegacy({ configFiles: { 'comfy.settings.json': '{}' } })
    try {
      // Drop a fake uv binary into the legacy venv so getLegacyVenvUvPath resolves.
      const uvPath = getLegacyVenvUvPath(legacy.basePath)
      fs.mkdirSync(path.dirname(uvPath), { recursive: true })
      fs.writeFileSync(uvPath, '')
      // Have the git-clone dep populate a real requirements.txt.
      const cloneFn = vi.fn(async (_url: string, dest: string) => {
        fs.mkdirSync(dest, { recursive: true })
        fs.writeFileSync(path.join(dest, 'main.py'), '# clone')
        fs.writeFileSync(path.join(dest, 'requirements.txt'), 'comfy_aimdo>=1.2.0\ntorch>=2.0\n')
        fs.writeFileSync(path.join(dest, 'manager_requirements.txt'), 'pyyaml>=6\n')
        return { ok: true as const }
      })
      const tools = buildSilentTools()
      const record = await adoptDesktopInstall({
        tools,
        deps: buildDeps({ cloneSourceFromGit: cloneFn }, legacy.info)
      })
      // Both requirements files routed through installFilteredRequirements
      // with the legacy uv + adopted python.
      expect(installFilteredRequirementsMock).toHaveBeenCalledTimes(2)
      const coreCall = installFilteredRequirementsMock.mock.calls[0]!
      expect(coreCall[0]).toBe(path.join(record.installPath, 'ComfyUI', 'requirements.txt'))
      expect(coreCall[1]).toBe(uvPath)
      // pythonPath is the legacy venv python derived from basePath
      expect(typeof coreCall[2]).toBe('string')
      const mgrCall = installFilteredRequirementsMock.mock.calls[1]!
      expect(mgrCall[0]).toBe(path.join(record.installPath, 'ComfyUI', 'manager_requirements.txt'))
    } finally {
      legacy.cleanup()
    }
  })

  it('reconciles requirements on re-run against an already-adopted install', async () => {
    const legacy = buildFakeLegacy({ configFiles: { 'comfy.settings.json': '{}' } })
    try {
      const uvPath = getLegacyVenvUvPath(legacy.basePath)
      fs.mkdirSync(path.dirname(uvPath), { recursive: true })
      fs.writeFileSync(uvPath, '')
      const cloneFn = vi.fn(async (_url: string, dest: string) => {
        fs.mkdirSync(dest, { recursive: true })
        fs.writeFileSync(path.join(dest, 'main.py'), '# clone')
        fs.writeFileSync(path.join(dest, 'requirements.txt'), 'comfy_aimdo>=1.2.0\n')
        return { ok: true as const }
      })
      // First run: full adoption, installs requirements once.
      const first = await adoptDesktopInstall({
        tools: buildSilentTools(),
        deps: buildDeps({ cloneSourceFromGit: cloneFn }, legacy.info)
      })
      expect(installFilteredRequirementsMock).toHaveBeenCalledTimes(1)
      installFilteredRequirementsMock.mockClear()
      // Second run: marker present → reconcile requirements without
      // re-cloning / re-registering.
      const second = await adoptDesktopInstall({
        tools: buildSilentTools(),
        deps: buildDeps({ cloneSourceFromGit: cloneFn }, legacy.info)
      })
      expect(second.id).toBe(first.id)
      expect(cloneFn).toHaveBeenCalledTimes(1) // not re-cloned
      // Requirements re-checked against the existing install's destSource.
      expect(installFilteredRequirementsMock).toHaveBeenCalledTimes(1)
      const reconcileCall = installFilteredRequirementsMock.mock.calls[0]!
      expect(reconcileCall[0]).toBe(path.join(first.installPath, 'ComfyUI', 'requirements.txt'))
      expect(reconcileCall[1]).toBe(uvPath)
    } finally {
      legacy.cleanup()
    }
  })

  it('skips requirements install when the legacy venv uv is missing', async () => {
    const legacy = buildFakeLegacy({ configFiles: { 'comfy.settings.json': '{}' } })
    try {
      // No uv binary written under .venv — should skip cleanly.
      const tools = buildSilentTools()
      await adoptDesktopInstall({
        tools,
        deps: buildDeps({}, legacy.info)
      })
      expect(installFilteredRequirementsMock).not.toHaveBeenCalled()
      // pygit2 install requires uv too — it's skipped together.
      expect(runUvPipMock).not.toHaveBeenCalled()
    } finally {
      legacy.cleanup()
    }
  })

  it('installs pygit2 into the legacy venv during adoption so Manager + in-place updates work', async () => {
    const legacy = buildFakeLegacy({ configFiles: { 'comfy.settings.json': '{}' } })
    try {
      const uvPath = getLegacyVenvUvPath(legacy.basePath)
      fs.mkdirSync(path.dirname(uvPath), { recursive: true })
      fs.writeFileSync(uvPath, '')
      const cloneFn = vi.fn(async (_url: string, dest: string) => {
        fs.mkdirSync(dest, { recursive: true })
        fs.writeFileSync(path.join(dest, 'main.py'), '# clone')
        // No requirements files so installFilteredRequirements isn't invoked
        // and we can isolate the pygit2 call.
        return { ok: true as const }
      })
      const tools = buildSilentTools()
      await adoptDesktopInstall({
        tools,
        deps: buildDeps({ cloneSourceFromGit: cloneFn }, legacy.info)
      })
      // Exactly one runUvPip call, targeting pygit2 against the legacy uv
      // and the adopted python.
      expect(runUvPipMock).toHaveBeenCalledTimes(1)
      const [calledUv, calledArgs] = runUvPipMock.mock.calls[0]!
      expect(calledUv).toBe(uvPath)
      expect(Array.isArray(calledArgs)).toBe(true)
      const args = calledArgs as string[]
      expect(args.slice(0, 3)).toEqual(['pip', 'install', 'pygit2'])
      expect(args).toContain('--python')
      // pygit2 result reported in telemetry succeeded payload.
      expect(telemetry.capture).toHaveBeenCalledWith(
        'comfy.desktop.adopt.succeeded',
        expect.objectContaining({ requirements_pygit2_exit: 0 })
      )
    } finally {
      legacy.cleanup()
    }
  })

  it('records pygit2 install failure in telemetry without aborting adoption', async () => {
    const legacy = buildFakeLegacy({ configFiles: { 'comfy.settings.json': '{}' } })
    try {
      const uvPath = getLegacyVenvUvPath(legacy.basePath)
      fs.mkdirSync(path.dirname(uvPath), { recursive: true })
      fs.writeFileSync(uvPath, '')
      runUvPipMock.mockResolvedValueOnce(99)
      const cloneFn = vi.fn(async (_url: string, dest: string) => {
        fs.mkdirSync(dest, { recursive: true })
        fs.writeFileSync(path.join(dest, 'main.py'), '# clone')
        return { ok: true as const }
      })
      const tools = buildSilentTools()
      const record = await adoptDesktopInstall({
        tools,
        deps: buildDeps({ cloneSourceFromGit: cloneFn }, legacy.info)
      })
      expect(record.adopted).toBe(true)
      expect(telemetry.capture).toHaveBeenCalledWith(
        'comfy.desktop.adopt.succeeded',
        expect.objectContaining({ requirements_pygit2_exit: 99 })
      )
    } finally {
      legacy.cleanup()
    }
  })

  it('rolls back the installation record when the marker writeFile fails', async () => {
    const legacy = buildFakeLegacy({ configFiles: { 'comfy.settings.json': '{}' } })
    try {
      // Targeted spy: fail only the marker write; let every other writeFile
      // (snapshot, backup, etc.) succeed via the real impl.
      const realWriteFile = fs.promises.writeFile.bind(fs.promises) as (
        ...args: unknown[]
      ) => Promise<void>
      const markerPath = path.join(legacy.basePath, '.comfyui-desktop-2')
      const spy = vi.spyOn(fs.promises, 'writeFile').mockImplementation(((...args: unknown[]) => {
        const [file] = args
        if (typeof file === 'string' && file === markerPath) {
          return Promise.reject(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))
        }
        return realWriteFile(...args)
      }) as typeof fs.promises.writeFile)
      try {
        const tools = buildSilentTools()
        await expect(
          adoptDesktopInstall({
            tools,
            deps: buildDeps({}, legacy.info)
          })
        ).rejects.toThrow(/disk full/)
        // DB rolled back — no orphaned record.
        expect(installationsMock.__records).toHaveLength(0)
      } finally {
        spy.mockRestore()
      }
    } finally {
      legacy.cleanup()
    }
  })
})
