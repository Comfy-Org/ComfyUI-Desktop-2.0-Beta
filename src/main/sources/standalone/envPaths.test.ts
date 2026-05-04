import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
}))

import { writeComfyEnvironment } from './envPaths'

const ENV_FILENAME = '.comfy_environment'
const EXPECTED_CONTENT = 'local_desktop2_standalone\n'

describe('writeComfyEnvironment', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-env-test-'))
  })

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  })

  it('writes the marker file with local_desktop2_standalone content + trailing newline', async () => {
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
