import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'

import { en } from '../lib/i18nMessages.ts'
import type { SnapshotListData } from '../types/ipc'

// The interactive console pane drives a real xterm terminal (needs a canvas);
// stub it so the picker's detail pane renders without a terminal host.
vi.mock('../views/comfyUISettings/ConsoleTerminalPane.vue', () => ({
  default: {
    name: 'ConsoleTerminalPane',
    props: ['installationId'],
    template: '<div data-testid="console-terminal-pane-stub" />',
  },
}))

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
  /** Optional — defaults to `[]` in `mountPicker`. Tests that exercise
   *  the launching state explicitly set this. */
  launchingInstallationIds?: string[]
  selectedInstallationId?: string | null
  pickerSelectionEpoch?: number
  selectedSettings?: unknown[] | null
  selectedSnapshots?: unknown | null
}

interface BridgeState {
  picks: string[]
  /** Captures opts so tests assert the renderer-confirmed flag reaches the bridge. */
  restarts: { id: string; opts?: { confirmed?: boolean } }[]
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
    restartInstall: (id: string, opts?: { confirmed?: boolean }) => {
      state.restarts.push({ id, opts })
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
    launchingInstallationIds: [] as string[],
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

    // The "Current" pill replaces recency on the active-host install only.
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

    // Update-available paints the dot orange, overriding the green running dot.
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
      // Orange present, green absent even though the row is also running.
      expect(alphaRow.find('.picker-row-update-dot').exists()).toBe(true)
      expect(alphaRow.find('.picker-row-running-dot').exists()).toBe(false)
      const bravoRow = rows.find((c) => c.text().includes('Bravo'))!
      expect(bravoRow.find('.picker-row-update-dot').exists()).toBe(false)
      expect(bravoRow.find('.picker-row-running-dot').exists()).toBe(false)
    })
  })

  // Home dispatches `return-to-dashboard`; only on install-hosted pickers.
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

    it('shows the in-drawer confirm and dispatches restartInstall(confirmed) on accept', async () => {
      const { default: ComfyUISettingsContent } = await import(
        '../components/settings/ComfyUISettingsContent.vue'
      )
      const { useDialogs } = await import('../composables/useDialogs')
      const wrapper = await mountPicker({
        installs: [makeInstall({ id: 'a', name: 'Alpha', sourceCategory: 'local' })],
        activeInstallationId: 'a',
        runningInstallationIds: ['a'],
      })
      const settings = wrapper.findComponent(ComfyUISettingsContent)
      expect(settings.exists()).toBe(true)
      settings.vm.$emit('primary-action', true)
      await flushPromises()
      // Renderer parks on the confirm; bridge hasn't fired yet.
      const dialogs = useDialogs()
      expect(dialogs.state.open).toBe(true)
      expect(dialogs.state.kind).toBe('confirm')
      expect(dialogs.state.confirm.title).toBe('Restart instance?')
      expect(bridge.restarts).toEqual([])
      // Accept — bridge fires `confirmed: true` so main skips its system-modal.
      dialogs.confirmPrimary()
      await flushPromises()
      expect(bridge.restarts).toEqual([{ id: 'a', opts: { confirmed: true } }])
      expect(bridge.picks).toEqual([])
    })

    it('does not dispatch restartInstall when the in-drawer confirm is cancelled', async () => {
      const { default: ComfyUISettingsContent } = await import(
        '../components/settings/ComfyUISettingsContent.vue'
      )
      const { useDialogs } = await import('../composables/useDialogs')
      const wrapper = await mountPicker({
        installs: [makeInstall({ id: 'a', name: 'Alpha', sourceCategory: 'local' })],
        activeInstallationId: 'a',
        runningInstallationIds: ['a'],
      })
      const settings = wrapper.findComponent(ComfyUISettingsContent)
      settings.vm.$emit('primary-action', true)
      await flushPromises()
      const dialogs = useDialogs()
      expect(dialogs.state.open).toBe(true)
      dialogs.cancel()
      await flushPromises()
      expect(bridge.restarts).toEqual([])
    })

    it('skips the in-drawer confirm for non-local installs (no local process to kill)', async () => {
      const { default: ComfyUISettingsContent } = await import(
        '../components/settings/ComfyUISettingsContent.vue'
      )
      const { useDialogs } = await import('../composables/useDialogs')
      const wrapper = await mountPicker({
        installs: [makeInstall({ id: 'r', name: 'Remote', sourceCategory: 'remote' })],
        activeInstallationId: 'r',
        runningInstallationIds: ['r'],
      })
      const settings = wrapper.findComponent(ComfyUISettingsContent)
      settings.vm.$emit('primary-action', true)
      await flushPromises()
      // No confirm parked — restart fires straight through with `confirmed: true`.
      const dialogs = useDialogs()
      expect(dialogs.state.open).toBe(false)
      expect(bridge.restarts).toEqual([{ id: 'r', opts: { confirmed: true } }])
    })

    // An install running in ANOTHER window must route through pickInstall (which
    // focuses that window), not restartInstall.
    it('dispatches pickInstall (not restart) for an install running in another window', async () => {
      const { default: ComfyUISettingsContent } = await import(
        '../components/settings/ComfyUISettingsContent.vue'
      )
      const wrapper = await mountPicker({
        installs: [
          makeInstall({ id: 'a', name: 'Alpha' }),
          makeInstall({ id: 'b', name: 'Bravo' }),
        ],
        // Host is attached to 'a'; selected 'b' runs in its own window.
        activeInstallationId: 'a',
        selectedInstallationId: 'b',
        runningInstallationIds: ['b'],
      })
      const settings = wrapper.findComponent(ComfyUISettingsContent)
      expect(settings.exists()).toBe(true)
      settings.vm.$emit('primary-action', false)
      await flushPromises()
      expect(bridge.picks).toEqual(['b'])
      expect(bridge.restarts).toEqual([])
    })
  })

  // `sessionStore` is hydrated only from the snapshot (no `onInstanceLaunching`
  // in the preload), so the watcher must fire on launching-only transitions or
  // `useInstallCta` keeps the CTA on Start for the whole launching window.
  describe('session-store hydration from snapshot', () => {
    it('hydrates launching ids when only launchingInstallationIds changes', async () => {
      const { useSessionStore } = await import('../stores/sessionStore')
      const wrapper = await mountPicker({
        installs: [makeInstall({ id: 'a', name: 'Alpha' })],
        activeInstallationId: null,
        runningInstallationIds: [],
        launchingInstallationIds: [],
      })
      const sessionStore = useSessionStore()
      expect(sessionStore.isLaunching('a')).toBe(false)

      await wrapper.setProps({
        snapshot: {
          installs: [makeInstall({ id: 'a', name: 'Alpha' })],
          activeInstallationId: 'a',
          runningInstallationIds: [],
          launchingInstallationIds: ['a'],
          selectedInstallationId: null,
          selectedSettings: null,
          selectedSnapshots: emptySnapshotListPayload,
        },
      })
      await flushPromises()
      expect(sessionStore.isLaunching('a')).toBe(true)
    })

    // Snapshot-driven selection updates are gated on a strictly-increasing
    // `pickerSelectionEpoch` (only `openInstancePickerForHost` bumps it), so a
    // stale same-epoch rebroadcast can't snap a fast local pick back.
    describe('selection epoch gating (#788)', () => {
      it('ignores a stale same-epoch snapshot that would override a local pick', async () => {
        const wrapper = await mountPicker({
          installs: [
            makeInstall({ id: 'a', name: 'Alpha' }),
            makeInstall({ id: 'b', name: 'Bravo' }),
          ],
          activeInstallationId: 'a',
          runningInstallationIds: [],
          // First (open) snapshot at epoch 1: main seeded selection = 'a'.
          pickerSelectionEpoch: 1,
        })

        // User clicks Bravo locally.
        const bravoRow = wrapper.findAll('.picker-row').find((c) => c.text().includes('Bravo'))
        await bravoRow!.trigger('click')
        await flushPromises()
        expect(bridge.selectedInstallSets.at(-1)).toBe('b')
        const echoCountAfterClick = bridge.selectedInstallSets.length

        // A late same-epoch snapshot carrying the old selection ('a') must not
        // re-select 'a' or re-echo it back to main.
        await wrapper.setProps({
          snapshot: {
            installs: [
              makeInstall({ id: 'a', name: 'Alpha' }),
              makeInstall({ id: 'b', name: 'Bravo' }),
            ],
            activeInstallationId: 'a',
            runningInstallationIds: [],
            launchingInstallationIds: [],
            selectedInstallationId: 'a',
            pickerSelectionEpoch: 1,
            selectedSettings: null,
            selectedSnapshots: emptySnapshotListPayload,
          },
        })
        await flushPromises()

        const stillBravo = wrapper.findAll('.picker-row').find((c) => c.text().includes('Bravo'))
        expect(stillBravo!.classes()).toContain('is-active')
        expect(bridge.selectedInstallSets.length).toBe(echoCountAfterClick)
        expect(bridge.selectedInstallSets.at(-1)).toBe('b')
      })

      it('retargets selection when the epoch advances (main reopened picker)', async () => {
        const wrapper = await mountPicker({
          installs: [
            makeInstall({ id: 'a', name: 'Alpha' }),
            makeInstall({ id: 'b', name: 'Bravo' }),
            makeInstall({ id: 'c', name: 'Charlie' }),
          ],
          activeInstallationId: 'a',
          runningInstallationIds: [],
          pickerSelectionEpoch: 1,
        })

        // User clicks Bravo locally.
        const bravoRow = wrapper.findAll('.picker-row').find((c) => c.text().includes('Bravo'))
        await bravoRow!.trigger('click')
        await flushPromises()

        // Main retargets to Charlie via a fresh open; the epoch advances so the
        // renderer honours it.
        await wrapper.setProps({
          snapshot: {
            installs: [
              makeInstall({ id: 'a', name: 'Alpha' }),
              makeInstall({ id: 'b', name: 'Bravo' }),
              makeInstall({ id: 'c', name: 'Charlie' }),
            ],
            activeInstallationId: 'a',
            runningInstallationIds: [],
            launchingInstallationIds: [],
            selectedInstallationId: 'c',
            pickerSelectionEpoch: 2,
            selectedSettings: null,
            selectedSnapshots: emptySnapshotListPayload,
          },
        })
        await flushPromises()

        const charlie = wrapper.findAll('.picker-row').find((c) => c.text().includes('Charlie'))
        expect(charlie!.classes()).toContain('is-active')
      })
    })

    it('clears a launching id when it drops out of the snapshot', async () => {
      const { useSessionStore } = await import('../stores/sessionStore')
      const wrapper = await mountPicker({
        installs: [makeInstall({ id: 'a', name: 'Alpha' })],
        activeInstallationId: 'a',
        runningInstallationIds: [],
        launchingInstallationIds: ['a'],
      })
      const sessionStore = useSessionStore()
      expect(sessionStore.isLaunching('a')).toBe(true)

      await wrapper.setProps({
        snapshot: {
          installs: [makeInstall({ id: 'a', name: 'Alpha' })],
          activeInstallationId: 'a',
          runningInstallationIds: ['a'],
          launchingInstallationIds: [],
          selectedInstallationId: null,
          selectedSettings: null,
          selectedSnapshots: emptySnapshotListPayload,
        },
      })
      await flushPromises()
      expect(sessionStore.isLaunching('a')).toBe(false)
      expect(sessionStore.isRunning('a')).toBe(true)
    })
  })
})
