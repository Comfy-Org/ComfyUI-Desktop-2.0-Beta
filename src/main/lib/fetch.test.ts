import { EventEmitter } from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { R2_BASE_URL, R2_MIRROR_BASE_URL } from './r2Mirror'

vi.mock('./paths', () => ({ cacheDir: () => '/tmp/desktop-test-cache' }))
vi.mock('./safe-file', () => ({ writeFileSafe: vi.fn() }))

interface FakeRequest extends EventEmitter {
  setHeader: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
  __url: string
  __headers: Record<string, string>
}

const requests: FakeRequest[] = []

vi.mock('electron', () => ({
  net: {
    request: vi.fn((opts: { url: string }) => {
      const headers: Record<string, string> = {}
      const req = Object.assign(new EventEmitter(), {
        setHeader: vi.fn((k: string, v: string) => { headers[k] = v }),
        end: vi.fn(),
        __url: opts.url,
        __headers: headers,
      }) as FakeRequest
      requests.push(req)
      return req
    }),
  },
}))

import { _resetCacheForTest, fetchJSON } from './fetch'

function makeResponse(statusCode: number, body: string, headers: Record<string, string> = {}): EventEmitter & { statusCode: number; headers: Record<string, string> } {
  const res = Object.assign(new EventEmitter(), { statusCode, headers })
  setImmediate(() => {
    res.emit('data', body)
    res.emit('end')
  })
  return res
}

const PRIMARY = `${R2_BASE_URL}/latest.json`
const MIRROR = `${R2_MIRROR_BASE_URL}/latest.json`

describe('fetchJSON — happy path preserved by refactor', () => {
  beforeEach(() => { requests.length = 0; _resetCacheForTest() })

  it('returns primary body on 200', async () => {
    const p = fetchJSON(PRIMARY)
    requests[0]!.emit('response', makeResponse(200, '{"ok":true}', { etag: '"v1"' }))
    await expect(p).resolves.toEqual({ ok: true })
    expect(requests.length).toBe(1)
  })

  it('rejects with HTTP error on non-200, no mirror retry, no cached fallback', async () => {
    const p = fetchJSON(PRIMARY)
    requests[0]!.emit('response', makeResponse(500, ''))
    // Mirror IS tried on HTTP error — verify the mirror is the second request,
    // then make it also error so the call rejects.
    await new Promise((r) => setImmediate(r))
    expect(requests[1]?.__url).toBe(MIRROR)
    requests[1]!.emit('error', new Error('mirror down'))
    await expect(p).rejects.toThrow(/HTTP 500/)
  })

  it('rejects with parse error on malformed JSON, no cached fallback', async () => {
    const p = fetchJSON(PRIMARY)
    requests[0]!.emit('response', makeResponse(200, '{not valid'))
    await new Promise((r) => setImmediate(r))
    expect(requests[1]?.__url).toBe(MIRROR)
    requests[1]!.emit('error', new Error('mirror down'))
    await expect(p).rejects.toThrow(/Invalid JSON/)
  })
})

describe('fetchJSON — mirror fallback semantics', () => {
  beforeEach(() => { requests.length = 0; _resetCacheForTest() })

  it('retries the mirror when the primary connection errors', async () => {
    const p = fetchJSON(PRIMARY)
    requests[0]!.emit('error', new Error('ECONNRESET'))
    await new Promise((r) => setImmediate(r))
    expect(requests[1]?.__url).toBe(MIRROR)
    requests[1]!.emit('response', makeResponse(200, '{"from":"mirror"}'))
    await expect(p).resolves.toEqual({ from: 'mirror' })
  })

  it('does NOT send the primary If-None-Match to the mirror', async () => {
    // No prior cache entry; just verify the mirror leg gets fresh headers.
    const p = fetchJSON(PRIMARY)
    requests[0]!.emit('response', makeResponse(500, ''))
    await new Promise((r) => setImmediate(r))
    const mirrorReq = requests[1]!
    expect(mirrorReq.__url).toBe(MIRROR)
    expect(mirrorReq.__headers['If-None-Match']).toBeUndefined()
    mirrorReq.emit('response', makeResponse(200, '{"ok":true}', { etag: '"mirror-etag"' }))
    await expect(p).resolves.toEqual({ ok: true })
  })

  it('rejects with the primary error when both legs fail and no cache exists', async () => {
    const p = fetchJSON(PRIMARY)
    requests[0]!.emit('error', new Error('PRIMARY_DOWN'))
    await new Promise((r) => setImmediate(r))
    requests[1]!.emit('error', new Error('MIRROR_DOWN'))
    await expect(p).rejects.toThrow(/PRIMARY_DOWN/)
  })

  it('does not retry the mirror for URLs outside the R2 namespace', async () => {
    const p = fetchJSON('https://api.github.com/repos/x/y/releases')
    requests[0]!.emit('error', new Error('NETWORK_DOWN'))
    await expect(p).rejects.toThrow(/NETWORK_DOWN/)
    expect(requests.length).toBe(1)
  })
})

describe('fetchJSON — mirror is not allowed to poison the cache', () => {
  beforeEach(() => { requests.length = 0; _resetCacheForTest() })

  it('does NOT write a cache entry when the response came from the mirror', async () => {
    // Drive a mirror-served success, then make a second call and assert the
    // second call still goes to the primary without If-None-Match (i.e. the
    // first call wrote nothing to the cache).
    const p1 = fetchJSON(PRIMARY)
    requests[0]!.emit('error', new Error('PRIMARY_DOWN'))
    await new Promise((r) => setImmediate(r))
    requests[1]!.emit('response', makeResponse(200, '{"v":1}', { etag: '"mirror-etag-1"' }))
    await expect(p1).resolves.toEqual({ v: 1 })

    requests.length = 0
    const p2 = fetchJSON(PRIMARY)
    // No prior cache entry persisted from the mirror-served call, so no
    // conditional header.
    expect(requests[0]!.__headers['If-None-Match']).toBeUndefined()
    requests[0]!.emit('response', makeResponse(200, '{"v":2}', { etag: '"primary-etag"' }))
    await expect(p2).resolves.toEqual({ v: 2 })
  })

  it('DOES write a cache entry when the response came from the primary', async () => {
    const p1 = fetchJSON(PRIMARY)
    requests[0]!.emit('response', makeResponse(200, '{"v":1}', { etag: '"primary-etag-1"' }))
    await p1

    requests.length = 0
    const p2 = fetchJSON(PRIMARY)
    // The primary-served call DID populate the cache, so the second call
    // sends the primary's ETag.
    expect(requests[0]!.__headers['If-None-Match']).toBe('"primary-etag-1"')
    requests[0]!.emit('response', makeResponse(304, ''))
    await expect(p2).resolves.toEqual({ v: 1 })
  })
})
