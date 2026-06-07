import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia, getActivePinia, setActivePinia } from 'pinia'
import { computed, ref, nextTick } from 'vue'

import type { Installation } from '../../types/ipc'
import { useSessionStore } from '../../stores/sessionStore'

/**
 * Tests for the picker/drawer's per-install settings body. Locks: (1) overlay
 * title branches on `isDowngrade` for `update-comfyui`; (2) no overlay for
 * `snapshot-restore`; (3) footer "More" disables on opInflight and auto-closes.
 * Heavy children + `useComfyUISettings` are stubbed.
 */

const messages = {
  en: {
    common: { back: 'Back', cancel: 'Cancel' },
    comfyUISettings: {
      title: 'Settings',
      tabConfig: 'Startup Args',
      tabStatus: 'About',
      tabUpdate: 'Update',
      tabSnapshots: 'Snapshots',
      tabStorage: 'Storage',
      tabConsole: 'Console',
      relaunch: 'Relaunch',
      more: 'More',
    },
    tooltips: {
      snapshots:
        'A saved point-in-time state of an installation (versions + custom nodes) you can restore later.',
      console:
        "An interactive shell running in this installation's folder. Works whether ComfyUI is running or stopped.",
    },
    instancePicker: {
      open: 'Start',
      restart: 'Restart',
      switch: 'Switch',
      restartToApply: 'Restart to apply changes',
      progressUpdating: 'Updating…',
      progressDowngrading: 'Downgrading…',
      progressSuccessStopped: 'Update complete',
      progressSuccessRunning: 'Updated & relaunched',
      progressDowngraded: 'Downgrade complete',
      progressCopying: 'Copying…',
      progressCopied: 'Copy complete',
      progressCopyingUpdating: 'Copying & updating…',
      progressCopiedUpdated: 'Copy complete',
      progressDeleting: 'Deleting…',
      progressDeleted: 'Deleted',
      progressRestoring: 'Restoring snapshot…',
      progressRestored: 'Snapshot restored',
      progressMigrating: 'Migrating…',
      progressMigrated: 'Migration complete',
      progressDone: 'Done',
      progressCancel: 'Cancel',
      progressRetry: 'Try Again',
      progressDismiss: 'Dismiss',
      progressError: 'Something went wrong',
      progressCancelled: 'Cancelled',
      progressWorking: 'Working…',
      progressSuccessCountdown: 'Returning to settings in {n}…',
    },
  },
} as const

function createTestI18n() {
  return createI18n({ legacy: false, locale: 'en', messages })
}

const useComfyUISettingsState = {
  pinBottomActions: ref<{ id: string; label: string }[]>([{ id: 'untrack', label: 'Forget' }]),
  sections: ref<unknown[]>([{ tab: 'update', fields: [] }, { tab: 'status', fields: [] }, { tab: 'snapshots' }]),
  loading: ref(false),
  error: ref<null>(null),
  // Default fresh; the "switch staleness" tests override to false.
  sectionsFresh: ref<boolean>(true),
  runningActionIds: ref<Set<string>>(new Set()),
  pendingRestartFieldIds: ref<Set<string>>(new Set()),
  fieldErrorMessages: ref<Record<string, string>>({}),
  diskUsageItem: ref(null),
  // Stable spy so stale-watcher tests can assert the channel-refresh watcher
  // doesn't auto-fire against the wrong install's payload.
  runActionStub: vi.fn(),
}
vi.mock('../../composables/useComfyUISettings', () => ({
  useComfyUISettings: () => ({
    ...useComfyUISettingsState,
    updateField: vi.fn(),
    runAction: useComfyUISettingsState.runActionStub,
    // Mirror the real ComputedRef<DetailSection[]> so `.value.length` reads work.
    sectionsForTab: (tab: string) => computed(() => {
      const hasTab = useComfyUISettingsState.sections.value.some(
        (s) => (s as { tab?: string }).tab === tab
      )
      return hasTab ? [{ tab, fields: [] }] : []
    }),
    reload: vi.fn(),
  }),
}))

// Stub heavy children — only their host wiring matters.
vi.mock('../../views/comfyUISettings/SnapshotsView.vue', () => ({
  default: {
    name: 'SnapshotsView',
    emits: ['op-cancel', 'op-retry', 'op-dismiss', 'run-action', 'refresh-all'],
    template: '<div data-testid="snapshots-view-stub"></div>',
  },
}))
vi.mock('../../views/comfyUISettings/SettingsSectionList.vue', () => ({
  default: { template: '<div data-testid="settings-section-list-stub"></div>' },
}))
vi.mock('../../views/comfyUISettings/StatusFactPanel.vue', () => ({
  default: { template: '<div />' },
}))
vi.mock('../../views/comfyUISettings/StoragePane.vue', () => ({
  default: { template: '<div />' },
}))
vi.mock('../../views/comfyUISettings/ConsoleTerminalPane.vue', () => ({
  default: { name: 'ConsoleTerminalPane', props: ['installationId'], template: '<div data-testid="console-terminal-pane-stub" />' },
}))
vi.mock('../../views/comfyUISettings/ArgsBuilderPage.vue', () => ({
  default: { template: '<div />' },
}))
vi.mock('../../views/comfyUISettings/MoreMenu.vue', () => ({
  default: {
    props: ['open'],
    template: '<div v-if="open" data-testid="more-menu">menu</div>',
  },
}))

const SAMPLE_INSTALL: Installation = {
  id: 'inst-1',
  name: 'My Install',
  sourceId: 'standalone',
  sourceLabel: 'Standalone',
  sourceCategory: 'local',
  status: 'installed',
} as unknown as Installation

async function mountContent(props: Record<string, unknown> = {}): Promise<VueWrapper> {
  const { default: ComfyUISettingsContent } = await import('./ComfyUISettingsContent.vue')
  // Reuse the active pinia so session-store seeding shares the mounted instance.
  const pinia = getActivePinia() ?? createPinia()
  const wrapper = mount(ComfyUISettingsContent, {
    props: {
      installation: SAMPLE_INSTALL,
      initialTab: 'update',
      activeOperation: null,
      ...props,
    },
    global: { plugins: [createTestI18n(), pinia] },
  }) as VueWrapper
  await flushPromises()
  return wrapper
}

describe('ComfyUISettingsContent', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      onErrorDetail: vi.fn(() => () => {}),
      onInstanceProgress: vi.fn(() => () => {}),
      getDiskSpace: vi.fn().mockResolvedValue(null),
    }
    useComfyUISettingsState.pinBottomActions.value = [{ id: 'untrack', label: 'Forget' }]
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('overlay title — isDowngrade branch', () => {
    it('renders "Updating…" when actionData.isDowngrade is false', async () => {
      const w = await mountContent({
        activeOperation: {
          actionId: 'update-comfyui',
          actionData: { isDowngrade: false },
          done: false, ok: null, error: null,
          percent: 30, status: 'Fetching…', cancellable: false, title: '',
        },
      })
      expect(w.find('.op-title').text()).toBe('Updating…')
    })

    it('renders "Downgrading…" when actionData.isDowngrade is true', async () => {
      const w = await mountContent({
        activeOperation: {
          actionId: 'update-comfyui',
          actionData: { isDowngrade: true },
          done: false, ok: null, error: null,
          percent: 30, status: 'Fetching…', cancellable: false, title: '',
        },
      })
      expect(w.find('.op-title').text()).toBe('Downgrading…')
    })

    it('success title says "Downgrade complete" when isDowngrade is true', async () => {
      const w = await mountContent({
        activeOperation: {
          actionId: 'update-comfyui',
          actionData: { isDowngrade: true },
          done: true, ok: true, error: null,
          percent: 100, status: 'Complete', cancellable: false, title: '',
        },
      })
      expect(w.find('.op-title').text()).toBe('Downgrade complete')
    })

    it('success title says "Update complete" when isDowngrade is false', async () => {
      const w = await mountContent({
        activeOperation: {
          actionId: 'update-comfyui',
          actionData: { isDowngrade: false },
          done: true, ok: true, error: null,
          percent: 100, status: 'Complete', cancellable: false, title: '',
        },
      })
      expect(w.find('.op-title').text()).toBe('Update complete')
    })
  })

  describe('overlay routing', () => {
    it('does NOT render the overlay for snapshot-restore on the snapshots tab', async () => {
      const w = await mountContent({
        initialTab: 'snapshots',
        activeOperation: {
          actionId: 'snapshot-restore',
          actionData: { file: 'snap-1.json' },
          done: false, ok: null, error: null,
          percent: 30, status: 'Loading snapshot…', cancellable: true, title: '',
        },
      })
      // On the snapshots tab SnapshotsView renders its own rail, so the generic
      // overlay must stay hidden to avoid double progress UI.
      expect(w.find('.op-overlay').exists()).toBe(false)
    })

    it('auto-switches to the snapshots tab when a snapshot-restore op starts on another tab', async () => {
      const w = await mountContent({
        initialTab: 'update',
        activeOperation: {
          actionId: 'snapshot-restore',
          actionData: { file: 'snap-1.json' },
          done: false, ok: null, error: null,
          percent: 30, status: 'Loading snapshot…', cancellable: true, title: '',
        },
      })
      // Routed to the snapshots tab so its dedicated rail shows progress;
      // the generic overlay must stay hidden to avoid double progress UI.
      expect(w.find('[data-testid="snapshots-view-stub"]').exists()).toBe(true)
      expect(w.find('.op-overlay').exists()).toBe(false)
    })

    it('auto-switches to the Update tab when a non-snapshot op starts on the snapshots tab', async () => {
      const w = await mountContent({
        initialTab: 'snapshots',
        activeOperation: {
          actionId: 'copy', actionData: {},
          done: false, ok: null, error: null,
          percent: 30, status: '', cancellable: true, title: '',
        },
      })
      // The snapshots pane can't render a non-snapshot op's progress, so the
      // host moves to the Update tab where the overlay is shown.
      expect(w.find('[data-testid="snapshots-view-stub"]').exists()).toBe(false)
      expect(w.find('.op-overlay').exists()).toBe(true)
      expect(w.find('.op-title').text()).toBe('Copying…')
    })

    it('switches to the op home tab when selecting an already-operating install', async () => {
      // Viewing an idle install on the snapshots tab...
      const w = await mountContent({ initialTab: 'snapshots', activeOperation: null })
      expect(w.find('[data-testid="snapshots-view-stub"]').exists()).toBe(true)

      // ...then selecting a different install that already has an in-flight op
      // (e.g. one updating from another window's shelf) routes to its progress.
      await w.setProps({
        installation: { ...SAMPLE_INSTALL, id: 'inst-2' },
        activeOperation: {
          actionId: 'release-update', actionData: {},
          done: false, ok: null, error: null,
          percent: 30, status: '', cancellable: true, title: '',
        },
      })
      await flushPromises()
      expect(w.find('[data-testid="snapshots-view-stub"]').exists()).toBe(false)
      expect(w.find('.op-overlay').exists()).toBe(true)
      expect(w.find('.op-title').text()).toBe('Updating…')
    })

    it('renders the overlay on the Update tab when a copy op is in flight', async () => {
      const w = await mountContent({
        initialTab: 'update',
        activeOperation: {
          actionId: 'copy', actionData: {},
          done: false, ok: null, error: null,
          percent: 30, status: '', cancellable: true, title: '',
        },
      })
      expect(w.find('.op-overlay').exists()).toBe(true)
      expect(w.find('.op-title').text()).toBe('Copying…')
    })
  })

  describe('overlay title — per-action labels', () => {
    it.each([
      ['copy',                  { actionData: {} }, 'Copying…',           'Copy complete'],
      ['copy-update',           { actionData: {} }, 'Copying & updating…', 'Copy complete'],
      ['delete',                { actionData: {} }, 'Deleting…',          'Deleted'],
      ['release-update',        { actionData: {} }, 'Updating…',          'Update complete'],
      // snapshot-restore is intentionally absent: it renders in the snapshots
      // tab's dedicated rail, not the generic overlay (see "overlay routing").
      ['migrate-to-standalone', { actionData: {} }, 'Migrating…',         'Migration complete'],
    ])('actionId=%s → in-flight %s / success %s', async (actionId, extras, inflight, success) => {
      const wIn = await mountContent({
        activeOperation: {
          actionId, ...extras,
          done: false, ok: null, error: null,
          percent: 30, status: '', cancellable: false, title: '',
        },
      })
      expect(wIn.find('.op-title').text()).toBe(inflight)

      const wDone = await mountContent({
        activeOperation: {
          actionId, ...extras,
          done: true, ok: true, error: null,
          percent: 100, status: 'Complete', cancellable: false, title: '',
        },
      })
      expect(wDone.find('.op-title').text()).toBe(success)
    })
  })

  describe('More button', () => {
    it('is enabled when no op is in flight', async () => {
      const w = await mountContent()
      const moreBtn = w.find('.settings-v2-more')
      expect(moreBtn.exists()).toBe(true)
      expect(moreBtn.attributes('disabled')).toBeUndefined()
    })

    it('disables when an op is in flight', async () => {
      const w = await mountContent({
        activeOperation: {
          actionId: 'update-comfyui', actionData: {},
          done: false, ok: null, error: null,
          percent: 30, status: '', cancellable: false, title: '',
        },
      })
      const moreBtn = w.find('.settings-v2-more')
      expect(moreBtn.attributes('disabled')).toBeDefined()
    })

    it('auto-closes an open menu when an op begins mid-interaction', async () => {
      const w = await mountContent()
      // Open the menu first (idle state).
      await w.find('.settings-v2-more').trigger('click')
      await nextTick()
      expect(w.find('[data-testid="more-menu"]').exists()).toBe(true)

      // Now an op begins — the watcher should close the menu.
      await w.setProps({
        activeOperation: {
          actionId: 'update-comfyui', actionData: {},
          done: false, ok: null, error: null,
          percent: 0, status: '', cancellable: false, title: '',
        },
      })
      await flushPromises()
      expect(w.find('[data-testid="more-menu"]').exists()).toBe(false)
    })
  })

  describe('tab tooltips (#702 concept tooltips + #713 — no redundant label echo)', () => {
    type ResizeCb = (entries: ResizeObserverEntry[], obs: ResizeObserver) => void
    interface RoHandle {
      el: Element
      fire(width: number): void
    }
    let roHandles: RoHandle[]
    let originalRo: typeof globalThis.ResizeObserver | undefined

    beforeEach(() => {
      roHandles = []
      class StubRo {
        cb: ResizeCb
        constructor(cb: ResizeCb) {
          this.cb = cb
        }
        observe(el: Element): void {
          roHandles.push({
            el,
            fire: (width: number) => {
              this.cb(
                [{ contentRect: { width, height: 44 } as DOMRectReadOnly } as ResizeObserverEntry],
                this as unknown as ResizeObserver,
              )
            },
          })
        }
        disconnect(): void {}
        unobserve(): void {}
      }
      originalRo = (globalThis as { ResizeObserver?: typeof globalThis.ResizeObserver })
        .ResizeObserver
      ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
        StubRo as unknown as typeof globalThis.ResizeObserver
    })
    afterEach(() => {
      if (originalRo) {
        ;(globalThis as { ResizeObserver?: typeof globalThis.ResizeObserver }).ResizeObserver =
          originalRo
      } else {
        delete (globalThis as { ResizeObserver?: typeof globalThis.ResizeObserver }).ResizeObserver
      }
    })

    const SNAPSHOTS_TOOLTIP =
      'A saved point-in-time state of an installation (versions + custom nodes) you can restore later.'
    const CONSOLE_TOOLTIP =
      "An interactive shell running in this installation's folder. Works whether ComfyUI is running or stopped."

    /** Static text labels carried by tabs that have no concept tooltip wired.
     *  Every current tab carries a concept tooltip, so finding a Tooltip whose
     *  text is one of these would mean the tab fell back to the label-echo
     *  path — what these tests are guarding against. */
    const TAB_LABELS = new Set(['Update', 'Startup Args', 'Snapshots', 'Storage', 'Console', 'About'])

    function tabTooltips(w: VueWrapper) {
      return w
        .findAllComponents({ name: 'Tooltip' })
        .filter((tt) => !TAB_LABELS.has(tt.props('text') as string))
    }

    it('wires a concept tooltip on every install-settings tab (no label-echo fallback in use)', async () => {
      const w = await mountContent()
      roHandles.forEach((h) => h.fire(900))
      await nextTick()
      const allTabTooltips = w.findAllComponents({ name: 'Tooltip' })
      const concept = tabTooltips(w)
      // No tab fell back to label-echo. Reflects the new "every tab has its
      // own one-line description" wiring — the previous shape kept Update /
      // Startup Args / Storage / About on the label-echo path so they had
      // no hover description at full width.
      expect(concept.length).toBe(allTabTooltips.length)
      expect(concept.length).toBeGreaterThan(0)
      const texts = concept.map((tt) => tt.props('text') as string)
      // The two canonical entries still carry their original copy; guards
      // against an accidental rewire that would change visible UX text.
      expect(texts).toContain(SNAPSHOTS_TOOLTIP)
      expect(texts).toContain(CONSOLE_TOOLTIP)
      // Every concept tooltip is live at full width — the collapse-only
      // fallback has nothing to disable.
      expect(concept.every((tt) => tt.props('disabled') === false)).toBe(true)
    })

    it('always shows the Snapshots concept tooltip regardless of strip width', async () => {
      const w = await mountContent({ initialTab: 'snapshots' })
      const snapshotTip = () =>
        w
          .findAllComponents({ name: 'Tooltip' })
          .find((tt) => tt.props('text') === SNAPSHOTS_TOOLTIP)
      // Full width: the concept tooltip stays live (adds info beyond the label).
      roHandles.forEach((h) => h.fire(900))
      await nextTick()
      expect(snapshotTip()?.props('disabled')).toBe(false)
      // Collapsed: still live.
      roHandles.forEach((h) => h.fire(300))
      await nextTick()
      expect(snapshotTip()?.props('disabled')).toBe(false)
    })

    it('keeps every tab tooltip live when the strip collapses to icon-only', async () => {
      const w = await mountContent({ initialTab: 'update' })
      roHandles.forEach((h) => h.fire(300))
      await nextTick()
      // Concept tooltips ignore the collapse breakpoint — width changes
      // should not flip any of them off.
      const tips = tabTooltips(w)
      expect(tips.length).toBeGreaterThan(0)
      expect(tips.every((tt) => tt.props('disabled') === false)).toBe(true)
    })
  })

  // The footer CTA distinguishes running in THIS window (Restart) from a
  // DIFFERENT window (Switch → focus it) from not running (Start).
  describe('footer primary action — running scope (issue #749)', () => {
    function markRunning(installId: string): void {
      const store = useSessionStore()
      store.runningInstances.set(installId, {
        installationId: installId,
        installationName: 'X',
        mode: '',
      })
    }

    it('labels "Start" and emits restartInPlace=false when not running', async () => {
      const w = await mountContent({ activeInstallationId: 'inst-1' })
      expect(w.find('.settings-v2-relaunch').text()).toBe('Start')
      await w.find('.settings-v2-relaunch').trigger('click')
      expect(w.emitted('primary-action')).toEqual([[false]])
    })

    it('labels "Restart" and emits restartInPlace=true when running in THIS window', async () => {
      markRunning('inst-1')
      const w = await mountContent({ activeInstallationId: 'inst-1' })
      expect(w.find('.settings-v2-relaunch').text()).toBe('Restart')
      await w.find('.settings-v2-relaunch').trigger('click')
      expect(w.emitted('primary-action')).toEqual([[true]])
    })

    it('labels "Switch" and emits restartInPlace=false when running in ANOTHER window', async () => {
      // Host attached to 'other'; selected 'inst-1' runs elsewhere.
      markRunning('inst-1')
      const w = await mountContent({ activeInstallationId: 'other' })
      expect(w.find('.settings-v2-relaunch').text()).toBe('Switch')
      await w.find('.settings-v2-relaunch').trigger('click')
      expect(w.emitted('primary-action')).toEqual([[false]])
    })

    it('treats a running install as "Switch" on an install-less (dashboard) host', async () => {
      // No activeInstallationId → no in-place session to restart, so always Switch.
      markRunning('inst-1')
      const w = await mountContent({ activeInstallationId: null })
      expect(w.find('.settings-v2-relaunch').text()).toBe('Switch')
      await w.find('.settings-v2-relaunch').trigger('click')
      expect(w.emitted('primary-action')).toEqual([[false]])
    })
  })

  // On an install switch the body must (a) stay painted, (b) mark `.is-stale` so
  // a click doesn't run against the previous payload, and (c) disable the More
  // menu until the new payload lands.
  describe('switch staleness (#782)', () => {
    function setStale(value: boolean): void {
      useComfyUISettingsState.sectionsFresh.value = !value
    }

    it('does NOT show the "Loading…" placeholder when sections are still painted (fresh OR stale)', async () => {
      setStale(true)
      // No placeholder while the previous payload is still painted.
      useComfyUISettingsState.loading.value = true
      const w = await mountContent()
      expect(w.find('[data-testid="picker-settings-loading"]').exists()).toBe(false)
      expect(w.find('[data-testid="picker-settings-sections"]').exists()).toBe(true)
      useComfyUISettingsState.loading.value = false
    })

    it('still shows the "Loading…" placeholder on a true first load (no prior sections)', async () => {
      // First load with no prior payload is the only legitimate placeholder case.
      const priorSections = useComfyUISettingsState.sections.value
      useComfyUISettingsState.sections.value = []
      useComfyUISettingsState.loading.value = true
      const w = await mountContent()
      expect(w.find('[data-testid="picker-settings-loading"]').exists()).toBe(true)
      useComfyUISettingsState.sections.value = priorSections
      useComfyUISettingsState.loading.value = false
    })

    it('marks the body root .is-stale while the new install\'s sections are still in flight', async () => {
      setStale(true)
      const w = await mountContent()
      const root = w.find('[data-testid="picker-settings-sections"]')
      expect(root.classes()).toContain('is-stale')
      setStale(false)
      await nextTick()
      expect(root.classes()).not.toContain('is-stale')
    })

    it('disables the footer More menu while sections are stale, re-enables when fresh', async () => {
      setStale(true)
      const w = await mountContent()
      const more = w.find('.settings-v2-more')
      expect((more.element as HTMLButtonElement).disabled).toBe(true)
      setStale(false)
      await nextTick()
      expect((more.element as HTMLButtonElement).disabled).toBe(false)
    })

    it('does NOT auto-fire `check-update` against the new install while sections are still stale', async () => {
      // The channel-refresh watcher must not walk the prior install's stale
      // sections and fire `check-update` against Cloud (which has no handler).
      const priorSections = useComfyUISettingsState.sections.value
      // Stale sections from a prior local install, still painted after clicking Cloud.
      useComfyUISettingsState.sections.value = [
        {
          tab: 'update',
          fields: [{ id: 'channel', editType: 'channel-cards', value: 'stable' }],
          actions: [{ id: 'check-update', label: 'Check for update', data: {} }],
        },
      ]
      setStale(true)
      useComfyUISettingsState.runActionStub.mockClear()

      await mountContent({ initialTab: 'update' })

      expect(useComfyUISettingsState.runActionStub).not.toHaveBeenCalled()

      useComfyUISettingsState.sections.value = priorSections
    })
  })

  // Each pane is keyed by install id so `<Transition>` fires on install switch
  // even when the same tab persists; pinned by asserting the pane element is
  // replaced.
  describe('install-switch transition cue', () => {
    it('remounts the inner tab pane when the installation changes (same tab)', async () => {
      const w = await mountContent({ initialTab: 'status' })
      const paneBefore = w.find('.settings-v2-tab-pane').element
      expect(paneBefore).toBeTruthy()

      const other = {
        ...SAMPLE_INSTALL,
        id: 'inst-2',
        name: 'Other Install',
      } as unknown as Installation
      await w.setProps({ installation: other })
      await flushPromises()

      const paneAfter = w.find('.settings-v2-tab-pane').element
      expect(paneAfter).toBeTruthy()
      expect(paneAfter).not.toBe(paneBefore)
    })
  })

  describe('op-event relay from SnapshotsView', () => {
    it('forwards op-cancel / op-retry / op-dismiss up to the host', async () => {
      const w = await mountContent({ initialTab: 'snapshots' })
      const snapshotsStub = w.findComponent({ name: 'SnapshotsView' })
      expect(snapshotsStub.exists()).toBe(true)

      snapshotsStub.vm.$emit('op-cancel')
      snapshotsStub.vm.$emit('op-retry')
      snapshotsStub.vm.$emit('op-dismiss')
      await flushPromises()

      expect(w.emitted('op-cancel')).toHaveLength(1)
      expect(w.emitted('op-retry')).toHaveLength(1)
      expect(w.emitted('op-dismiss')).toHaveLength(1)
    })
  })
})
