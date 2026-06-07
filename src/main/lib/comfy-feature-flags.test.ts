import { describe, it, expect, beforeEach } from 'vitest'
import {
  parseFeatureFlagOutput,
  getCachedFeatureFlagRegistry,
  isCachedFeatureFlagAvailable,
  clearFeatureFlagRegistryCache,
  getComfyFeatureFlagRegistry,
} from './comfy-feature-flags'

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

describe('feature-flag registry cache accessors', () => {
  const installationId = 'cache-test-install'
  // A path that can't be executed, so discovery fails and caches {} —
  // exercising the spawn-free accessors without needing a real Python.
  const badPython = '/nonexistent/python-binary'

  beforeEach(() => {
    clearFeatureFlagRegistryCache(installationId)
  })

  it('returns null before any discovery has run', () => {
    expect(getCachedFeatureFlagRegistry(installationId)).toBeNull()
    expect(isCachedFeatureFlagAvailable(installationId, 'supports_terminal')).toBe(false)
  })

  it('caches an empty registry after a failed discovery and reports flags absent', async () => {
    await getComfyFeatureFlagRegistry(badPython, 'main.py', process.cwd(), installationId, '1.0.0')
    expect(getCachedFeatureFlagRegistry(installationId)).toEqual({})
    expect(isCachedFeatureFlagAvailable(installationId, 'supports_terminal')).toBe(false)
  })

  it('matches a cached version and rejects a mismatched one', async () => {
    await getComfyFeatureFlagRegistry(badPython, 'main.py', process.cwd(), installationId, '1.0.0')
    expect(getCachedFeatureFlagRegistry(installationId, '1.0.0')).toEqual({})
    expect(getCachedFeatureFlagRegistry(installationId, '2.0.0')).toBeNull()
    // A version-less query always hits the cache.
    expect(getCachedFeatureFlagRegistry(installationId)).toEqual({})
  })

  it('clears the cache back to a miss', async () => {
    await getComfyFeatureFlagRegistry(badPython, 'main.py', process.cwd(), installationId, '1.0.0')
    clearFeatureFlagRegistryCache(installationId)
    expect(getCachedFeatureFlagRegistry(installationId)).toBeNull()
  })
})
