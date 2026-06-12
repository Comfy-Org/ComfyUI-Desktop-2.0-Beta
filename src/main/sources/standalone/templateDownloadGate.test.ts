import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The gate (`awaitTemplateDownloadSettled`) polls the process-global download
// state that `startTemplateDownload` writes. We drive that state through the
// real public API while mocking only the heavy I/O underneath the task, so the
// poller's branching (terminal / skip / abort / absent) is exercised end-to-end.

const resolveTemplateModels = vi.fn<() => Promise<Array<Record<string, unknown>>>>()
const download = vi.fn()
const getDiskSpace = vi.fn(async () => ({ free: 1e15, total: 1e15 }))

vi.mock('./templateModels', () => ({ resolveTemplateModels: () => resolveTemplateModels() }))
vi.mock('../../lib/download', () => ({ download: (...a: unknown[]) => download(...a) }))
vi.mock('../../lib/disk', () => ({ getDiskSpace: () => getDiskSpace() }))
vi.mock('../../lib/comfyDownloadManager', () => ({
  getModelsBaseDir: () => '/tmp/models',
  setTemplateTrayMirror: vi.fn(),
  clearTemplateTrayMirror: vi.fn(),
}))
// Keep the task hermetic — never touch the real filesystem. `stat` rejects so
// the loop treats every file as "not present" and proceeds to `download`.
vi.mock('fs', () => ({
  default: {
    promises: {
      stat: vi.fn().mockRejectedValue(new Error('ENOENT')),
      mkdir: vi.fn().mockResolvedValue(undefined),
    },
  },
}))

import {
  awaitTemplateDownloadSettled,
  requestSkipTemplateDownload,
  abortTemplateDownload,
  startTemplateDownload,
  getTemplateDownloadState,
} from './templateDownloadTask'

const sendOutput = vi.fn()

function makeInstall(id: string) {
  return {
    id,
    bundledTemplateId: 't',
    bundledTemplateModelBytes: 1024,
  } as unknown as Parameters<typeof startTemplateDownload>[0]
}

/** Spin the microtask queue + fake-timer poll until the task settles the state. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(0)
  }
}

describe('awaitTemplateDownloadSettled', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resolveTemplateModels.mockReset()
    download.mockReset()
    sendOutput.mockReset()
    getDiskSpace.mockReset().mockResolvedValue({ free: 1e15, total: 1e15 })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("resolves 'absent' when there is no task for the install", async () => {
    const ctrl = new AbortController()
    await expect(awaitTemplateDownloadSettled('nope', ctrl.signal)).resolves.toBe('absent')
  })

  it("resolves 'done' once the task finishes (no models is an instant done)", async () => {
    resolveTemplateModels.mockResolvedValue([])
    startTemplateDownload(makeInstall('done-1'), 0, { sendOutput })
    await flush()
    expect(getTemplateDownloadState('done-1')?.status).toBe('done')

    const ctrl = new AbortController()
    await expect(awaitTemplateDownloadSettled('done-1', ctrl.signal)).resolves.toBe('done')
  })

  it("resolves 'error' when the task fails (resolve throws)", async () => {
    resolveTemplateModels.mockRejectedValue(new Error('network down'))
    startTemplateDownload(makeInstall('err-1'), 0, { sendOutput })
    await flush()
    expect(getTemplateDownloadState('err-1')?.status).toBe('error')

    const ctrl = new AbortController()
    await expect(awaitTemplateDownloadSettled('err-1', ctrl.signal)).resolves.toBe('error')
  })

  it("resolves 'error' on a disk-space pre-flight failure", async () => {
    resolveTemplateModels.mockResolvedValue([{ filename: 'm.safetensors', directory: 'checkpoints', url: 'u' }])
    getDiskSpace.mockResolvedValue({ free: 1, total: 1e15 })
    startTemplateDownload(makeInstall('err-disk'), 10 * 1024 ** 3, { sendOutput })
    await flush()
    expect(getTemplateDownloadState('err-disk')?.status).toBe('error')

    const ctrl = new AbortController()
    await expect(awaitTemplateDownloadSettled('err-disk', ctrl.signal)).resolves.toBe('error')
  })

  it("resolves 'cancelled' after abortTemplateDownload", async () => {
    // A never-resolving download keeps the task in-flight so abort can land.
    let release!: () => void
    resolveTemplateModels.mockResolvedValue([{ filename: 'm.safetensors', directory: 'checkpoints', url: 'u' }])
    download.mockImplementation(() => new Promise<void>((res) => { release = res }))
    startTemplateDownload(makeInstall('cancel-1'), 0, { sendOutput })
    await flush()

    abortTemplateDownload('cancel-1')
    const ctrl = new AbortController()
    await expect(awaitTemplateDownloadSettled('cancel-1', ctrl.signal)).resolves.toBe('cancelled')
    release()
  })

  it("resolves 'skipped' when the user requests skip mid-download", async () => {
    resolveTemplateModels.mockResolvedValue([{ filename: 'm.safetensors', directory: 'checkpoints', url: 'u' }])
    download.mockImplementation(() => new Promise<void>(() => { /* hangs */ }))
    startTemplateDownload(makeInstall('skip-1'), 0, { sendOutput })
    await flush()
    expect(getTemplateDownloadState('skip-1')?.status).not.toBe('done')

    const ctrl = new AbortController()
    const settled = awaitTemplateDownloadSettled('skip-1', ctrl.signal)
    requestSkipTemplateDownload('skip-1')
    await vi.advanceTimersByTimeAsync(300) // one poll tick
    await expect(settled).resolves.toBe('skipped')
  })

  it("resolves 'aborted' when the gate's own signal aborts (launch teardown)", async () => {
    resolveTemplateModels.mockResolvedValue([{ filename: 'm.safetensors', directory: 'checkpoints', url: 'u' }])
    download.mockImplementation(() => new Promise<void>(() => { /* hangs */ }))
    startTemplateDownload(makeInstall('abort-1'), 0, { sendOutput })
    await flush()

    const ctrl = new AbortController()
    const settled = awaitTemplateDownloadSettled('abort-1', ctrl.signal)
    ctrl.abort()
    await expect(settled).resolves.toBe('aborted')
  })

  it('clears the skip flag on settle so a later download for the same id is not pre-skipped', async () => {
    resolveTemplateModels.mockResolvedValue([{ filename: 'm.safetensors', directory: 'checkpoints', url: 'u' }])
    download.mockImplementation(() => new Promise<void>(() => { /* hangs */ }))
    startTemplateDownload(makeInstall('skip-clear'), 0, { sendOutput })
    await flush()

    const ctrl1 = new AbortController()
    const first = awaitTemplateDownloadSettled('skip-clear', ctrl1.signal)
    requestSkipTemplateDownload('skip-clear')
    await vi.advanceTimersByTimeAsync(300)
    await expect(first).resolves.toBe('skipped')

    // Second wait must NOT immediately resolve 'skipped' from the stale flag.
    const ctrl2 = new AbortController()
    const second = awaitTemplateDownloadSettled('skip-clear', ctrl2.signal)
    ctrl2.abort()
    await expect(second).resolves.toBe('aborted')
  })
})
