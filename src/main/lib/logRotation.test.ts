import { afterEach, describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { rotateLogFiles, getLogDir } from './logRotation'

describe('rotateLogFiles', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('renames current log file to timestamped version', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-rotate-'))
    const baseName = 'app.log'
    fs.writeFileSync(path.join(tmpDir, baseName), 'log content')

    await rotateLogFiles(tmpDir, baseName)

    const files = fs.readdirSync(tmpDir)
    expect(files).toHaveLength(1)
    expect(files[0]).not.toBe(baseName)
    expect(files[0]).toMatch(/^app\.log_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.log$/)
  })

  it('does nothing when log dir does not exist', async () => {
    tmpDir = path.join(os.tmpdir(), `log-rotate-nonexistent-${Date.now()}`)

    await expect(rotateLogFiles(tmpDir, 'app.log')).resolves.toBeUndefined()
  })

  it('does nothing when current log file does not exist', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-rotate-'))

    await expect(rotateLogFiles(tmpDir, 'app.log')).resolves.toBeUndefined()

    const files = fs.readdirSync(tmpDir)
    expect(files).toHaveLength(0)
  })

  it('deletes oldest file when count exceeds maxFiles', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-rotate-'))
    const baseName = 'app.log'

    // Create rotated files that exceed maxFiles
    const oldFile = `${baseName}_2020-01-01T00-00-00-000Z.log`
    const newFile = `${baseName}_2025-01-01T00-00-00-000Z.log`
    fs.writeFileSync(path.join(tmpDir, oldFile), 'old')
    fs.writeFileSync(path.join(tmpDir, newFile), 'new')
    fs.writeFileSync(path.join(tmpDir, baseName), 'current')

    await rotateLogFiles(tmpDir, baseName, 1)

    const files = fs.readdirSync(tmpDir)
    expect(files).not.toContain(oldFile)
    expect(files).toContain(newFile)
  })

  it('works with maxFiles=0 (no deletion)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-rotate-'))
    const baseName = 'app.log'

    const existingFile = `${baseName}_2020-01-01T00-00-00-000Z.log`
    fs.writeFileSync(path.join(tmpDir, existingFile), 'old')
    fs.writeFileSync(path.join(tmpDir, baseName), 'current')

    await rotateLogFiles(tmpDir, baseName, 0)

    const files = fs.readdirSync(tmpDir)
    expect(files).toContain(existingFile)
    expect(files).toHaveLength(2)
  })
})

describe('getLogDir', () => {
  it('returns <installPath>/logs', () => {
    const installPath = '/some/install/path'
    expect(getLogDir(installPath)).toBe(path.join(installPath, 'logs'))
  })
})
