import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'

import ChooserView from './ChooserView.vue'
import type { Installation } from '../types/ipc'

// Stub the heavy ContextMenu child — we don't exercise menu interactions here.
vi.mock('../components/ContextMenu.vue', () => ({
  default: { name: 'ContextMenu', template: '<div data-testid="context-menu" />' },
}))

const messages = {
  en: {
    common: { loading: 'Loading…' },
    dashboard: {
      cloudSection: 'ComfyUI Cloud',
      pinned: 'Pinned',
      launchedAgo: 'Launched {time}',
      neverLaunched: 'Not launched yet',
      pinToDashboard: 'Pin',
      unpinFromDashboard: 'Unpin',
    },
    list: { view: 'View' },
    running: { dismiss: 'Dismiss' },
    chooser: {
      recent: 'Recent',
      all: 'All',
      openCloud: 'Open',
      emptyTitle: 'No installations yet',
      emptyDesc: 'Create your first ComfyUI installation to get started.',
      createInstall: 'Create installation',
    },
  },
}

function createTestI18n() {
  return createI18n({ legacy: false, locale: 'en', messages })
}

interface MockApi {
  getInstallations: ReturnType<typeof vi.fn>
  onInstallationsChanged: ReturnType<typeof vi.fn>
  onInstallationsVersionsUpdated: ReturnType<typeof vi.fn>
  getSetting: ReturnType<typeof vi.fn>
  runAction: ReturnType<typeof vi.fn>
}

function installMockApi(initial: Installation[]): MockApi {
  const api: MockApi = {
    getInstallations: vi.fn().mockResolvedValue(initial),
    onInstallationsChanged: vi.fn(() => () => {}),
    onInstallationsVersionsUpdated: vi.fn(() => () => {}),
    getSetting: vi.fn().mockResolvedValue(undefined),
    runAction: vi.fn().mockResolvedValue({ ok: true }),
  }
  ;(window as unknown as { api: MockApi }).api = api
  return api
}

function makeInstall(overrides: Partial<Installation>): Installation {
  return {
    id: 'inst-x',
    name: 'X',
    sourceLabel: 'Standalone',
    sourceCategory: 'local',
    ...overrides,
  } as unknown as Installation
}

function mountChooser() {
  return mount(ChooserView, {
    global: { plugins: [createTestI18n(), createPinia()] },
  })
}

describe('ChooserView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('renders the empty state when there are no installations', async () => {
    installMockApi([])
    const wrapper = mountChooser()
    await flushPromises()
    expect(wrapper.text()).toContain('No installations yet')
    const cta = wrapper.find('button.primary')
    expect(cta.exists()).toBe(true)
    expect(cta.text()).toContain('Create installation')
  })

  it('emits show-new-install when the empty-state CTA is clicked', async () => {
    installMockApi([])
    const wrapper = mountChooser()
    await flushPromises()
    await wrapper.find('button.primary').trigger('click')
    expect(wrapper.emitted('show-new-install')).toBeDefined()
    expect(wrapper.emitted('show-new-install')!.length).toBe(1)
  })

  it('renders the cloud promo row above the table when a cloud install exists', async () => {
    installMockApi([
      makeInstall({ id: 'cloud', name: 'Comfy Cloud', sourceCategory: 'cloud', sourceLabel: 'Cloud' }),
      makeInstall({ id: 'a', name: 'Local A' }),
    ])
    const wrapper = mountChooser()
    await flushPromises()
    expect(wrapper.text()).toContain('Comfy Cloud')
    expect(wrapper.text()).toContain('ComfyUI Cloud')
  })

  it('places the most-recently-launched non-cloud install at the top of the Recent section', async () => {
    installMockApi([
      makeInstall({ id: 'old', name: 'Old', lastLaunchedAt: 100 }),
      makeInstall({ id: 'new', name: 'New', lastLaunchedAt: 500 }),
      makeInstall({ id: 'never', name: 'Never' }),
    ])
    const wrapper = mountChooser()
    await flushPromises()

    const rows = wrapper.findAll('.chooser-row')
    // First three rows: Recent section (only the two with timestamps),
    // followed by the All section (all three).
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(rows[0]!.text()).toContain('New')
    expect(rows[1]!.text()).toContain('Old')
  })

  it('emits pick with the installation when a row is clicked', async () => {
    installMockApi([
      makeInstall({ id: 'a', name: 'Alpha' }),
    ])
    const wrapper = mountChooser()
    await flushPromises()

    const row = wrapper.find('.chooser-row')
    expect(row.exists()).toBe(true)
    await row.trigger('click')

    const events = wrapper.emitted('pick')
    expect(events).toBeDefined()
    expect((events![0]![0] as Installation).id).toBe('a')
  })

  it('excludes cloud installs from both Recent and All sections', async () => {
    installMockApi([
      makeInstall({ id: 'cloud', name: 'Comfy Cloud', sourceCategory: 'cloud', sourceLabel: 'Cloud', lastLaunchedAt: 9999 }),
      makeInstall({ id: 'a', name: 'Local A', lastLaunchedAt: 100 }),
    ])
    const wrapper = mountChooser()
    await flushPromises()

    const rows = wrapper.findAll('.chooser-row')
    for (const row of rows) {
      expect(row.text()).not.toContain('Comfy Cloud')
    }
  })
})
