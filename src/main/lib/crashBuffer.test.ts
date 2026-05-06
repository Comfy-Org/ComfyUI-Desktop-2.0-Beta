import { beforeEach, describe, expect, it } from 'vitest'

import { MAX_BUFFER_BYTES, clearCrash, getCrash, recordCrash, _resetCrashBuffer } from './crashBuffer'

describe('crashBuffer', () => {
  beforeEach(() => {
    _resetCrashBuffer()
  })

  it('returns null for an unknown installation', () => {
    expect(getCrash('inst-1')).toBeNull()
  })

  it('records and retrieves a crash payload', () => {
    recordCrash({
      installationId: 'inst-1',
      installationName: 'Local',
      crashed: true,
      exitCode: 137,
      lastStderr: 'OOM\n',
    })
    const stored = getCrash('inst-1')
    expect(stored).not.toBeNull()
    expect(stored?.exitCode).toBe(137)
    expect(stored?.lastStderr).toBe('OOM\n')
    expect(stored?.installationName).toBe('Local')
  })

  it('caps lastStderr at MAX_BUFFER_BYTES, keeping the tail', () => {
    const overSize = MAX_BUFFER_BYTES + 4096
    const big = 'x'.repeat(overSize - 5) + 'TAILS'
    recordCrash({
      installationId: 'inst-1',
      installationName: 'Local',
      crashed: true,
      exitCode: 1,
      lastStderr: big,
    })
    const stored = getCrash('inst-1')
    expect(stored?.lastStderr?.length).toBe(MAX_BUFFER_BYTES)
    expect(stored?.lastStderr?.endsWith('TAILS')).toBe(true)
  })

  it('clearCrash removes the entry', () => {
    recordCrash({
      installationId: 'inst-1',
      installationName: 'Local',
      crashed: true,
      exitCode: 1,
      lastStderr: 'oops',
    })
    clearCrash('inst-1')
    expect(getCrash('inst-1')).toBeNull()
  })

  it('overwrites a prior crash for the same installation', () => {
    recordCrash({
      installationId: 'inst-1',
      installationName: 'Local',
      crashed: true,
      exitCode: 1,
      lastStderr: 'first',
    })
    recordCrash({
      installationId: 'inst-1',
      installationName: 'Local',
      crashed: true,
      exitCode: 2,
      lastStderr: 'second',
    })
    expect(getCrash('inst-1')?.lastStderr).toBe('second')
    expect(getCrash('inst-1')?.exitCode).toBe(2)
  })
})
