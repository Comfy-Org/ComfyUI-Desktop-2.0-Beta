import os from 'os'
import path from 'path'
import fs from 'fs'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import type * as pathsModule from './paths'

vi.mock('electron', () => ({
  app: { getPath: (name: string) => name === 'home' ? os.tmpdir() : os.tmpdir() },
}))

vi.mock('./paths', async (importOriginal) => {
  const actual = await importOriginal<typeof pathsModule>()
  return {
    ...actual,
    defaultInstallDir: () => path.join(os.tmpdir(), 'desktopAdopt-installs'),
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
    getAll: vi.fn(() => ({ ...store })),
    __store: store,
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
    __records: records,
    __reset: () => { records.length = 0; nextSeq = 0 },
  }
})

vi.mock('./telemetry', () => ({
  capture: vi.fn(),
  bucketError: vi.fn(() => 'other'),
  trackedStep: vi.fn(async (_step: string, _ctx: unknown, fn: () => Promise<unknown>) => fn()),
}))

vi.mock('./github-mirror', () => ({
  getComfyUIRemoteUrl: vi.fn(() => 'https://github.com/Comfy-Org/ComfyUI.git'),
}))

import {
  adoptDesktopInstall,
  parseExtraModelsYaml,
  deriveLaunchArgs,
  computeModelsDirsToCarry,
  type AdoptTools,
  type AdoptDeps,
  type UserChoice,
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
    promptUser: promptUser ?? vi.fn(async () => { throw new Error('promptUser unexpectedly called') }),
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

function buildFakeLegacy(opts: {
  configFiles?: Record<string, string>
  baseFiles?: Record<string, string>
  hasVenv?: boolean
} = {}): FakeLegacy {
  const root = mkdtemp('adopt-test-')
  const basePath = path.join(root, 'data')
  const configDir = path.join(root, 'userData')
  fs.mkdirSync(basePath, { recursive: true })
  fs.mkdirSync(configDir, { recursive: true })
  fs.mkdirSync(path.join(basePath, 'models'), { recursive: true })
  fs.mkdirSync(path.join(basePath, 'user'), { recursive: true })
  if (opts.hasVenv !== false) {
    const venvBin = process.platform === 'win32'
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
    hasVenv: opts.hasVenv !== false,
  }
  return {
    basePath, configDir, info,
    cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} },
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
      skipPipSync: true,
    })),
    now: () => new Date('2026-05-19T12:00:00.000Z'),
    ...overrides,
  }
}

beforeEach(() => {
  installationsMock.__reset()
  for (const key of Object.keys(settingsMock.__store)) delete settingsMock.__store[key]
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('parseExtraModelsYaml', () => {
  it('extracts base_path values across multiple sections', () => {
    const yaml = `# header\n` +
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
  it('uses defaults when settings are missing', () => {
    expect(deriveLaunchArgs({})).toBe('--listen 127.0.0.1 --port 8000 --enable-manager')
  })

  it('uses server_config.listen/port from settings', () => {
    const args = deriveLaunchArgs({ 'server_config.listen': '0.0.0.0', 'server_config.port': 8188 })
    expect(args).toBe('--listen 0.0.0.0 --port 8188 --enable-manager')
  })

  it('flattens extra_server_args with values', () => {
    const args = deriveLaunchArgs({ extra_server_args: { 'use-pytorch-cross-attention': '', verbose: 'DEBUG' } })
    expect(args).toContain('--use-pytorch-cross-attention')
    expect(args).toMatch(/--verbose\s+DEBUG/)
  })

  it('keeps --enable-manager even when overrides are present', () => {
    const args = deriveLaunchArgs({ extra_server_args: { cpu: '' } })
    expect(args).toContain('--enable-manager')
    expect(args).toContain('--cpu')
  })
})

describe('computeModelsDirsToCarry', () => {
  it('adds basePath/models plus extra YAML mounts and dedupes against existing', () => {
    const basePath = '/data/ComfyUI'
    const yaml = `c1:\n  base_path: /data/ComfyUI\nc2:\n  base_path: /extra/A1111\n`
    const existing = [path.resolve('/shared/models')]
    const out = computeModelsDirsToCarry(basePath, yaml, existing)
    expect(out).toEqual([
      path.resolve(path.join(basePath, 'models')),
      path.resolve('/data/ComfyUI'),
      path.resolve('/extra/A1111'),
    ])
  })

  it('skips duplicates already present in existing', () => {
    const basePath = '/data/ComfyUI'
    const existing = [path.resolve(path.join(basePath, 'models'))]
    expect(computeModelsDirsToCarry(basePath, null, existing)).toEqual([])
  })
})

describe('adoptDesktopInstall — orchestrator', () => {
  it('returns existing record when marker matches an installation (idempotent no-op)', async () => {
    const legacy = buildFakeLegacy()
    try {
      // Pre-seed an installation + marker
      const seeded = await installations.add({ name: 'previous', installPath: '/x', sourceId: 'standalone', status: 'installed' })
      fs.writeFileSync(path.join(legacy.basePath, '.comfyui-desktop-2'), seeded.id)

      const tools = buildSilentTools()
      const result = await adoptDesktopInstall({
        trigger: 'beta-action',
        tools,
        deps: buildDeps({}, legacy.info),
      })
      expect(result.id).toBe(seeded.id)
      // No second installation added
      expect(installationsMock.__records).toHaveLength(1)
    } finally { legacy.cleanup() }
  })

  it('throws no-legacy-install when detection returns null', async () => {
    const tools = buildSilentTools()
    await expect(adoptDesktopInstall({
      trigger: 'beta-action',
      tools,
      deps: { detectDesktopInstall: () => null },
    })).rejects.toThrow('no-legacy-install')
    expect(telemetry.capture).toHaveBeenCalledWith('desktop2.adopt.failed', expect.objectContaining({
      error_bucket: 'no-legacy-install',
    }))
  })

  it('prefers pre-swap-copy when staged source is valid', async () => {
    const legacy = buildFakeLegacy({
      configFiles: {
        'comfy.settings.json': JSON.stringify({ 'server_config.listen': '0.0.0.0', 'server_config.port': 8188 }),
      },
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
        trigger: 'beta-action',
        tools,
        deps: buildDeps({ copyStagedSource: copyFn, cloneSourceFromGit: cloneFn }, legacy.info),
      })
      expect(copyFn).toHaveBeenCalledOnce()
      expect(cloneFn).not.toHaveBeenCalled()
      expect(record.adoptedSourceMode).toBe('pre-swap-copy')
      expect(record.launchArgs).toBe('--listen 0.0.0.0 --port 8188 --enable-manager')
      // Marker written
      const marker = fs.readFileSync(path.join(legacy.basePath, '.comfyui-desktop-2'), 'utf-8')
      expect(marker).toBe(record.id)
    } finally { legacy.cleanup() }
  })

  it('falls back to git clone when staged source is missing', async () => {
    const legacy = buildFakeLegacy({
      configFiles: { 'comfy.settings.json': '{}' },
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
        trigger: 'beta-action',
        tools,
        deps: buildDeps({ cloneSourceFromGit: cloneFn }, legacy.info),
      })
      expect(cloneFn).toHaveBeenCalledOnce()
      expect(record.adoptedSourceMode).toBe('git-clone-fallback')
      expect(record.version).toBe('0.9.9')
    } finally { legacy.cleanup() }
  })

  it('merges modelsDirs from extra_models_config.yaml and basePath/models', async () => {
    const yaml = `comfyui_desktop:\n  base_path: /shared/A\n  is_default: true\nA1111:\n  base_path: /shared/B\n`
    const legacy = buildFakeLegacy({
      configFiles: {
        'comfy.settings.json': '{}',
        'extra_models_config.yaml': yaml,
      },
    })
    try {
      const tools = buildSilentTools()
      await adoptDesktopInstall({
        trigger: 'beta-action',
        tools,
        deps: buildDeps({}, legacy.info),
      })
      const finalDirs = settingsMock.__store['modelsDirs'] as string[] | undefined
      expect(finalDirs).toBeDefined()
      expect(finalDirs).toEqual(expect.arrayContaining([
        path.resolve(path.join(legacy.basePath, 'models')),
        path.resolve('/shared/A'),
        path.resolve('/shared/B'),
      ]))
    } finally { legacy.cleanup() }
  })

  it('continues adoption when validateLegacyVenv fails and user picks use-anyway', async () => {
    const legacy = buildFakeLegacy({ configFiles: { 'comfy.settings.json': '{}' } })
    try {
      const prompt = vi.fn(async (_kind, _ctx): Promise<UserChoice> => ({ kind: 'venv-broken', choice: 'use-anyway' }))
      const tools = buildSilentTools(prompt)
      const validate = vi.fn(async () => ({ ok: false as const, message: 'no torch' }))
      const record = await adoptDesktopInstall({
        trigger: 'beta-action',
        tools,
        deps: buildDeps({ validateLegacyVenv: validate }, legacy.info),
      })
      expect(validate).toHaveBeenCalledOnce()
      expect(prompt).toHaveBeenCalledWith('venv-broken', expect.objectContaining({ message: 'no torch' }))
      expect(record.id).toMatch(/^inst-test-/)
    } finally { legacy.cleanup() }
  })

  it('aborts adoption when validateLegacyVenv fails and user cancels', async () => {
    const legacy = buildFakeLegacy({ configFiles: { 'comfy.settings.json': '{}' } })
    try {
      const prompt = vi.fn(async (): Promise<UserChoice> => ({ kind: 'venv-broken', choice: 'cancel' }))
      const tools = buildSilentTools(prompt)
      const validate = vi.fn(async () => ({ ok: false as const, message: 'no torch' }))
      await expect(adoptDesktopInstall({
        trigger: 'beta-action',
        tools,
        deps: buildDeps({ validateLegacyVenv: validate }, legacy.info),
      })).rejects.toThrow(/venv-broken-cancelled/)
      // No installation created
      expect(installationsMock.__records).toHaveLength(0)
    } finally { legacy.cleanup() }
  })

  it('cutover mode auto-picks use-anyway without invoking promptUser', async () => {
    const legacy = buildFakeLegacy({ configFiles: { 'comfy.settings.json': '{}' } })
    try {
      const prompt = vi.fn()
      const tools: AdoptTools = {
        sendProgress: vi.fn(),
        sendOutput: vi.fn(),
        signal: new AbortController().signal,
        promptUser: prompt as unknown as AdoptTools['promptUser'],
      }
      const validate = vi.fn(async () => ({ ok: false as const, message: 'no torch' }))
      const record = await adoptDesktopInstall({
        trigger: 'first-launch-cutover',
        tools,
        deps: buildDeps({ validateLegacyVenv: validate }, legacy.info),
      })
      expect(prompt).not.toHaveBeenCalled()
      expect(record.id).toMatch(/^inst-test-/)
    } finally { legacy.cleanup() }
  })

  it('writes the marker and registers an installation with the §2 shape', async () => {
    const legacy = buildFakeLegacy({
      configFiles: {
        'comfy.settings.json': JSON.stringify({
          'server_config.port': 8188,
          'extra_server_args': { 'use-pytorch-cross-attention': '' },
          'Comfy-Desktop.SendStatistics': false,
        }),
      },
    })
    try {
      const tools = buildSilentTools()
      const record = await adoptDesktopInstall({
        trigger: 'beta-action',
        tools,
        deps: buildDeps({}, legacy.info),
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
        useSharedPaths: false,
        copiedFrom: 'legacy-desktop',
        copyReason: 'in-place-adoption',
        status: 'installed',
      })
      expect(record.launchArgs as string).toContain('--port 8188')
      expect(record.launchArgs as string).toContain('--use-pytorch-cross-attention')
      // Marker stamped with the freshly minted install id
      const marker = fs.readFileSync(path.join(legacy.basePath, '.comfyui-desktop-2'), 'utf-8')
      expect(marker).toBe(record.id)
      // Telemetry succeeded
      expect(telemetry.capture).toHaveBeenCalledWith('desktop2.adopt.succeeded', expect.objectContaining({
        trigger: 'beta-action',
        adopted_source_mode: 'git-clone-fallback',
      }))
      // Telemetry consent carried from legacy SendStatistics
      expect(settingsMock.__store['telemetryEnabled']).toBe(false)
    } finally { legacy.cleanup() }
  })

  it('does not overwrite telemetryEnabled when already set', async () => {
    const legacy = buildFakeLegacy({
      configFiles: {
        'comfy.settings.json': JSON.stringify({ 'Comfy-Desktop.SendStatistics': false }),
      },
    })
    try {
      settingsMock.__store['telemetryEnabled'] = true
      const tools = buildSilentTools()
      await adoptDesktopInstall({
        trigger: 'beta-action',
        tools,
        deps: buildDeps({}, legacy.info),
      })
      expect(settingsMock.__store['telemetryEnabled']).toBe(true)
    } finally { legacy.cleanup() }
  })

  it('captures forensic snapshot under basePath/.snapshots', async () => {
    const legacy = buildFakeLegacy({ configFiles: { 'comfy.settings.json': '{}' } })
    try {
      const tools = buildSilentTools()
      await adoptDesktopInstall({
        trigger: 'beta-action',
        tools,
        deps: buildDeps({}, legacy.info),
      })
      const snapshotDir = path.join(legacy.basePath, '.snapshots')
      const entries = fs.readdirSync(snapshotDir)
      expect(entries.some((f) => f.startsWith('legacy-adopted-') && f.endsWith('.json'))).toBe(true)
    } finally { legacy.cleanup() }
  })

  it('backs up legacy userData files into legacy-backup/<ts>', async () => {
    const legacy = buildFakeLegacy({
      configFiles: {
        'config.json': '{"basePath":"x"}',
        'comfy.settings.json': '{}',
        'extra_models_config.yaml': 'c:\n  base_path: /a\n',
        'window.json': '{}',
      },
    })
    try {
      const tools = buildSilentTools()
      await adoptDesktopInstall({
        trigger: 'beta-action',
        tools,
        deps: buildDeps({}, legacy.info),
      })
      const backupDirs = fs.readdirSync(path.join(legacy.configDir, 'legacy-backup'))
      expect(backupDirs).toHaveLength(1)
      const files = fs.readdirSync(path.join(legacy.configDir, 'legacy-backup', backupDirs[0]!))
      expect(files.sort()).toEqual(['comfy.settings.json', 'config.json', 'extra_models_config.yaml', 'window.json'])
    } finally { legacy.cleanup() }
  })
})
