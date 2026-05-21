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
  // exercise the picker's right-pane Settings/Snapshots accordions
  // override these explicitly. Older test cases predate these fields
  // and don't care.
  const enriched = {
    selectedInstallationId: snapshot.activeInstallationId,
    selectedSettings: null,
    selectedSnapshots: null,
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
      expect(bridge.restarts).toEqual([])
    })

    it('switches the primary CTA to "Restart" when the selected install is running', async () => {
      // Clicking Open on a running install would be a no-op visually
      // (main just refocuses the existing window), so the CTA flips to
      // Restart and dispatches the restart flow (stop → re-launch)
      // through the dedicated bridge method. Main confirms via a
      // native dialog before actually killing the session.
      const wrapper = await mountPicker({
        installs: [makeInstall({ id: 'a', name: 'Alpha' })],
        activeInstallationId: 'a',
        runningInstallationIds: ['a'],
      })
      const openButton = wrapper.find('.picker-detail-open')
      expect(openButton.text()).toBe('Restart')
      await openButton.trigger('click')
      expect(bridge.restarts).toEqual(['a'])
      expect(bridge.picks).toEqual([])
    })

    it('pushes the selected install id to main when the user picks a different row', async () => {
      // The picker tells main about its current selection via
      // `setPickerSelectedInstall` whenever the user picks a different
      // row. Main re-resolves Settings + Snapshots for the new install
      // and pushes a fresh snapshot back. The initial selection on
      // mount does NOT fire this IPC — main already seeded
      // `pickerSelectedInstallationId` with the host's active install
      // and kicked the initial details fetch before showing the
      // popup, so an `immediate: true` watcher would cause a spurious
      // re-broadcast → resize-during-open flicker.
      const wrapper = await mountPicker({
        installs: [
          makeInstall({ id: 'a', name: 'Alpha' }),
          makeInstall({ id: 'b', name: 'Bravo' }),
        ],
        activeInstallationId: 'a',
        runningInstallationIds: [],
      })
      expect(bridge.selectedInstallSets).toEqual([])
      const bravoRow = wrapper
        .findAll('.picker-row')
        .find((r) => r.text().includes('Bravo'))
      await bravoRow!.trigger('click')
      await flushPromises()
      expect(bridge.selectedInstallSets[bridge.selectedInstallSets.length - 1]).toBe('b')
    })

    it('keeps the primary CTA as "Open" for non-running selections', async () => {
      const wrapper = await mountPicker({
        installs: [
          makeInstall({ id: 'a', name: 'Alpha' }),
          makeInstall({ id: 'b', name: 'Bravo' }),
        ],
        activeInstallationId: 'a',
        runningInstallationIds: ['b'],
      })
      expect(wrapper.find('.picker-detail-open').text()).toBe('Open')
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
      expect(detail.text()).toContain('v0.20.2+57')
      expect(detail.text()).not.toContain('vv0.20.2+57')
    })

    it('does not double-prefix the version pill when version already starts with v', async () => {
      const wrapper = await mountPicker({
        installs: [
          makeInstall({ id: 'a', name: 'Alpha', version: 'v0.21.1' }),
        ],
        activeInstallationId: 'a',
        runningInstallationIds: [],
      })
      const detail = wrapper.find('.picker-detail')
      expect(detail.text()).toContain('v0.21.1')
      expect(detail.text()).not.toContain('vv0.21.1')
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

    it('shows Settings and Snapshots nav when main sent a snapshots list payload', async () => {
      const wrapper = await mountPicker({
        installs: [makeInstall({ id: 'a', name: 'Alpha' })],
        activeInstallationId: 'a',
        runningInstallationIds: [],
        selectedSnapshots: emptySnapshotListPayload,
      })
      const nav = wrapper.find('.picker-detail-nav')
      expect(nav.text()).toContain('Settings')
      expect(nav.text()).toContain('Snapshots')
    })
  })
})
