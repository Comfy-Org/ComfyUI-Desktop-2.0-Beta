import { describe, expect, it } from 'vitest'
import { resolveDeepLink } from './deepLink'

describe('resolveDeepLink', () => {
  describe('valid links', () => {
    it('resolves a path link to the cloud origin', () => {
      expect(resolveDeepLink('comfy://open?path=/workflows/123')).toBe(
        'https://cloud.comfy.org/workflows/123'
      )
    })

    it('resolves the bare cloud root path', () => {
      expect(resolveDeepLink('comfy://open?path=/')).toBe('https://cloud.comfy.org/')
    })

    it('preserves a query string on a path link', () => {
      // The query rides along in the `path` value. A fragment cannot: an
      // unencoded `#` belongs to the outer `comfy://` URL, so anything that
      // needs a hash must use the encoded `url=` form below.
      expect(resolveDeepLink('comfy://open?path=/workflows/123?tab=runs')).toBe(
        'https://cloud.comfy.org/workflows/123?tab=runs'
      )
    })

    it('preserves query and hash via an encoded url param', () => {
      const target = 'https://cloud.comfy.org/workflows/123?tab=runs#top'
      expect(resolveDeepLink(`comfy://open?url=${encodeURIComponent(target)}`)).toBe(target)
    })

    it('resolves a full cloud url param', () => {
      expect(resolveDeepLink('comfy://open?url=https://cloud.comfy.org/x')).toBe(
        'https://cloud.comfy.org/x'
      )
    })

    it('prefers url over path when both are present', () => {
      expect(
        resolveDeepLink('comfy://open?url=https://cloud.comfy.org/a&path=/b')
      ).toBe('https://cloud.comfy.org/a')
    })
  })

  describe('rejected: wrong scheme', () => {
    it('rejects https scheme', () => {
      expect(resolveDeepLink('https://cloud.comfy.org/workflows/123')).toBeNull()
    })

    it('rejects http scheme', () => {
      expect(resolveDeepLink('http://cloud.comfy.org/workflows/123')).toBeNull()
    })

    it('rejects file scheme', () => {
      expect(resolveDeepLink('file:///etc/passwd')).toBeNull()
    })

    it('rejects javascript scheme', () => {
      expect(resolveDeepLink('javascript:alert(1)')).toBeNull()
    })
  })

  describe('rejected: disallowed origin', () => {
    it('rejects a non-cloud origin in url param', () => {
      expect(resolveDeepLink('comfy://open?url=https://evil.com')).toBeNull()
    })

    it('rejects a non-cloud origin with a cloud-looking subdomain', () => {
      expect(
        resolveDeepLink('comfy://open?url=https://cloud.comfy.org.evil.com/x')
      ).toBeNull()
    })

    it('rejects an http cloud url param (origin includes scheme)', () => {
      expect(resolveDeepLink('comfy://open?url=http://cloud.comfy.org/x')).toBeNull()
    })
  })

  describe('rejected: path tricks', () => {
    it('rejects protocol-relative path', () => {
      expect(resolveDeepLink('comfy://open?path=//evil.com')).toBeNull()
    })

    it('rejects an absolute https url passed as path', () => {
      expect(resolveDeepLink('comfy://open?path=https://evil.com')).toBeNull()
    })

    it('rejects a backslash trick path', () => {
      expect(resolveDeepLink('comfy://open?path=/\\evil.com')).toBeNull()
    })

    it('rejects a relative path', () => {
      expect(resolveDeepLink('comfy://open?path=workflows/123')).toBeNull()
    })

    it('rejects a missing path/url', () => {
      expect(resolveDeepLink('comfy://open')).toBeNull()
    })

    it('rejects an empty path', () => {
      expect(resolveDeepLink('comfy://open?path=')).toBeNull()
    })
  })

  describe('rejected: malformed input', () => {
    it('rejects an empty string', () => {
      expect(resolveDeepLink('')).toBeNull()
    })

    it('rejects garbage', () => {
      expect(resolveDeepLink('not a url at all')).toBeNull()
    })

    it('rejects a non-string input', () => {
      // @ts-expect-error exercising the runtime guard against non-string input
      expect(resolveDeepLink(undefined)).toBeNull()
    })
  })
})
