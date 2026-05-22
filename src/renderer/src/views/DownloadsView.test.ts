import { createTestingPinia } from '@pinia/testing'
import { setActivePinia } from 'pinia'
import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ElectronApi, ModelDownloadProgress } from '../types/ipc'
import DownloadsView from './DownloadsView.vue'
import { useDownloadStore } from '../stores/downloadStore'

function makeProgress(
  overrides: Partial<ModelDownloadProgress> & { url: string },
): ModelDownloadProgress {
  return {
    filename: 'model.safetensors',
    progress: 0,
    status: 'pending',
    ...overrides,
  }
}

interface MockApiState {
  pauseCalls: string[]
  resumeCalls: string[]
  cancelCalls: string[]
  showInFolderCalls: string[]
  dismissCalls: string[]
  clearFinishedCalls: number
}

function installMockApi(): MockApiState {
  const calls: MockApiState = {
    pauseCalls: [],
    resumeCalls: [],
    cancelCalls: [],
    showInFolderCalls: [],
    dismissCalls: [],
    clearFinishedCalls: 0,
  }
  // Removal/cleared broadcasts are how main keeps every renderer
  // surface in sync — the store waits for these instead of mutating
  // locally. The mocks fake the round-trip so per-row Remove and
  // Clear-finished tests still observe the entry leaving the store.
  let removedCb: ((data: { url: string }) => void) | null = null
  let clearedCb: ((data: { urls: string[] }) => void) | null = null
  window.api = {
    platform: 'darwin',
    listModelDownloads: vi.fn().mockResolvedValue([]),
    onModelDownloadProgress: vi.fn(() => vi.fn()),
    onModelDownloadRemoved: vi.fn((cb: (data: { url: string }) => void) => {
      removedCb = cb
      return vi.fn()
    }),
    onModelDownloadsClearedFinished: vi.fn(
      (cb: (data: { urls: string[] }) => void) => {
        clearedCb = cb
        return vi.fn()
      },
    ),
    pauseModelDownload: vi.fn((url: string) => {
      calls.pauseCalls.push(url)
      return Promise.resolve()
    }),
    resumeModelDownload: vi.fn((url: string) => {
      calls.resumeCalls.push(url)
      return Promise.resolve()
    }),
    cancelModelDownload: vi.fn((url: string) => {
      calls.cancelCalls.push(url)
      return Promise.resolve()
    }),
    showDownloadInFolder: vi.fn((path: string) => {
      calls.showInFolderCalls.push(path)
      return Promise.resolve()
    }),
    dismissModelDownload: vi.fn((url: string) => {
      calls.dismissCalls.push(url)
      removedCb?.({ url })
      return Promise.resolve(true)
    }),
    clearFinishedModelDownloads: vi.fn(() => {
      calls.clearFinishedCalls += 1
      // The fake broadcast mirrors main's contract: emit the urls of
      // every terminal entry currently in the store.
      const urls = useDownloadStore()
        .finishedDownloads.map((d) => d.url)
      clearedCb?.({ urls })
      return Promise.resolve(urls.length)
    }),
  } as unknown as ElectronApi
  return calls
}

describe('views/DownloadsView (Settings → Downloads tab)', () => {
  let apiCalls: MockApiState

  beforeEach(() => {
    apiCalls = installMockApi()
    setActivePinia(createTestingPinia({ stubActions: false }))
  })

  it('shows the empty placeholder when the store has no entries', async () => {
    const wrapper = mount(DownloadsView)
    await flushPromises()
    expect(wrapper.find('.downloads-tab-empty').text()).toContain(
      'No downloads to show',
    )
    expect(wrapper.findAll('.downloads-tab-item').length).toBe(0)
  })

  it('lists active entries before finished entries by default', async () => {
    const store = useDownloadStore()
    store.upsert(
      makeProgress({
        url: 'https://example.com/dl.bin',
        filename: 'dl.bin',
        progress: 0.4,
        status: 'downloading',
      }),
    )
    store.upsert(
      makeProgress({
        url: 'https://example.com/done.bin',
        filename: 'done.bin',
        progress: 1,
        status: 'completed',
        savePath: '/tmp/done.bin',
      }),
    )
    const wrapper = mount(DownloadsView)
    await flushPromises()
    const items = wrapper.findAll('.downloads-tab-item')
    expect(items.length).toBe(2)
    expect(items[0]!.find('.downloads-tab-name').text()).toBe('dl.bin')
    expect(items[1]!.find('.downloads-tab-name').text()).toBe('done.bin')
  })

  it('filters entries by status when chips are clicked', async () => {
    const store = useDownloadStore()
    store.upsert(
      makeProgress({
        url: 'https://example.com/a',
        filename: 'a.bin',
        progress: 0.4,
        status: 'downloading',
      }),
    )
    store.upsert(
      makeProgress({
        url: 'https://example.com/b',
        filename: 'b.bin',
        progress: 1,
        status: 'completed',
      }),
    )
    store.upsert(
      makeProgress({
        url: 'https://example.com/c',
        filename: 'c.bin',
        progress: 0,
        status: 'error',
        error: 'boom',
      }),
    )
    const wrapper = mount(DownloadsView)
    await flushPromises()

    const chips = wrapper.findAll('.downloads-filter-chip')
    const labels = chips.map((c) => c.text())
    expect(labels).toEqual(['All', 'Active', 'Completed', 'Failed'])

    await chips[1]!.trigger('click') // Active
    await flushPromises()
    expect(wrapper.findAll('.downloads-tab-item').length).toBe(1)
    expect(wrapper.find('.downloads-tab-name').text()).toBe('a.bin')

    await chips[2]!.trigger('click') // Completed
    await flushPromises()
    expect(wrapper.findAll('.downloads-tab-item').length).toBe(1)
    expect(wrapper.find('.downloads-tab-name').text()).toBe('b.bin')

    await chips[3]!.trigger('click') // Failed
    await flushPromises()
    expect(wrapper.findAll('.downloads-tab-item').length).toBe(1)
    expect(wrapper.find('.downloads-tab-name').text()).toBe('c.bin')
  })

  it('routes pause / resume / cancel / show-in-folder to window.api', async () => {
    const store = useDownloadStore()
    store.upsert(
      makeProgress({
        url: 'https://example.com/dl.bin',
        filename: 'dl.bin',
        progress: 0.5,
        status: 'downloading',
      }),
    )
    store.upsert(
      makeProgress({
        url: 'https://example.com/p.bin',
        filename: 'p.bin',
        progress: 0.1,
        status: 'paused',
      }),
    )
    store.upsert(
      makeProgress({
        url: 'https://example.com/ok.bin',
        filename: 'ok.bin',
        progress: 1,
        status: 'completed',
        savePath: '/tmp/ok.bin',
      }),
    )
    const wrapper = mount(DownloadsView)
    await flushPromises()

    const items = wrapper.findAll('.downloads-tab-item')
    // downloading entry: Pause + Cancel + (no remove until terminal)
    const dlButtons = items[0]!.findAll('button')
    const pauseBtn = dlButtons.find((b) => b.text().includes('Pause'))!
    await pauseBtn.trigger('click')
    expect(apiCalls.pauseCalls).toEqual(['https://example.com/dl.bin'])
    const dlCancelBtn = dlButtons.find((b) => b.text().includes('Cancel'))!
    await dlCancelBtn.trigger('click')
    expect(apiCalls.cancelCalls).toEqual(['https://example.com/dl.bin'])

    // paused entry: Resume
    const pausedButtons = items[1]!.findAll('button')
    const resumeBtn = pausedButtons.find((b) => b.text().includes('Resume'))!
    await resumeBtn.trigger('click')
    expect(apiCalls.resumeCalls).toEqual(['https://example.com/p.bin'])

    // completed entry: Show in Finder
    const completedButtons = items[2]!.findAll('button')
    const showBtn = completedButtons.find((b) => b.text().includes('Show in Finder'))!
    await showBtn.trigger('click')
    expect(apiCalls.showInFolderCalls).toEqual(['/tmp/ok.bin'])
  })

  it('per-row Remove dismisses a single terminal entry from the store', async () => {
    const store = useDownloadStore()
    store.upsert(
      makeProgress({
        url: 'https://example.com/done',
        filename: 'b.bin',
        progress: 1,
        status: 'completed',
        savePath: '/tmp/b.bin',
      }),
    )
    store.upsert(
      makeProgress({
        url: 'https://example.com/oops',
        filename: 'c.bin',
        progress: 0,
        status: 'error',
      }),
    )
    const wrapper = mount(DownloadsView)
    await flushPromises()
    const items = wrapper.findAll('.downloads-tab-item')
    const removeBtn = items[0]!.find('.downloads-tab-dismiss')
    await removeBtn.trigger('click')
    await flushPromises()
    expect(store.downloads.has('https://example.com/done')).toBe(false)
    expect(store.downloads.has('https://example.com/oops')).toBe(true)
  })
})
