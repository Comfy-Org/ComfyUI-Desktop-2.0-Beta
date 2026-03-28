// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  ipcMain: { handle: vi.fn() },
}))

import os from 'os'
import fs from 'fs'
import path from 'path'
import { spawnCommand } from './updateOrchestrator'

const isWin = process.platform === 'win32'

function echoCmd(text: string): { command: string; args: string[] } {
  if (isWin) {
    return { command: 'cmd.exe', args: ['/c', `echo ${text}`] }
  }
  return { command: 'sh', args: ['-c', `echo "${text}"`] }
}

function stderrCmd(text: string): { command: string; args: string[] } {
  if (isWin) {
    return { command: 'cmd.exe', args: ['/c', `echo ${text} 1>&2`] }
  }
  return { command: 'sh', args: ['-c', `echo "${text}" >&2`] }
}

function exitCmd(code: number): { command: string; args: string[] } {
  if (isWin) {
    return { command: 'cmd.exe', args: ['/c', `exit /b ${code}`] }
  }
  return { command: 'sh', args: ['-c', `exit ${code}`] }
}

function multiLineCmd(lines: string[]): { command: string; args: string[] } {
  // Use node -e to avoid Windows echo trailing space issues
  const script = lines.map((l) => `console.log(${JSON.stringify(l)})`).join(';')
  return { command: 'node', args: ['-e', script] }
}

function sleepCmd(): { command: string; args: string[] } {
  // Use node so the process is killable on all platforms
  return { command: 'node', args: ['-e', 'setTimeout(() => {}, 60000)'] }
}

describe('spawnCommand', { timeout: 15_000 }, () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnCommand-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('captures stdout and returns exit code 0 on success', async () => {
    const { command, args } = echoCmd('hello world')
    const result = await spawnCommand(command, args, tmpDir, undefined, undefined)
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('hello world')
    expect(result.stderr).toBe('')
  })

  it('captures stderr separately from stdout', async () => {
    const { command, args } = stderrCmd('error output')
    const result = await spawnCommand(command, args, tmpDir, undefined, undefined)
    expect(result.stderr.trim()).toBe('error output')
  })

  it('returns non-zero exit code on failure', async () => {
    const { command, args } = exitCmd(42)
    const result = await spawnCommand(command, args, tmpDir, undefined, undefined)
    expect(result.code).toBe(42)
  })

  it('calls onStdout callback with stdout chunks', async () => {
    const chunks: string[] = []
    const { command, args } = echoCmd('callback test')
    await spawnCommand(command, args, tmpDir, (text) => chunks.push(text), undefined)
    expect(chunks.join('').trim()).toBe('callback test')
  })

  it('calls onStderr callback with stderr chunks', async () => {
    const chunks: string[] = []
    const { command, args } = stderrCmd('stderr callback')
    await spawnCommand(command, args, tmpDir, undefined, (text) => chunks.push(text))
    expect(chunks.join('').trim()).toBe('stderr callback')
  })

  it('captures multiple lines of stdout', async () => {
    const { command, args } = multiLineCmd(['line1', 'line2', 'line3'])
    const result = await spawnCommand(command, args, tmpDir, undefined, undefined)
    const lines = result.stdout.trim().split(/\r?\n/)
    expect(lines).toEqual(['line1', 'line2', 'line3'])
  })

  it('kills process when abort signal is fired', async () => {
    const controller = new AbortController()
    const { command, args } = sleepCmd()

    setTimeout(() => controller.abort(), 200)

    const start = Date.now()
    const result = await spawnCommand(command, args, tmpDir, undefined, undefined, controller.signal)
    const elapsed = Date.now() - start

    expect(result.code).not.toBe(0)
    expect(elapsed).toBeLessThan(10_000)
  })

  it('returns code 1 when command does not exist', async () => {
    const result = await spawnCommand('nonexistent-binary-xyz', [], tmpDir, undefined, undefined)
    expect(result.code).toBe(1)
  })

  it('reports spawn error via onStderr callback', async () => {
    const errors: string[] = []
    await spawnCommand('nonexistent-binary-xyz', [], tmpDir, undefined, (text) => errors.push(text))
    expect(errors.join('')).toContain('Error:')
  })

  it('collects both stdout and stderr independently', async () => {
    // Script that writes to both stdout and stderr
    const script = 'process.stdout.write("out"); process.stderr.write("err")'
    const result = await spawnCommand('node', ['-e', script], tmpDir, undefined, undefined)
    expect(result.stdout).toBe('out')
    expect(result.stderr).toBe('err')
    expect(result.code).toBe(0)
  })

  it('resolves immediately when signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const { command, args } = sleepCmd()

    const start = Date.now()
    const result = await spawnCommand(command, args, tmpDir, undefined, undefined, controller.signal)
    const elapsed = Date.now() - start

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
    expect(elapsed).toBeLessThan(1_000)
  })

  it('invokes both callbacks when process writes to stdout and stderr', async () => {
    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []
    const script = 'process.stdout.write("hello"); process.stderr.write("world")'
    await spawnCommand(
      'node', ['-e', script], tmpDir,
      (text) => stdoutChunks.push(text),
      (text) => stderrChunks.push(text),
    )
    expect(stdoutChunks.join('')).toBe('hello')
    expect(stderrChunks.join('')).toBe('world')
  })
})
