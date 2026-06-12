import { describe, it, expect } from 'vitest'
import { templateDiskRequiredBytes } from './installHelpers'

const GB = 1024 * 1024 * 1024

describe('templateDiskRequiredBytes', () => {
  it('is zero for a model-free template (nothing to block on)', () => {
    expect(templateDiskRequiredBytes(0)).toBe(0)
    expect(templateDiskRequiredBytes(-1)).toBe(0)
  })

  it('adds headroom over the raw model size', () => {
    const required = templateDiskRequiredBytes(2 * GB)
    expect(required).toBeGreaterThan(2 * GB)
    expect(required).toBe(Math.ceil(2 * GB * 1.1))
  })
})
