import { describe, it, expect } from 'vitest'
import { templateDiskRequiredBytes, isTemplateDiskBlocked } from './installHelpers'

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

describe('isTemplateDiskBlocked', () => {
  it('does not block when disk space is unknown yet', () => {
    expect(isTemplateDiskBlocked(null, 2 * GB)).toBe(false)
  })

  it('does not block a model-free template', () => {
    expect(isTemplateDiskBlocked({ free: 0, total: 100 * GB }, 0)).toBe(false)
  })

  it('blocks when free space is below model size + headroom', () => {
    // 2 GB models → ~2.2 GB required; 2.1 GB free is short.
    expect(isTemplateDiskBlocked({ free: 2.1 * GB, total: 100 * GB }, 2 * GB)).toBe(true)
  })

  it('allows when free space covers model size + headroom', () => {
    expect(isTemplateDiskBlocked({ free: 3 * GB, total: 100 * GB }, 2 * GB)).toBe(false)
  })
})
