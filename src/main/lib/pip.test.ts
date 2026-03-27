import { describe, it, expect } from 'vitest'
import { getPipIndexArgs, PYPI_INDEX_URL, PYPI_MIRROR_URLS } from './pip'

describe('getPipIndexArgs', () => {
  it('always uses pypi.org as --index-url', () => {
    const args = getPipIndexArgs()
    const idxPos = args.indexOf('--index-url')
    expect(idxPos).toBeGreaterThanOrEqual(0)
    expect(args[idxPos + 1]).toBe(PYPI_INDEX_URL)
  })

  it('does not include Chinese mirrors when useChineseMirrors is false or unset', () => {
    const args = getPipIndexArgs()
    for (const url of PYPI_MIRROR_URLS) {
      expect(args).not.toContain(url)
    }
    const extraCount = args.filter((a) => a === '--extra-index-url').length
    expect(extraCount).toBe(0)
  })

  it('includes Chinese mirrors as --extra-index-url when useChineseMirrors is true', () => {
    const args = getPipIndexArgs(undefined, true)
    for (const url of PYPI_MIRROR_URLS) {
      expect(args).toContain(url)
    }
    const extraCount = args.filter((a) => a === '--extra-index-url').length
    expect(extraCount).toBe(PYPI_MIRROR_URLS.length)
  })

  it('does not include --index-strategy', () => {
    const noMirror = getPipIndexArgs()
    expect(noMirror).not.toContain('--index-strategy')

    const withMirror = getPipIndexArgs('https://custom.mirror.example/simple/')
    expect(withMirror).not.toContain('--index-strategy')
  })

  it('adds user mirror as --extra-index-url when provided', () => {
    const mirror = 'https://custom.mirror.example/simple/'
    const args = getPipIndexArgs(mirror)
    // pypi.org is still --index-url
    const idxPos = args.indexOf('--index-url')
    expect(args[idxPos + 1]).toBe(PYPI_INDEX_URL)
    // user mirror is an extra
    const extras: string[] = []
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--extra-index-url') extras.push(args[i + 1]!)
    }
    expect(extras).toContain(mirror)
  })

  it('adds user mirror without Chinese mirrors when useChineseMirrors is false', () => {
    const mirror = 'https://custom.mirror.example/simple/'
    const args = getPipIndexArgs(mirror, false)
    const extras: string[] = []
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--extra-index-url') extras.push(args[i + 1]!)
    }
    expect(extras).toEqual([mirror])
  })

  it('adds user mirror and Chinese mirrors when useChineseMirrors is true', () => {
    const mirror = 'https://custom.mirror.example/simple/'
    const args = getPipIndexArgs(mirror, true)
    const extras: string[] = []
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--extra-index-url') extras.push(args[i + 1]!)
    }
    expect(extras).toContain(mirror)
    for (const url of PYPI_MIRROR_URLS) {
      expect(extras).toContain(url)
    }
    expect(extras.length).toBe(1 + PYPI_MIRROR_URLS.length)
  })

  it('deduplicates when user mirror matches pypi.org', () => {
    const args = getPipIndexArgs('https://pypi.org/simple/', true)
    const extras: string[] = []
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--extra-index-url') extras.push(args[i + 1]!)
    }
    expect(extras).not.toContain('https://pypi.org/simple/')
    expect(extras.length).toBe(PYPI_MIRROR_URLS.length)
  })

  it('deduplicates when user mirror matches pypi.org without trailing slash', () => {
    const args = getPipIndexArgs('https://pypi.org/simple', true)
    const extras: string[] = []
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--extra-index-url') extras.push(args[i + 1]!)
    }
    expect(extras.length).toBe(PYPI_MIRROR_URLS.length)
  })

  it('deduplicates when user mirror is one of the Chinese mirrors', () => {
    const mirror = PYPI_MIRROR_URLS[0]!
    const args = getPipIndexArgs(mirror, true)
    const extras: string[] = []
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--extra-index-url') extras.push(args[i + 1]!)
    }
    // mirror appears once as extra, not duplicated
    expect(extras.filter((u) => u === mirror).length).toBe(1)
    expect(extras.length).toBe(PYPI_MIRROR_URLS.length)
  })

  it('treats empty string as no mirror', () => {
    const args = getPipIndexArgs('')
    expect(args).toEqual(getPipIndexArgs())
  })

  it('treats whitespace-only string as no mirror', () => {
    const args = getPipIndexArgs('   ')
    expect(args).toEqual(getPipIndexArgs())
  })

  it('trims whitespace from mirror URL', () => {
    const mirror = '  https://custom.mirror.example/simple/  '
    const args = getPipIndexArgs(mirror)
    const extras: string[] = []
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--extra-index-url') extras.push(args[i + 1]!)
    }
    expect(extras).toContain('https://custom.mirror.example/simple/')
  })

  it('passes undefined the same as no argument', () => {
    expect(getPipIndexArgs(undefined)).toEqual(getPipIndexArgs())
  })
})
