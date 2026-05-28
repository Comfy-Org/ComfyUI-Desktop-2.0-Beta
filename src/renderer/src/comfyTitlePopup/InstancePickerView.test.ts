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
    getDetailSections: vi.fn().mockResolvedValue([]),
    getDiskSpace: vi.fn().mockResolvedValue(null),
    getInstallationSize: vi.fn().mockResolvedValue({ sizeBytes: 0 }),
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
    ; (window as unknown as { __comfyTitlePopup: typeof bridge }).__comfyTitlePopup = bridge
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
    props: {
      snapshot: enriched,
      globalSettingsSnapshot: {
        sharedDirectoriesFields: [],
        modelsDirs: [],
        modelsSystemDefault: '',
      },
    },
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

    // Spec item 2 — "Xh ago" recency is replaced by a "Current" pill on
    // the install whose host window opened the picker (NOT just the
    // selected row). Other rows keep their recency labels.
    it('renders the Current pill on the active-host install and only there', async () => {
      const wrapper = await mountPicker({
        installs: [
          makeInstall({ id: 'a', name: 'Alpha', lastLaunchedAt: Date.now() - 60_000 }),
          makeInstall({ id: 'b', name: 'Bravo', lastLaunchedAt: Date.now() - 3_600_000 }),
        ],
        activeInstallationId: 'a',
        runningInstallationIds: [],
      })
      const rows = wrapper.findAll('.picker-row')
      const alphaRow = rows.find((c) => c.text().includes('Alpha'))!
      const bravoRow = rows.find((c) => c.text().includes('Bravo'))!
      expect(alphaRow.find('.picker-row-current-pill').exists()).toBe(true)
      expect(alphaRow.find('.picker-row-recency').exists()).toBe(false)
      expect(bravoRow.find('.picker-row-current-pill').exists()).toBe(false)
      expect(bravoRow.find('.picker-row-recency').exists()).toBe(true)
    })

    // Spec item 6 — update-available paints the dot orange (overrides
    // the green running dot when both apply, since update is the more
    // actionable signal).
    it('paints the row dot orange when update available, including when also running', async () => {
      const wrapper = await mountPicker({
        installs: [
          makeInstall({
            id: 'a',
            name: 'Alpha',
            statusTag: { style: 'update', label: 'Update' },
          }),
          makeInstall({ id: 'b', name: 'Bravo' }),
        ],
        activeInstallationId: null,
        runningInstallationIds: ['a'],
      })
      const rows = wrapper.findAll('.picker-row')
      const alphaRow = rows.find((c) => c.text().includes('Alpha'))!
      // Orange takes precedence: orange present, green absent on the
      // same row even though it's also running.
      expect(alphaRow.find('.picker-row-update-dot').exists()).toBe(true)
      expect(alphaRow.find('.picker-row-running-dot').exists()).toBe(false)
      const bravoRow = rows.find((c) => c.text().includes('Bravo'))!
      expect(bravoRow.find('.picker-row-update-dot').exists()).toBe(false)
      expect(bravoRow.find('.picker-row-running-dot').exists()).toBe(false)
    })
  })

  // Spec item 10 — Home icon in the chips row dispatches the existing
  // `return-to-dashboard` menu-item activation through the popup
  // bridge. Only surfaces on install-hosted pickers, not on the
  // dashboard chooser's own picker.
  describe('home icon', () => {
    it('renders Home only when the picker is hosted by an install', async () => {
      const installHost = await mountPicker({
        installs: [makeInstall({ id: 'a', name: 'Alpha' })],
        activeInstallationId: 'a',
        runningInstallationIds: [],
      })
      expect(installHost.find('.picker-home').exists()).toBe(true)

      const chooserHost = await mountPicker({
        installs: [makeInstall({ id: 'a', name: 'Alpha' })],
        activeInstallationId: null,
        runningInstallationIds: [],
      })
      expect(chooserHost.find('.picker-home').exists()).toBe(false)
    })

    it('routes dashboard-button clicks through bridge.activate("new-window") so the running instance is not stopped', async () => {
      const activate = vi.fn()
      const existing = (window as unknown as { __comfyTitlePopup: Record<string, unknown> })
        .__comfyTitlePopup
      ;(window as unknown as { __comfyTitlePopup: Record<string, unknown> }).__comfyTitlePopup = {
        ...existing,
        activate,
      }
      const wrapper = await mountPicker({
        installs: [makeInstall({ id: 'a', name: 'Alpha' })],
        activeInstallationId: 'a',
        runningInstallationIds: [],
      })
      await wrapper.find('.picker-home').trigger('click')
      expect(activate).toHaveBeenCalledWith('new-window')
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
    it('auto-selects the first install on an install-less host', async () => {
      const wrapper = await mountPicker({
        installs: [
          makeInstall({ id: 'a', name: 'Alpha' }),
          makeInstall({ id: 'b', name: 'Beta' }),
        ],
        activeInstallationId: null,
        runningInstallationIds: [],
        selectedInstallationId: null,
      })
      await flushPromises()
      expect(wrapper.find('.settings-v2-content').exists()).toBe(true)
      expect(bridge.selectedInstallSets).toContain('a')
    })

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
