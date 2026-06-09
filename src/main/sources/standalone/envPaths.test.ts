import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
}))

import { writeComfyEnvironment, getTorchVersion } from './envPaths'
import type { InstallationRecord } from '../../installations'

const ENV_FILENAME = '.comfy_environment'
const EXPECTED_CONTENT = 'local-desktop2-standalone\n'

/** Build the platform-appropriate site-packages dir under a managed venv and return it. */
function makeSitePackages(installPath: string): string {
  const venv = path.join(installPath, 'ComfyUI', '.venv')
  const sitePackages = process.platform === 'win32'
    ? path.join(venv, 'Lib', 'site-packages')
    : path.join(venv, 'lib', 'python3.12', 'site-packages')
  fs.mkdirSync(sitePackages, { recursive: true })
  return sitePackages
}

describe('writeComfyEnvironment', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-env-test-'))
  })

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  })

  it('writes the marker file with local-desktop2-standalone content + trailing newline', async () => {
    await writeComfyEnvironment(tmpDir)
    const written = fs.readFileSync(path.join(tmpDir, ENV_FILENAME), 'utf-8')
    expect(written).toBe(EXPECTED_CONTENT)
  })

  it('is idempotent — does not rewrite when content already matches', async () => {
    const filePath = path.join(tmpDir, ENV_FILENAME)
    await writeComfyEnvironment(tmpDir)
    const mtimeBefore = fs.statSync(filePath).mtimeMs
    // Wait a tick so mtime would change if a write actually happened.
    await new Promise((r) => setTimeout(r, 20))
    await writeComfyEnvironment(tmpDir)
    const mtimeAfter = fs.statSync(filePath).mtimeMs
    expect(mtimeAfter).toBe(mtimeBefore)
  })

  it('rewrites when existing content differs', async () => {
    const filePath = path.join(tmpDir, ENV_FILENAME)
    fs.writeFileSync(filePath, 'something_else\n', 'utf-8')
    await writeComfyEnvironment(tmpDir)
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(EXPECTED_CONTENT)
  })

  it('skips silently when the target directory does not exist', async () => {
    const missingDir = path.join(tmpDir, 'does-not-exist')
    await expect(writeComfyEnvironment(missingDir)).resolves.toBeUndefined()
    expect(fs.existsSync(path.join(missingDir, ENV_FILENAME))).toBe(false)
  })

  it('swallows write errors and warns instead of throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // tmpDir exists, but we pre-create the marker as a directory so writeFile fails with EISDIR.
    fs.mkdirSync(path.join(tmpDir, ENV_FILENAME))
    await expect(writeComfyEnvironment(tmpDir)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('getTorchVersion', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-torch-test-'))
  })

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  })

  function install(): InstallationRecord {
    return { id: 'i', name: 'i', installPath: tmpDir } as unknown as InstallationRecord
  }

  it('reads the version from the torch dist-info directory', () => {
    const sitePackages = makeSitePackages(tmpDir)
    fs.mkdirSync(path.join(sitePackages, 'torch-2.5.1+cu121.dist-info'))
    expect(getTorchVersion(install())).toBe('2.5.1+cu121')
  })

  it('returns null when torch is not installed', () => {
    const sitePackages = makeSitePackages(tmpDir)
    fs.mkdirSync(path.join(sitePackages, 'numpy-1.26.4.dist-info'))
    expect(getTorchVersion(install())).toBeNull()
  })

  it('returns null when the venv does not exist', () => {
    expect(getTorchVersion(install())).toBeNull()
  })
})
