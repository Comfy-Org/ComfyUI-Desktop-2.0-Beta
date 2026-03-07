import { describe, it, expect } from 'vitest'
import { getPipIndexArgs, PYPI_FALLBACK_INDEX_URLS } from './pip'

describe('getPipIndexArgs', () => {
  it('returns only --extra-index-url flags when no mirror is set', () => {
    const args = getPipIndexArgs()
    expect(args).not.toContain('--index-url')
    for (const url of PYPI_FALLBACK_INDEX_URLS) {
      expect(args).toContain(url)
    }
    const extraCount = args.filter((a) => a === '--extra-index-url').length
    expect(extraCount).toBe(PYPI_FALLBACK_INDEX_URLS.length)
  })

  it('sets --index-url when a mirror is provided', () => {
    const mirror = 'https://custom.mirror.example/simple/'
    const args = getPipIndexArgs(mirror)
    const idxPos = args.indexOf('--index-url')
    expect(idxPos).toBeGreaterThanOrEqual(0)
    expect(args[idxPos + 1]).toBe(mirror)
  })

  it('excludes the mirror from --extra-index-url to avoid duplication', () => {
    const mirror = PYPI_FALLBACK_INDEX_URLS[0]!
    const args = getPipIndexArgs(mirror)
    const extras: string[] = []
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--extra-index-url') extras.push(args[i + 1]!)
    }
    expect(extras).not.toContain(mirror)
    expect(extras.length).toBe(PYPI_FALLBACK_INDEX_URLS.length - 1)
  })

  it('treats empty string as no mirror', () => {
    const args = getPipIndexArgs('')
    expect(args).not.toContain('--index-url')
    expect(args).toEqual(getPipIndexArgs())
  })

  it('treats whitespace-only string as no mirror', () => {
    const args = getPipIndexArgs('   ')
    expect(args).not.toContain('--index-url')
    expect(args).toEqual(getPipIndexArgs())
  })

  it('deduplicates when mirror differs only by trailing slash', () => {
    const mirror = 'https://pypi.org/simple'
    const args = getPipIndexArgs(mirror)
    const extras: string[] = []
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--extra-index-url') extras.push(args[i + 1]!)
    }
    // pypi.org/simple/ is in PYPI_FALLBACK_INDEX_URLS — should be deduped
    expect(extras).not.toContain('https://pypi.org/simple/')
    expect(extras.length).toBe(PYPI_FALLBACK_INDEX_URLS.length - 1)
  })

  it('trims whitespace from mirror URL', () => {
    const mirror = '  https://custom.mirror.example/simple/  '
    const args = getPipIndexArgs(mirror)
    const idxPos = args.indexOf('--index-url')
    expect(args[idxPos + 1]).toBe('https://custom.mirror.example/simple/')
  })

  it('passes undefined the same as no argument', () => {
    expect(getPipIndexArgs(undefined)).toEqual(getPipIndexArgs())
  })
})
