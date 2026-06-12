import { describe, it, expect } from 'vitest'
import { shouldWarnVram } from './bundledTemplates'

const GB = 1024 * 1024 * 1024

describe('shouldWarnVram', () => {
  it('warns when detected VRAM is below the recommendation', () => {
    expect(shouldWarnVram(6 * GB, 12 * GB)).toBe(true)
  })

  it('does not warn when detected VRAM meets or exceeds the recommendation', () => {
    expect(shouldWarnVram(12 * GB, 12 * GB)).toBe(false)
    expect(shouldWarnVram(24 * GB, 12 * GB)).toBe(false)
  })

  it('stays silent when detected VRAM is unknown (AMD/Intel/unknown)', () => {
    expect(shouldWarnVram(undefined, 12 * GB)).toBe(false)
  })

  it('stays silent when the template has no recommendation', () => {
    expect(shouldWarnVram(2 * GB, undefined)).toBe(false)
    expect(shouldWarnVram(2 * GB, 0)).toBe(false)
  })
})
