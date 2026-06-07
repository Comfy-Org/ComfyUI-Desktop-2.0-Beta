import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'

// Mocked so tests can drive `modal.confirm(...)`, which never resolves
// on its own.
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

// `getDetailSections` is spied so tests can assert the delete fast path
// never calls it.
const apiMock = {
  platform: 'darwin',
  runAction: vi.fn().mockResolvedValue({ ok: true }),
  getDetailSections: vi.fn().mockResolvedValue([]),
  onErrorDetail: vi.fn(() => () => {}),
  getSnapshots: vi.fn().mockResolvedValue({ snapshots: [] }),
  exportSnapshot: vi.fn().mockResolvedValue({ ok: true }),
  stopComfyUI: vi.fn().mockResolvedValue(undefined),
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
        'This permanently removes this ComfyUI installation and all its files. Other installations and ComfyUI itself are unaffected. This cannot be undone.',
      share: 'Share',
      stop: 'Stop',
      stopConfirmTitle: 'Stop ComfyUI',
      stopConfirmMessage:
        'This will stop ComfyUI. Any unsaved work will be lost. The window stays open so you can relaunch anytime.',
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

// Shared harness reused across factories (one component to satisfy
// `vue/one-component-per-file`); `setup` runs the per-mount closure.
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
  // Update and migrate are mutually exclusive (a single `statusTag`), so each
  // is exercised against an install carrying the matching tag.
  it('renders update / restore-snapshot / delete enabled when the install is idle', () => {
    const inst = makeInstall() // statusTag style 'update'
    const { menu } = mountHarness(inst)
    const items = menu.ctxMenuItems.value

    expect(findItem(items, 'update')?.disabled).toBeFalsy()
    expect(findItem(items, 'restore-snapshot')?.disabled).toBeFalsy()
    expect(findItem(items, 'delete')?.disabled).toBeFalsy()
    expect(menu.isStoppedActionGated(inst)).toBe(false)
  })

  it('renders migrate / restore-snapshot / delete enabled when the install is idle', () => {
    const inst = makeInstall({ statusTag: { style: 'migrate', label: 'Migrate to Standalone' } })
    const { menu } = mountHarness(inst)
    const items = menu.ctxMenuItems.value

    expect(findItem(items, 'migrate')?.disabled).toBeFalsy()
    expect(findItem(items, 'restore-snapshot')?.disabled).toBeFalsy()
    expect(findItem(items, 'delete')?.disabled).toBeFalsy()
    expect(menu.isStoppedActionGated(inst)).toBe(false)
  })

  it('disables REQUIRES_STOPPED items when the install is running', () => {
    const inst = makeInstall({ statusTag: { style: 'migrate', label: 'Migrate to Standalone' } })
    const { menu } = mountHarness(inst, ({ session }) => {
      session.runningInstances.set(inst.id, {
        installationId: inst.id,
        installationName: inst.name,
      } as never)
    })
    const items = menu.ctxMenuItems.value

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

function mountHarnessWithProgress(
  _inst: Installation,
  onShowProgress: (opts: ShowProgressOpts) => void,
): { menu: ReturnType<typeof useInstallContextMenu> } {
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
    expect(confirmArgs.message).toContain('permanently removes this ComfyUI installation')
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

  it('update opens the Update tab AND auto-fires the update (matches the title-bar pill)', async () => {
    const onManage = vi.fn<(inst: Installation, options?: { initialTab?: string; autoAction?: string | null }) => void>()
    const inst = makeInstall()
    const { menu } = mountHarnessWithManage(onManage)

    await menu.triggerAction('update', inst)

    expect(onManage).toHaveBeenCalledTimes(1)
    expect(onManage.mock.calls[0][1]).toEqual({ initialTab: 'update', autoAction: 'update-comfyui' })
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

  // Adopted (legacy-desktop) installs hide the Forget item: the
  // `.comfyui-desktop-2` marker on disk also makes the legacy
  // auto-tracker stop surfacing the install, so forgetting strands
  // the user with no path back. Delete still appears (real disposal).
  it('hides the Forget item for adopted installs but keeps Delete', () => {
    const inst = makeInstall({ adopted: true } as Partial<Installation>)
    const { menu } = mountHarness(inst)
    const items = menu.ctxMenuItems.value
    expect(findItem(items, 'untrack')).toBeUndefined()
    expect(findItem(items, 'delete')).toBeTruthy()
  })

  it('shows the Forget item for non-adopted installs', () => {
    const inst = makeInstall()
    const { menu } = mountHarness(inst)
    const items = menu.ctxMenuItems.value
    expect(findItem(items, 'untrack')).toBeTruthy()
    expect(findItem(items, 'delete')).toBeTruthy()
  })
})

describe('useInstallContextMenu — migrate item keys off the migrate status tag', () => {
  // Portable, git, and Legacy Desktop installs all report a `migrate`
  // status tag (and `sourceCategory === 'local'`), so the Migrate item must
  // follow the tag, not a single source.
  it.each([
    ['portable', 'standalone'],
    ['git', 'standalone'],
    ['desktop', 'desktop'],
  ])('shows the Migrate item for a %s install carrying a migrate tag', (_label, sourceId) => {
    const inst = makeInstall({
      sourceId,
      sourceCategory: 'local',
      statusTag: { style: 'migrate', label: 'Migrate to Standalone' },
    } as Partial<Installation>)
    const { menu } = mountHarness(inst)
    expect(findItem(menu.ctxMenuItems.value, 'migrate')).toBeTruthy()
  })

  it('hides the Migrate item when there is no migrate tag (e.g. an update is pending)', () => {
    const inst = makeInstall() // statusTag style 'update'
    const { menu } = mountHarness(inst)
    expect(findItem(menu.ctxMenuItems.value, 'migrate')).toBeUndefined()
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

describe('useInstallContextMenu — stop (shut down backend, keep window)', () => {
  beforeEach(() => {
    apiMock.stopComfyUI.mockClear()
    modalMock.confirm.mockReset()
    modalMock.alert.mockReset()
  })

  it('shows the Stop item only when the install is running', () => {
    const inst = makeInstall()
    const { menu: idle } = mountHarness(inst)
    expect(findItem(idle.ctxMenuItems.value, 'stop')).toBeUndefined()

    const { menu: running } = mountHarness(inst, ({ session }) => {
      session.runningInstances.set(inst.id, {
        installationId: inst.id,
        installationName: inst.name,
      } as never)
    })
    expect(findItem(running.ctxMenuItems.value, 'stop')).toBeTruthy()
  })

  it('hides the Stop item for cloud installs (no local Python to stop)', () => {
    const inst = makeInstall({ sourceCategory: 'cloud' })
    const { menu } = mountHarness(inst, ({ session }) => {
      session.runningInstances.set(inst.id, {
        installationId: inst.id,
        installationName: inst.name,
      } as never)
    })
    expect(findItem(menu.ctxMenuItems.value, 'stop')).toBeUndefined()
  })

  it('shows a danger confirm and stops the backend on confirm', async () => {
    modalMock.confirm.mockResolvedValue(true)
    const inst = makeInstall()
    const { menu } = mountHarnessWithManage(() => {})

    await menu.triggerAction('stop', inst)

    expect(modalMock.confirm).toHaveBeenCalledTimes(1)
    const args = modalMock.confirm.mock.calls[0]![0]
    expect(args.title).toBe('Stop ComfyUI')
    expect(args.confirmLabel).toBe('Stop')
    expect(args.confirmStyle).toBe('danger')
    expect(apiMock.stopComfyUI).toHaveBeenCalledTimes(1)
    expect(apiMock.stopComfyUI).toHaveBeenCalledWith(inst.id)
  })

  it('does not stop the backend when the confirm is cancelled', async () => {
    modalMock.confirm.mockResolvedValue(false)
    const inst = makeInstall()
    const { menu } = mountHarnessWithManage(() => {})

    await menu.triggerAction('stop', inst)

    expect(apiMock.stopComfyUI).not.toHaveBeenCalled()
  })

  it('surfaces a stop failure via an alert', async () => {
    modalMock.confirm.mockResolvedValue(true)
    apiMock.stopComfyUI.mockRejectedValueOnce(new Error('kill failed'))
    const inst = makeInstall()
    const { menu } = mountHarnessWithManage(() => {})

    await menu.triggerAction('stop', inst)

    expect(modalMock.alert).toHaveBeenCalledTimes(1)
    expect(modalMock.alert.mock.calls[0]![0].message).toBe('kill failed')
  })
})
