import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
}))

import { getTorchVendorMismatch, copyTorchFamily } from './torchRepair'
import type { InstallationRecord } from '../../installations'

let tmpDir: string

/** Create a managed venv site-packages dir with a torch dist-info of the given version. */
function makeVenvWithTorch(installPath: string, torchVersion: string | null): string {
  const venv = path.join(installPath, 'ComfyUI', '.venv')
  const sitePackages =
    process.platform === 'win32'
      ? path.join(venv, 'Lib', 'site-packages')
      : path.join(venv, 'lib', 'python3.12', 'site-packages')
  fs.mkdirSync(sitePackages, { recursive: true })
  if (torchVersion) fs.mkdirSync(path.join(sitePackages, `torch-${torchVersion}.dist-info`))
  return sitePackages
}

function install(over: Partial<InstallationRecord> = {}): InstallationRecord {
  return { id: 'i', name: 'i', installPath: tmpDir, sourceId: 'standalone', ...over } as unknown as InstallationRecord
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torch-repair-test-'))
})

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
})

describe('getTorchVendorMismatch', () => {
  it('flags an NVIDIA install running a bare (Windows-bug) torch', () => {
    makeVenvWithTorch(tmpDir, '2.12.0')
    const m = getTorchVendorMismatch(install({ variant: 'win-nvidia' }))
    expect(m).not.toBeNull()
    expect(m!.variantBase).toBe('nvidia')
    expect(m!.expectedFamily).toBe('cu')
    expect(m!.installedTag).toBe('')
  })

  it('flags an NVIDIA install running a +cpu torch', () => {
    makeVenvWithTorch(tmpDir, '2.10.0+cpu')
    const m = getTorchVendorMismatch(install({ variant: 'linux-nvidia' }))
    expect(m).not.toBeNull()
    expect(m!.installedTag).toBe('cpu')
  })

  it('does not flag an NVIDIA install with the correct cu tag (any version)', () => {
    makeVenvWithTorch(tmpDir, '2.10.0+cu128')
    expect(getTorchVendorMismatch(install({ variant: 'win-nvidia' }))).toBeNull()
  })

  it('does not flag a different CUDA minor version (user freedom)', () => {
    makeVenvWithTorch(tmpDir, '2.6.0+cu126')
    expect(getTorchVendorMismatch(install({ variant: 'win-nvidia' }))).toBeNull()
  })

  it('flags an AMD install running CPU torch and accepts rocm', () => {
    makeVenvWithTorch(tmpDir, '2.10.0+cpu')
    expect(getTorchVendorMismatch(install({ variant: 'linux-amd' }))).not.toBeNull()
    fs.rmSync(path.join(tmpDir, 'ComfyUI'), { recursive: true, force: true })
    makeVenvWithTorch(tmpDir, '2.10.0+rocm7.1')
    expect(getTorchVendorMismatch(install({ variant: 'linux-amd' }))).toBeNull()
  })

  it('flags an Intel XPU install running CPU torch and accepts xpu', () => {
    makeVenvWithTorch(tmpDir, '2.10.0+cpu')
    expect(getTorchVendorMismatch(install({ variant: 'win-intel-xpu' }))).not.toBeNull()
    fs.rmSync(path.join(tmpDir, 'ComfyUI'), { recursive: true, force: true })
    makeVenvWithTorch(tmpDir, '2.10.0+xpu')
    expect(getTorchVendorMismatch(install({ variant: 'win-intel-xpu' }))).toBeNull()
  })

  it('never flags CPU or mac/MPS variants', () => {
    makeVenvWithTorch(tmpDir, '2.12.0')
    expect(getTorchVendorMismatch(install({ variant: 'win-cpu' }))).toBeNull()
    expect(getTorchVendorMismatch(install({ variant: 'mac-mps' }))).toBeNull()
  })

  it('skips adopted installs', () => {
    makeVenvWithTorch(tmpDir, '2.12.0')
    expect(getTorchVendorMismatch(install({ variant: 'win-nvidia', adopted: true }))).toBeNull()
  })

  it('returns null when torch cannot be read', () => {
    makeVenvWithTorch(tmpDir, null)
    expect(getTorchVendorMismatch(install({ variant: 'win-nvidia' }))).toBeNull()
  })

  it('returns null when no variant is recorded', () => {
    makeVenvWithTorch(tmpDir, '2.12.0')
    expect(getTorchVendorMismatch(install({}))).toBeNull()
  })
})

describe('copyTorchFamily', () => {
  it('replaces torch-family entries from src and leaves unrelated packages intact', async () => {
    const src = path.join(tmpDir, 'src')
    const dst = path.join(tmpDir, 'dst')
    fs.mkdirSync(src, { recursive: true })
    fs.mkdirSync(dst, { recursive: true })

    // Helper: a package dir always has at least one file (copyDir skips empty dirs).
    const pkg = (root: string, name: string, content: string): void => {
      fs.mkdirSync(path.join(root, name), { recursive: true })
      fs.writeFileSync(path.join(root, name, 'FILE'), content)
    }

    // Source bundle: GPU torch stack.
    pkg(src, 'torch', "__version__ = '2.10.0+cu128'")
    pkg(src, 'torch-2.10.0+cu128.dist-info', 'METADATA')
    pkg(src, 'nvidia_cudnn_cu12', 'lib')
    pkg(src, 'triton', 'lib')

    // Destination venv: CPU torch stack + an unrelated package.
    pkg(dst, 'torch', "__version__ = '2.12.0'")
    pkg(dst, 'torch-2.12.0.dist-info', 'METADATA')
    pkg(dst, 'numpy', 'keep me')

    await copyTorchFamily(src, dst)

    // GPU torch copied in, stale CPU dist-info removed, numpy untouched.
    expect(fs.readFileSync(path.join(dst, 'torch', 'FILE'), 'utf-8')).toContain('cu128')
    expect(fs.existsSync(path.join(dst, 'torch-2.10.0+cu128.dist-info'))).toBe(true)
    expect(fs.existsSync(path.join(dst, 'torch-2.12.0.dist-info'))).toBe(false)
    expect(fs.existsSync(path.join(dst, 'nvidia_cudnn_cu12'))).toBe(true)
    expect(fs.existsSync(path.join(dst, 'triton'))).toBe(true)
    expect(fs.readFileSync(path.join(dst, 'numpy', 'FILE'), 'utf-8')).toBe('keep me')
  })
})
