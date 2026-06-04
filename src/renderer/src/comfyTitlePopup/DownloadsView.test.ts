import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

interface MockDownloadEntry {
  url: string
  filename: string
  directory?: string
  savePath?: string
  progress: number
  receivedBytes?: number
  totalBytes?: number
  speedBytesPerSec?: number
  etaSeconds?: number
  status: 'pending' | 'downloading' | 'paused' | 'completed' | 'error' | 'cancelled'
  error?: string
}

interface MockDownloadsState {
  active: MockDownloadEntry[]
  recent: MockDownloadEntry[]
}

interface MockBridgeState {
  downloadsActions: { action: string; url?: string; savePath?: string }[]
  openSettingsTabCalls: string[]
  openDownloadsModalCalls: number
}

function installMockBridge(platform: string = 'darwin'): MockBridgeState {
  const state: MockBridgeState = {
    downloadsActions: [],
    openSettingsTabCalls: [],
    openDownloadsModalCalls: 0,
  }
  const bridge = {
    platform,
    downloadsAction: (a: { action: string; url?: string; savePath?: string }) => {
      state.downloadsActions.push(a)
    },
    openSettingsTab: (tab: string) => {
      state.openSettingsTabCalls.push(tab)
    },
    openDownloadsModal: () => {
      state.openDownloadsModalCalls += 1
    },
  }
  ;(window as unknown as { __comfyTitlePopup: typeof bridge }).__comfyTitlePopup = bridge
  return state
}

const EMPTY_STATE: MockDownloadsState = { active: [], recent: [] }

/**
 * The redesigned popover collapses per-row actions into a right-edge X
 * (cancel/dismiss) plus a row-click that opens the save location on completed
 * rows. Pause/Resume are dropped from the UI. Bridge IPC shapes are unchanged.
 */

describe('comfyTitlePopup/DownloadsView', () => {
  let bridgeState: MockBridgeState

  beforeEach(() => {
    bridgeState = installMockBridge()
    vi.resetModules()
  })

  it('shows the "Downloads" title and the empty placeholder when state has no entries', async () => {
    const { default: DownloadsView } = await import('./DownloadsView.vue')
    const wrapper = mount(DownloadsView, { props: { state: EMPTY_STATE } })
    await flushPromises()
    expect(wrapper.find('.downloads-title').text()).toBe('Downloads')
    expect(wrapper.find('.downloads-empty').text()).toBe('No downloads yet')
    expect(wrapper.findAll('.downloads-item').length).toBe(0)
    expect(wrapper.find('.downloads-clear').exists()).toBe(false)
  })

  it('renders an active downloading entry with the full browser-style status line (size / speed / ETA) and an inline progress gradient', async () => {
    const { default: DownloadsView } = await import('./DownloadsView.vue')
    const state: MockDownloadsState = {
      active: [
        {
          url: 'https://example.com/a.bin',
          filename: 'a.bin',
          directory: 'models/checkpoints',
          progress: 0.42,
          receivedBytes: 4_200_000,
          totalBytes: 10_000_000,
          speedBytesPerSec: 1_048_576,
          etaSeconds: 30,
          status: 'downloading',
        },
      ],
      recent: [],
    }
    const wrapper = mount(DownloadsView, { props: { state } })
    await flushPromises()
    const item = wrapper.find('.downloads-item.is-active')
    expect(item.exists()).toBe(true)
    expect(item.find('.downloads-item-name').text()).toBe(
      'models/checkpoints / a.bin',
    )
    // All four facets (size / percent / speed / ETA) show without leaving the tray.
    const sub = item.find('.downloads-item-sub').text()
    expect(sub).toContain('4.0 MB / 9.5 MB')
    expect(sub).toContain('42%')
    expect(sub).toContain('1.0 MB/s')
    expect(sub).toContain('30s')
    // The row itself acts as the progress bar (gradient stop at 42%).
    const style = item.attributes('style') ?? ''
    expect(style).toContain('linear-gradient')
    expect(style).toContain('42%')
  })

  it('renders a paused entry with a paused subtitle showing the percentage', async () => {
    const { default: DownloadsView } = await import('./DownloadsView.vue')
    const state: MockDownloadsState = {
      active: [
        {
          url: 'https://example.com/p.bin',
          filename: 'p.bin',
          progress: 0.1,
          status: 'paused',
        },
      ],
      recent: [],
    }
    const wrapper = mount(DownloadsView, { props: { state } })
    await flushPromises()
    const item = wrapper.find('.downloads-item.is-paused')
    expect(item.exists()).toBe(true)
    const sub = item.find('.downloads-item-sub').text()
    expect(sub).toContain('Pause')
    expect(sub).toContain('10%')
  })

  it('renders a completed entry as a clickable row with a Show-in-folder subtitle and a dismiss X', async () => {
    const { default: DownloadsView } = await import('./DownloadsView.vue')
    const state: MockDownloadsState = {
      active: [],
      recent: [
        {
          url: 'https://example.com/done.bin',
          filename: 'done.bin',
          progress: 1,
          status: 'completed',
          savePath: '/tmp/done.bin',
        },
      ],
    }
    const wrapper = mount(DownloadsView, { props: { state } })
    await flushPromises()
    const item = wrapper.find('.downloads-item.is-finished')
    expect(item.exists()).toBe(true)
    expect(item.classes()).toContain('is-completed')
    expect(item.classes()).toContain('is-clickable')
    expect(item.find('.downloads-item-sub').text()).toBe('Show in Finder')
    const close = item.find('.downloads-item-close')
    expect(close.exists()).toBe(true)
    expect(close.attributes('aria-label')).toBe('Remove from list')
  })

  it('renders an errored entry without a save path using the status line as subtitle and keeps the X', async () => {
    const { default: DownloadsView } = await import('./DownloadsView.vue')
    const state: MockDownloadsState = {
      active: [],
      recent: [
        {
          url: 'https://example.com/x.bin',
          filename: 'x.bin',
          progress: 0,
          status: 'error',
          error: 'oops',
        },
      ],
    }
    const wrapper = mount(DownloadsView, { props: { state } })
    await flushPromises()
    const item = wrapper.find('.downloads-item.is-error')
    expect(item.exists()).toBe(true)
    expect(item.find('.downloads-item-sub').text()).toBe('oops')
    expect(item.classes()).not.toContain('is-clickable')
    expect(item.find('.downloads-item-close').exists()).toBe(true)
  })

  it('routes the close X to cancel for active rows and dismiss for terminal rows', async () => {
    const { default: DownloadsView } = await import('./DownloadsView.vue')
    const state: MockDownloadsState = {
      active: [
        {
          url: 'https://example.com/dl.bin',
          filename: 'dl.bin',
          progress: 0.5,
          status: 'downloading',
        },
      ],
      recent: [
        {
          url: 'https://example.com/done.bin',
          filename: 'done.bin',
          progress: 1,
          status: 'completed',
          savePath: '/tmp/done.bin',
        },
      ],
    }
    const wrapper = mount(DownloadsView, { props: { state } })
    await flushPromises()
    const items = wrapper.findAll('.downloads-item')
    await items[0]!.find('.downloads-item-close').trigger('click')
    await items[1]!.find('.downloads-item-close').trigger('click')
    expect(bridgeState.downloadsActions).toEqual([
      { action: 'cancel', url: 'https://example.com/dl.bin' },
      { action: 'dismiss', url: 'https://example.com/done.bin' },
    ])
  })

  it('clicking a completed row body opens the file location via the bridge', async () => {
    const { default: DownloadsView } = await import('./DownloadsView.vue')
    const state: MockDownloadsState = {
      active: [],
      recent: [
        {
          url: 'https://example.com/ok.bin',
          filename: 'ok.bin',
          progress: 1,
          status: 'completed',
          savePath: '/tmp/ok.bin',
        },
      ],
    }
    const wrapper = mount(DownloadsView, { props: { state } })
    await flushPromises()
    await wrapper.find('.downloads-item.is-finished').trigger('click')
    expect(bridgeState.downloadsActions).toEqual([
      {
        action: 'show-in-folder',
        url: 'https://example.com/ok.bin',
        savePath: '/tmp/ok.bin',
      },
    ])
  })

  it('clicking the X on a completed row dismisses without triggering show-in-folder', async () => {
    const { default: DownloadsView } = await import('./DownloadsView.vue')
    const state: MockDownloadsState = {
      active: [],
      recent: [
        {
          url: 'https://example.com/ok.bin',
          filename: 'ok.bin',
          progress: 1,
          status: 'completed',
          savePath: '/tmp/ok.bin',
        },
      ],
    }
    const wrapper = mount(DownloadsView, { props: { state } })
    await flushPromises()
    await wrapper.find('.downloads-item-close').trigger('click')
    expect(bridgeState.downloadsActions).toEqual([
      { action: 'dismiss', url: 'https://example.com/ok.bin' },
    ])
  })

  it('routes the footer link to the standalone DownloadsModal (not the Settings tab)', async () => {
    const { default: DownloadsView } = await import('./DownloadsView.vue')
    const wrapper = mount(DownloadsView, { props: { state: EMPTY_STATE } })
    await flushPromises()
    expect(wrapper.find('.downloads-link').text()).toBe('View All Downloads')
    await wrapper.find('.downloads-link').trigger('click')
    expect(bridgeState.openDownloadsModalCalls).toBe(1)
    // The modal, not `openSettingsTab('downloads')`, is now the destination.
    expect(bridgeState.openSettingsTabCalls).toEqual([])
  })
})
