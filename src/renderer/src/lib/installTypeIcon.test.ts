import { describe, it, expect } from 'vitest'
import { Cloud, Computer, LaptopMinimal, Globe, Box } from 'lucide-vue-next'

import { installTypeMetaFor } from './installTypeIcon'

describe('installTypeMetaFor', () => {
  it('maps `local` to the Standalone laptop icon', () => {
    const meta = installTypeMetaFor('local')
    expect(meta.key).toBe('standalone')
    expect(meta.icon).toBe(LaptopMinimal)
    expect(meta.labelKey).toBe('installType.standalone')
  })

  it('maps `cloud` to the Cloud icon', () => {
    const meta = installTypeMetaFor('cloud')
    expect(meta.key).toBe('cloud')
    expect(meta.icon).toBe(Cloud)
    expect(meta.labelKey).toBe('installType.cloud')
  })

  it('maps `desktop` to the Legacy Desktop tower icon — visibly distinct from Standalone', () => {
    const standalone = installTypeMetaFor('local')
    const legacy = installTypeMetaFor('desktop')
    expect(legacy.key).toBe('legacyDesktop')
    expect(legacy.icon).toBe(Computer)
    expect(legacy.labelKey).toBe('installType.legacyDesktop')
    // The whole point of Track G: Legacy Desktop must not share an icon
    // with the current Standalone install type.
    expect(legacy.icon).not.toBe(standalone.icon)
  })

  it('maps `remote` to the Globe icon', () => {
    const meta = installTypeMetaFor('remote')
    expect(meta.key).toBe('remote')
    expect(meta.icon).toBe(Globe)
    expect(meta.labelKey).toBe('installType.remote')
  })

  it('falls back to the generic Box icon for unknown / undefined / null categories', () => {
    for (const input of [undefined, null, '', 'something-else']) {
      const meta = installTypeMetaFor(input)
      expect(meta.key).toBe('unknown')
      expect(meta.icon).toBe(Box)
      expect(meta.labelKey).toBe('installType.unknown')
    }
  })
})
