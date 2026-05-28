import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'
import { computed, ref, nextTick } from 'vue'

import type { Installation } from '../../types/ipc'

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
    instancePicker: {
      open: 'Open',
      restart: 'Restart',
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
  runningActionIds: ref<Set<string>>(new Set()),
  pendingRestartFieldIds: ref<Set<string>>(new Set()),
  fieldErrorMessages: ref<Record<string, string>>({}),
  diskUsageItem: ref(null),
}
vi.mock('../../composables/useComfyUISettings', () => ({
  useComfyUISettings: () => ({
    ...useComfyUISettingsState,
    updateField: vi.fn(),
    runAction: vi.fn(),
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
  const wrapper = mount(ComfyUISettingsContent, {
    props: {
      installation: SAMPLE_INSTALL,
      initialTab: 'update',
      activeOperation: null,
      ...props,
    },
    global: { plugins: [createTestI18n(), createPinia()] },
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
