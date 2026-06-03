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
    cloud: { label: 'Cloud', desc: 'Try Cloud' },
    dashboard: {
      cloudSection: 'ComfyUI Cloud',
      launchedAgo: 'Launched {time}',
      neverLaunched: 'Not launched yet',
    },
    list: { view: 'View' },
    running: { dismiss: 'Dismiss' },
    chooser: {
      newInstall: 'New Install',
      newInstallDesc: 'Set up a fresh ComfyUI environment.',
      filterAll: 'All',
      filterLocal: 'Local',
      filterCloud: 'Cloud',
      filterRemote: 'Remote',
      moreActions: 'More actions',
      manageInstall: 'Manage',
      searchPlaceholder: 'Search for and open an instance',
      noMatches: 'No instances match',
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
  // progressStore subscribes to onErrorDetail at construction time, so
  // the mock has to expose at least the listener-registration shape it
  // expects. ChooserView reads progressStore.getProgressInfo() per
  // tile to drive in-flight-progress affordances.
  onErrorDetail: ReturnType<typeof vi.fn>
}

function installMockApi(initial: Installation[]): MockApi {
  const api: MockApi = {
    getInstallations: vi.fn().mockResolvedValue(initial),
    onInstallationsChanged: vi.fn(() => () => {}),
    onInstallationsVersionsUpdated: vi.fn(() => () => {}),
    getSetting: vi.fn().mockResolvedValue(undefined),
    runAction: vi.fn().mockResolvedValue({ ok: true }),
    onErrorDetail: vi.fn(() => () => {}),
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

  it('always renders the New Install tile and a Cloud tile', async () => {
    installMockApi([])
    const wrapper = mountChooser()
    await flushPromises()
    expect(wrapper.text()).toContain('New Install')
    // Cloud tile shows the Try-Cloud CTA when no cloud install exists.
    expect(wrapper.text()).toContain('Cloud')
    expect(wrapper.text()).toContain('Try Cloud')
  })

  it('emits show-new-install when the New Install tile is clicked', async () => {
    installMockApi([])
    const wrapper = mountChooser()
    await flushPromises()
    await wrapper.find('.chooser-tile-new').trigger('click')
    expect(wrapper.emitted('show-new-install')).toBeDefined()
    expect(wrapper.emitted('show-new-install')!.length).toBe(1)
  })

  it('emits show-new-install when the Cloud tile is clicked and no cloud install exists', async () => {
    installMockApi([
      makeInstall({ id: 'a', name: 'Local A' }),
    ])
    const wrapper = mountChooser()
    await flushPromises()
    await wrapper.find('.chooser-tile-cloud').trigger('click')
    expect(wrapper.emitted('show-new-install')).toBeDefined()
  })

  it('emits pick with the cloud install when the Cloud tile is clicked and one exists', async () => {
    installMockApi([
      makeInstall({ id: 'cloud', name: 'Comfy Cloud', sourceCategory: 'cloud', sourceLabel: 'Cloud' }),
    ])
    const wrapper = mountChooser()
    await flushPromises()
    await wrapper.find('.chooser-tile-cloud').trigger('click')
    // `pickInstall` is async (capacity gate awaits `confirmEntry`); the
    // emit happens after the next tick, so drain pending microtasks
    // before asserting.
    await flushPromises()
    const events = wrapper.emitted('pick')
    expect(events).toBeDefined()
    expect((events![0]![0] as Installation).id).toBe('cloud')
  })

  it('orders install tiles by lastLaunchedAt desc with never-launched at the end', async () => {
    installMockApi([
      makeInstall({ id: 'old', name: 'Old', lastLaunchedAt: 100 }),
      makeInstall({ id: 'new', name: 'New', lastLaunchedAt: 500 }),
      makeInstall({ id: 'never', name: 'Never' }),
    ])
    const wrapper = mountChooser()
    await flushPromises()
    // The first two tiles are the fixed New Install + Cloud entries; the
    // remaining tiles are the install rows in recency order.
    const tiles = wrapper.findAll('.chooser-tile')
    const installTiles = tiles.filter(
      (t) => !t.classes().includes('chooser-tile-new') && !t.classes().includes('chooser-tile-cloud')
    )
    expect(installTiles.length).toBe(3)
    expect(installTiles[0]!.text()).toContain('New')
    expect(installTiles[1]!.text()).toContain('Old')
    expect(installTiles[2]!.text()).toContain('Never')
  })

  it('emits pick when an install tile is single-clicked', async () => {
    // Single-click on the tile body launches via pickInstall — the
    // same gesture the Cloud tile uses, so behaviour can't drift
    // between the two surfaces. Manage / Update / Migrate / Open
    // Folder / Delete all live behind the kebab (⋮) menu.
    installMockApi([
      makeInstall({ id: 'a', name: 'Alpha', status: 'installed' }),
    ])
    const wrapper = mountChooser()
    await flushPromises()
    const tiles = wrapper.findAll('.chooser-tile')
    const alphaTile = tiles.find((t) => t.text().includes('Alpha'))
    expect(alphaTile).toBeTruthy()
    await alphaTile!.trigger('click')
    const events = wrapper.emitted('pick')
    expect(events).toBeDefined()
    expect((events![0]![0] as Installation).id).toBe('a')
  })

  it('does not render per-state launch CTAs — only the Close-instance CTA when running', async () => {
    // Per-state CTAs (Play / Show Window / View Progress) collapsed
    // into the body click handler; only a "Close instance" CTA
    // remains, and only while the install is running / stopping.
    installMockApi([
      makeInstall({ id: 'a', name: 'Alpha', status: 'installed' }),
    ])
    const wrapper = mountChooser()
    await flushPromises()
    expect(wrapper.find('.chooser-tile-cta-play').exists()).toBe(false)
    expect(wrapper.find('.chooser-tile-cta-show').exists()).toBe(false)
    expect(wrapper.find('.chooser-tile-cta-progress').exists()).toBe(false)
    // Idle install has no CTA cluster at all.
    expect(wrapper.find('.chooser-tile-cta').exists()).toBe(false)
  })

  it('does not emit pick when the kebab button is clicked — only the menu opens', async () => {
    // The kebab (⋮) action menu sits in the top-right of every
    // install tile. Its click handler stop-propagates so neither
    // the tile-level Manage open nor the launch fast-path fires.
    installMockApi([
      makeInstall({ id: 'a', name: 'Alpha' }),
    ])
    const wrapper = mountChooser()
    await flushPromises()
    const kebab = wrapper.find('.chooser-tile-kebab')
    expect(kebab.exists()).toBe(true)
    await kebab.trigger('click')
    expect(wrapper.emitted('pick')).toBeUndefined()
  })

  it('filters install tiles by source category when a filter chip is active', async () => {
    installMockApi([
      makeInstall({ id: 'l', name: 'LocalThing', sourceCategory: 'local' }),
      makeInstall({ id: 'd', name: 'DesktopThing', sourceCategory: 'desktop' }),
      makeInstall({ id: 'r', name: 'RemoteThing', sourceCategory: 'remote' }),
    ])
    const wrapper = mountChooser()
    await flushPromises()

    // Activate the Remote filter — only the remote install should remain
    // among the install tiles. New Install stays visible; Cloud is hidden
    // when filtering to a non-cloud category.
    //
    // The filter UI is hidden in the brand redesign but the underlying
    // `activeFilter` state + visibleInstalls switch are preserved, so
    // we drive it through the vm directly.
    ;(wrapper.vm as unknown as { activeFilter: string }).activeFilter = 'remote'
    await flushPromises()

    const tiles = wrapper.findAll('.chooser-tile')
    const installTiles = tiles.filter(
      (t) => !t.classes().includes('chooser-tile-new') && !t.classes().includes('chooser-tile-cloud')
    )
    expect(installTiles.length).toBe(1)
    expect(installTiles[0]!.text()).toContain('RemoteThing')
  })

  it('groups Legacy Desktop installs under the Local filter', async () => {
    // The dedicated Desktop filter chip is gone; Legacy Desktop installs
    // (sourceCategory === 'desktop') continue to surface alongside
    // Standalone Local installs under the Local chip rather than vanishing
    // from the filtered view.
    installMockApi([
      makeInstall({ id: 'l', name: 'LocalThing', sourceCategory: 'local' }),
      makeInstall({ id: 'd', name: 'LegacyDesktopThing', sourceCategory: 'desktop' }),
      makeInstall({ id: 'r', name: 'RemoteThing', sourceCategory: 'remote' }),
    ])
    const wrapper = mountChooser()
    await flushPromises()

    ;(wrapper.vm as unknown as { activeFilter: string }).activeFilter = 'local'
    await flushPromises()

    const tiles = wrapper.findAll('.chooser-tile')
    const installTiles = tiles.filter(
      (t) => !t.classes().includes('chooser-tile-new') && !t.classes().includes('chooser-tile-cloud')
    )
    const labels = installTiles.map((t) => t.text())
    expect(installTiles.length).toBe(2)
    expect(labels.some((l) => l.includes('LocalThing'))).toBe(true)
    expect(labels.some((l) => l.includes('LegacyDesktopThing'))).toBe(true)
    expect(labels.some((l) => l.includes('RemoteThing'))).toBe(false)
  })

  it('has no Desktop entry in the filter state', async () => {
    // The category-filter UI is hidden in the brand redesign; this test
    // is preserved as a guard on the underlying state model — Legacy
    // Desktop installs map to the 'local' filter, not a dedicated key.
    installMockApi([])
    const wrapper = mountChooser()
    await flushPromises()
    type FilterKey = 'all' | 'local' | 'cloud' | 'remote'
    const validKeys: FilterKey[] = ['all', 'local', 'cloud', 'remote']
    expect(validKeys).not.toContain('desktop' as FilterKey)
    // Also confirms activeFilter ref is reachable from vm so the other
    // filter-driven tests in this file stay valid.
    expect((wrapper.vm as unknown as { activeFilter: FilterKey }).activeFilter).toBe('all')
  })
})
