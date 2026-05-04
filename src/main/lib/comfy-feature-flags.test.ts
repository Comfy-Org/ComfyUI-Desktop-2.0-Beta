import { describe, it, expect } from 'vitest'
import { parseFeatureFlagOutput } from './comfy-feature-flags'

describe('parseFeatureFlagOutput', () => {
  it('parses valid JSON output', () => {
    const stdout = JSON.stringify({
      show_signin_button: { type: 'bool', default: false, description: 'Show sign-in' },
    })
    expect(parseFeatureFlagOutput(stdout)).toEqual({
      show_signin_button: { type: 'bool', default: false, description: 'Show sign-in' },
    })
  })

  it('returns empty registry on malformed JSON', () => {
    expect(parseFeatureFlagOutput('not valid json {{{')).toEqual({})
  })

  it('returns empty registry on empty string', () => {
    expect(parseFeatureFlagOutput('')).toEqual({})
  })

  it('rejects JSON arrays (only flat object registries are valid)', () => {
    expect(parseFeatureFlagOutput(JSON.stringify(['not', 'a', 'registry']))).toEqual({})
  })

  it('rejects JSON null', () => {
    expect(parseFeatureFlagOutput('null')).toEqual({})
  })

  it('rejects JSON primitives', () => {
    expect(parseFeatureFlagOutput('42')).toEqual({})
    expect(parseFeatureFlagOutput('"a string"')).toEqual({})
    expect(parseFeatureFlagOutput('true')).toEqual({})
  })

  it('accepts an empty object', () => {
    expect(parseFeatureFlagOutput('{}')).toEqual({})
  })

  it('preserves multiple flag entries', () => {
    const stdout = JSON.stringify({
      flag_a: { type: 'bool', default: true, description: 'A' },
      flag_b: { type: 'int', default: 10, description: 'B' },
    })
    const reg = parseFeatureFlagOutput(stdout)
    expect(Object.keys(reg)).toEqual(['flag_a', 'flag_b'])
    expect(reg['flag_b']?.default).toBe(10)
  })
})
