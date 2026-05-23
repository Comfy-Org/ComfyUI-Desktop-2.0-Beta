import { describe, it, expect } from 'vitest'
import {
  deriveGpuTier,
  toCountBucket,
  toErrorBucket,
  toFileExtension,
  toModelDirectoryBucket,
  toSizeBucket,
  toVariantBucket,
} from './telemetry'

describe('toErrorBucket', () => {
  it('returns "unknown" for empty', () => {
    expect(toErrorBucket('')).toBe('unknown')
  })
  it('detects cancellation', () => {
    expect(toErrorBucket('Operation cancelled by user')).toBe('cancelled')
  })
  it('detects timeout / network / disk / permissions / path', () => {
    expect(toErrorBucket('timeout reached')).toBe('timeout')
    expect(toErrorBucket('fetch failed')).toBe('network')
    expect(toErrorBucket('no disk space')).toBe('disk')
    expect(toErrorBucket('permission denied')).toBe('permissions')
    expect(toErrorBucket('invalid path: missing')).toBe('path')
  })
  it('falls back to "other"', () => {
    expect(toErrorBucket('unexpected boom')).toBe('other')
  })
})

describe('toVariantBucket', () => {
  it('strips the platform prefix', () => {
    expect(toVariantBucket('win-x64-cuda')).toBe('x64-cuda')
    expect(toVariantBucket('mac-arm64-mps')).toBe('arm64-mps')
    expect(toVariantBucket('linux-x64-cpu')).toBe('x64-cpu')
  })
  it('handles missing variant', () => {
    expect(toVariantBucket(undefined)).toBe('unknown')
  })
})

describe('toCountBucket', () => {
  it('buckets common ranges', () => {
    expect(toCountBucket(0)).toBe('0')
    expect(toCountBucket(1)).toBe('1')
    expect(toCountBucket(2)).toBe('2')
    expect(toCountBucket(4)).toBe('3_4')
    expect(toCountBucket(9)).toBe('5_9')
    expect(toCountBucket(50)).toBe('10_plus')
  })
})

describe('toSizeBucket', () => {
  it('buckets by byte size', () => {
    expect(toSizeBucket(undefined)).toBe('unknown')
    expect(toSizeBucket(1024)).toBe('lt_10mb')
    expect(toSizeBucket(50 * 1024 * 1024)).toBe('10_99mb')
    expect(toSizeBucket(500 * 1024 * 1024)).toBe('100mb_1gb')
    expect(toSizeBucket(5 * 1024 * 1024 * 1024)).toBe('gte_1gb')
  })
})

describe('toFileExtension', () => {
  it('extracts the lowercased extension', () => {
    expect(toFileExtension('model.SafeTensors')).toBe('safetensors')
    expect(toFileExtension('archive.tar.gz')).toBe('gz')
    expect(toFileExtension('nodot')).toBe('none')
    expect(toFileExtension(undefined)).toBe('unknown')
  })
})

describe('toModelDirectoryBucket', () => {
  it('returns the known leaf directory', () => {
    expect(toModelDirectoryBucket('/var/models/checkpoints')).toBe('checkpoints')
    expect(toModelDirectoryBucket('C:\\models\\loras')).toBe('loras')
    expect(toModelDirectoryBucket('/models/some_custom_dir')).toBe('other')
    expect(toModelDirectoryBucket(undefined)).toBe('unknown')
  })
})

describe('deriveGpuTier', () => {
  it('returns apple for Apple-vendor GPUs regardless of VRAM', () => {
    expect(deriveGpuTier({ vendor: 'apple', vramGb: null })).toBe('apple')
    expect(deriveGpuTier({ vendor: 'Apple', vramGb: 8 })).toBe('apple')
  })

  it('returns high for NVIDIA / AMD with ≥ 24 GB VRAM', () => {
    expect(deriveGpuTier({ vendor: 'nvidia', vramGb: 24 })).toBe('high')
    expect(deriveGpuTier({ vendor: 'nvidia', vramGb: 80 })).toBe('high')
    expect(deriveGpuTier({ vendor: 'amd', vramGb: 24 })).toBe('high')
  })

  it('returns mid for 12-23 GB VRAM', () => {
    expect(deriveGpuTier({ vendor: 'nvidia', vramGb: 12 })).toBe('mid')
    expect(deriveGpuTier({ vendor: 'nvidia', vramGb: 23 })).toBe('mid')
  })

  it('returns low for 6-11 GB VRAM', () => {
    expect(deriveGpuTier({ vendor: 'nvidia', vramGb: 6 })).toBe('low')
    expect(deriveGpuTier({ vendor: 'nvidia', vramGb: 11 })).toBe('low')
  })

  it('returns sub_low for NVIDIA / AMD < 6 GB and non-NVIDIA / non-AMD discrete cards', () => {
    expect(deriveGpuTier({ vendor: 'nvidia', vramGb: 4 })).toBe('sub_low')
    expect(deriveGpuTier({ vendor: 'intel', vramGb: 16 })).toBe('sub_low')
  })

  it('returns cpu_only when vendor or VRAM is missing', () => {
    expect(deriveGpuTier({ vendor: null, vramGb: 8 })).toBe('cpu_only')
    expect(deriveGpuTier({ vendor: 'nvidia', vramGb: 0 })).toBe('cpu_only')
    expect(deriveGpuTier({ vendor: 'nvidia', vramGb: null })).toBe('cpu_only')
  })
})
