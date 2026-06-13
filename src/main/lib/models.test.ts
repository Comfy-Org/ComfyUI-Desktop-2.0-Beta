import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// `models.ts` reads `dataDir()` at module-load time to derive YAML_PATH, and
// `instanceModelPathsYaml()` reads it per call. The real `dataDir()` calls
// `electron.app.getPath('userData')`, which crashes outside Electron. A hoisted
// holder lets the mock resolve to a disposable temp dir we control per suite.
const holder = vi.hoisted(() => ({ dataDir: '' }))
vi.mock('./paths', () => ({
  dataDir: () => holder.dataDir,
}))

// Module-load dataDir for the YAML_PATH-dependent (shared) tests below. Set
// before the dynamic import so the module-level YAML_PATH lands inside it.
const sharedTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'models-yaml-'))
holder.dataDir = sharedTmpRoot

const {
  instanceModelPathsYaml,
  ensureModelPathsConfig,
  syncCustomModelFolders,
  resolveExtraModelPaths,
  resolveInstallModelSearchPaths,
  mapLegacyFolderType,
} = await import('./models')

import type { InstallationRecord } from '../installations'

/**
 * Locks the YAML shape that `ensureModelPathsConfig` emits, with focus on the
 * legacy alias directories (`clip/`, `unet/`, `t2i_adapter/`) that ComfyUI
 * registers under canonical folder types via `folder_paths.map_legacy`.
 * Without these in the YAML, shared-dir users who keep encoders in
 * `<shared>/clip/` (the historical ComfyUI layout) see their files invisible
 * to `DualCLIPLoader` / `UNETLoader` even though Storage shows the dir.
 */
describe('ensureModelPathsConfig — YAML emission', () => {
  beforeEach(() => {
    holder.dataDir = sharedTmpRoot
  })
  afterAll(() => {
    fs.rmSync(sharedTmpRoot, { recursive: true, force: true })
  })

  it('emits clip/, unet/, t2i_adapter/ entries for every shared dir', () => {
    const sharedDir = fs.mkdtempSync(path.join(sharedTmpRoot, 'shared-'))
    const result = ensureModelPathsConfig([sharedDir])
    expect(result).not.toBeNull()
    const yaml = fs.readFileSync(result!.yamlPath, 'utf-8')

    // Canonical entries still present.
    expect(yaml).toMatch(/'loras': 'loras\/'/)
    expect(yaml).toMatch(/'text_encoders': 'text_encoders\/'/)
    expect(yaml).toMatch(/'diffusion_models': 'diffusion_models\/'/)

    // Legacy alias entries — the actual bug fix.
    expect(yaml).toMatch(/'clip': 'clip\/'/)
    expect(yaml).toMatch(/'unet': 'unet\/'/)

    // `t2i_adapter` is NOT legacy-mapped, so it must ride under the `controlnet`
    // key as a block scalar — a standalone `t2i_adapter:` key would create its
    // own folder type that ControlNet loaders never read. Parse to verify both
    // dirs resolve under `controlnet`.
    const resolved = resolveExtraModelPaths(result!.yamlPath)
    const controlnetDirs = resolved
      .filter((r) => r.type === 'controlnet')
      .map((r) => path.basename(r.dir))
    expect(controlnetDirs).toContain('controlnet')
    expect(controlnetDirs).toContain('t2i_adapter')
    // No standalone t2i_adapter folder type.
    expect(resolved.some((r) => r.type === 't2i_adapter')).toBe(false)
  })

  it('emits the alias entries for each shared dir (not just the first)', () => {
    const d1 = fs.mkdtempSync(path.join(sharedTmpRoot, 'd1-'))
    const d2 = fs.mkdtempSync(path.join(sharedTmpRoot, 'd2-'))
    const result = ensureModelPathsConfig([d1, d2])
    const yaml = fs.readFileSync(result!.yamlPath, 'utf-8')

    const clipMatches = yaml.match(/'clip': 'clip\/'/g) || []
    expect(clipMatches.length).toBe(2)
    const unetMatches = yaml.match(/'unet': 'unet\/'/g) || []
    expect(unetMatches.length).toBe(2)
  })

  it('canonical entries come before legacy aliases (search-order matters)', () => {
    const sharedDir = fs.mkdtempSync(path.join(sharedTmpRoot, 'order-'))
    const result = ensureModelPathsConfig([sharedDir])
    const yaml = fs.readFileSync(result!.yamlPath, 'utf-8')
    const canonical = yaml.indexOf("'text_encoders': 'text_encoders/'")
    const alias = yaml.indexOf("'clip': 'clip/'")
    expect(canonical).toBeGreaterThan(0)
    expect(alias).toBeGreaterThan(canonical)
  })
})

describe('models per-install YAML', () => {
  let tmpRoot = ''

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'models-test-'))
    holder.dataDir = path.join(tmpRoot, 'data')
    fs.mkdirSync(holder.dataDir, { recursive: true })
  })

  afterEach(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    } catch {}
    holder.dataDir = sharedTmpRoot
  })

  it('builds a per-install YAML path under dataDir()', () => {
    const p = instanceModelPathsYaml('inst-123')
    expect(p).toBe(path.join(holder.dataDir, 'instance-model-paths', 'inst-123.yaml'))
  })

  it('writes the config to the supplied YAML path; first dir is default when primaryDir is omitted', () => {
    const dirA = path.join(tmpRoot, 'a')
    const dirB = path.join(tmpRoot, 'b')
    fs.mkdirSync(dirA, { recursive: true })
    fs.mkdirSync(dirB, { recursive: true })
    const yamlPath = instanceModelPathsYaml('inst-xyz')

    const result = ensureModelPathsConfig([dirA, dirB], { yamlPath })

    expect(result).not.toBeNull()
    expect(result!.yamlPath).toBe(yamlPath)
    expect(fs.existsSync(yamlPath)).toBe(true)
    const yaml = fs.readFileSync(yamlPath, 'utf-8')
    expect(yaml).toContain(`base_path: '${dirA}'`)
    expect(yaml).toContain(`base_path: '${dirB}'`)
    // Only the first (primary) directory is marked as the default save location.
    // (The header comment also mentions is_default, so match the real entry.)
    expect(yaml.match(/^ {2}is_default: true$/gm)).toHaveLength(1)
    const firstIdx = yaml.indexOf(`base_path: '${dirA}'`)
    const defaultIdx = yaml.search(/^ {2}is_default: true$/m)
    const secondIdx = yaml.indexOf(`base_path: '${dirB}'`)
    expect(defaultIdx).toBeGreaterThan(firstIdx)
    expect(defaultIdx).toBeLessThan(secondIdx)
  })

  it('marks the supplied primaryDir as default, not the first dir', () => {
    const dirA = path.join(tmpRoot, 'a')
    const dirB = path.join(tmpRoot, 'b')
    fs.mkdirSync(dirA, { recursive: true })
    fs.mkdirSync(dirB, { recursive: true })
    const yamlPath = instanceModelPathsYaml('inst-pri')

    ensureModelPathsConfig([dirA, dirB], { yamlPath, primaryDir: dirB })

    const yaml = fs.readFileSync(yamlPath, 'utf-8')
    expect(yaml.match(/^ {2}is_default: true$/gm)).toHaveLength(1)
    // The default marker sits with dirB (the second entry), not dirA.
    const aIdx = yaml.indexOf(`base_path: '${dirA}'`)
    const bIdx = yaml.indexOf(`base_path: '${dirB}'`)
    const defaultIdx = yaml.search(/^ {2}is_default: true$/m)
    expect(defaultIdx).toBeGreaterThan(bIdx)
    expect(defaultIdx).toBeGreaterThan(aIdx)
  })

  it('emits NO is_default when primaryDir is null (install-owned primary)', () => {
    const dirA = path.join(tmpRoot, 'a')
    const dirB = path.join(tmpRoot, 'b')
    fs.mkdirSync(dirA, { recursive: true })
    fs.mkdirSync(dirB, { recursive: true })
    const yamlPath = instanceModelPathsYaml('inst-own')

    const result = ensureModelPathsConfig([dirA, dirB], { yamlPath, primaryDir: null })

    expect(result).not.toBeNull()
    const yaml = fs.readFileSync(yamlPath, 'utf-8')
    expect(yaml).toContain(`base_path: '${dirA}'`)
    expect(yaml.match(/^ {2}is_default: true$/gm)).toBeNull()
  })

  it('does not write the global YAML when targeting a per-install path', () => {
    const dir = path.join(tmpRoot, 'models')
    fs.mkdirSync(dir, { recursive: true })
    const yamlPath = instanceModelPathsYaml('inst-1')

    ensureModelPathsConfig([dir], { yamlPath })

    expect(fs.existsSync(path.join(holder.dataDir, 'shared_model_paths.yaml'))).toBe(false)
  })

  it('returns null for empty/missing model dirs', () => {
    expect(ensureModelPathsConfig([], { yamlPath: instanceModelPathsYaml('x') })).toBeNull()
    expect(ensureModelPathsConfig(undefined, { yamlPath: instanceModelPathsYaml('x') })).toBeNull()
  })

  it('syncCustomModelFolders writes to the supplied per-install YAML', () => {
    const installPath = path.join(tmpRoot, 'install')
    fs.mkdirSync(path.join(installPath, 'ComfyUI', 'models'), { recursive: true })
    const dir = path.join(tmpRoot, 'instance-models')
    fs.mkdirSync(dir, { recursive: true })
    const yamlPath = instanceModelPathsYaml('inst-9')

    const { config } = syncCustomModelFolders(installPath, [dir], [], { yamlPath })

    expect(config).not.toBeNull()
    expect(config!.yamlPath).toBe(yamlPath)
    expect(fs.existsSync(yamlPath)).toBe(true)
  })
})

describe('resolveExtraModelPaths — mirrors ComfyUI extra_config.py', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'extra-yaml-'))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  function writeYaml(content: string): string {
    const p = path.join(tmp, 'extra_model_paths.yaml')
    fs.writeFileSync(p, content)
    return p
  }

  it('returns [] when the file is missing', () => {
    expect(resolveExtraModelPaths(path.join(tmp, 'nope.yaml'))).toEqual([])
  })

  it('returns [] for malformed YAML', () => {
    expect(resolveExtraModelPaths(writeYaml(': : : not yaml'))).toEqual([])
  })

  it('joins arbitrary per-type subpaths onto an absolute base_path', () => {
    const base = path.join(tmp, 'root')
    const yaml = writeYaml(`my_section:\n  base_path: ${base}\n  loras: somedir/myname\n  checkpoints: cp/\n`)
    const resolved = resolveExtraModelPaths(yaml)
    const byType = Object.fromEntries(resolved.map((r) => [r.type, r.dir]))
    expect(byType['loras']).toBe(path.normalize(path.join(base, 'somedir/myname')))
    expect(byType['checkpoints']).toBe(path.normalize(path.join(base, 'cp')))
  })

  it('resolves a relative base_path against the YAML directory', () => {
    const yaml = writeYaml(`s:\n  base_path: ../sibling\n  loras: loras\n`)
    const resolved = resolveExtraModelPaths(yaml)
    expect(resolved[0]!.dir).toBe(path.normalize(path.resolve(tmp, '../sibling', 'loras')))
  })

  it('treats an absolute subpath as-is even when base_path is set', () => {
    const abs = path.join(tmp, 'abs-loras')
    const yaml = writeYaml(`s:\n  base_path: ${path.join(tmp, 'root')}\n  loras: ${abs}\n`)
    const resolved = resolveExtraModelPaths(yaml)
    expect(resolved.find((r) => r.type === 'loras')!.dir).toBe(path.normalize(abs))
  })

  it('expands multiple newline-delimited dirs for one type', () => {
    const base = path.join(tmp, 'root')
    const yaml = writeYaml(`s:\n  base_path: ${base}\n  text_encoders: |\n    text_encoders/\n    clip/\n`)
    const dirs = resolveExtraModelPaths(yaml)
      .filter((r) => r.type === 'text_encoders')
      .map((r) => r.dir)
    expect(dirs).toContain(path.normalize(path.join(base, 'text_encoders')))
    expect(dirs).toContain(path.normalize(path.join(base, 'clip')))
  })

  it('maps legacy folder names (clip → text_encoders, unet → diffusion_models)', () => {
    const base = path.join(tmp, 'root')
    const yaml = writeYaml(`s:\n  base_path: ${base}\n  clip: myclip/\n  unet: myunet/\n`)
    const resolved = resolveExtraModelPaths(yaml)
    expect(resolved.find((r) => r.rawType === 'clip')!.type).toBe('text_encoders')
    expect(resolved.find((r) => r.rawType === 'unet')!.type).toBe('diffusion_models')
  })

  it('captures is_default per section', () => {
    const base = path.join(tmp, 'root')
    const yaml = writeYaml(`s:\n  base_path: ${base}\n  is_default: true\n  checkpoints: cp/\n`)
    expect(resolveExtraModelPaths(yaml)[0]!.isDefault).toBe(true)
  })

  it('does not register custom_nodes as a model dir', () => {
    const base = path.join(tmp, 'root')
    const yaml = writeYaml(`s:\n  base_path: ${base}\n  custom_nodes: custom_nodes/\n  loras: loras/\n`)
    const resolved = resolveExtraModelPaths(yaml)
    expect(resolved.map((r) => r.type)).toEqual(['loras'])
  })
})

describe('resolveInstallModelSearchPaths', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'install-search-'))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  function makeInstall(over: Partial<InstallationRecord>): InstallationRecord {
    const installPath = path.join(tmp, 'install')
    fs.mkdirSync(path.join(installPath, 'ComfyUI', 'models'), { recursive: true })
    return {
      id: 'inst-1',
      name: 'Test',
      createdAt: '',
      installPath,
      sourceId: 's',
      ...over,
    } as InstallationRecord
  }

  it('uses the first shared dir as primary when shared models are on', () => {
    const shared = [path.join(tmp, 'shared-a'), path.join(tmp, 'shared-b')]
    const res = resolveInstallModelSearchPaths(makeInstall({ useSharedModels: true }), shared)
    expect(res.downloadBaseDir).toBe(path.resolve(shared[0]!))
    expect(res.modelRoots).toContain(path.resolve(shared[0]!))
    expect(res.modelRoots).toContain(path.resolve(shared[1]!))
  })

  it('uses the install-own models dir as primary when shared off with no promoted primary', () => {
    const inst = makeInstall({ useSharedModels: false, modelDirs: [path.join(tmp, 'ext')] })
    const res = resolveInstallModelSearchPaths(inst, [path.join(tmp, 'shared')])
    expect(res.downloadBaseDir).toBe(path.resolve(path.join(inst.installPath, 'ComfyUI', 'models')))
    // The global shared dir must NOT appear in a shared-off install's roots.
    expect(res.modelRoots).not.toContain(path.resolve(path.join(tmp, 'shared')))
  })

  it('honors a promoted external primary when shared off', () => {
    const ext = path.join(tmp, 'ext')
    const inst = makeInstall({ useSharedModels: false, modelDirs: [ext], modelDirsPrimary: ext })
    const res = resolveInstallModelSearchPaths(inst, [])
    expect(res.downloadBaseDir).toBe(path.resolve(ext))
  })

  it('includes the install own extra_model_paths.yaml dirs', () => {
    const inst = makeInstall({ useSharedModels: false })
    const base = path.join(tmp, 'extra-root')
    fs.writeFileSync(
      path.join(inst.installPath, 'ComfyUI', 'extra_model_paths.yaml'),
      `s:\n  base_path: ${base}\n  loras: custom/loras\n`,
    )
    const res = resolveInstallModelSearchPaths(inst, [])
    expect(res.extraPaths.find((e) => e.type === 'loras')!.dir).toBe(
      path.normalize(path.join(base, 'custom/loras')),
    )
  })
})

describe('mapLegacyFolderType', () => {
  it('maps known aliases and passes through canonical names', () => {
    expect(mapLegacyFolderType('clip')).toBe('text_encoders')
    expect(mapLegacyFolderType('unet')).toBe('diffusion_models')
    expect(mapLegacyFolderType('loras')).toBe('loras')
  })
})
