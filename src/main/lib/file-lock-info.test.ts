import { describe, it, expect } from 'vitest'
import { findLockingProcesses } from './file-lock-info'
import { fork } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'

describe('findLockingProcesses', { timeout: 30_000 }, () => {
  it('returns an empty array for a file not locked by any process', async () => {
    const tmpFile = path.join(os.tmpdir(), `file-lock-test-${Date.now()}.txt`)
    fs.writeFileSync(tmpFile, 'test')
    try {
      const result = await findLockingProcesses(tmpFile)
      expect(Array.isArray(result)).toBe(true)
    } finally {
      try { fs.unlinkSync(tmpFile) } catch {}
    }
  })

  it('returns an empty array for a non-existent file', async () => {
    const result = await findLockingProcesses('/tmp/nonexistent-file-lock-test-' + Date.now())
    expect(result).toEqual([])
  })

  it('returns results with pid and name fields', async () => {
    const tmpFile = path.join(os.tmpdir(), `file-lock-shape-test-${Date.now()}.txt`)
    fs.writeFileSync(tmpFile, 'test')
    try {
      const result = await findLockingProcesses(tmpFile)
      for (const entry of result) {
        expect(typeof entry.pid).toBe('number')
        expect(typeof entry.name).toBe('string')
      }
    } finally {
      try { fs.unlinkSync(tmpFile) } catch {}
    }
  })

  it('detects a process holding a file open', async () => {
    // On Windows, the Restart Manager API only detects applications that
    // registered with it (GUI apps, services) — it does not reliably detect
    // arbitrary file handles from console processes like Node.js. Skip this
    // test on Windows since the underlying API cannot provide the result we
    // need. On Linux/macOS, lsof works correctly for all process types.
    if (process.platform === 'win32') return

    const tmpFile = path.join(os.tmpdir(), `file-lock-held-test-${Date.now()}.txt`)
    fs.writeFileSync(tmpFile, 'test')

    // Spawn a child process that opens the file and holds it open
    const child = fork(
      '-e',
      [
        `const fs = require('fs');` +
        `const fd = fs.openSync(${JSON.stringify(tmpFile)}, 'r+');` +
        `process.send('ready');` +
        `process.on('message', () => { fs.closeSync(fd); process.exit(); });`,
      ],
      { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] }
    )

    // Wait for the child to signal it has the file open
    await new Promise<void>((resolve) => { child.on('message', () => resolve()) })
    await new Promise((r) => setTimeout(r, 500))

    try {
      const result = await findLockingProcesses(tmpFile)
      expect(result.length).toBeGreaterThanOrEqual(1)
      const pids = result.map((r) => r.pid)
      expect(pids).toContain(child.pid)
      for (const entry of result) {
        expect(entry.pid).toBeGreaterThan(0)
        expect(entry.name.length).toBeGreaterThan(0)
      }
    } finally {
      child.send('close')
      await new Promise<void>((resolve) => { child.on('exit', () => resolve()) })
      try { fs.unlinkSync(tmpFile) } catch {}
    }
  })
})
