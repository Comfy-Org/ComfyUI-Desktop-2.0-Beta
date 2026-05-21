import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'

import { en } from '../lib/i18nMessages.ts'
import type { SnapshotListData } from '../types/ipc'

/** Minimal list payload — main always sends this for local installs; cloud omits it. */
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
 * Component tests for the instance-picker popover view. Compact mode
 * is a single-column list of self-contained PickerRow cards; expanded
 * mode mounts ComfyUISettingsContent in a list-left + settings-right
 * split. Tests below cover the compact-mode contract — each row is
 * its own affordance with Open + Manage CTAs and the picker dispatches
 * the right bridge IPC for each click.
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
  mode?: 'compact' | 'expanded'
}

interface BridgeState {
  picks: string[]
  restarts: string[]
  newInstallCount: number
  selectedInstallSets: (string | null)[]
  updateFieldCalls: { installationId: string; fieldId: string; value: unknown }[]
  runActionCalls: { installationId: string; actionId: string; actionData?: unknown }[]
  setPickerModeCalls: { mode: 'compact' | 'expanded'; opts?: unknown }[]
}

function installMockBridge(): BridgeState {
  const state: BridgeState = {
    picks: [],
    restarts: [],
    newInstallCount: 0,
    selectedInstallSets: [],
    updateFieldCalls: [],
    runActionCalls: [],
    setPickerModeCalls: [],
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
    setPickerMode: (mode: 'compact' | 'expanded', opts?: unknown) => {
      state.setPickerModeCalls.push({ mode, opts })
    },
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
  // Dynamic import so the bridge mock is installed (in `beforeEach`)
  // before the component touches `window.__comfyTitlePopup` — same
  // convention DownloadsView's test uses.
  const { default: InstancePickerView } = await import('./InstancePickerView.vue')
  // Fill in the new snapshot fields with safe defaults — tests that
  // exercise expanded mode pass `mode: 'expanded'` explicitly.
  const enriched = {
    selectedInstallationId: snapshot.activeInstallationId,
    selectedSettings: null,
    selectedSnapshots: null,
    mode: 'compact' as const,
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
    it('renders the search input, chip row, and rows pane', async () => {
      const wrapper = await mountPicker({
        installs: [],
        activeInstallationId: null,
        runningInstallationIds: [],
      })
      expect(wrapper.find('.picker-search input').exists()).toBe(true)
      expect(wrapper.findAll('.picker-chip').length).toBeGreaterThan(0)
      expect(wrapper.find('.picker-rows').exists()).toBe(true)
    })

    it('renders the "+ New Instance" CTA at the bottom of compact mode', async () => {
      const wrapper = await mountPicker({
        installs: [makeInstall({ id: 'a', name: 'Alpha' })],
        activeInstallationId: null,
        runningInstallationIds: [],
      })
      const newInstall = wrapper.find('.picker-new-install-row')
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
        .findAll('.picker-row-card-name')
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
      const cards = wrapper.findAll('.picker-row-card')
      const alphaCard = cards.find((c) => c.text().includes('Alpha'))
      expect(alphaCard!.classes()).toContain('is-running')
    })

    it('renders Open + Manage CTAs on every row', async () => {
      const wrapper = await mountPicker({
        installs: [
          makeInstall({ id: 'a', name: 'Alpha' }),
          makeInstall({ id: 'b', name: 'Bravo' }),
        ],
        activeInstallationId: null,
        runningInstallationIds: [],
      })
      const opens = wrapper.findAll('.picker-row-card-open')
      const manages = wrapper.findAll('.picker-row-card-manage')
      expect(opens.length).toBe(2)
      expect(manages.length).toBe(2)
    })

    it('shows the source-label and version pills on each row', async () => {
      const wrapper = await mountPicker({
        installs: [
          makeInstall({
            id: 'a',
            name: 'Alpha',
            version: '0.20.2+57',
            sourceLabel: 'GitHub',
          }),
        ],
        activeInstallationId: null,
        runningInstallationIds: [],
      })
      const card = wrapper.find('.picker-row-card')
      expect(card.text()).toContain('Alpha')
      expect(card.text()).toContain('GitHub')
      expect(card.text()).toContain('v0.20.2+57')
      expect(card.text()).not.toContain('vv0.20.2+57')
    })

    it('does not double-prefix the version pill when version already starts with v', async () => {
      const wrapper = await mountPicker({
        installs: [
          makeInstall({ id: 'a', name: 'Alpha', version: 'v0.21.1' }),
        ],
        activeInstallationId: null,
        runningInstallationIds: [],
      })
      const card = wrapper.find('.picker-row-card')
      expect(card.text()).toContain('v0.21.1')
      expect(card.text()).not.toContain('vv0.21.1')
    })
  })

  describe('user actions', () => {
    it('dispatches openNewInstall when the New Install row is clicked', async () => {
      const wrapper = await mountPicker({
        installs: [],
        activeInstallationId: null,
        runningInstallationIds: [],
      })
      const newInstallRow = wrapper.find('.picker-new-install-row')
      await newInstallRow.trigger('click')
      expect(bridge.newInstallCount).toBe(1)
    })

    it('dispatches pickInstall when a row\'s Open button is clicked', async () => {
      const wrapper = await mountPicker({
        installs: [makeInstall({ id: 'a', name: 'Alpha' })],
        activeInstallationId: 'a',
        runningInstallationIds: [],
      })
      const openButton = wrapper.find('.picker-row-card-open')
      expect(openButton.exists()).toBe(true)
      await openButton.trigger('click')
      expect(bridge.picks).toEqual(['a'])
      expect(bridge.restarts).toEqual([])
    })

    it('switches a row\'s primary CTA to "Restart" when the install is running', async () => {
      // Clicking Open on a running install would be a no-op visually
      // (main just refocuses the existing window), so the per-row CTA
      // flips to Restart and dispatches the restart flow.
      const wrapper = await mountPicker({
        installs: [makeInstall({ id: 'a', name: 'Alpha' })],
        activeInstallationId: 'a',
        runningInstallationIds: ['a'],
      })
      const openButton = wrapper.find('.picker-row-card-open')
      expect(openButton.text()).toBe('Restart')
      await openButton.trigger('click')
      expect(bridge.restarts).toEqual(['a'])
      expect(bridge.picks).toEqual([])
    })

    it('keeps the primary CTA as "Open" for non-running rows', async () => {
      const wrapper = await mountPicker({
        installs: [
          makeInstall({ id: 'a', name: 'Alpha' }),
          makeInstall({ id: 'b', name: 'Bravo' }),
        ],
        activeInstallationId: 'a',
        runningInstallationIds: ['b'],
      })
      // Alpha is not running — its Open button should read "Open".
      const cards = wrapper.findAll('.picker-row-card')
      const alphaCard = cards.find((c) => c.text().includes('Alpha'))
      expect(alphaCard!.find('.picker-row-card-open').text()).toBe('Open')
    })

    it('dispatches setPickerMode("expanded") with config tab when Manage is clicked', async () => {
      const wrapper = await mountPicker({
        installs: [makeInstall({ id: 'a', name: 'Alpha' })],
        activeInstallationId: 'a',
        runningInstallationIds: [],
      })
      const manageButton = wrapper.find('.picker-row-card-manage')
      await manageButton.trigger('click')
      await flushPromises()
      expect(bridge.setPickerModeCalls.length).toBe(1)
      expect(bridge.setPickerModeCalls[0]).toEqual({
        mode: 'expanded',
        opts: { initialTab: 'config' },
      })
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
      const cards = wrapper.findAll('.picker-row-card')
      expect(cards.length).toBe(1)
      expect(cards[0]!.text()).toContain('Alpha')
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
      const cards = wrapper.findAll('.picker-row-card')
      expect(cards.length).toBe(1)
      expect(cards[0]!.text()).toContain('RemoteThing')
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
      expect(wrapper.find('.picker-rows-empty').exists()).toBe(true)
    })
  })

  describe('expanded mode', () => {
    it('mounts the list-left + settings-right split when mode is expanded', async () => {
      const wrapper = await mountPicker({
        installs: [makeInstall({ id: 'a', name: 'Alpha' })],
        activeInstallationId: 'a',
        runningInstallationIds: [],
        mode: 'expanded',
        selectedSnapshots: emptySnapshotListPayload,
      })
      // Expanded mode keeps the left list (compact InstanceRow shape)
      // and mounts ComfyUISettingsContent on the right.
      expect(wrapper.find('.picker-list').exists()).toBe(true)
      expect(wrapper.find('.picker-detail-wrap.is-expanded').exists()).toBe(true)
      // Compact rows are NOT mounted in expanded mode.
      expect(wrapper.find('.picker-rows').exists()).toBe(false)
    })

    it('pulls main\'s locale catalog on first expand', async () => {
      await mountPicker({
        installs: [makeInstall({ id: 'a', name: 'Alpha' })],
        activeInstallationId: 'a',
        runningInstallationIds: [],
        mode: 'expanded',
        selectedSnapshots: emptySnapshotListPayload,
      })
      await flushPromises()
      const bridgeRef = (window as unknown as {
        __comfyTitlePopup: { pickerSettingsGetLocaleMessages: ReturnType<typeof vi.fn> }
      }).__comfyTitlePopup
      expect(bridgeRef.pickerSettingsGetLocaleMessages).toHaveBeenCalled()
    })
  })
})
