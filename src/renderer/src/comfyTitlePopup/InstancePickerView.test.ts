import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'

import { en } from '../lib/i18nMessages.ts'
import type { SnapshotListData } from '../types/ipc'

const emptySnapshotListPayload: SnapshotListData = {
  snapshots: [],
  copyEvents: [],
  totalCount: 0,
  context: {
    updateChannel: 'stable',
    pythonVersion: '3.12',
    variant: 'cpu',
    variantLabel: 'CPU',
  },
}

  ; (window as unknown as { api: Record<string, unknown> }).api = {
    onErrorDetail: vi.fn(() => () => { }),
    onInstanceStarted: vi.fn(() => () => { }),
    onInstanceStopped: vi.fn(() => () => { }),
    onInstanceProgress: vi.fn(() => () => { }),
    onSessionStateChanged: vi.fn(() => () => { }),
  }

/**
 * Component tests for the instance-picker popover view. Always renders
 * the master–detail split: list-left + settings-right.
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
  selectedInstallationId?: string | null
  selectedSettings?: unknown[] | null
  selectedSnapshots?: unknown | null
}

interface BridgeState {
  picks: string[]
  restarts: string[]
  newInstallCount: number
  selectedInstallSets: (string | null)[]
  updateFieldCalls: { installationId: string; fieldId: string; value: unknown }[]
  runActionCalls: { installationId: string; actionId: string; actionData?: unknown }[]
}

function installMockBridge(): BridgeState {
  const state: BridgeState = {
    picks: [],
    restarts: [],
    newInstallCount: 0,
    selectedInstallSets: [],
    updateFieldCalls: [],
    runActionCalls: [],
  }
  const bridge = {
    pickInstall: (id: string) => {
      state.picks.push(id)
    },
    restartInstall: (id: string) => {
      state.restarts.push(id)
    },
    openNewInstall: () => {
      state.newInstallCount += 1
    },
    openSettingsTab: vi.fn(),
    setPickerSelectedInstall: (id: string | null) => {
      state.selectedInstallSets.push(id)
    },
    pickerUpdateField: vi.fn(
      async (installationId: string, fieldId: string, value: unknown) => {
        state.updateFieldCalls.push({ installationId, fieldId, value })
        return { ok: true }
      },
    ),
    pickerRunAction: vi.fn(
      async (installationId: string, actionId: string, actionData?: unknown) => {
        state.runActionCalls.push({ installationId, actionId, actionData })
        return { ok: true }
      },
    ),
    pickerSettingsGetLocaleMessages: vi.fn(async () => ({})),
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
  const { default: InstancePickerView } = await import('./InstancePickerView.vue')
  const enriched = {
    selectedInstallationId: snapshot.activeInstallationId,
    selectedSettings: null,
    selectedSnapshots: emptySnapshotListPayload,
    ...snapshot,
  }
  return mount(InstancePickerView, {
    props: { snapshot: enriched },
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
    it('renders the search input, chip row, and split panes', async () => {
      const wrapper = await mountPicker({
        installs: [],
        activeInstallationId: null,
        runningInstallationIds: [],
      })
      expect(wrapper.find('.picker-search input').exists()).toBe(true)
      expect(wrapper.findAll('.picker-chip').length).toBeGreaterThan(0)
      expect(wrapper.find('.picker-list').exists()).toBe(true)
      expect(wrapper.find('.picker-detail-wrap.is-expanded').exists()).toBe(true)
    })

    it('renders the "+ New Instance" CTA in the left footer', async () => {
      const wrapper = await mountPicker({
        installs: [makeInstall({ id: 'a', name: 'Alpha' })],
        activeInstallationId: null,
        runningInstallationIds: [],
      })
      const newInstall = wrapper.find('.picker-new-install')
      expect(newInstall.exists()).toBe(true)
    })
  })

  describe('row rendering', () => {
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
      const namesInOrder = wrapper
        .findAll('.picker-row-name')
        .map((n) => n.text())
      expect(namesInOrder).toEqual(['New', 'Old', 'Never'])
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
      const rows = wrapper.findAll('.picker-row')
      const alphaRow = rows.find((c) => c.text().includes('Alpha'))
      expect(alphaRow!.classes()).toContain('is-running')
    })

    it('selects a row on click without launching', async () => {
      const wrapper = await mountPicker({
        installs: [
          makeInstall({ id: 'a', name: 'Alpha' }),
          makeInstall({ id: 'b', name: 'Bravo' }),
        ],
        activeInstallationId: 'a',
        runningInstallationIds: [],
      })
      const bravoRow = wrapper.findAll('.picker-row').find((c) => c.text().includes('Bravo'))
      await bravoRow!.trigger('click')
      await flushPromises()
      expect(bridge.picks).toEqual([])
      expect(bridge.selectedInstallSets.at(-1)).toBe('b')
    })
  })

  describe('user actions', () => {
    it('dispatches openNewInstall when the New Instance button is clicked', async () => {
      const wrapper = await mountPicker({
        installs: [],
        activeInstallationId: null,
        runningInstallationIds: [],
      })
      const newInstallRow = wrapper.find('.picker-new-install')
      await newInstallRow.trigger('click')
      expect(bridge.newInstallCount).toBe(1)
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
      const rows = wrapper.findAll('.picker-row')
      expect(rows.length).toBe(1)
      expect(rows[0]!.text()).toContain('Alpha')
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
      const rows = wrapper.findAll('.picker-row')
      expect(rows.length).toBe(1)
      expect(rows[0]!.text()).toContain('RemoteThing')
    })

    it('shows the empty-state hint when no rows match', async () => {
      const wrapper = await mountPicker({
        installs: [makeInstall({ id: 'a', name: 'Alpha' })],
        activeInstallationId: null,
        runningInstallationIds: [],
      })
      const input = wrapper.find('.picker-search input')
      await input.setValue('zzzz-no-match')
      await flushPromises()
      expect(wrapper.find('.picker-list-empty').exists()).toBe(true)
    })
  })

  describe('settings pane', () => {
    it('mounts ComfyUISettingsContent when an install is selected', async () => {
      const wrapper = await mountPicker({
        installs: [makeInstall({ id: 'a', name: 'Alpha' })],
        activeInstallationId: 'a',
        runningInstallationIds: [],
      })
      expect(wrapper.find('.settings-v2-content').exists()).toBe(true)
    })

    it('pulls main\'s locale catalog on mount', async () => {
      await mountPicker({
        installs: [makeInstall({ id: 'a', name: 'Alpha' })],
        activeInstallationId: 'a',
        runningInstallationIds: [],
      })
      await flushPromises()
      const bridgeRef = (window as unknown as {
        __comfyTitlePopup: { pickerSettingsGetLocaleMessages: ReturnType<typeof vi.fn> }
      }).__comfyTitlePopup
      expect(bridgeRef.pickerSettingsGetLocaleMessages).toHaveBeenCalled()
    })
  })

  // Settings pane's primary CTA is the only launch path now — used to
  // live on the compact row. Cover the pick-vs-restart branch directly
  // so the regression alarm fires if the dispatch logic drifts.
  describe('primary action dispatch', () => {
    it('dispatches pickInstall when the selected install is not running', async () => {
      const { default: ComfyUISettingsContent } = await import(
        '../components/settings/ComfyUISettingsContent.vue'
      )
      const wrapper = await mountPicker({
        installs: [makeInstall({ id: 'a', name: 'Alpha' })],
        activeInstallationId: 'a',
        runningInstallationIds: [],
      })
      const settings = wrapper.findComponent(ComfyUISettingsContent)
      expect(settings.exists()).toBe(true)
      settings.vm.$emit('primary-action', false)
      await flushPromises()
      expect(bridge.picks).toEqual(['a'])
      expect(bridge.restarts).toEqual([])
    })

    it('dispatches restartInstall when the selected install is running', async () => {
      const { default: ComfyUISettingsContent } = await import(
        '../components/settings/ComfyUISettingsContent.vue'
      )
      const wrapper = await mountPicker({
        installs: [makeInstall({ id: 'a', name: 'Alpha' })],
        activeInstallationId: 'a',
        runningInstallationIds: ['a'],
      })
      const settings = wrapper.findComponent(ComfyUISettingsContent)
      expect(settings.exists()).toBe(true)
      settings.vm.$emit('primary-action', true)
      await flushPromises()
      expect(bridge.restarts).toEqual(['a'])
      expect(bridge.picks).toEqual([])
    })
  })
})
