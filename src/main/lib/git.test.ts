// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return { ...actual, execFile: vi.fn() }
})

import { execFile } from 'child_process'
import { countCommitsAhead } from './git'

const mockedExecFile = vi.mocked(execFile)

function mockExecFile(cb: (cmd: string, args: string[], opts: Record<string, unknown>, callback: (err: Error | null, stdout: string, stderr: string) => void) => void): void {
  mockedExecFile.mockImplementation(cb as never)
}

describe('countCommitsAhead', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('returns the count when git succeeds', async () => {
    mockExecFile((_cmd, _args, _opts, cb) => { cb(null, '21\n', '') })
    expect(await countCommitsAhead('/repo', 'v0.14.2')).toBe(21)
  })

  it('returns 0 when on the tag exactly', async () => {
    mockExecFile((_cmd, _args, _opts, cb) => { cb(null, '0\n', '') })
    expect(await countCommitsAhead('/repo', 'v0.14.2')).toBe(0)
  })

  it('returns undefined when git fails', async () => {
    mockExecFile((_cmd, _args, _opts, cb) => { cb(new Error('not found'), '', '') })
    expect(await countCommitsAhead('/repo', 'v0.14.2')).toBeUndefined()
  })

  it('returns undefined for non-numeric output', async () => {
    mockExecFile((_cmd, _args, _opts, cb) => { cb(null, 'bad\n', '') })
    expect(await countCommitsAhead('/repo', 'v0.14.2')).toBeUndefined()
  })
})
