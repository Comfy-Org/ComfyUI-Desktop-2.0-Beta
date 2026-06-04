import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { R2_BASE_URL, R2_MIRROR_BASE_URL } from './r2Mirror'

interface FakeRequest extends EventEmitter {
  setHeader: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
  abort: ReturnType<typeof vi.fn>
  __url: string
}

const requests: FakeRequest[] = []
const settingsState: Record<string, unknown> = {}

vi.mock('../settings', () => ({
  get: (key: string) => settingsState[key],
  set: (key: string, value: unknown) => { settingsState[key] = value },
}))

vi.mock('electron', () => ({
  net: {
    request: vi.fn((url: string) => {
      const req = Object.assign(new EventEmitter(), {
        setHeader: vi.fn(),
        end: vi.fn(),
        abort: vi.fn(),
        __url: url,
      }) as FakeRequest
      requests.push(req)
      return req
    }),
  },
}))

import { download } from './download'

function makeResponse(statusCode: number, body: Buffer | string, headers: Record<string, string | string[]> = {}): EventEmitter & { statusCode: number; headers: Record<string, string | string[]> } {
  const res = Object.assign(new EventEmitter(), { statusCode, headers })
  const buf = typeof body === 'string' ? Buffer.from(body) : body
  if (!headers['content-length']) headers['content-length'] = String(buf.length)
  setImmediate(() => {
    res.emit('data', buf)
    res.emit('end')
  })
  return res
}

const PRIMARY_BIN = `${R2_BASE_URL}/linux-nvidia/v0.20.1-env1/bundle.7z`
const MIRROR_BIN = `${R2_MIRROR_BASE_URL}/linux-nvidia/v0.20.1-env1/bundle.7z`

describe('download — R2 mirror fallback for binaries', () => {
  let tmpDir: string

  beforeEach(() => {
    requests.length = 0
    for (const k of Object.keys(settingsState)) delete settingsState[k]
    settingsState['useChineseMirrors'] = true
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'download-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('retries against the mirror when the primary connection errors before any bytes arrive', async () => {
    const dest = path.join(tmpDir, 'bundle.7z')
    const p = download(PRIMARY_BIN, dest, null)
    requests[0]!.emit('error', new Error('ECONNRESET'))
    await new Promise((r) => setImmediate(r))
    expect(requests[1]?.__url).toBe(MIRROR_BIN)
    const body = Buffer.from('mirror-served-bytes')
    requests[1]!.emit('response', makeResponse(200, body))
    await expect(p).resolves.toBe(dest)
    expect(fs.readFileSync(dest, 'utf-8')).toBe('mirror-served-bytes')
  })

  it('retries against the mirror when the primary responds with HTTP error and no bytes have been received', async () => {
    const dest = path.join(tmpDir, 'bundle.7z')
    const p = download(PRIMARY_BIN, dest, null)
    requests[0]!.emit('response', makeResponse(503, ''))
    await new Promise((r) => setImmediate(r))
    expect(requests[1]?.__url).toBe(MIRROR_BIN)
    requests[1]!.emit('response', makeResponse(200, Buffer.from('ok-via-mirror')))
    await expect(p).resolves.toBe(dest)
    expect(fs.readFileSync(dest, 'utf-8')).toBe('ok-via-mirror')
  })

  it('rejects with the primary error when both legs fail', async () => {
    const dest = path.join(tmpDir, 'bundle.7z')
    const p = download(PRIMARY_BIN, dest, null)
    requests[0]!.emit('error', new Error('PRIMARY_DOWN'))
    await new Promise((r) => setImmediate(r))
    requests[1]!.emit('error', new Error('MIRROR_DOWN'))
    await expect(p).rejects.toThrow(/PRIMARY_DOWN/)
  })

  it('does not retry the mirror for URLs outside the R2 namespace', async () => {
    const dest = path.join(tmpDir, 'other.7z')
    const p = download('https://example.com/other.7z', dest, null)
    requests[0]!.emit('error', new Error('NETWORK_DOWN'))
    await expect(p).rejects.toThrow(/NETWORK_DOWN/)
    expect(requests.length).toBe(1)
  })

  it('does NOT retry the mirror when useChineseMirrors is off (avoids thundering-herd on R2 blips)', async () => {
    settingsState['useChineseMirrors'] = false
    const dest = path.join(tmpDir, 'bundle.7z')
    const p = download(PRIMARY_BIN, dest, null)
    requests[0]!.emit('error', new Error('R2_BLIP'))
    await expect(p).rejects.toThrow(/R2_BLIP/)
    expect(requests.length).toBe(1)
  })

  it('does not retry the mirror when the recursive _skipMirror is set (no bounce-back)', async () => {
    // Internal contract: when download is called from inside the mirror-retry
    // branch, _skipMirror=true prevents infinite ping-pong if the mirror itself
    // happens to live under R2_MIRROR_BASE_URL (it doesn't today, but lock it).
    const dest = path.join(tmpDir, 'bundle.7z')
    const p = download(MIRROR_BIN, dest, null, { _skipMirror: true } as unknown as { _skipMirror: boolean })
    requests[0]!.emit('error', new Error('SECOND_DOWN'))
    await expect(p).rejects.toThrow(/SECOND_DOWN/)
    expect(requests.length).toBe(1)
  })
})
