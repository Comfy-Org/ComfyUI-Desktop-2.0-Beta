import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'

// `useModal` is a singleton with module-level state. The composable
// awaits `modal.confirm(...)` which never resolves on its own — mock
// the composable so tests can drive the confirm response synchronously.
const modalMock = {
  confirm: vi.fn(),
  alert: vi.fn(),
  prompt: vi.fn(),
  select: vi.fn(),
  confirmWithOptions: vi.fn(),
}
vi.mock('./useModal', () => ({
  useModal: () => modalMock,
}))

import { useInstallContextMenu } from './useInstallContextMenu'
import { useSessionStore } from '../stores/sessionStore'
import { useProgressStore } from '../stores/progressStore'
import type { Installation, ShowProgressOpts } from '../types/ipc'
import type { ContextMenuItem } from '../types/context-menu'

// Mock api on `window`. `getDetailSections` is spied so tests can
// assert it is NOT called by the delete fast path (regression for the
// ~2s confirm-modal latency on the dashboard kebab → Delete click).
const apiMock = {
  platform: 'darwin',
  runAction: vi.fn().mockResolvedValue({ ok: true }),
  getDetailSections: vi.fn().mockResolvedValue([]),
  onErrorDetail: vi.fn(() => () => {}),
  getSnapshots: vi.fn().mockResolvedValue({ snapshots: [] }),
  exportSnapshot: vi.fn().mockResolvedValue({ ok: true }),
}
vi.stubGlobal('window', {
  ...window,
  api: apiMock,
})

const messages = {
  en: {
    chooser: {
      manageInstall: 'Manage',
      menuUpdate: 'Update',
      menuMigrate: 'Migrate to Standalone',
      menuRestoreSnapshot: 'Restore Snapshot',
      menuRevealInFolder: 'Open Folder',
      menuDelete: 'Uninstall',
    },
    actions: {
      copyInstallation: 'Copy Install',
      untrack: 'Forget',
      untrackConfirmTitle: 'Forget Install',
      untrackConfirmMessage:
        'This will remove the install from the app. The files will not be deleted.',
      delete: 'Delete',
      deleteConfirmTitle: 'Delete Install',
      deleteConfirmMessage:
        'This will permanently delete the install and all its files. This cannot be undone.',
      share: 'Share',
    },
    snapshots: {
      noSnapshotsToShare: 'There are no snapshots to share yet.',
      shareFailed: 'Could not share the snapshot.',
    },
    progress: { working: 'Working…' },
    running: { dismiss: 'Dismiss' },
  },
}

function makeInstall(overrides: Partial<Installation> = {}): Installation {
  return {
    id: 'inst-1',
    name: 'Inst 1',
    sourceLabel: 'Standalone',
    sourceCategory: 'local',
    status: 'installed',
    installPath: '/tmp/inst-1',
    statusTag: { style: 'update', label: 'Update available' },
    ...overrides,
  } as unknown as Installation
}

interface HarnessHandles {
  menu: ReturnType<typeof useInstallContextMenu>
  session: ReturnType<typeof useSessionStore>
  progress: ReturnType<typeof useProgressStore>
}

/**
 * Common harness component used by every spec. `useInstallContextMenu`
 * calls Pinia stores + `useI18n()` so the composable can only run from
 * inside a real component setup scope; this single `defineComponent`
 * is reused across all `mountHarness*` factories so the file stays
 * compliant with `vue/one-component-per-file`.
 *
 * The factory hands `setup` a closure that runs once per mount and
 * captures handles back into the caller-supplied refs.
 */
let _harnessSetup: (() => void) | null = null
const HarnessComponent = defineComponent({
  setup() {
    _harnessSetup?.()
    return () => h('div')
  },
})

function mountHarness(inst: Installation, mutate?: (h: HarnessHandles) => void) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const i18n = createI18n({ legacy: false, locale: 'en', messages })
  let handles!: HarnessHandles
  _harnessSetup = () => {
    const menu = useInstallContextMenu({ onManage: () => {} })
    const session = useSessionStore()
    const progress = useProgressStore()
    handles = { menu, session, progress }
    mutate?.(handles)
    menu.openCardMenu(
      new MouseEvent('contextmenu', { clientX: 0, clientY: 0 }),
      inst,
    )
  }
  const wrapper = mount(HarnessComponent, { global: { plugins: [pinia, i18n] } })
  _harnessSetup = null
  return { wrapper, ...handles }
}

function findItem(items: ContextMenuItem[], id: string): ContextMenuItem | undefined {
  return items.find((i) => i.id === id)
}

let _activePinia: Pinia | undefined
beforeEach(() => {
  _activePinia = createPinia()
  setActivePinia(_activePinia)
  vi.clearAllMocks()
})

describe('useInstallContextMenu — gated REQUIRES_STOPPED items', () => {
  it('renders update / migrate / restore-snapshot / delete enabled when the install is idle', () => {
    const inst = makeInstall({ sourceCategory: 'desktop' })
    const { menu } = mountHarness(inst)
    const items = menu.ctxMenuItems.value

    expect(findItem(items, 'update')?.disabled).toBeFalsy()
    expect(findItem(items, 'migrate')?.disabled).toBeFalsy()
    expect(findItem(items, 'restore-snapshot')?.disabled).toBeFalsy()
    expect(findItem(items, 'delete')?.disabled).toBeFalsy()
    expect(menu.isStoppedActionGated(inst)).toBe(false)
  })

  it('disables REQUIRES_STOPPED items when the install is running', () => {
    const inst = makeInstall({ sourceCategory: 'desktop' })
    const { menu } = mountHarness(inst, ({ session }) => {
      session.runningInstances.set(inst.id, {
        installationId: inst.id,
        installationName: inst.name,
      } as never)
    })
    const items = menu.ctxMenuItems.value

    expect(findItem(items, 'update')?.disabled).toBe(true)
    expect(findItem(items, 'migrate')?.disabled).toBe(true)
    expect(findItem(items, 'restore-snapshot')?.disabled).toBe(true)
    expect(findItem(items, 'delete')?.disabled).toBe(true)
    expect(menu.isStoppedActionGated(inst)).toBe(true)

    // Always-safe items stay enabled.
    expect(findItem(items, 'manage')?.disabled).toBeFalsy()
    expect(findItem(items, 'reveal-in-folder')?.disabled).toBeFalsy()
  })

  it('disables REQUIRES_STOPPED items when the install is stopping', () => {
    const inst = makeInstall()
    const { menu } = mountHarness(inst, ({ session }) => {
      session.stoppingInstances.add(inst.id)
    })
    expect(menu.isStoppedActionGated(inst)).toBe(true)
    expect(findItem(menu.ctxMenuItems.value, 'delete')?.disabled).toBe(true)
  })

  it('disables REQUIRES_STOPPED items when a long-running operation is in flight', () => {
    const inst = makeInstall()
    const { menu } = mountHarness(inst, ({ progress }) => {
      progress.operations.set(inst.id, {
        title: 'Updating…',
        steps: null,
        activePhase: null,
        activePercent: 0,
        lastStatus: {},
        flatStatus: 'Working…',
        flatPercent: 0.5,
        terminalOutput: '',
        done: false,
        finished: false,
        error: null,
        cancelRequested: false,
        result: null,
        unsubProgress: null,
        unsubOutput: null,
        apiCall: null,
      } as never)
    })
    expect(menu.isStoppedActionGated(inst)).toBe(true)
    expect(findItem(menu.ctxMenuItems.value, 'delete')?.disabled).toBe(true)
  })
})

// --- Delete fast path (regression for #582) ---
//
// Old delete branch called `fetchActionDef` → `getDetailSections` →
// rebuilds the entire detail tree just to pluck the 12-line
// `deleteAction()` constant; on Windows this stalled the confirm modal
// by ~2s. The fast path builds the confirm + showProgress payload
// entirely renderer-side.

function mountHarnessWithProgress(
  _inst: Installation,
  onShowProgress: (opts: ShowProgressOpts) => void,
): { menu: ReturnType<typeof useInstallContextMenu> } {
  // Reuses the shared `HarnessComponent` defined above; tests drive
  // `menu.triggerAction(...)` directly so the inst arg is just a
  // documented call-site hint.
  const pinia = createPinia()
  setActivePinia(pinia)
  const i18n = createI18n({ legacy: false, locale: 'en', messages })
  let menu!: ReturnType<typeof useInstallContextMenu>
  _harnessSetup = () => {
    menu = useInstallContextMenu({
      onManage: () => {},
      onShowProgress,
    })
  }
  mount(HarnessComponent, { global: { plugins: [pinia, i18n] } })
  _harnessSetup = null
  return { menu }
}

describe('useInstallContextMenu — delete fast path (regression for #582)', () => {
  beforeEach(() => {
    apiMock.getDetailSections.mockClear()
    apiMock.runAction.mockClear()
    modalMock.confirm.mockReset()
  })

  it('shows the confirm modal without calling getDetailSections', async () => {
    modalMock.confirm.mockResolvedValue(true)
    const onShowProgress = vi.fn<(opts: ShowProgressOpts) => void>()
    const inst = makeInstall({ name: 'My Install', installPath: '/tmp/my' })
    const { menu } = mountHarnessWithProgress(inst, onShowProgress)

    await menu.triggerAction('delete', inst)

    expect(apiMock.getDetailSections).not.toHaveBeenCalled()
    expect(modalMock.confirm).toHaveBeenCalledTimes(1)
    const confirmArgs = modalMock.confirm.mock.calls[0][0]
    expect(confirmArgs.title).toBe('Delete Install')
    expect(confirmArgs.message).toContain('permanently delete')
    expect(confirmArgs.message).toContain('/tmp/my')
    expect(confirmArgs.confirmLabel).toBe('Delete')
    expect(confirmArgs.confirmStyle).toBe('danger')
  })

  it('on confirm true, emits showProgress with the correct shape and does not pre-run the action', async () => {
    modalMock.confirm.mockResolvedValue(true)
    const onShowProgress = vi.fn<(opts: ShowProgressOpts) => void>()
    const inst = makeInstall({ name: 'My Install', installPath: '/tmp/my' })
    const { menu } = mountHarnessWithProgress(inst, onShowProgress)

    await menu.triggerAction('delete', inst)

    expect(onShowProgress).toHaveBeenCalledTimes(1)
    const opts = onShowProgress.mock.calls[0][0]
    expect(opts.installationId).toBe(inst.id)
    expect(opts.title).toBe('Delete — My Install')
    expect(opts.cancellable).toBe(true)
    expect(opts.returnTo).toBe('list')
    expect(opts.destroysInstance).toBe(true)

    // The actual destructive call runs inside ProgressModal, not here.
    expect(apiMock.runAction).not.toHaveBeenCalled()
  })

  it('on confirm cancel, does not emit showProgress and does not call runAction', async () => {
    modalMock.confirm.mockResolvedValue(false)
    const onShowProgress = vi.fn<(opts: ShowProgressOpts) => void>()
    const inst = makeInstall()
    const { menu } = mountHarnessWithProgress(inst, onShowProgress)

    await menu.triggerAction('delete', inst)

    expect(onShowProgress).not.toHaveBeenCalled()
    expect(apiMock.runAction).not.toHaveBeenCalled()
    expect(apiMock.getDetailSections).not.toHaveBeenCalled()
  })
})

function mountHarnessWithManage(
  onManage: (inst: Installation, options?: { initialTab?: string; autoAction?: string | null }) => void,
): { menu: ReturnType<typeof useInstallContextMenu> } {
  const pinia = createPinia()
  setActivePinia(pinia)
  const i18n = createI18n({ legacy: false, locale: 'en', messages })
  let menu!: ReturnType<typeof useInstallContextMenu>
  _harnessSetup = () => {
    menu = useInstallContextMenu({ onManage })
  }
  mount(HarnessComponent, { global: { plugins: [pinia, i18n] } })
  _harnessSetup = null
  return { menu }
}

describe('useInstallContextMenu — copy-install routing', () => {
  beforeEach(() => {
    apiMock.runAction.mockClear()
  })

  it('copy-install routes through onManage with autoAction "copy" and does not call runAction directly', async () => {
    const onManage = vi.fn<(inst: Installation, options?: { autoAction?: string | null }) => void>()
    const inst = makeInstall()
    const { menu } = mountHarnessWithManage(onManage)

    await menu.triggerAction('copy-install', inst)

    expect(onManage).toHaveBeenCalledTimes(1)
    expect(onManage.mock.calls[0][0]).toBe(inst)
    expect(onManage.mock.calls[0][1]).toEqual({ autoAction: 'copy' })
    expect(apiMock.runAction).not.toHaveBeenCalled()
  })
})

describe('useInstallContextMenu — untrack confirm-then-remove', () => {
  beforeEach(() => {
    apiMock.runAction.mockClear()
    modalMock.confirm.mockReset()
  })

  it('shows a danger confirm and never opens the picker', async () => {
    modalMock.confirm.mockResolvedValue(true)
    const onManage = vi.fn()
    const inst = makeInstall()
    const { menu } = mountHarnessWithManage(onManage)

    await menu.triggerAction('untrack', inst)

    expect(modalMock.confirm).toHaveBeenCalledTimes(1)
    const args = modalMock.confirm.mock.calls[0]![0]
    expect(args.title).toBe('Forget Install')
    expect(args.confirmLabel).toBe('Forget')
    expect(args.confirmStyle).toBe('danger')
    expect(onManage).not.toHaveBeenCalled()
  })

  it('on confirm true, dispatches the `remove` action once', async () => {
    modalMock.confirm.mockResolvedValue(true)
    const inst = makeInstall()
    const { menu } = mountHarnessWithManage(() => {})

    await menu.triggerAction('untrack', inst)

    expect(apiMock.runAction).toHaveBeenCalledTimes(1)
    expect(apiMock.runAction).toHaveBeenCalledWith(inst.id, 'remove')
  })

  it('on confirm cancel, does not dispatch the action', async () => {
    modalMock.confirm.mockResolvedValue(false)
    const inst = makeInstall()
    const { menu } = mountHarnessWithManage(() => {})

    await menu.triggerAction('untrack', inst)

    expect(apiMock.runAction).not.toHaveBeenCalled()
  })
})

describe('useInstallContextMenu — share (export latest snapshot)', () => {
  beforeEach(() => {
    apiMock.getSnapshots.mockReset()
    apiMock.exportSnapshot.mockReset()
    modalMock.alert.mockReset()
  })

  it('shows the Share item for an installed local install', () => {
    const { menu } = mountHarness(makeInstall({ sourceCategory: 'local' }))
    expect(findItem(menu.ctxMenuItems.value, 'share')).toBeTruthy()
  })

  it('hides the Share item for cloud installs (snapshots are local-only)', () => {
    const { menu } = mountHarness(makeInstall({ sourceCategory: 'cloud' }))
    expect(findItem(menu.ctxMenuItems.value, 'share')).toBeUndefined()
  })

  it('exports the newest snapshot and shows no alert on success', async () => {
    apiMock.getSnapshots.mockResolvedValue({
      snapshots: [{ filename: 'snap-newest.json' }, { filename: 'snap-older.json' }],
    })
    apiMock.exportSnapshot.mockResolvedValue({ ok: true })
    const inst = makeInstall()
    const { menu } = mountHarnessWithManage(() => {})

    await menu.triggerAction('share', inst)

    expect(apiMock.exportSnapshot).toHaveBeenCalledWith(inst.id, 'snap-newest.json')
    expect(modalMock.alert).not.toHaveBeenCalled()
  })

  it('alerts and skips export when there are no snapshots', async () => {
    apiMock.getSnapshots.mockResolvedValue({ snapshots: [] })
    const inst = makeInstall()
    const { menu } = mountHarnessWithManage(() => {})

    await menu.triggerAction('share', inst)

    expect(apiMock.exportSnapshot).not.toHaveBeenCalled()
    expect(modalMock.alert).toHaveBeenCalledTimes(1)
    expect(modalMock.alert.mock.calls[0]![0].message).toBe('There are no snapshots to share yet.')
  })

  it('surfaces a real export error but stays silent on a dialog cancel', async () => {
    apiMock.getSnapshots.mockResolvedValue({ snapshots: [{ filename: 'snap.json' }] })
    const inst = makeInstall()
    const { menu } = mountHarnessWithManage(() => {})

    // Cancel — export IPC returns { ok: false } with no message.
    apiMock.exportSnapshot.mockResolvedValueOnce({ ok: false })
    await menu.triggerAction('share', inst)
    expect(modalMock.alert).not.toHaveBeenCalled()

    // Real failure — a message is present, so it surfaces.
    apiMock.exportSnapshot.mockResolvedValueOnce({ ok: false, message: 'Disk full' })
    await menu.triggerAction('share', inst)
    expect(modalMock.alert).toHaveBeenCalledTimes(1)
    expect(modalMock.alert.mock.calls[0]![0].message).toBe('Disk full')
  })
})
