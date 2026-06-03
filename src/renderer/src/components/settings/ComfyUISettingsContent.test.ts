import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia, getActivePinia, setActivePinia } from 'pinia'
import { computed, ref, nextTick } from 'vue'

import type { Installation } from '../../types/ipc'
import { useSessionStore } from '../../stores/sessionStore'

/**
 * Component tests for the picker / drawer's per-install settings body.
 *
 * Locks three pieces of behaviour:
 *   1. Overlay title branches on `actionData.isDowngrade` for `update-comfyui`
 *      — "Downgrading…" vs "Updating…", with matching success copy.
 *   2. The overlay is NOT shown for `snapshot-restore` (gated to the
 *      update tab) — snapshot ops route to the SnapshotsView card instead.
 *   3. Footer "More" button disables on opInflight and the open menu
 *      auto-closes when an op begins.
 *
 * Heavy children + the IPC-tied `useComfyUISettings` composable are
 * stubbed so the test focuses on the bits this component owns.
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
      relaunch: 'Relaunch',
      more: 'More',
    },
    tooltips: {
      snapshots:
        'A saved point-in-time state of an installation (versions + custom nodes) you can restore later.',
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

// --- Mocks ------------------------------------------------------------

const useComfyUISettingsState = {
  pinBottomActions: ref<{ id: string; label: string }[]>([{ id: 'untrack', label: 'Forget' }]),
  sections: ref<unknown[]>([{ tab: 'update', fields: [] }, { tab: 'status', fields: [] }, { tab: 'snapshots' }]),
  loading: ref(false),
  error: ref<null>(null),
  // Default to fresh — most tests don't care about freshness gating
  // and want the host to render in its normal state. The "switch
  // staleness" tests override this with `false` to exercise the
  // `.is-stale` / More-menu gates.
  sectionsFresh: ref<boolean>(true),
  runningActionIds: ref<Set<string>>(new Set()),
  pendingRestartFieldIds: ref<Set<string>>(new Set()),
  fieldErrorMessages: ref<Record<string, string>>({}),
  diskUsageItem: ref(null),
  // Stable spies so the stale-watcher tests can assert that the
  // channel-refresh watcher (#782) doesn't auto-fire actions
  // against the wrong install's payload.
  runActionStub: vi.fn(),
}
vi.mock('../../composables/useComfyUISettings', () => ({
  useComfyUISettings: () => ({
    ...useComfyUISettingsState,
    updateField: vi.fn(),
    runAction: useComfyUISettingsState.runActionStub,
    // Real composable returns ComputedRef<DetailSection[]>; mirror that
    // so the host's `.value.length` reads work without surfacing the
    // composable's tab-filtering implementation here.
    sectionsForTab: (tab: string) => computed(() => {
      const hasTab = useComfyUISettingsState.sections.value.some(
        (s) => (s as { tab?: string }).tab === tab
      )
      return hasTab ? [{ tab, fields: [] }] : []
    }),
    reload: vi.fn(),
  }),
}))

// Stub heavy children — we only care about their host wiring.
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
vi.mock('../../views/comfyUISettings/ArgsBuilderPage.vue', () => ({
  default: { template: '<div />' },
}))
vi.mock('../../views/comfyUISettings/MoreMenu.vue', () => ({
  default: {
    props: ['open'],
    template: '<div v-if="open" data-testid="more-menu">menu</div>',
  },
}))

// --- Mount helper -----------------------------------------------------

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
  // Reuse the active pinia (set in beforeEach) so tests that seed the
  // session store via `useSessionStore()` share the same instance the
  // mounted component reads.
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

// --- Tests ------------------------------------------------------------

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
      // The op-overlay's success branch picks `opSuccessLabel`.
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
      // Snapshot-restore on the snapshots tab is rendered by
      // SnapshotsView's own timeline rail — the generic overlay must
      // stay hidden to avoid double-rendering progress UI.
      expect(w.find('.op-overlay').exists()).toBe(false)
    })

    it('renders the overlay for snapshot-restore on a NON-snapshots tab', async () => {
      const w = await mountContent({
        initialTab: 'update',
        activeOperation: {
          actionId: 'snapshot-restore',
          actionData: { file: 'snap-1.json' },
          done: false, ok: null, error: null,
          percent: 30, status: 'Loading snapshot…', cancellable: true, title: '',
        },
      })
      expect(w.find('.op-overlay').exists()).toBe(true)
      expect(w.find('.op-title').text()).toBe('Restoring snapshot…')
    })

    it('renders the overlay on the Update tab when a copy op is in flight', async () => {
      // Copy is initiated from the picker's Update tab, so this is the
      // common case. Pre-fix, only `update-comfyui` would have rendered
      // a meaningful label here; we now show "Copying…".
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
      ['snapshot-restore',      { actionData: {} }, 'Restoring snapshot…', 'Snapshot restored'],
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

    /** Tooltips for tabs that only echo their label (no explicit concept
     *  copy). The Snapshots tab carries a real concept tooltip and is
     *  exempt from the "disabled at full width" rule. */
    function labelEchoDisabledFlags(w: VueWrapper): boolean[] {
      return w
        .findAllComponents({ name: 'Tooltip' })
        .filter((tt) => tt.props('text') !== SNAPSHOTS_TOOLTIP)
        .map((tt) => tt.props('disabled') as boolean)
    }

    it('disables label-echo tab tooltips at full width (label is visible → pure echo)', async () => {
      const w = await mountContent()
      roHandles.forEach((h) => h.fire(900))
      await nextTick()
      const flags = labelEchoDisabledFlags(w)
      expect(flags.length).toBeGreaterThan(0)
      expect(flags.every((d) => d === true)).toBe(true)
    })

    it('always shows the Snapshots concept tooltip regardless of strip width', async () => {
      const w = await mountContent({ initialTab: 'snapshots' })
      const snapshotTip = () =>
        w
          .findAllComponents({ name: 'Tooltip' })
          .find((tt) => tt.props('text') === SNAPSHOTS_TOOLTIP)
      // Full width — an echo tab would be suppressed here, but the concept
      // tooltip stays live because it adds info beyond the label.
      roHandles.forEach((h) => h.fire(900))
      await nextTick()
      expect(snapshotTip()?.props('disabled')).toBe(false)
      // Collapsed — still live (and it's the active tab, which would also
      // suppress a pure echo).
      roHandles.forEach((h) => h.fire(300))
      await nextTick()
      expect(snapshotTip()?.props('disabled')).toBe(false)
    })

    it('keeps the tooltip on collapsed icon-only tabs but not the active one', async () => {
      const w = await mountContent({ initialTab: 'update' })
      roHandles.forEach((h) => h.fire(300))
      await nextTick()
      const tooltips = w.findAllComponents({ name: 'Tooltip' })
      // Active tab (Update) keeps its label → tooltip stays disabled.
      const updateTip = tooltips.find((tt) => tt.props('text') === 'Update')
      expect(updateTip?.props('disabled')).toBe(true)
      // A collapsed, inactive tab hides its label → tooltip is live.
      const statusTip = tooltips.find((tt) => tt.props('text') === 'About')
      expect(statusTip?.props('disabled')).toBe(false)
    })
  })

  // Issue #749 — the footer primary CTA must distinguish an install
  // running in THIS window (Restart, in place) from one running in a
  // DIFFERENT window (Switch → focus that window) from one not running
  // (Open → launch). Pre-fix the label was "Restart" whenever a session
  // existed anywhere, so switching between an already-open Cloud and
  // local window was mislabeled and broke (it restarted instead of
  // focusing the other window).
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
      // The host window is attached to a different install ('other'),
      // while the selected install ('inst-1') is running elsewhere.
      markRunning('inst-1')
      const w = await mountContent({ activeInstallationId: 'other' })
      expect(w.find('.settings-v2-relaunch').text()).toBe('Switch')
      await w.find('.settings-v2-relaunch').trigger('click')
      // restartInPlace=false → host routes to pickInstall (focus existing).
      expect(w.emitted('primary-action')).toEqual([[false]])
    })

    it('treats a running install as "Switch" on an install-less (dashboard) host', async () => {
      // No activeInstallationId → there is no in-place session to restart,
      // so a running install always reads as "switch to its window".
      markRunning('inst-1')
      const w = await mountContent({ activeInstallationId: null })
      expect(w.find('.settings-v2-relaunch').text()).toBe('Switch')
      await w.find('.settings-v2-relaunch').trigger('click')
      expect(w.emitted('primary-action')).toEqual([[false]])
    })
  })

  // Issue #782 — clicking a row in the central pill drawer used to
  // flash "Loading…" while the new install's `get-detail-sections`
  // IPC was in flight. The composable no longer blanks `sections` on
  // switch; this component must (a) keep the body painted, (b) mark
  // the body root `.is-stale` so a click in the brief window doesn't
  // run against the previous install's payload, and (c) disable the
  // footer More menu until the new payload lands.
  describe('switch staleness (#782)', () => {
    function setStale(value: boolean): void {
      // `sectionsFresh = false` mirrors the real composable's state
      // between an install switch and the new IPC resolving.
      useComfyUISettingsState.sectionsFresh.value = !value
    }

    it('does NOT show the "Loading…" placeholder when sections are still painted (fresh OR stale)', async () => {
      setStale(true)
      // `loading: true` simulates the in-flight switch window. The
      // placeholder must NOT appear because the previous payload's
      // visibleSections.length > 0 — that is the whole point of the
      // #782 fix.
      useComfyUISettingsState.loading.value = true
      const w = await mountContent()
      expect(w.find('[data-testid="picker-settings-loading"]').exists()).toBe(false)
      // The settings body root is still rendered so the user keeps
      // seeing recognizable content during the IPC.
      expect(w.find('[data-testid="picker-settings-sections"]').exists()).toBe(true)
      useComfyUISettingsState.loading.value = false
    })

    it('still shows the "Loading…" placeholder on a true first load (no prior sections)', async () => {
      // First mount with no payload yet: blank sections + loading.
      // This is the only case where the placeholder is legitimate.
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
      // Regression for an "Action 'check-update' not yet implemented."
      // alert that appeared when switching from a local install to
      // Cloud. The channel-cards-refresh watcher used to walk
      // `sections.value` whenever `sectionsLen > 0`; with #782 keeping
      // the previous install's sections painted across switches, that
      // walked the wrong install's payload and fired the action
      // against Cloud, which has no `check-update` handler.
      const priorSections = useComfyUISettingsState.sections.value
      // Seed STALE sections that contain a channel-cards field AND a
      // `check-update` action — what would still be painted from a
      // prior local install when the user has just clicked Cloud.
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

  // Switching between installs in the central pill drawer should always
  // give the user a visible motion cue — even when the same tab exists
  // on both installs (e.g. Status → Status). The inner `<Transition>`
  // only fires when its child key changes, so we key each pane by the
  // install id; this test pins that contract by asserting the active
  // pane's DOM element is replaced on install switch (which is exactly
  // what makes the `tabTransition` animation fire).
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
