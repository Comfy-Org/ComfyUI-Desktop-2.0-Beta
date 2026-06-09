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

const { instanceModelPathsYaml, ensureModelPathsConfig, syncCustomModelFolders } = await import(
  './models'
)

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
    expect(yaml).toMatch(/'controlnet': 'controlnet\/'/)

    // Legacy alias entries — the actual bug fix.
    expect(yaml).toMatch(/'clip': 'clip\/'/)
    expect(yaml).toMatch(/'unet': 'unet\/'/)
    expect(yaml).toMatch(/'t2i_adapter': 't2i_adapter\/'/)
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

  it('writes the config to the supplied YAML path with the first dir as default', () => {
    const dirA = path.join(tmpRoot, 'a')
    const dirB = path.join(tmpRoot, 'b')
    fs.mkdirSync(dirA, { recursive: true })
    fs.mkdirSync(dirB, { recursive: true })
    const yamlPath = instanceModelPathsYaml('inst-xyz')

    const result = ensureModelPathsConfig([dirA, dirB], yamlPath)

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

  it('does not write the global YAML when targeting a per-install path', () => {
    const dir = path.join(tmpRoot, 'models')
    fs.mkdirSync(dir, { recursive: true })
    const yamlPath = instanceModelPathsYaml('inst-1')

    ensureModelPathsConfig([dir], yamlPath)

    expect(fs.existsSync(path.join(holder.dataDir, 'shared_model_paths.yaml'))).toBe(false)
  })

  it('returns null for empty/missing model dirs', () => {
    expect(ensureModelPathsConfig([], instanceModelPathsYaml('x'))).toBeNull()
    expect(ensureModelPathsConfig(undefined, instanceModelPathsYaml('x'))).toBeNull()
  })

  it('syncCustomModelFolders writes to the supplied per-install YAML', () => {
    const installPath = path.join(tmpRoot, 'install')
    fs.mkdirSync(path.join(installPath, 'ComfyUI', 'models'), { recursive: true })
    const dir = path.join(tmpRoot, 'instance-models')
    fs.mkdirSync(dir, { recursive: true })
    const yamlPath = instanceModelPathsYaml('inst-9')

    const { config } = syncCustomModelFolders(installPath, [dir], [], yamlPath)

    expect(config).not.toBeNull()
    expect(config!.yamlPath).toBe(yamlPath)
    expect(fs.existsSync(yamlPath)).toBe(true)
  })
})
