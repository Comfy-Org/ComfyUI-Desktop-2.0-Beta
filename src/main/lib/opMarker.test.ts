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
import { writeOpMarker, readOpMarker, clearOpMarker, completeOpMarker, recoverInterruptedComfyOp } from './opMarker'

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
    // HEAD reads as moved first (triggers rollback), then as restored afterward.
    mockedReadGitHead.mockReturnValueOnce('NEWHEAD').mockReturnValue('OLDHEAD')
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

  it('never rolls back a completed marker (success whose unlink failed)', async () => {
    // postHead present => the op reached consistency; HEAD legitimately moved.
    await writeOpMarker(installPath, { op: 'update', preHead: 'OLD', startedAt: 1, postHead: 'NEW' })
    mockedReadGitHead.mockReturnValue('NEW')

    const recovered = await recoverInterruptedComfyOp(installPath)

    expect(recovered).toBe(true)
    expect(mockedRollback).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(installPath, MARKER_NAME))).toBe(false)
  })

  it('throws and records an attempt when the rollback fails (so next launch retries)', async () => {
    await writeOpMarker(installPath, { op: 'update', preHead: 'OLD', startedAt: 1 })
    mockedReadGitHead.mockReturnValue('NEW') // never reaches OLD
    mockedRollback.mockResolvedValue(false)

    await expect(recoverInterruptedComfyOp(installPath)).rejects.toThrow(/roll ComfyUI source back/i)
    const marker = readOpMarker(installPath)
    expect(marker).not.toBeNull()
    expect(marker!.recoveryAttempts).toBe(1)
  })

  it('gives up and drops the marker after MAX_RECOVERY_ATTEMPTS so launch is never bricked', async () => {
    // Pre-seed the marker as if two prior launches already failed to roll back.
    await writeOpMarker(installPath, { op: 'update', preHead: 'OLD', startedAt: 1, recoveryAttempts: 2 })
    mockedReadGitHead.mockReturnValue('NEW') // rollback can never reach OLD
    mockedRollback.mockResolvedValue(false)

    // The third attempt gives up instead of throwing, and clears the marker.
    const recovered = await recoverInterruptedComfyOp(installPath)
    expect(recovered).toBe(true)
    expect(fs.existsSync(path.join(installPath, MARKER_NAME))).toBe(false)
  })
})

describe('completeOpMarker', () => {
  it('stamps postHead then removes the marker', async () => {
    await writeOpMarker(installPath, { op: 'update', preHead: 'OLD', startedAt: 1 })
    mockedReadGitHead.mockReturnValue('NEW')

    await completeOpMarker(installPath)

    // Marker file removed on success.
    expect(fs.existsSync(path.join(installPath, MARKER_NAME))).toBe(false)
  })

  it('is safe when no marker exists', async () => {
    await expect(completeOpMarker(installPath)).resolves.toBeUndefined()
  })
})
