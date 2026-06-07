import { describe, it, expect, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'models-yaml-'))

// `models.ts` reads `dataDir()` at module-load time to derive YAML_PATH. The
// real `dataDir()` calls `electron.app.getPath('userData')`, which crashes
// outside Electron. Mock the import so YAML_PATH lands inside our tmp root.
vi.mock('./paths', () => ({
  dataDir: () => tmpRoot,
}))

const { ensureModelPathsConfig } = await import('./models')

/**
 * Locks the YAML shape that `ensureModelPathsConfig` emits, with focus on the
 * legacy alias directories (`clip/`, `unet/`, `t2i_adapter/`) that ComfyUI
 * registers under canonical folder types via `folder_paths.map_legacy`.
 * Without these in the YAML, shared-dir users who keep encoders in
 * `<shared>/clip/` (the historical ComfyUI layout) see their files invisible
 * to `DualCLIPLoader` / `UNETLoader` even though Storage shows the dir.
 */
describe('ensureModelPathsConfig — YAML emission', () => {
  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('emits clip/, unet/, t2i_adapter/ entries for every shared dir', () => {
    const sharedDir = fs.mkdtempSync(path.join(tmpRoot, 'shared-'))
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
    const d1 = fs.mkdtempSync(path.join(tmpRoot, 'd1-'))
    const d2 = fs.mkdtempSync(path.join(tmpRoot, 'd2-'))
    const result = ensureModelPathsConfig([d1, d2])
    const yaml = fs.readFileSync(result!.yamlPath, 'utf-8')

    const clipMatches = yaml.match(/'clip': 'clip\/'/g) || []
    expect(clipMatches.length).toBe(2)
    const unetMatches = yaml.match(/'unet': 'unet\/'/g) || []
    expect(unetMatches.length).toBe(2)
  })

  it('canonical entries come before legacy aliases (search-order matters)', () => {
    const sharedDir = fs.mkdtempSync(path.join(tmpRoot, 'order-'))
    const result = ensureModelPathsConfig([sharedDir])
    const yaml = fs.readFileSync(result!.yamlPath, 'utf-8')
    const canonical = yaml.indexOf("'text_encoders': 'text_encoders/'")
    const alias = yaml.indexOf("'clip': 'clip/'")
    expect(canonical).toBeGreaterThan(0)
    expect(alias).toBeGreaterThan(canonical)
  })
})
