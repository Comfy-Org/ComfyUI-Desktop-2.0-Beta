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
  downloadsCallbacks: ((state: MockDownloadsState) => void)[]
  downloadsActions: { action: string; url: string; savePath?: string }[]
  openSettingsTabCalls: string[]
}

function installMockBridge(): MockBridgeState {
  const state: MockBridgeState = {
    downloadsCallbacks: [],
    downloadsActions: [],
    openSettingsTabCalls: [],
  }
  const bridge = {
    onDownloadsChanged: (cb: (next: MockDownloadsState) => void) => {
      state.downloadsCallbacks.push(cb)
      return () => {}
    },
    downloadsAction: (a: { action: string; url: string; savePath?: string }) => {
      state.downloadsActions.push(a)
    },
    openSettingsTab: (tab: string) => {
      state.openSettingsTabCalls.push(tab)
    },
  }
  ;(window as unknown as { __comfyTitlePopup: typeof bridge }).__comfyTitlePopup = bridge
  return state
}

function pushState(
  state: MockBridgeState,
  next: { active?: MockDownloadEntry[]; recent?: MockDownloadEntry[] } = {},
): void {
  state.downloadsCallbacks.forEach((cb) =>
    cb({ active: next.active ?? [], recent: next.recent ?? [] }),
  )
}

describe('comfyTitlePopup/DownloadsView', () => {
  let bridgeState: MockBridgeState

  beforeEach(() => {
    bridgeState = installMockBridge()
    vi.resetModules()
  })

  it('shows the empty placeholder before any state push', async () => {
    const { default: DownloadsView } = await import('./DownloadsView.vue')
    const wrapper = mount(DownloadsView)
    await flushPromises()
    expect(wrapper.find('.downloads-empty').text()).toBe('No downloads yet')
    expect(wrapper.findAll('.downloads-item').length).toBe(0)
  })

  it('renders an active downloading entry with a progress bar and Pause/Cancel actions', async () => {
    const { default: DownloadsView } = await import('./DownloadsView.vue')
    const wrapper = mount(DownloadsView)
    await flushPromises()
    pushState(bridgeState, {
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
    })
    await flushPromises()
    const item = wrapper.find('.downloads-item.is-active')
    expect(item.exists()).toBe(true)
    expect(item.find('.downloads-item-name').text()).toBe(
      'models/checkpoints / a.bin',
    )
    const status = item.find('.downloads-item-status').text()
    expect(status).toContain('42%')
    expect(status).toContain('1.0 MB/s')
    const fill = item.find('.downloads-bar-fill')
    expect(fill.attributes('style')).toContain('width: 42%')
    const labels = item.findAll('button').map((b) => b.text())
    expect(labels.some((l) => l.includes('Pause'))).toBe(true)
    expect(labels.some((l) => l.includes('Cancel'))).toBe(true)
    expect(labels.some((l) => l.includes('Resume'))).toBe(false)
  })

  it('renders a paused entry with Resume + Cancel and an indeterminate bar for pending', async () => {
    const { default: DownloadsView } = await import('./DownloadsView.vue')
    const wrapper = mount(DownloadsView)
    await flushPromises()
    pushState(bridgeState, {
      active: [
        {
          url: 'https://example.com/p.bin',
          filename: 'p.bin',
          progress: 0.1,
          status: 'paused',
        },
        {
          url: 'https://example.com/q.bin',
          filename: 'q.bin',
          progress: 0,
          status: 'pending',
        },
      ],
    })
    await flushPromises()
    const items = wrapper.findAll('.downloads-item')
    expect(items.length).toBe(2)
    const pausedLabels = items[0]!.findAll('button').map((b) => b.text())
    expect(pausedLabels.some((l) => l.includes('Resume'))).toBe(true)
    expect(pausedLabels.some((l) => l.includes('Cancel'))).toBe(true)
    expect(pausedLabels.some((l) => l.includes('Pause'))).toBe(false)
    // Pending entries get a full-width indeterminate bar.
    const pendingFill = items[1]!.find('.downloads-bar-fill')
    expect(pendingFill.classes()).toContain('indeterminate')
    expect(pendingFill.attributes('style')).toContain('width: 100%')
  })

  it('renders a completed recent entry with a Show-in-folder action when savePath is present', async () => {
    const { default: DownloadsView } = await import('./DownloadsView.vue')
    const wrapper = mount(DownloadsView)
    await flushPromises()
    pushState(bridgeState, {
      recent: [
        {
          url: 'https://example.com/done.bin',
          filename: 'done.bin',
          progress: 1,
          status: 'completed',
          savePath: '/tmp/done.bin',
        },
      ],
    })
    await flushPromises()
    const item = wrapper.find('.downloads-item.is-finished')
    expect(item.exists()).toBe(true)
    expect(item.find('.downloads-item-status').text()).toBe('Completed')
    const buttons = item.findAll('button')
    expect(buttons.length).toBe(1)
    expect(buttons[0]!.text()).toBe('Show in folder')
  })

  it('omits Show-in-folder for terminal entries that did not write to disk', async () => {
    const { default: DownloadsView } = await import('./DownloadsView.vue')
    const wrapper = mount(DownloadsView)
    await flushPromises()
    pushState(bridgeState, {
      recent: [
        {
          url: 'https://example.com/x.bin',
          filename: 'x.bin',
          progress: 0,
          status: 'error',
          error: 'oops',
        },
      ],
    })
    await flushPromises()
    const item = wrapper.find('.downloads-item.is-error')
    expect(item.exists()).toBe(true)
    expect(item.find('.downloads-item-status').text()).toBe('oops')
    expect(item.findAll('button').length).toBe(0)
  })

  it('forwards pause/resume/cancel/show-in-folder to the bridge', async () => {
    const { default: DownloadsView } = await import('./DownloadsView.vue')
    const wrapper = mount(DownloadsView)
    await flushPromises()
    pushState(bridgeState, {
      active: [
        {
          url: 'https://example.com/dl.bin',
          filename: 'dl.bin',
          progress: 0.5,
          status: 'downloading',
        },
        {
          url: 'https://example.com/p.bin',
          filename: 'p.bin',
          progress: 0.1,
          status: 'paused',
        },
      ],
      recent: [
        {
          url: 'https://example.com/ok.bin',
          filename: 'ok.bin',
          progress: 1,
          status: 'completed',
          savePath: '/tmp/ok.bin',
        },
      ],
    })
    await flushPromises()
    const items = wrapper.findAll('.downloads-item')
    // Pause the downloading entry.
    await items[0]!.find('button[aria-label="Pause"]').trigger('click')
    // Resume the paused entry.
    await items[1]!.find('button[aria-label="Resume"]').trigger('click')
    // Cancel the paused entry.
    await items[1]!.find('button[aria-label="Cancel"]').trigger('click')
    // Show-in-folder for the completed entry.
    await items[2]!.find('button').trigger('click')
    expect(bridgeState.downloadsActions).toEqual([
      { action: 'pause', url: 'https://example.com/dl.bin' },
      { action: 'resume', url: 'https://example.com/p.bin' },
      { action: 'cancel', url: 'https://example.com/p.bin' },
      {
        action: 'show-in-folder',
        url: 'https://example.com/ok.bin',
        savePath: '/tmp/ok.bin',
      },
    ])
  })

  it('routes the footer link to the Settings → Downloads tab', async () => {
    const { default: DownloadsView } = await import('./DownloadsView.vue')
    const wrapper = mount(DownloadsView)
    await flushPromises()
    await wrapper.find('.downloads-link').trigger('click')
    expect(bridgeState.openSettingsTabCalls).toEqual(['downloads'])
  })
})
