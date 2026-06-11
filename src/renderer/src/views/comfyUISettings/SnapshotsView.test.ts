import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

import { TID } from '../../../../shared/testIds'
import SnapshotsView from './SnapshotsView.vue'
import type { SnapshotSummary, SnapshotListData, CopyEvent } from '../../types/ipc'

// Tests the snapshots tab + inline restore op-card state machine: in-flight, success (auto-dismiss 1.8s), error (Retry/Dismiss), cancelled.

const messages = {
  en: {
    common: {
      cancel: 'Cancel',
      dismiss: 'Dismiss',
      loading: 'Loading…',
    },
    snapshots: {
      createLabel: 'Create Snapshot',
      createNew: 'Create Snapshot',
      createSnapshot: 'Create Snapshot',
      restoringStatus: 'Restoring snapshot',
      restoringFrom: 'from {label}',
      restored: 'Snapshot restored',
      restoredFrom: 'Rolled back to {label}',
      restoreFailed: 'Restore failed',
      tryAgain: 'Try again',
      restore: 'Restore',
      delete: 'Delete',
      exportSnapshot: 'Export',
      diffPrevious: 'Changes from previous',
      noChangesSinceLast: 'No changes since the previous snapshot.',
      noPrevious: 'First snapshot — no previous to compare',
      diffNoChanges: 'No changes',
      empty: 'No snapshots yet.',
      // Trigger labels for `triggerLabel`:
      triggerBoot: 'Boot',
      triggerRestart: 'Manager',
      triggerManual: 'Manual',
      triggerPreUpdate: 'Update',
      triggerPostUpdate: 'Updated',
      triggerPostRestore: 'Restored',
      timeJustNow: 'Just now',
      timeMinutesAgo: '{count}m ago',
      timeHoursAgo: '{count}h ago',
      timeDaysAgo: '{count}d ago',
      noneYet: 'No snapshots yet.',
      importSnapshots: 'Import',
      exportAll: 'Export All',
      latestLabel: 'Latest:',
      latestBadge: 'Latest',
      copyEventLabel: 'Copied as {destination}',
      copyEventLabelIncoming: 'Copied from {source}',
      nodesCount: '{count} nodes',
      packagesCount: '{count} pkgs',
    },
    standalone: {
      snapshotRestore: 'Restore',
      snapshotCreateTitle: 'Create Snapshot',
      snapshotCreateMessage: '',
      snapshotLabelPlaceholder: '',
    },
  },
} as const

function createTestI18n() {
  return createI18n({ legacy: false, locale: 'en', messages })
}

function makeSnapshot(overrides: Partial<SnapshotSummary> = {}): SnapshotSummary {
  return {
    filename: 'snap-2026-04-01.json',
    createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),  // ~1h ago
    trigger: 'boot',
    label: null,
    comfyuiVersion: 'v0.3.20',
    nodeCount: 10,
    pipPackageCount: 20,
    ...overrides,
  }
}

const FIXTURE_SNAPSHOTS: SnapshotSummary[] = [
  makeSnapshot({ filename: 'snap-newest.json', trigger: 'post-update' }),
  makeSnapshot({ filename: 'snap-middle.json', trigger: 'boot' }),
  makeSnapshot({ filename: 'snap-oldest.json', trigger: 'manual', label: 'My save point' }),
]

function makeListData(snapshots: SnapshotSummary[] = FIXTURE_SNAPSHOTS): SnapshotListData {
  return {
    snapshots,
    copyEvents: [],
    totalCount: snapshots.length,
    context: { updateChannel: 'stable', pythonVersion: '3.12', variant: 'cpu', variantLabel: 'CPU' },
  }
}

interface ActiveOperation {
  percent: number
  status: string
  done: boolean
  ok: boolean | null
  error: string | null
  actionId: string
  actionData?: Record<string, unknown>
  cancellable?: boolean
}

async function mountView(opts: {
  activeOperation?: ActiveOperation | null
  snapshots?: SnapshotSummary[]
} = {}): Promise<VueWrapper> {
  const wrapper = mount(SnapshotsView, {
    props: {
      installationId: 'install-A',
      activeOperation: opts.activeOperation ?? null,
    },
    global: { plugins: [createTestI18n(), createPinia()] },
  })
  await flushPromises()
  return wrapper as VueWrapper
}

describe('comfyUISettings/SnapshotsView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      getSnapshots: vi.fn().mockResolvedValue(makeListData()),
      getSnapshotDiff: vi.fn().mockResolvedValue(null),
      runAction: vi.fn(),
      exportSnapshot: vi.fn(),
      exportAllSnapshots: vi.fn(),
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('idle: renders the Save New Snapshot CTA and no op-card', async () => {
    const w = await mountView()
    expect(w.find(`[data-testid="${TID.snapshotsOpCard}"]`).exists()).toBe(false)
    expect(w.find('.snapshots-rail-cta').exists()).toBe(true)
    expect(w.find('.snapshots-rail-cta').text()).toContain('Create Snapshot')
  })

  it('in-flight: morphs the slot into the op-card with target label + percent + spinner dot', async () => {
    const w = await mountView({
      activeOperation: {
        actionId: 'snapshot-restore',
        done: false,
        ok: null,
        error: null,
        percent: 42,
        status: 'Loading snapshot…',
        actionData: { file: 'snap-middle.json' },
        cancellable: true,
      },
    })

    // Save CTA gone, op-card present.
    expect(w.find('.snapshots-rail-cta').exists()).toBe(false)
    const card = w.find(`[data-testid="${TID.snapshotsOpCard}"]`)
    expect(card.exists()).toBe(true)

    // Header label.
    expect(w.find('.snapshots-rail-label').text()).toContain('Restoring snapshot')

    // Target label resolves "from {trigger · relative-time}".
    expect(card.find('.snapshots-op-card-target').text()).toMatch(/from\s+Boot/)

    // Percent text.
    expect(card.find('.snapshots-op-bar-pct').text()).toContain('42%')

    // Phase status.
    expect(card.find('.snapshots-op-bar-status').text()).toContain('Loading snapshot')

    // Spinner dot on the top card (not the historical rows).
    const topNode = w.findAll('.snapshots-rail-node.is-save')[0]
    expect(topNode!.find('.snapshots-rail-dot.is-spinning').exists()).toBe(true)

    // Cancel button visible (cancellable=true) + carries the dedicated TID.
    expect(w.find(`[data-testid="${TID.snapshotsOpCardCancel}"]`).exists()).toBe(true)
  })

  it('in-flight indeterminate: no percent text, fill is .is-indeterminate', async () => {
    const w = await mountView({
      activeOperation: {
        actionId: 'snapshot-restore',
        done: false, ok: null, error: null,
        percent: -1,
        status: 'Stopping…',
        actionData: { file: 'snap-middle.json' },
      },
    })
    expect(w.find('.snapshots-op-bar-pct').exists()).toBe(false)
    expect(w.find('.snapshots-op-bar-fill.is-indeterminate').exists()).toBe(true)
  })

  it('success transition: shows the green card, then auto-dismisses after 1.8s and emits op-dismiss + reload', async () => {
    vi.useFakeTimers()

    const w = await mountView({
      activeOperation: {
        actionId: 'snapshot-restore',
        done: false, ok: null, error: null,
        percent: 90, status: 'Complete',
        actionData: { file: 'snap-middle.json' },
      },
    })

    // Reset call count from initial load() so the post-success reload is the new call.
    const apiGetSnapshots = vi.mocked(
      (window as unknown as { api: { getSnapshots: ReturnType<typeof vi.fn> } }).api.getSnapshots
    )
    apiGetSnapshots.mockClear()

    // Transition op to done+ok.
    await w.setProps({
      activeOperation: {
        actionId: 'snapshot-restore',
        done: true, ok: true, error: null,
        percent: 100, status: 'Complete',
        actionData: { file: 'snap-middle.json' },
      },
    })
    await flushPromises()

    // Green success card present.
    expect(w.find('.snapshots-rail-save-box.is-op-success').exists()).toBe(true)
    expect(w.find('.snapshots-rail-label').text()).toContain('Snapshot restored')
    expect(w.find('.snapshots-op-card.is-success .snapshots-op-card-target').text())
      .toMatch(/Rolled back to/)

    // Before timer fires: no op-dismiss yet.
    expect(w.emitted('op-dismiss')).toBeUndefined()

    // Advance through the 1.8s auto-dismiss timer.
    await vi.advanceTimersByTimeAsync(1800)
    await flushPromises()

    // op-dismiss + refresh-all emitted, list reloaded.
    expect(w.emitted('op-dismiss')).toHaveLength(1)
    expect(w.emitted('refresh-all')).toHaveLength(1)
    expect(apiGetSnapshots).toHaveBeenCalledWith('install-A')
  })

  it('error: shows red card with message + Retry / Dismiss; clicks emit op-retry / op-dismiss', async () => {
    const w = await mountView({
      activeOperation: {
        actionId: 'snapshot-restore',
        done: false, ok: null, error: null,
        percent: 30, status: 'Loading snapshot…',
        actionData: { file: 'snap-middle.json' },
      },
    })
    await w.setProps({
      activeOperation: {
        actionId: 'snapshot-restore',
        done: true, ok: false, error: 'Permission denied',
        percent: 30, status: '',
        actionData: { file: 'snap-middle.json' },
      },
    })
    await flushPromises()

    // Red card present, error message visible.
    expect(w.find('.snapshots-rail-save-box.is-op-error').exists()).toBe(true)
    expect(w.find(`[data-testid="${TID.pickerOpErrorMessage}"]`).text()).toBe('Permission denied')

    // Retry button.
    await w.find(`[data-testid="${TID.snapshotsOpCardRetry}"]`).trigger('click')
    expect(w.emitted('op-retry')).toHaveLength(1)
    // The error card is cleared optimistically on retry — Save CTA back.
    await nextTick()
    expect(w.find('.snapshots-rail-cta').exists()).toBe(true)
  })

  it('error: Dismiss button emits op-dismiss and clears the card', async () => {
    const w = await mountView({
      activeOperation: {
        actionId: 'snapshot-restore',
        done: false, ok: null, error: null,
        percent: 30, status: 'Loading snapshot…',
        actionData: { file: 'snap-middle.json' },
      },
    })
    await w.setProps({
      activeOperation: {
        actionId: 'snapshot-restore',
        done: true, ok: false, error: 'Disk full',
        percent: 30, status: '',
        actionData: { file: 'snap-middle.json' },
      },
    })
    await flushPromises()

    await w.find(`[data-testid="${TID.snapshotsOpCardDismiss}"]`).trigger('click')
    expect(w.emitted('op-dismiss')).toHaveLength(1)
  })

  it('cancelled: silently clears — no terminal card, Save CTA restored, no events emitted', async () => {
    const w = await mountView({
      activeOperation: {
        actionId: 'snapshot-restore',
        done: false, ok: null, error: null,
        percent: 30, status: 'Loading snapshot…',
        actionData: { file: 'snap-middle.json' },
      },
    })
    await w.setProps({
      activeOperation: {
        actionId: 'snapshot-restore',
        done: true, ok: false, error: 'Cancelled.',
        percent: 30, status: '',
        actionData: { file: 'snap-middle.json' },
      },
    })
    await flushPromises()

    expect(w.find(`[data-testid="${TID.snapshotsOpCard}"]`).exists()).toBe(false)
    expect(w.find('.snapshots-rail-cta').exists()).toBe(true)
    expect(w.emitted('op-dismiss')).toBeUndefined()
    expect(w.emitted('op-retry')).toBeUndefined()
  })

  it('non-restore op is ignored — update-comfyui does not hijack the snapshots tab', async () => {
    const w = await mountView({
      activeOperation: {
        actionId: 'update-comfyui',
        done: false, ok: null, error: null,
        percent: 50, status: 'Updating…',
        actionData: { isDowngrade: false },
      },
    })
    expect(w.find(`[data-testid="${TID.snapshotsOpCard}"]`).exists()).toBe(false)
    expect(w.find('.snapshots-rail-cta').exists()).toBe(true)
  })

  it('scrolls the top card into view when restore starts', async () => {
    const scrollSpy = vi.spyOn(HTMLElement.prototype, 'scrollIntoView')
      .mockImplementation(() => {})

    const w = await mountView()
    await w.setProps({
      activeOperation: {
        actionId: 'snapshot-restore',
        done: false, ok: null, error: null,
        percent: 0, status: 'Loading snapshot…',
        actionData: { file: 'snap-middle.json' },
      },
    })
    await flushPromises()
    await nextTick()

    expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
  })

  // Regression for #1007: a "Copied from/as X" event that sorts above the
  // newest snapshot must not steal the "Latest" designation. Latest tracks the
  // newest *snapshot* (snapshotIndex === 0), not the merged timeline index.
  describe('latest detection with copy events (#1007)', () => {
    function makeCopyEvent(overrides: Partial<CopyEvent> = {}): CopyEvent {
      return {
        installationId: 'install-B',
        installationName: 'Copy of A',
        copiedAt: new Date().toISOString(), // now — newer than the ~1h-old snapshots
        copyReason: 'copy',
        exists: true,
        direction: 'in',
        ...overrides,
      }
    }

    async function mountWithCopyEvent(event: CopyEvent): Promise<VueWrapper> {
      ;(window as unknown as { api: Record<string, unknown> }).api = {
        getSnapshots: vi.fn().mockResolvedValue({ ...makeListData(), copyEvents: [event] }),
        getSnapshotDiff: vi.fn().mockResolvedValue(null),
        runAction: vi.fn(),
        exportSnapshot: vi.fn(),
        exportAllSnapshots: vi.fn(),
      }
      return mountView()
    }

    it('keeps the Latest badge on the newest snapshot when an incoming copy event sorts first', async () => {
      const w = await mountWithCopyEvent(makeCopyEvent({ direction: 'in' }))

      // The copy event is rendered (and sorts to the top of the rail)…
      expect(w.text()).toContain('Copied from Copy of A')

      // …but the "Latest" badge appears exactly once, on the newest snapshot.
      const badges = w.findAll('.snapshot-row-latest')
      expect(badges).toHaveLength(1)
      const newestRow = w.find(`[data-testid="${TID.snapshotRow('snap-newest.json')}"]`)
      expect(newestRow.find('.snapshot-row-latest').exists()).toBe(true)

      // The newest snapshot is auto-expanded; restoring it is a no-op, so it
      // must not offer a Restore action even though a copy event sorts above it.
      expect(w.find(`[data-testid="${TID.snapshotRowRestore('snap-newest.json')}"]`).exists())
        .toBe(false)
    })

    it('keeps the Latest badge on the newest snapshot for an outgoing copy event', async () => {
      const w = await mountWithCopyEvent(makeCopyEvent({ direction: 'out' }))

      expect(w.text()).toContain('Copied as Copy of A')
      expect(w.findAll('.snapshot-row-latest')).toHaveLength(1)
      expect(w.find(`[data-testid="${TID.snapshotRowRestore('snap-newest.json')}"]`).exists())
        .toBe(false)
    })

    it('header "Latest:" stat reflects the newest snapshot, not the copy event time', async () => {
      const w = await mountWithCopyEvent(makeCopyEvent({ direction: 'in' }))

      // Snapshots are ~1h old; the copy event is "now". The stat must show the
      // snapshot's age (1h ago), proving the copy event didn't hijack it.
      const latest = w.find('.snapshots-view-latest')
      expect(latest.text()).toContain('Latest:')
      expect(latest.text()).toContain('1h ago')
    })
  })
})
