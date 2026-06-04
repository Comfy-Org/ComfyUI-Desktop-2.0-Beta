import { EventEmitter } from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./paths', () => ({
  cacheDir: () => '/tmp/desktop-test-cache',
}))

vi.mock('./safe-file', () => ({
  writeFileSafe: vi.fn(),
}))

interface FakeRequest extends EventEmitter {
  setHeader: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
  __resolvedUrl: string
}

const requests: FakeRequest[] = []

vi.mock('electron', () => ({
  net: {
    request: vi.fn((opts: { url: string }) => {
      const req = Object.assign(new EventEmitter(), {
        setHeader: vi.fn(),
        end: vi.fn(),
        __resolvedUrl: opts.url,
      }) as FakeRequest
      requests.push(req)
      return req
    }),
  },
}))

import { fetchJSON } from './fetch'

function makeResponse(statusCode: number, body: string, headers: Record<string, string> = {}): EventEmitter & { statusCode: number; headers: Record<string, string> } {
  const res = Object.assign(new EventEmitter(), { statusCode, headers })
  setImmediate(() => {
    res.emit('data', body)
    res.emit('end')
  })
  return res
}

describe('fetchJSON mirror fallback', () => {
  beforeEach(() => {
    requests.length = 0
  })

  it('returns the primary response when the primary succeeds (mirror untouched)', async () => {
    const promise = fetchJSON('https://primary.example/x.json', {
      mirrorUrl: 'https://mirror.example/x.json',
    })
    // First request is the primary
    const req = requests[0]!
    expect(req.__resolvedUrl).toBe('https://primary.example/x.json')
    req.emit('response', makeResponse(200, '{"ok":true}'))
    await expect(promise).resolves.toEqual({ ok: true })
    expect(requests.length).toBe(1)
  })

  it('retries the mirror when the primary connection errors', async () => {
    const promise = fetchJSON('https://primary.example/x.json', {
      mirrorUrl: 'https://mirror.example/x.json',
    })
    const primary = requests[0]!
    primary.emit('error', new Error('ECONNRESET'))
    // Second request is the mirror
    await new Promise((r) => setImmediate(r))
    const mirror = requests[1]!
    expect(mirror.__resolvedUrl).toBe('https://mirror.example/x.json')
    mirror.emit('response', makeResponse(200, '{"from":"mirror"}'))
    await expect(promise).resolves.toEqual({ from: 'mirror' })
  })

  it('rejects with the primary error when both primary and mirror fail and no cache exists', async () => {
    const promise = fetchJSON('https://primary.example/y.json', {
      mirrorUrl: 'https://mirror.example/y.json',
    })
    requests[0]!.emit('error', new Error('PRIMARY_DOWN'))
    await new Promise((r) => setImmediate(r))
    requests[1]!.emit('error', new Error('MIRROR_DOWN'))
    await expect(promise).rejects.toThrow(/PRIMARY_DOWN/)
  })

  it('does not retry the mirror when none is supplied', async () => {
    const promise = fetchJSON('https://primary.example/z.json')
    requests[0]!.emit('error', new Error('NETWORK_DOWN'))
    await expect(promise).rejects.toThrow(/NETWORK_DOWN/)
    expect(requests.length).toBe(1)
  })

  it('does not retry the mirror when it equals the primary URL', async () => {
    const url = 'https://primary.example/same.json'
    const promise = fetchJSON(url, { mirrorUrl: url })
    requests[0]!.emit('error', new Error('SAME_URL_FAIL'))
    await expect(promise).rejects.toThrow(/SAME_URL_FAIL/)
    expect(requests.length).toBe(1)
  })
})
