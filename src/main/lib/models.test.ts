import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// dataDir() resolves to a per-test temp dir so the module-level YAML_PATH and
// instanceModelPathsYaml() write somewhere disposable instead of userData.
// `vi.hoisted` keeps the holder accessible to the hoisted mock factory.
const holder = vi.hoisted(() => ({ dataDir: '' }))
vi.mock('./paths', () => ({
  dataDir: () => holder.dataDir,
}))

import {
  instanceModelPathsYaml,
  ensureModelPathsConfig,
  syncCustomModelFolders,
} from './models'

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
