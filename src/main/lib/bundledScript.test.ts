import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import path from 'path'

// The bundled output lands in out/main/index.js, so __dirname at runtime
// is always <projectRoot>/out/main.  The dev-mode formula must resolve
// from there to <projectRoot>/lib/<script>.

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..')

/** Simulate the dev-mode path resolution as it runs inside the bundle. */
function devScriptPath(scriptName: string): string {
  const bundledDir = path.join(PROJECT_ROOT, 'out', 'main')
  return path.join(bundledDir, '..', '..', 'lib', scriptName)
}

describe('bundled script paths', () => {
  it('dev-mode path resolves to lib/update_comfyui.py which exists', () => {
    const resolved = path.resolve(devScriptPath('update_comfyui.py'))
    expect(resolved).toBe(path.join(PROJECT_ROOT, 'lib', 'update_comfyui.py'))
    expect(fs.existsSync(resolved)).toBe(true)
  })

  it('dev-mode path resolves to lib/git_operations.py which exists', () => {
    const resolved = path.resolve(devScriptPath('git_operations.py'))
    expect(resolved).toBe(path.join(PROJECT_ROOT, 'lib', 'git_operations.py'))
    expect(fs.existsSync(resolved)).toBe(true)
  })

  it('getBundledScriptPath uses the same formula in dev mode', async () => {
    vi.mock('electron', () => ({ app: { isPackaged: false } }))
    const { getBundledScriptPath } = await import('./bundledScript')
    const result = getBundledScriptPath('update_comfyui.py')
    expect(result).toContain('update_comfyui.py')
    expect(result.endsWith(path.join('lib', 'update_comfyui.py'))).toBe(true)
  })
})
