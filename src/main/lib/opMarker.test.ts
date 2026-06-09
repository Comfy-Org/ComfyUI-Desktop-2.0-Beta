// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('./git', () => ({
  readGitHead: vi.fn(),
  rollbackComfySource: vi.fn(),
}))

import { readGitHead, rollbackComfySource } from './git'
import { writeOpMarker, readOpMarker, clearOpMarker, recoverInterruptedComfyOp } from './opMarker'

const mockedReadGitHead = vi.mocked(readGitHead)
const mockedRollback = vi.mocked(rollbackComfySource)

const MARKER_NAME = '.comfyui-op-in-progress.json'

let installPath: string

beforeEach(() => {
  installPath = fs.mkdtempSync(path.join(os.tmpdir(), 'opmarker-'))
  vi.clearAllMocks()
})

afterEach(() => {
  fs.rmSync(installPath, { recursive: true, force: true })
})

describe('marker read/write/clear', () => {
  it('round-trips a written marker', async () => {
    await writeOpMarker(installPath, { op: 'update', preHead: 'abc123', startedAt: 42 })
    expect(fs.existsSync(path.join(installPath, MARKER_NAME))).toBe(true)
    expect(readOpMarker(installPath)).toEqual({ op: 'update', preHead: 'abc123', startedAt: 42 })
  })

  it('returns null when no marker exists', () => {
    expect(readOpMarker(installPath)).toBeNull()
  })

  it('returns null for a malformed or incomplete marker', () => {
    fs.writeFileSync(path.join(installPath, MARKER_NAME), '{ not json', 'utf-8')
    expect(readOpMarker(installPath)).toBeNull()

    fs.writeFileSync(path.join(installPath, MARKER_NAME), JSON.stringify({ op: 'update' }), 'utf-8')
    expect(readOpMarker(installPath)).toBeNull()

    fs.writeFileSync(path.join(installPath, MARKER_NAME), JSON.stringify({ op: 'bogus', preHead: 'x' }), 'utf-8')
    expect(readOpMarker(installPath)).toBeNull()
  })

  it('clear removes the marker and is safe when absent', async () => {
    await writeOpMarker(installPath, { op: 'restore', preHead: 'def', startedAt: 1 })
    await clearOpMarker(installPath)
    expect(fs.existsSync(path.join(installPath, MARKER_NAME))).toBe(false)
    await expect(clearOpMarker(installPath)).resolves.toBeUndefined()
  })
})

describe('recoverInterruptedComfyOp', () => {
  it('does nothing and returns false when no marker is present', async () => {
    const recovered = await recoverInterruptedComfyOp(installPath)
    expect(recovered).toBe(false)
    expect(mockedRollback).not.toHaveBeenCalled()
  })

  it('rolls back and clears the marker when HEAD moved (hard-kill case)', async () => {
    await writeOpMarker(installPath, { op: 'update', preHead: 'OLDHEAD', startedAt: 1 })
    mockedReadGitHead.mockReturnValue('NEWHEAD')
    mockedRollback.mockResolvedValue(true)

    const recovered = await recoverInterruptedComfyOp(installPath)

    expect(recovered).toBe(true)
    expect(mockedRollback).toHaveBeenCalledWith(
      path.join(installPath, 'ComfyUI'), 'OLDHEAD', undefined,
    )
    expect(fs.existsSync(path.join(installPath, MARKER_NAME))).toBe(false)
  })

  it('is a no-op rollback but still clears the marker when HEAD already matches', async () => {
    await writeOpMarker(installPath, { op: 'restore', preHead: 'SAME', startedAt: 1 })
    mockedReadGitHead.mockReturnValue('SAME')

    const recovered = await recoverInterruptedComfyOp(installPath)

    expect(recovered).toBe(true)
    expect(mockedRollback).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(installPath, MARKER_NAME))).toBe(false)
  })
})
