import { afterEach, describe, expect, it, vi } from 'vitest'
import { withCloudDistributionUtm } from './cloudUrl'

// The default deviceIdProvider reads (and may write) a file under the
// user data dir via `getDeviceId`. Inject a no-op provider so the UTM
// assertions don't depend on disk state and don't leak fixtures.
const noDeviceId = () => null

describe('withCloudDistributionUtm', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('adds default UTM params for cloud distribution links', () => {
    const result = withCloudDistributionUtm('https://cloud.comfy.org/', noDeviceId)
    const url = new URL(result)

    expect(url.hostname).toBe('cloud.comfy.org')
    expect(url.searchParams.get('utm_source')).toBe('comfy.desktop')
    expect(url.searchParams.get('utm_medium')).toBe('app_feature')
    expect(url.searchParams.has('utm_campaign')).toBe(false)
  })

  it('preserves existing query params and UTM overrides', () => {
    const result = withCloudDistributionUtm(
      'https://cloud.comfy.org/path?plan=pro&utm_source=custom-source',
      noDeviceId
    )
    const url = new URL(result)

    expect(url.searchParams.get('plan')).toBe('pro')
    expect(url.searchParams.get('utm_source')).toBe('custom-source')
    expect(url.searchParams.get('utm_medium')).toBe('app_feature')
    expect(url.searchParams.has('utm_campaign')).toBe(false)
  })

  it('does not modify non-cloud URLs', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const input = 'https://example.com/path?plan=pro'
    expect(withCloudDistributionUtm(input, noDeviceId)).toBe(input)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('returns invalid URLs unchanged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(withCloudDistributionUtm('not a url', noDeviceId)).toBe('not a url')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('appends desktop_device_id when a device id is available', () => {
    const url = new URL(
      withCloudDistributionUtm('https://cloud.comfy.org/path', () => 'abc-123')
    )

    expect(url.searchParams.get('desktop_device_id')).toBe('abc-123')
    expect(url.searchParams.get('utm_source')).toBe('comfy.desktop')
  })

  it('does not append desktop_device_id when the provider returns null', () => {
    const url = new URL(
      withCloudDistributionUtm('https://cloud.comfy.org/path', () => null)
    )

    expect(url.searchParams.has('desktop_device_id')).toBe(false)
  })

  it('preserves caller-supplied desktop_device_id over the provider', () => {
    const url = new URL(
      withCloudDistributionUtm(
        'https://cloud.comfy.org/path?desktop_device_id=caller-explicit',
        () => 'provider-id'
      )
    )

    expect(url.searchParams.get('desktop_device_id')).toBe('caller-explicit')
  })
})
