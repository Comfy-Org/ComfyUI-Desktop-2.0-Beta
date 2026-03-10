import { describe, it, expect } from 'vitest'
import { findBestVariant, stripVariantPrefix, sortedCardOptions } from './variants'
import type { FieldOption } from '../types/ipc'

function opt(value: string, overrides?: Partial<FieldOption>): FieldOption {
  return { value, label: value, ...overrides }
}

describe('findBestVariant', () => {
  const nvidia = opt('win-nvidia-cu128', { data: { variantId: 'win-nvidia-cu128' } })
  const amd = opt('win-amd', { data: { variantId: 'win-amd' }, recommended: true })
  const cpu = opt('win-cpu', { data: { variantId: 'win-cpu' } })
  const options = [nvidia, amd, cpu]

  it('prefers recommended over snapshot match', () => {
    expect(findBestVariant(options, 'win-nvidia-cu128')).toBe(amd)
  })

  it('returns recommended when no snapshot variant', () => {
    expect(findBestVariant(options, '')).toBe(amd)
  })

  it('falls back to snapshot match when no recommended', () => {
    const noRec = [
      opt('nvidia', { data: { variantId: 'win-nvidia-cu128' } }),
      opt('cpu', { data: { variantId: 'win-cpu' } }),
    ]
    expect(findBestVariant(noRec, 'linux-nvidia-cu128')).toBe(noRec[0])
  })

  it('snapshot match ignores platform prefix', () => {
    const noRec = [
      opt('nvidia', { data: { variantId: 'win-nvidia-cu128' } }),
      opt('cpu', { data: { variantId: 'win-cpu' } }),
    ]
    expect(findBestVariant(noRec, 'mac-nvidia-cu128')).toBe(noRec[0])
  })

  it('falls back to first option when no recommended and no snapshot match', () => {
    const noRec = [opt('a', { data: { variantId: 'a' } }), opt('b', { data: { variantId: 'b' } })]
    expect(findBestVariant(noRec, 'unknown')).toBe(noRec[0])
  })

  it('returns null for empty options', () => {
    expect(findBestVariant([], 'win-nvidia-cu128')).toBeNull()
  })
})

describe('stripVariantPrefix', () => {
  it('strips win- prefix', () => {
    expect(stripVariantPrefix('win-nvidia-cu128')).toBe('nvidia-cu128')
  })

  it('strips linux- prefix', () => {
    expect(stripVariantPrefix('linux-amd')).toBe('amd')
  })

  it('strips mac- prefix', () => {
    expect(stripVariantPrefix('mac-mps')).toBe('mps')
  })

  it('returns unchanged string without platform prefix', () => {
    expect(stripVariantPrefix('nvidia-cu128')).toBe('nvidia-cu128')
  })
})

describe('sortedCardOptions', () => {
  it('sorts by preferred vendor order', () => {
    const opts = [
      opt('cpu', { data: { variantId: 'win-cpu' } }),
      opt('nvidia', { data: { variantId: 'win-nvidia-cu128' } }),
      opt('amd', { data: { variantId: 'win-amd' } }),
    ]
    const sorted = sortedCardOptions(opts)
    expect(sorted.map((o) => o.value)).toEqual(['amd', 'nvidia', 'cpu'])
  })

  it('does not mutate the original array', () => {
    const opts = [opt('b', { data: { variantId: 'win-cpu' } }), opt('a', { data: { variantId: 'win-amd' } })]
    const original = [...opts]
    sortedCardOptions(opts)
    expect(opts).toEqual(original)
  })
})
