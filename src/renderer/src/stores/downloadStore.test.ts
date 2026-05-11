import { createTestingPinia } from '@pinia/testing'
import { setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ElectronApi, ModelDownloadProgress } from '../types/ipc'
import { useDownloadStore } from './downloadStore'

function makeProgress(
  overrides: Partial<ModelDownloadProgress> & { url: string }
): ModelDownloadProgress {
  return {
    filename: 'model.safetensors',
    progress: 0,
    status: 'pending',
    ...overrides,
  }
}

interface BroadcastHooks {
  /** Invokes whatever callback the store registered via
   *  `onModelDownloadRemoved` — used to fake main's removal
   *  broadcast in unit tests so we can verify that the store drops
   *  entries in lockstep with main. */
  emitRemoved: (url: string) => void
  emitClearedFinished: (urls: string[]) => void
  dismissModelDownload: ReturnType<typeof vi.fn>
  clearFinishedModelDownloads: ReturnType<typeof vi.fn>
}

function installMockApi(): BroadcastHooks {
  let removedCb: ((data: { url: string }) => void) | null = null
  let clearedCb: ((data: { urls: string[] }) => void) | null = null
  const dismissModelDownload = vi.fn().mockResolvedValue(true)
  const clearFinishedModelDownloads = vi.fn().mockResolvedValue(0)
  window.api = {
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
      }
    ),
    dismissModelDownload,
    clearFinishedModelDownloads,
  } as unknown as ElectronApi
  return {
    emitRemoved: (url) => removedCb?.({ url }),
    emitClearedFinished: (urls) => clearedCb?.({ urls }),
    dismissModelDownload,
    clearFinishedModelDownloads,
  }
}

describe('useDownloadStore', () => {
  let store: ReturnType<typeof useDownloadStore>
  let api: BroadcastHooks

  beforeEach(() => {
    api = installMockApi()
    setActivePinia(createTestingPinia({ stubActions: false }))
    store = useDownloadStore()
    // init() wires up the removed / cleared broadcast handlers that
    // the dismiss/clearFinished tests rely on for round-tripping.
    store.init()
    // listModelDownloads() seeds asynchronously; we only care about
    // the post-init state here so reset call counts.
    api.dismissModelDownload.mockClear()
    api.clearFinishedModelDownloads.mockClear()
  })

  describe('upsert', () => {
    it('inserts a new download entry', () => {
      const p = makeProgress({ url: 'https://example.com/a.bin' })
      store.upsert(p)

      expect(store.downloads.size).toBe(1)
      expect(store.downloads.get('https://example.com/a.bin')).toMatchObject({
        url: 'https://example.com/a.bin',
        status: 'pending',
      })
    })

    it('updates an existing entry with same url', () => {
      const url = 'https://example.com/a.bin'
      store.upsert(makeProgress({ url, progress: 0, status: 'pending' }))
      store.upsert(makeProgress({ url, progress: 50, status: 'downloading' }))

      expect(store.downloads.size).toBe(1)
      expect(store.downloads.get(url)).toMatchObject({
        progress: 50,
        status: 'downloading',
      })
    })

    it('preserves other entries when updating one', () => {
      store.upsert(makeProgress({ url: 'https://example.com/a.bin' }))
      store.upsert(makeProgress({ url: 'https://example.com/b.bin' }))
      store.upsert(
        makeProgress({ url: 'https://example.com/a.bin', progress: 75 })
      )

      expect(store.downloads.size).toBe(2)
      expect(store.downloads.get('https://example.com/b.bin')).toBeDefined()
    })
  })

  describe('dismiss', () => {
    it('routes through main and waits for the removed broadcast to drop the entry', () => {
      const url = 'https://example.com/a.bin'
      store.upsert(makeProgress({ url }))

      store.dismiss(url)
      expect(api.dismissModelDownload).toHaveBeenCalledWith(url)
      // The store deliberately doesn't mutate locally — every other
      // surface watching the same broadcast would otherwise drift out
      // of sync. The entry is still present until main echoes back.
      expect(store.downloads.has(url)).toBe(true)

      api.emitRemoved(url)
      expect(store.downloads.has(url)).toBe(false)
    })

    it('forwards even unknown urls to main (main is the source of truth)', () => {
      store.upsert(makeProgress({ url: 'https://example.com/a.bin' }))
      store.dismiss('https://example.com/unknown.bin')

      expect(api.dismissModelDownload).toHaveBeenCalledWith(
        'https://example.com/unknown.bin'
      )
      expect(store.downloads.size).toBe(1)
    })
  })

  describe('clearFinished', () => {
    it('routes through main and removes every url echoed back by the broadcast', () => {
      store.upsert(makeProgress({ url: 'a', status: 'completed' }))
      store.upsert(makeProgress({ url: 'b', status: 'error' }))
      store.upsert(makeProgress({ url: 'c', status: 'downloading' }))

      store.clearFinished()
      expect(api.clearFinishedModelDownloads).toHaveBeenCalled()

      api.emitClearedFinished(['a', 'b'])
      expect(store.downloads.has('a')).toBe(false)
      expect(store.downloads.has('b')).toBe(false)
      expect(store.downloads.has('c')).toBe(true)
    })
  })

  describe('activeDownloads', () => {
    it('includes downloads with status pending, downloading, paused', () => {
      store.upsert(makeProgress({ url: 'a', status: 'pending' }))
      store.upsert(makeProgress({ url: 'b', status: 'downloading' }))
      store.upsert(makeProgress({ url: 'c', status: 'paused' }))

      expect(store.activeDownloads).toHaveLength(3)
      expect(store.activeDownloads.map((d) => d.url).sort()).toEqual([
        'a',
        'b',
        'c',
      ])
    })

    it('excludes completed, error, cancelled', () => {
      store.upsert(makeProgress({ url: 'a', status: 'completed' }))
      store.upsert(makeProgress({ url: 'b', status: 'error' }))
      store.upsert(makeProgress({ url: 'c', status: 'cancelled' }))
      store.upsert(makeProgress({ url: 'd', status: 'downloading' }))

      expect(store.activeDownloads).toHaveLength(1)
      expect(store.activeDownloads[0].url).toBe('d')
    })
  })

  describe('finishedDownloads', () => {
    it('includes downloads with status completed, error, cancelled', () => {
      store.upsert(makeProgress({ url: 'a', status: 'completed' }))
      store.upsert(makeProgress({ url: 'b', status: 'error' }))
      store.upsert(makeProgress({ url: 'c', status: 'cancelled' }))

      expect(store.finishedDownloads).toHaveLength(3)
      expect(store.finishedDownloads.map((d) => d.url).sort()).toEqual([
        'a',
        'b',
        'c',
      ])
    })

    it('excludes pending, downloading, paused', () => {
      store.upsert(makeProgress({ url: 'a', status: 'pending' }))
      store.upsert(makeProgress({ url: 'b', status: 'downloading' }))
      store.upsert(makeProgress({ url: 'c', status: 'paused' }))
      store.upsert(makeProgress({ url: 'd', status: 'completed' }))

      expect(store.finishedDownloads).toHaveLength(1)
      expect(store.finishedDownloads[0].url).toBe('d')
    })
  })

  describe('hasDownloads', () => {
    it('returns false when empty', () => {
      expect(store.hasDownloads).toBe(false)
    })

    it('returns true when downloads exist', () => {
      store.upsert(makeProgress({ url: 'a' }))

      expect(store.hasDownloads).toBe(true)
    })

    it('returns false after all entries are removed via the broadcast', () => {
      store.upsert(makeProgress({ url: 'a' }))
      store.upsert(makeProgress({ url: 'b' }))

      store.dismiss('a')
      store.dismiss('b')
      api.emitRemoved('a')
      api.emitRemoved('b')

      expect(store.hasDownloads).toBe(false)
    })
  })
})
