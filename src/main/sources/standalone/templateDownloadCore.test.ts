import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import path from 'path'

// Back `t()` with the real en.json (vitest `__dirname` doesn't line up with the
// i18n module's relative `locales/` lookup), so the formatter is asserted
// against real English copy + interpolation.
const EN = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'locales', 'en.json'), 'utf-8'),
) as Record<string, Record<string, string>>
vi.mock('../../lib/i18n', () => ({
  t: (key: string, params?: Record<string, string | number>): string => {
    const [ns, k] = key.split('.')
    let s = EN[ns!]?.[k!]
    if (typeof s !== 'string') return key
    if (params) {
      s = s.replace(/\{(\w+)\}/g, (_, p: string) =>
        params[p] !== undefined ? String(params[p]) : `{${p}}`,
      )
    }
    return s
  },
}))

import {
  runPool,
  withRetry,
  truncateForMaxPath,
  templateStateToTrayEntries,
  describeDownloadFailure,
  summarizeTemplateState,
  formatTemplateSubStatus,
  type TemplateDownloadState,
  type FileProgress,
} from './templateDownloadCore'

const GB = 1024 * 1024 * 1024

function file(p: Partial<FileProgress>): FileProgress {
  return { name: 'm.safetensors', directory: 'checkpoints', received: 0, total: 0, done: false, failed: false, ...p }
}
function state(p: Partial<TemplateDownloadState>): TemplateDownloadState {
  return { status: 'downloading', files: [], estimatedTotalBytes: 0, speedMBs: 0, etaSecs: -1, ...p }
}

describe('summarizeTemplateState', () => {
  it('zero files → empty/100 done', () => {
    const s = summarizeTemplateState(state({ status: 'done', files: [] }))
    expect(s.fileCount).toBe(0)
    expect(s.receivedBytes).toBe(0)
    expect(s.percent).toBe(100)
  })

  it('sums received across files and reports the active one', () => {
    const s = summarizeTemplateState(state({
      files: [
        file({ name: 'a', received: 2 * GB, total: 2 * GB, done: true }),
        file({ name: 'b', received: 1 * GB, total: 4 * GB }),
      ],
    }))
    expect(s.receivedBytes).toBe(3 * GB)
    expect(s.totalBytes).toBe(6 * GB)
    expect(s.doneCount).toBe(1)
    expect(s.fileIndex).toBe(2) // 'b' is the first not-finished
    expect(s.currentFile).toBe('b')
    expect(s.percent).toBe(50)
  })

  it('falls back to the index estimate before real totals are known', () => {
    const s = summarizeTemplateState(state({
      estimatedTotalBytes: 4 * GB,
      files: [file({ name: 'a', received: 1 * GB, total: 0 })],
    }))
    expect(s.totalBytes).toBe(4 * GB) // estimate, since no real total yet
    expect(s.percent).toBe(25)
  })

  it('clamps in-progress percent to 99 and only "done" reaches 100', () => {
    const almost = summarizeTemplateState(state({
      files: [file({ received: 99.9 * GB / 100 * 100, total: 100 })],
      estimatedTotalBytes: 100,
    }))
    expect(almost.percent).toBeLessThanOrEqual(99)
    const done = summarizeTemplateState(state({ status: 'done', files: [file({ received: 100, total: 100, done: true })] }))
    expect(done.percent).toBe(100)
  })

  it('counts a failed file as terminal and advances the pointer past it', () => {
    const s = summarizeTemplateState(state({
      files: [file({ name: 'a', failed: true }), file({ name: 'b', received: 1, total: 2 })],
    }))
    expect(s.doneCount).toBe(1) // 'a' failed (terminal); 'b' still in-flight
    expect(s.currentFile).toBe('b') // pointer skipped past the failed 'a'
  })

  it('skipped-on-disk files contribute their bytes', () => {
    const s = summarizeTemplateState(state({
      status: 'done',
      files: [file({ name: 'a', received: 2 * GB, total: 2 * GB, done: true })],
    }))
    expect(s.receivedBytes).toBe(2 * GB)
    expect(s.totalBytes).toBe(2 * GB)
  })
})

describe('runPool', () => {
  it('runs every item exactly once', async () => {
    const seen: number[] = []
    await runPool([1, 2, 3, 4, 5], 2, async (n) => { seen.push(n) })
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5])
  })

  it('never exceeds the concurrency cap', async () => {
    let active = 0
    let peak = 0
    await runPool(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
    })
    expect(peak).toBeLessThanOrEqual(3)
  })

  it('stops scheduling new items once the signal aborts', async () => {
    const ctrl = new AbortController()
    const done: number[] = []
    const p = runPool(Array.from({ length: 10 }, (_, i) => i), 2, async (n) => {
      if (n === 1) ctrl.abort()
      await new Promise((r) => setTimeout(r, 2))
      done.push(n)
    }, ctrl.signal)
    await p
    expect(done.length).toBeLessThan(10) // aborted before scheduling all
  })

  it('cap is clamped to item count', async () => {
    let peak = 0, active = 0
    await runPool([1, 2], 10, async () => {
      active++; peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 2)); active--
    })
    expect(peak).toBeLessThanOrEqual(2)
  })
})

describe('withRetry', () => {
  it('returns the first success without re-running', async () => {
    let calls = 0
    const out = await withRetry(async () => { calls++; return 'ok' }, 2)
    expect(out).toBe('ok')
    expect(calls).toBe(1)
  })

  it('retries up to the budget then succeeds', async () => {
    let calls = 0
    const out = await withRetry(async () => {
      calls++
      if (calls < 3) throw new Error('flaky')
      return 'ok'
    }, 2)
    expect(out).toBe('ok')
    expect(calls).toBe(3) // 1 initial + 2 retries
  })

  it('rethrows the last error once the budget is exhausted', async () => {
    let calls = 0
    await expect(
      withRetry(async () => { calls++; throw new Error(`fail ${calls}`) }, 2),
    ).rejects.toThrow('fail 3')
    expect(calls).toBe(3)
  })

  it('stops immediately on a fatal error (no retry)', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => { calls++; throw new Error('Download cancelled') },
        2,
        { isFatal: (e) => (e as Error).message === 'Download cancelled' },
      ),
    ).rejects.toThrow('Download cancelled')
    expect(calls).toBe(1)
  })

  it('reports each re-attempt number to onRetry', async () => {
    const attempts: number[] = []
    await expect(
      withRetry(async () => { throw new Error('x') }, 2, {
        onRetry: (n) => attempts.push(n),
      }),
    ).rejects.toThrow()
    expect(attempts).toEqual([2, 3]) // before the 2nd and 3rd tries
  })
})

describe('truncateForMaxPath', () => {
  it('is a no-op off Windows', () => {
    const long = 'a'.repeat(400) + '.safetensors'
    expect(truncateForMaxPath('/models/checkpoints', long, 'darwin')).toBe(long)
  })

  it('leaves short Windows paths untouched', () => {
    expect(truncateForMaxPath('C:\\models', 'model.safetensors', 'win32')).toBe('model.safetensors')
  })

  it('truncates the stem (keeping the extension) when the full path is too long', () => {
    const dir = 'C:\\models\\checkpoints'
    const name = 'x'.repeat(300) + '.safetensors'
    const out = truncateForMaxPath(dir, name, 'win32')!
    expect(out.endsWith('.safetensors')).toBe(true)
    expect((dir + '\\' + out).length).toBeLessThanOrEqual(259)
  })

  it('returns null when even an empty stem cannot fit', () => {
    const dir = 'C:\\' + 'd'.repeat(260)
    expect(truncateForMaxPath(dir, 'model.safetensors', 'win32')).toBeNull()
  })
})

describe('describeDownloadFailure', () => {
  it('gives a login/license hint for a gated repo (401/403)', () => {
    const line = describeDownloadFailure('m.safetensors', 'Download failed: HTTP 401')
    expect(line).toMatch(/login or license/i)
    expect(line).toContain('m.safetensors')
    expect(describeDownloadFailure('m.safetensors', 'HTTP 403')).toMatch(/login or license/i)
  })

  it('passes through a generic failure with the in-app fallback note', () => {
    const line = describeDownloadFailure('m.safetensors', 'socket hang up')
    expect(line).toContain('socket hang up')
    expect(line).toMatch(/fall back to in-app/i)
    expect(line).not.toMatch(/login or license/i)
  })

  it('does not false-match a 401 inside an unrelated number', () => {
    // 4012 must not trip the gated-repo branch (word-boundary guard).
    expect(describeDownloadFailure('m.safetensors', 'wrote 4012 bytes then reset')).toMatch(
      /fall back to in-app/i,
    )
  })
})

describe('templateStateToTrayEntries', () => {
  it('maps one row per file with the right status', () => {
    const rows = templateStateToTrayEntries(state({
      files: [
        file({ name: 'a', received: 2 * GB, total: 2 * GB, done: true }),
        file({ name: 'b', received: 1 * GB, total: 4 * GB }),
        file({ name: 'c', failed: true }),
      ],
    }))
    expect(rows.map((r) => r.status)).toEqual(['completed', 'downloading', 'error'])
    expect(rows[1]!.progress).toBeCloseTo(0.25)
  })

  it('keys each row by a stable synthetic url so the tray updates in place', () => {
    const [row] = templateStateToTrayEntries(state({
      files: [file({ name: 'model.safetensors', directory: 'checkpoints' })],
    }))
    expect(row!.url).toBe('template-model://checkpoints/model.safetensors')
  })

  it('puts speed/ETA only on the first still-running row', () => {
    const rows = templateStateToTrayEntries(state({
      speedMBs: 8,
      etaSecs: 30,
      files: [
        file({ name: 'a', received: 1 * GB, total: 2 * GB }),
        file({ name: 'b', received: 0, total: 4 * GB }),
      ],
    }))
    expect(rows[0]!.speedBytesPerSec).toBeGreaterThan(0)
    expect(rows[0]!.etaSeconds).toBe(30)
    expect(rows[1]!.speedBytesPerSec).toBe(0)
    expect(rows[1]!.etaSeconds).toBe(0)
  })

  it('reports no live speed when nothing is downloading', () => {
    const rows = templateStateToTrayEntries(state({
      status: 'done',
      speedMBs: 5,
      files: [file({ name: 'a', received: 2 * GB, total: 2 * GB, done: true })],
    }))
    expect(rows[0]!.speedBytesPerSec).toBe(0)
  })
})

describe('formatTemplateSubStatus', () => {
  it('formats the downloading line with file/index/size/speed/eta', () => {
    const s = summarizeTemplateState(state({
      speedMBs: 5,
      etaSecs: 90,
      files: [
        file({ name: 'z_image_turbo.safetensors', received: 1.2 * GB, total: 4 * GB, done: false }),
      ],
      estimatedTotalBytes: 4 * GB,
    }))
    const out = formatTemplateSubStatus(s)
    expect(out).toContain('z_image_turbo.safetensors')
    expect(out).toContain('(1 of 1)')
    expect(out).toContain('MB/s')
  })

  it('uses dedicated strings for terminal states', () => {
    expect(formatTemplateSubStatus(summarizeTemplateState(state({ status: 'resolving' })))).toMatch(/resolv/i)
    expect(formatTemplateSubStatus(summarizeTemplateState(state({ status: 'done', files: [] })))).toMatch(/ready/i)
    expect(formatTemplateSubStatus(summarizeTemplateState(state({ status: 'cancelled' })))).toMatch(/cancel/i)
  })

  it('shows a disk-specific message for an insufficient-disk error', () => {
    const noSpace = formatTemplateSubStatus(
      summarizeTemplateState(state({ status: 'error', error: 'insufficient-disk' })),
    )
    const generic = formatTemplateSubStatus(
      summarizeTemplateState(state({ status: 'error', error: 'something-else' })),
    )
    expect(noSpace).toMatch(/disk space/i)
    expect(noSpace).not.toBe(generic)
  })
})
