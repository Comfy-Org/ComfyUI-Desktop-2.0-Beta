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
})
