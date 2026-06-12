import { describe, it, expect } from 'vitest'
import { shouldWarnVram, buildTemplateDeeplink } from './bundledTemplates'

const GB = 1024 * 1024 * 1024

describe('shouldWarnVram', () => {
  it('warns when detected VRAM is below the recommendation', () => {
    expect(shouldWarnVram(6 * GB, 12 * GB)).toBe(true)
  })

  it('does not warn when detected VRAM meets or exceeds the recommendation', () => {
    expect(shouldWarnVram(12 * GB, 12 * GB)).toBe(false)
    expect(shouldWarnVram(24 * GB, 12 * GB)).toBe(false)
  })

  it('stays silent when detected VRAM is unknown (AMD/Intel/unknown)', () => {
    expect(shouldWarnVram(undefined, 12 * GB)).toBe(false)
  })

  it('stays silent when the template has no recommendation', () => {
    expect(shouldWarnVram(2 * GB, undefined)).toBe(false)
    expect(shouldWarnVram(2 * GB, 0)).toBe(false)
  })
})

describe('buildTemplateDeeplink', () => {
  it('appends ?template=<id>&source=default and round-trips the id', () => {
    const out = buildTemplateDeeplink('http://127.0.0.1:8188/', 'flux_schnell')
    const parsed = new URL(out)
    expect(parsed.searchParams.get('template')).toBe('flux_schnell')
    expect(parsed.searchParams.get('source')).toBe('default')
  })

  it('preserves an existing query and host/port', () => {
    const out = buildTemplateDeeplink('http://localhost:8000/?foo=bar', 'text_to_video_wan')
    const parsed = new URL(out)
    expect(parsed.host).toBe('localhost:8000')
    expect(parsed.searchParams.get('foo')).toBe('bar')
    expect(parsed.searchParams.get('template')).toBe('text_to_video_wan')
  })

  it('returns the input unchanged when the URL cannot be parsed', () => {
    expect(buildTemplateDeeplink('not a url', 'flux_schnell')).toBe('not a url')
  })
})
