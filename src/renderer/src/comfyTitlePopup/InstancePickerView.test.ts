import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'

import { en } from '../lib/i18nMessages.ts'

  // `useInstallContextMenu` (used by the picker for kebab dispatch)
  // reaches into the panel renderer's session + progress stores; both
  // subscribe to `window.api.*` listeners at construction time, so the
  // popup-side tests need at least the listener-registration shape
  // exposed before the stores are instantiated.
  ; (window as unknown as { api: Record<string, unknown> }).api = {
    onErrorDetail: vi.fn(() => () => { }),
    onInstanceStarted: vi.fn(() => () => { }),
    onInstanceStopped: vi.fn(() => () => { }),
    onInstanceProgress: vi.fn(() => () => { }),
    onSessionStateChanged: vi.fn(() => () => { }),
  }

/**
 * Component tests for the instance-picker popover view. The component
 * is prop-driven (snapshot + theme passed in by the title-popup shell)
 * so tests don't need to mock the IPC handshake — only the bridge
 * methods invoked on user actions (pickInstall, openNewInstall).
 */

interface MockInstall {
  id: string
  name: string
  sourceLabel: string
  sourceCategory: string
  version?: string
  lastLaunchedAt?: number
  installPath?: string
  status?: string
  statusTag?: { style: string; label: string }
}

interface MockSnapshot {
  installs: MockInstall[]
  activeInstallationId: string | null
  runningInstallationIds: string[]
}

interface BridgeState {
  picks: string[]
  newInstallCount: number
}

function installMockBridge(): BridgeState {
  const state: BridgeState = {
    picks: [],
    newInstallCount: 0,
  }
  const bridge = {
    pickInstall: (id: string) => {
      state.picks.push(id)
    },
    openNewInstall: () => {
      state.newInstallCount += 1
    },
    openSettingsTab: vi.fn(),
  }
  ;(window as unknown as { __comfyTitlePopup: typeof bridge }).__comfyTitlePopup = bridge
  return state
}

function makeInstall(overrides: Partial<MockInstall>): MockInstall {
  return {
    id: 'inst-x',
    name: 'X',
    sourceLabel: 'Standalone',
    sourceCategory: 'local',
    ...overrides,
  }
}

async function mountPicker(snapshot: MockSnapshot) {
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
  const pinia = createPinia()
  // Dynamic import so the bridge mock is installed (in `beforeEach`)
  // before the component touches `window.__comfyTitlePopup` — same
  // convention DownloadsView's test uses.
  const { default: InstancePickerView } = await import('./InstancePickerView.vue')
  return mount(InstancePickerView, {
    props: { snapshot },
    global: { plugins: [i18n, pinia] },
  })
}

describe('comfyTitlePopup/InstancePickerView', () => {
  let bridge: BridgeState

  beforeEach(() => {
    setActivePinia(createPinia())
    bridge = installMockBridge()
  })

  describe('structural shell', () => {
    it('renders the search input, chip row, list pane and detail pane', async () => {
      const wrapper = await mountPicker({
        installs: [],
        activeInstallationId: null,
        runningInstallationIds: [],
      })
      expect(wrapper.find('.picker-search input').exists()).toBe(true)
      expect(wrapper.findAll('.picker-chip').length).toBeGreaterThan(0)
      expect(wrapper.find('.picker-list').exists()).toBe(true)
      expect(wrapper.find('.picker-detail').exists()).toBe(true)
    })

    it('renders the "+ New Instance" CTA pinned to the bottom of the left pane', async () => {
      const wrapper = await mountPicker({
        installs: [makeInstall({ id: 'a', name: 'Alpha' })],
        activeInstallationId: null,
        runningInstallationIds: [],
      })
      const newInstall = wrapper.find('.picker-new-install')
      expect(newInstall.exists()).toBe(true)
    })
  })

  describe('list rendering', () => {
    it('orders install rows by recency desc with never-launched last', async () => {
      const wrapper = await mountPicker({
        installs: [
          makeInstall({ id: 'old', name: 'Old', lastLaunchedAt: 100 }),
          makeInstall({ id: 'new', name: 'New', lastLaunchedAt: 500 }),
          makeInstall({ id: 'never', name: 'Never' }),
        ],
        activeInstallationId: null,
        runningInstallationIds: [],
      })
      const installRows = wrapper
        .findAll('.picker-row')
        .filter((r) => !r.classes().includes('picker-row-cloud'))
      // Row text includes the install name AND the formatted last-
      // launched label — assert on the name + order via the name slot,
      // not full row text.
      const namesInOrder = installRows.map((r) => r.find('.picker-row-name').text())
      expect(namesInOrder).toEqual(['New', 'Old', 'Never'])
    })

    it('highlights the active row from snapshot.activeInstallationId', async () => {
      const wrapper = await mountPicker({
        installs: [
          makeInstall({ id: 'a', name: 'Alpha' }),
          makeInstall({ id: 'b', name: 'Bravo' }),
        ],
        activeInstallationId: 'b',
        runningInstallationIds: [],
      })
      const activeRow = wrapper.find('.picker-row.is-active')
      expect(activeRow.exists()).toBe(true)
      expect(activeRow.text()).toContain('Bravo')
    })

    it('marks running rows with the is-running class', async () => {
      const wrapper = await mountPicker({
        installs: [
          makeInstall({ id: 'a', name: 'Alpha' }),
          makeInstall({ id: 'b', name: 'Bravo' }),
        ],
        activeInstallationId: null,
        runningInstallationIds: ['a'],
      })
      const alphaRow = wrapper
        .findAll('.picker-row')
        .find((r) => r.text().includes('Alpha'))
      expect(alphaRow!.classes()).toContain('is-running')
    })
  })

  describe('user actions', () => {
    it('selects (without launching) when an install row is clicked', async () => {
      // Switcher contract: row click updates the right detail pane
      // only. The actual launch waits on the Open button so the user
      // can browse multiple installs before committing — popup stays
      // open across row clicks. The pickInstall IPC must NOT fire.
      const wrapper = await mountPicker({
        installs: [makeInstall({ id: 'a', name: 'Alpha' })],
        activeInstallationId: null,
        runningInstallationIds: [],
      })
      const alphaRow = wrapper
        .findAll('.picker-row')
        .find((r) => r.text().includes('Alpha'))
      await alphaRow!.trigger('click')
      expect(bridge.picks).toEqual([])
      // Selection landed: Alpha is now the active row in the detail pane.
      expect(wrapper.find('.picker-row.is-active').text()).toContain('Alpha')
    })

    it('dispatches openNewInstall when the New Install row is clicked', async () => {
      const wrapper = await mountPicker({
        installs: [],
        activeInstallationId: null,
        runningInstallationIds: [],
      })
      const newInstallRow = wrapper.find('.picker-new-install')
      await newInstallRow.trigger('click')
      expect(bridge.newInstallCount).toBe(1)
    })

    it('dispatches pickInstall when the primary Open button is clicked', async () => {
      const wrapper = await mountPicker({
        installs: [makeInstall({ id: 'a', name: 'Alpha' })],
        activeInstallationId: 'a',
        runningInstallationIds: [],
      })
      const openButton = wrapper.find('.picker-detail-open')
      expect(openButton.exists()).toBe(true)
      await openButton.trigger('click')
      expect(bridge.picks).toEqual(['a'])
    })

    it('filters install rows by search query', async () => {
      const wrapper = await mountPicker({
        installs: [
          makeInstall({ id: 'a', name: 'Alpha' }),
          makeInstall({ id: 'b', name: 'Bravo' }),
        ],
        activeInstallationId: null,
        runningInstallationIds: [],
      })
      const input = wrapper.find('.picker-search input')
      await input.setValue('alph')
      await flushPromises()
      const installRows = wrapper
        .findAll('.picker-row')
        .filter((r) => !r.classes().includes('picker-row-cloud'))
      expect(installRows.map((r) => r.text()).join(' ')).toContain('Alpha')
      expect(installRows.map((r) => r.text()).join(' ')).not.toContain('Bravo')
    })

    it('switches visible rows when a non-all filter chip is activated', async () => {
      const wrapper = await mountPicker({
        installs: [
          makeInstall({ id: 'l', name: 'LocalThing', sourceCategory: 'local' }),
          makeInstall({ id: 'r', name: 'RemoteThing', sourceCategory: 'remote' }),
        ],
        activeInstallationId: null,
        runningInstallationIds: [],
      })
      const chips = wrapper.findAll('.picker-chip')
      const remoteChip = chips.find((c) => c.text() === 'Remote')
      expect(remoteChip).toBeTruthy()
      await remoteChip!.trigger('click')
      const installRows = wrapper
        .findAll('.picker-row')
        .filter((r) => !r.classes().includes('picker-row-cloud'))
      expect(installRows.length).toBe(1)
      expect(installRows[0]!.text()).toContain('RemoteThing')
    })
  })

  describe('detail pane', () => {
    it('shows the empty state when nothing is selected', async () => {
      const wrapper = await mountPicker({
        installs: [makeInstall({ id: 'a', name: 'Alpha' })],
        activeInstallationId: null,
        runningInstallationIds: [],
      })
      expect(wrapper.find('.picker-detail-empty').exists()).toBe(true)
      expect(wrapper.find('.picker-detail-open').exists()).toBe(false)
    })

    it('shows the install name + version pill in the detail pane', async () => {
      const wrapper = await mountPicker({
        installs: [
          makeInstall({ id: 'a', name: 'Alpha', version: '0.20.2+57' }),
        ],
        activeInstallationId: 'a',
        runningInstallationIds: [],
      })
      const detail = wrapper.find('.picker-detail')
      expect(detail.text()).toContain('Alpha')
      expect(detail.text()).toContain('0.20.2+57')
    })

    it('exposes the "Latest on GitHub" pill in the detail pane', async () => {
      const wrapper = await mountPicker({
        installs: [makeInstall({ id: 'a', name: 'Alpha' })],
        activeInstallationId: 'a',
        runningInstallationIds: [],
      })
      const detail = wrapper.find('.picker-detail')
      expect(detail.text()).toContain('Latest on GitHub')
    })

    it('shows Settings and Snapshots nav rows in the detail pane', async () => {
      const wrapper = await mountPicker({
        installs: [makeInstall({ id: 'a', name: 'Alpha' })],
        activeInstallationId: 'a',
        runningInstallationIds: [],
      })
      const nav = wrapper.find('.picker-detail-nav')
      expect(nav.text()).toContain('Settings')
      expect(nav.text()).toContain('Snapshots')
    })
  })
})
