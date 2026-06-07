import { createTestingPinia } from '@pinia/testing'
import { setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    // t(key, fallbackString) returns the fallback; t(key, paramsObject)
    // returns the bare key.
    t: (key: string, arg?: string | Record<string, unknown>) =>
      typeof arg === 'string' ? arg : key,
  }),
}))

// Hoisted so they can capture calls — the composable invokes
// `useModal()` / `useActionGuard()` once at setup.
const modalSpies = vi.hoisted(() => ({
  confirm: vi.fn(),
  prompt: vi.fn(),
  select: vi.fn(),
  confirmWithOptions: vi.fn(),
  alert: vi.fn(),
}))
// `dialogsSpies.confirm` resolves `'primary'` to proceed, `false` to cancel.
const dialogsSpies = vi.hoisted(() => ({
  confirm: vi.fn(),
  prompt: vi.fn(),
  actionSheet: vi.fn(),
  alert: vi.fn(),
}))
const actionGuardSpies = vi.hoisted(() => ({
  checkBeforeAction: vi.fn(),
}))

vi.mock('./useModal', () => ({
  useModal: () => modalSpies,
}))

vi.mock('./useDialogs', () => ({
  useDialogs: () => dialogsSpies,
}))

vi.mock('./useActionGuard', () => ({
  useActionGuard: () => actionGuardSpies,
}))

vi.mock('./useMigrateAction', () => ({
  useMigrateAction: () => ({
    confirmMigration: vi.fn(),
  }),
}))

vi.mock('../lib/telemetry', () => ({
  emitTelemetryAction: vi.fn(),
  toErrorBucket: () => 'other',
}))

import { useComfyUISettings } from './useComfyUISettings'
import { useSessionStore } from '../stores/sessionStore'
import type { ActionDef, ActionResult, DetailField, DetailSection, Installation, ShowProgressOpts } from '../types/ipc'

function makeInstall(id: string, name: string): Installation {
  return {
    id,
    name,
    sourceLabel: 'standalone',
    sourceCategory: 'local',
    status: 'installed',
    installPath: `/tmp/${id}`,
  } as Installation
}

function makeSection(installName: string): DetailSection {
  // Stamp the title with the install name so assertions can tell payloads apart.
  return {
    tab: 'status',
    title: `Sections for ${installName}`,
    fields: [],
  } as DetailSection
}

interface MockApi {
  getDetailSections: ReturnType<typeof vi.fn>
  getDiskSpace: ReturnType<typeof vi.fn>
  getInstallationSize: ReturnType<typeof vi.fn>
  stopComfyUI: ReturnType<typeof vi.fn>
  runAction: ReturnType<typeof vi.fn>
  updateInstallation: ReturnType<typeof vi.fn>
}

function installMockApi(overrides: Partial<MockApi> = {}): MockApi {
  const api: MockApi = {
    getDetailSections: vi.fn().mockResolvedValue([]),
    getDiskSpace: vi.fn().mockResolvedValue(null),
    getInstallationSize: vi.fn().mockResolvedValue({ sizeBytes: 0 }),
    stopComfyUI: vi.fn().mockResolvedValue(undefined),
    runAction: vi.fn().mockResolvedValue({ ok: true }),
    updateInstallation: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
    ; (window as unknown as { api: MockApi }).api = api
  return api
}

describe('useComfyUISettings — switch staleness behaviour (#782 / #582)', () => {
  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }))
  })

  it('keeps the previous install\'s sections + diskSpace painted during the switch window so the right pane does not flash "Loading…" (#782)', async () => {
    // Install B's IPC is held open to model the disk-bound delay.
    let resolveB: ((value: DetailSection[]) => void) | null = null
    const sectionsB = new Promise<DetailSection[]>((resolve) => {
      resolveB = resolve
    })

    const api = installMockApi({
      getDetailSections: vi.fn((id: string) => {
        if (id === 'a') return Promise.resolve([makeSection('A')])
        if (id === 'b') return sectionsB
        return Promise.resolve([])
      }),
    })

    const installation = ref<Installation | null>(makeInstall('a', 'A'))
    const onShowProgress = vi.fn()

    const scope = effectScope()
    let composable!: ReturnType<typeof useComfyUISettings>
    scope.run(() => {
      composable = useComfyUISettings({ installation, onShowProgress })
    })

    // Initial load (install A) resolves immediately.
    await nextTick()
    await Promise.resolve() // flush microtasks for the await chain in loadAll
    await Promise.resolve()
    expect(composable.sections.value.map((s) => s.title)).toEqual([
      'Sections for A',
    ])
    expect(composable.sectionsFresh.value).toBe(true)

    // Switch to install B. Sections/diskSpace are deliberately NOT blanked
    // synchronously so the "Loading…" placeholder never flashes;
    // `sectionsFresh` flips to false to mark the pane stale until B lands.
    installation.value = makeInstall('b', 'B')
    await nextTick()

    expect(composable.loading.value).toBe(true)
    expect(composable.sections.value.map((s) => s.title)).toEqual([
      'Sections for A',
    ])
    expect(composable.sectionsFresh.value).toBe(false)

    // Resolve B's IPC; sections flip to B and sectionsFresh returns true.
    resolveB!([makeSection('B')])
    await Promise.resolve()
    await Promise.resolve()
    await nextTick()

    expect(composable.loading.value).toBe(false)
    expect(composable.sections.value.map((s) => s.title)).toEqual([
      'Sections for B',
    ])
    expect(composable.sectionsFresh.value).toBe(true)
    expect(api.getDetailSections).toHaveBeenCalledTimes(2)
    scope.stop()
  })

  it('clears sections when the installation prop is set to null', async () => {
    installMockApi({
      getDetailSections: vi.fn().mockResolvedValue([makeSection('A')]),
    })
    const installation = ref<Installation | null>(makeInstall('a', 'A'))
    const onShowProgress = vi.fn()

    const scope = effectScope()
    let composable!: ReturnType<typeof useComfyUISettings>
    scope.run(() => {
      composable = useComfyUISettings({ installation, onShowProgress })
    })

    await nextTick()
    await Promise.resolve()
    await Promise.resolve()
    expect(composable.sections.value.length).toBeGreaterThan(0)

    installation.value = null
    await nextTick()
    expect(composable.sections.value).toEqual([])
    expect(composable.diskSpace.value).toBeNull()
    expect(composable.sectionsFresh.value).toBe(false)
    scope.stop()
  })

  it('does NOT clear sections on a same-install reload (only on install switches)', async () => {
    // Blanking on a same-install reload would flash Loading… for an edit;
    // only an install switch should clear.
    let getCallCount = 0
    installMockApi({
      getDetailSections: vi.fn(() => {
        getCallCount++
        return Promise.resolve([makeSection(`A-call-${getCallCount}`)])
      }),
    })
    const installation = ref<Installation | null>(makeInstall('a', 'A'))
    const onShowProgress = vi.fn()

    const scope = effectScope()
    let composable!: ReturnType<typeof useComfyUISettings>
    scope.run(() => {
      composable = useComfyUISettings({ installation, onShowProgress })
    })

    await nextTick()
    await Promise.resolve()
    await Promise.resolve()
    expect(composable.sections.value.map((s) => s.title)).toEqual(['Sections for A-call-1'])

    // Second reload for the same install must not blank the pane mid-flight.
    await composable.reload()
    expect(composable.sections.value.length).toBeGreaterThan(0)
    expect(composable.sections.value.map((s) => s.title)).toEqual(['Sections for A-call-2'])

    scope.stop()
  })

  it('discards an out-of-order older response (A → B → A returning B late)', async () => {
    // When B resolves after the switch back to A, its sections must NOT
    // overwrite A's payload.
    let resolveB: ((value: DetailSection[]) => void) | null = null
    const sectionsB = new Promise<DetailSection[]>((resolve) => {
      resolveB = resolve
    })
    const api = installMockApi({
      getDetailSections: vi.fn((id: string) => {
        if (id === 'a') return Promise.resolve([makeSection('A')])
        if (id === 'b') return sectionsB
        return Promise.resolve([])
      }),
    })

    const installation = ref<Installation | null>(makeInstall('a', 'A'))
    const scope = effectScope()
    let composable!: ReturnType<typeof useComfyUISettings>
    scope.run(() => {
      composable = useComfyUISettings({ installation, onShowProgress: vi.fn() })
    })

    await nextTick()
    await Promise.resolve()
    await Promise.resolve()

    // Switch to B — fetch held open.
    installation.value = makeInstall('b', 'B')
    await nextTick()

    // Switch back to A — A's IPC resolves immediately, sections=A.
    installation.value = makeInstall('a', 'A')
    await nextTick()
    await Promise.resolve()
    await Promise.resolve()
    expect(composable.sections.value.map((s) => s.title)).toEqual(['Sections for A'])
    expect(composable.loading.value).toBe(false)

    // Now resolve B late. The request-sequence guard must drop the
    // result so it never overwrites A's payload or flips loading.
    resolveB!([makeSection('B')])
    await Promise.resolve()
    await Promise.resolve()
    await nextTick()

    expect(composable.sections.value.map((s) => s.title)).toEqual(['Sections for A'])
    expect(composable.loading.value).toBe(false)
    expect(api.getDetailSections).toHaveBeenCalledTimes(3)
    scope.stop()
  })
})

describe('useComfyUISettings.runAction — stop-warning augment + self-stopping apiCall (FLOW 1 + FLOW 3)', () => {
  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }))
    modalSpies.confirm.mockReset()
    modalSpies.prompt.mockReset()
    modalSpies.select.mockReset()
    modalSpies.confirmWithOptions.mockReset()
    modalSpies.alert.mockReset()
    dialogsSpies.confirm.mockReset()
    dialogsSpies.prompt.mockReset()
    dialogsSpies.actionSheet.mockReset()
    dialogsSpies.alert.mockReset()
    actionGuardSpies.checkBeforeAction.mockReset()
    actionGuardSpies.checkBeforeAction.mockResolvedValue('proceed')
  })

  /** Mark an install running so `runAction`'s `wasRunning` capture flips true. */
  function markRunning(id: string, name = id): void {
    const sessionStore = useSessionStore()
    sessionStore.runningInstances.set(id, {
      installationId: id,
      installationName: name,
      mode: 'standalone',
    })
  }

  function mountComposable(installation: Installation | null, onShowProgress = vi.fn()): {
    composable: ReturnType<typeof useComfyUISettings>
    onShowProgress: ReturnType<typeof vi.fn>
    onDismissPreview: ReturnType<typeof vi.fn>
    scope: ReturnType<typeof effectScope>
  } {
    const installationRef = ref<Installation | null>(installation)
    const scope = effectScope()
    const onDismissPreview = vi.fn()
    let composable!: ReturnType<typeof useComfyUISettings>
    scope.run(() => {
      composable = useComfyUISettings({ installation: installationRef, onShowProgress, onDismissPreview })
    })
    return { composable, onShowProgress, onDismissPreview, scope }
  }

  it('prepends the willStopRunning warning to the action confirm message when the install is running', async () => {
    installMockApi()
    markRunning('a', 'A')
    dialogsSpies.confirm.mockResolvedValue(false) // user cancels — composable returns early
    const { composable, scope } = mountComposable(makeInstall('a', 'A'))

    await composable.runAction({
      id: 'update-comfyui',
      label: 'Update ComfyUI',
      confirm: { title: 'Update?', message: 'This will pull the latest ComfyUI.' },
    } as ActionDef)

    expect(dialogsSpies.confirm).toHaveBeenCalledTimes(1)
    const callArg = dialogsSpies.confirm.mock.calls[0]![0] as { message: string }
    // The warning is joined above the action copy with `\n\n`.
    expect(callArg.message).toBe('errors.willStopRunning\n\nThis will pull the latest ComfyUI.')
    scope.stop()
  })

  it('synthesizes a confirm dialog carrying just the warning when the action has neither confirm nor prompt', async () => {
    installMockApi()
    markRunning('a', 'A')
    dialogsSpies.confirm.mockResolvedValue(false)
    const { composable, scope } = mountComposable(makeInstall('a', 'A'))

    await composable.runAction({
      id: 'snapshot-restore',
      label: 'Restore Snapshot',
    } as ActionDef)

    expect(dialogsSpies.confirm).toHaveBeenCalledTimes(1)
    const callArg = dialogsSpies.confirm.mock.calls[0]![0] as { message: string; title: string }
    expect(callArg.message).toBe('errors.willStopRunning')
    expect(callArg.title).toBe('Restore Snapshot')
    scope.stop()
  })

  it('does NOT prepend the warning when the install is not running', async () => {
    installMockApi()
    // No markRunning — sessionStore.isRunning('a') === false.
    dialogsSpies.confirm.mockResolvedValue(false)
    const { composable, scope } = mountComposable(makeInstall('a', 'A'))

    await composable.runAction({
      id: 'update-comfyui',
      label: 'Update ComfyUI',
      confirm: { title: 'Update?', message: 'This will pull the latest ComfyUI.' },
    } as ActionDef)

    expect(dialogsSpies.confirm).toHaveBeenCalledTimes(1)
    const callArg = dialogsSpies.confirm.mock.calls[0]![0] as { message: string }
    expect(callArg.message).toBe('This will pull the latest ComfyUI.')
    scope.stop()
  })

  it('stop: shows a danger confirm, stops the backend, and dismisses the preview on confirm', async () => {
    const api = installMockApi()
    markRunning('a', 'A')
    dialogsSpies.confirm.mockResolvedValue('primary')
    const { composable, onDismissPreview, scope } = mountComposable(makeInstall('a', 'A'))

    await composable.runAction({ id: 'stop', label: 'Stop' } as ActionDef)

    expect(dialogsSpies.confirm).toHaveBeenCalledTimes(1)
    const callArg = dialogsSpies.confirm.mock.calls[0]![0] as { title: string; tone: string }
    expect(callArg.title).toBe('Stop ComfyUI')
    expect(callArg.tone).toBe('danger')
    expect(api.stopComfyUI).toHaveBeenCalledTimes(1)
    expect(api.stopComfyUI).toHaveBeenCalledWith('a')
    // Preview dismissed so the window lands on the stopped-relaunch card.
    expect(onDismissPreview).toHaveBeenCalledTimes(1)
    scope.stop()
  })

  it('stop: does not stop the backend or dismiss the preview when the confirm is cancelled', async () => {
    const api = installMockApi()
    markRunning('a', 'A')
    dialogsSpies.confirm.mockResolvedValue(false)
    const { composable, onDismissPreview, scope } = mountComposable(makeInstall('a', 'A'))

    await composable.runAction({ id: 'stop', label: 'Stop' } as ActionDef)

    expect(api.stopComfyUI).not.toHaveBeenCalled()
    expect(onDismissPreview).not.toHaveBeenCalled()
    scope.stop()
  })

  it('stop: keeps the preview open and alerts when stopComfyUI fails', async () => {
    const api = installMockApi({ stopComfyUI: vi.fn().mockRejectedValue(new Error('kill failed')) })
    markRunning('a', 'A')
    dialogsSpies.confirm.mockResolvedValue('primary')
    const { composable, onDismissPreview, scope } = mountComposable(makeInstall('a', 'A'))

    await composable.runAction({ id: 'stop', label: 'Stop' } as ActionDef)

    expect(api.stopComfyUI).toHaveBeenCalledTimes(1)
    expect(onDismissPreview).not.toHaveBeenCalled()
    expect(dialogsSpies.alert).toHaveBeenCalledTimes(1)
    expect(dialogsSpies.alert.mock.calls[0]![0].message).toBe('kill failed')
    scope.stop()
  })

  it('IN_PLACE_RELAUNCH apiCall stops the session, runs the op, and relaunches when the op succeeds', async () => {
    // stopComfyUI fires → flip runningInstances → polling loop in
    // stopAndWaitForExit exits → runAction(update-comfyui) → runAction(launch).
    const api = installMockApi({
      stopComfyUI: vi.fn().mockImplementation(async (id: string) => {
        useSessionStore().runningInstances.delete(id)
      }),
      runAction: vi.fn().mockResolvedValue({ ok: true }),
    })
    markRunning('a', 'A')
    dialogsSpies.confirm.mockResolvedValue('primary')

    const onShowProgress = vi.fn()
    const { composable, scope } = mountComposable(makeInstall('a', 'A'), onShowProgress)

    await composable.runAction({
      id: 'update-comfyui',
      label: 'Update ComfyUI',
      showProgress: true,
      confirm: { message: 'Update?' },
    } as ActionDef)

    expect(onShowProgress).toHaveBeenCalledTimes(1)
    const opts = onShowProgress.mock.calls[0]?.[0] as ShowProgressOpts
    // triggersInstanceStart reflects the relaunch the apiCall appends.
    expect(opts.triggersInstanceStart).toBe(true)

    const result = await opts.apiCall() as ActionResult

    expect(api.stopComfyUI).toHaveBeenCalledTimes(1)
    expect(api.stopComfyUI).toHaveBeenCalledWith('a')
    // Two run-action calls: the actual op, then the auto-relaunch.
    expect(api.runAction).toHaveBeenCalledTimes(2)
    expect(api.runAction).toHaveBeenNthCalledWith(1, 'a', 'update-comfyui', undefined)
    expect(api.runAction).toHaveBeenNthCalledWith(2, 'a', 'launch')
    expect(result).toEqual({ ok: true })
    scope.stop()
  })

  it('IN_PLACE_RELAUNCH apiCall skips the relaunch when the op result reports ok: false', async () => {
    // Must NOT relaunch on a failed update.
    const api = installMockApi({
      stopComfyUI: vi.fn().mockImplementation(async (id: string) => {
        useSessionStore().runningInstances.delete(id)
      }),
      runAction: vi.fn().mockResolvedValue({ ok: false, message: 'no update available' }),
    })
    markRunning('a', 'A')
    dialogsSpies.confirm.mockResolvedValue('primary')
    const onShowProgress = vi.fn()
    const { composable, scope } = mountComposable(makeInstall('a', 'A'), onShowProgress)

    await composable.runAction({
      id: 'update-comfyui',
      label: 'Update ComfyUI',
      showProgress: true,
      confirm: { message: 'Update?' },
    } as ActionDef)

    const opts = onShowProgress.mock.calls[0]?.[0] as ShowProgressOpts
    await opts.apiCall()

    expect(api.stopComfyUI).toHaveBeenCalledTimes(1)
    expect(api.runAction).toHaveBeenCalledTimes(1)
    expect(api.runAction).toHaveBeenCalledWith('a', 'update-comfyui', undefined)
    scope.stop()
  })

  it('REQUIRES_STOPPED-but-not-IN_PLACE_RELAUNCH apiCall stops and runs the op without an auto-relaunch (e.g. copy-update)', async () => {
    // copy-update returns a newInstallationId that opens in its own window;
    // the source install is intentionally left stopped, so no relaunch.
    const api = installMockApi({
      stopComfyUI: vi.fn().mockImplementation(async (id: string) => {
        useSessionStore().runningInstances.delete(id)
      }),
      runAction: vi.fn().mockResolvedValue({ ok: true, newInstallationId: 'a-prime' }),
    })
    markRunning('a', 'A')
    dialogsSpies.confirm.mockResolvedValue('primary')
    const onShowProgress = vi.fn()
    const { composable, scope } = mountComposable(makeInstall('a', 'A'), onShowProgress)

    await composable.runAction({
      id: 'copy-update',
      label: 'Copy & Update',
      showProgress: true,
      confirm: { message: 'Copy & update?' },
    } as ActionDef)

    const opts = onShowProgress.mock.calls[0]?.[0] as ShowProgressOpts
    // No auto-relaunch → triggersInstanceStart stays false.
    expect(opts.triggersInstanceStart).toBe(false)
    await opts.apiCall()

    expect(api.stopComfyUI).toHaveBeenCalledTimes(1)
    expect(api.runAction).toHaveBeenCalledTimes(1)
    expect(api.runAction).toHaveBeenCalledWith('a', 'copy-update', undefined)
    scope.stop()
  })

  it('apiCall does not stop or relaunch when the install is not running', async () => {
    // Wasn't running → nothing to stop or relaunch; just invoke the op.
    const api = installMockApi({
      runAction: vi.fn().mockResolvedValue({ ok: true }),
    })
    dialogsSpies.confirm.mockResolvedValue('primary')
    const onShowProgress = vi.fn()
    const { composable, scope } = mountComposable(makeInstall('a', 'A'), onShowProgress)

    await composable.runAction({
      id: 'update-comfyui',
      label: 'Update ComfyUI',
      showProgress: true,
      confirm: { message: 'Update?' },
    } as ActionDef)

    const opts = onShowProgress.mock.calls[0]?.[0] as ShowProgressOpts
    expect(opts.triggersInstanceStart).toBe(false)
    await opts.apiCall()

    expect(api.stopComfyUI).not.toHaveBeenCalled()
    expect(api.runAction).toHaveBeenCalledTimes(1)
    expect(api.runAction).toHaveBeenCalledWith('a', 'update-comfyui', undefined)
    scope.stop()
  })

  it('inline (no showProgress) REQUIRES_STOPPED action self-stops before invoking the backend', async () => {
    // Self-stop so the backend's running-check doesn't race the stop.
    const api = installMockApi({
      stopComfyUI: vi.fn().mockImplementation(async (id: string) => {
        useSessionStore().runningInstances.delete(id)
      }),
      runAction: vi.fn().mockResolvedValue({ ok: true }),
    })
    markRunning('a', 'A')
    dialogsSpies.confirm.mockResolvedValue('primary')
    const { composable, scope } = mountComposable(makeInstall('a', 'A'))

    await composable.runAction({
      id: 'update-comfyui',
      label: 'Update ComfyUI',
      confirm: { message: 'Update?' },
    } as ActionDef)

    expect(api.stopComfyUI).toHaveBeenCalledTimes(1)
    expect(api.runAction).toHaveBeenCalledWith('a', 'update-comfyui', undefined)
    scope.stop()
  })
})

describe('useComfyUISettings.updateField — optimistic write + restart-required tracking', () => {
  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }))
  })

  function makeRestartField(id: string, value: unknown): DetailField {
    return {
      id,
      label: id,
      value: value as DetailField['value'],
      editable: true,
      editType: 'select',
      requiresRestart: true,
    }
  }

  function makeSectionWithField(field: DetailField): DetailSection {
    return { tab: 'settings', title: 'Launch', fields: [field] } as DetailSection
  }

  /** Bring the composable up with one restart-required field in `sections`. */
  async function mountWithField(
    installId: string,
    initialValue: unknown,
    apiOverrides: Partial<MockApi> = {},
  ) {
    const initialField = makeRestartField('launchMode', initialValue)
    const api = installMockApi({
      getDetailSections: vi.fn().mockResolvedValue([makeSectionWithField(initialField)]),
      ...apiOverrides,
    })
    const installation = ref<Installation | null>(makeInstall(installId, installId.toUpperCase()))
    const scope = effectScope()
    let composable!: ReturnType<typeof useComfyUISettings>
    scope.run(() => {
      composable = useComfyUISettings({ installation, onShowProgress: vi.fn() })
    })
    await nextTick()
    await Promise.resolve()
    await Promise.resolve()
    return { composable, api, installation, scope }
  }

  function markRunning(id: string): void {
    useSessionStore().runningInstances.set(id, {
      installationId: id,
      installationName: id.toUpperCase(),
      mode: 'standalone',
    })
  }

  it('writes the new value into sections optimistically before the IPC resolves', async () => {
    // The optimistic write must land on `sections.value` regardless of
    // when main responds, so hold the IPC open.
    let resolveIpc: (() => void) | null = null
    const ipcPromise = new Promise<void>((r) => {
      resolveIpc = r
    })
    const updateInstallation = vi.fn().mockReturnValue(ipcPromise)
    const { composable, scope } = await mountWithField('a', 'window', { updateInstallation })

    markRunning('a')
    const updatePromise = composable.updateField(
      makeRestartField('launchMode', 'window'),
      'console',
    )

    // Microtask flush — but IPC is still pending.
    await nextTick()
    const field = composable.sections.value[0]!.fields![0]!
    expect(field.value).toBe('console')
    expect(updateInstallation).toHaveBeenCalledWith('a', { launchMode: 'console' })

    resolveIpc!()
    await updatePromise
    scope.stop()
  })

  it('marks the field dirty when running, clears it when reverted to baseline', async () => {
    const { composable, scope } = await mountWithField('a', 'window')
    markRunning('a')

    await composable.updateField(makeRestartField('launchMode', 'window'), 'console')
    expect(composable.pendingRestartFieldIds.value.has('launchMode')).toBe(true)

    // Revert — baseline is the original 'window', so this should drop
    // the dirty entry.
    await composable.updateField(makeRestartField('launchMode', 'console'), 'window')
    expect(composable.pendingRestartFieldIds.value.has('launchMode')).toBe(false)
    expect(composable.pendingRestartFieldIds.value.size).toBe(0)
    scope.stop()
  })

  it('does NOT mark dirty when the install is not running', async () => {
    const { composable, scope } = await mountWithField('a', 'window')
    // No markRunning — stopped install picks up new values on next
    // launch, so there is nothing pending.
    await composable.updateField(makeRestartField('launchMode', 'window'), 'console')
    expect(composable.pendingRestartFieldIds.value.size).toBe(0)
    scope.stop()
  })

  it('keeps the dirty state when the picker selection swaps to another install and back', async () => {
    // The Map<installId, ...> shape isolates state per install so toggling
    // the picker row preserves install A's edits.
    const initialField = makeRestartField('launchMode', 'window')
    const installation = ref<Installation | null>(makeInstall('a', 'A'))
    const api = installMockApi({
      getDetailSections: vi.fn((id: string) => {
        if (id === 'a') return Promise.resolve([makeSectionWithField(initialField)])
        if (id === 'b') return Promise.resolve([
          makeSectionWithField(makeRestartField('launchMode', 'window')),
        ])
        return Promise.resolve([])
      }),
    })
    const scope = effectScope()
    let composable!: ReturnType<typeof useComfyUISettings>
    scope.run(() => {
      composable = useComfyUISettings({ installation, onShowProgress: vi.fn() })
    })
    await nextTick()
    await Promise.resolve()
    await Promise.resolve()

    markRunning('a')
    await composable.updateField(makeRestartField('launchMode', 'window'), 'console')
    expect(composable.pendingRestartFieldIds.value.has('launchMode')).toBe(true)

    // Switch picker selection to B — different install, no edits, no
    // tag should surface for B.
    installation.value = makeInstall('b', 'B')
    await nextTick()
    await Promise.resolve()
    await Promise.resolve()
    expect(composable.pendingRestartFieldIds.value.has('launchMode')).toBe(false)

    // Switch back to A — dirty marker for A's launchMode is still there.
    installation.value = makeInstall('a', 'A')
    await nextTick()
    await Promise.resolve()
    await Promise.resolve()
    expect(composable.pendingRestartFieldIds.value.has('launchMode')).toBe(true)
    expect(api.getDetailSections).toHaveBeenCalled()
    scope.stop()
  })

  it('rolls back the optimistic write and surfaces an error pill when the IPC rejects', async () => {
    const updateInstallation = vi.fn().mockRejectedValue(new Error('boom'))
    const { composable, scope } = await mountWithField('a', 'window', { updateInstallation })
    markRunning('a')

    await composable.updateField(makeRestartField('launchMode', 'window'), 'console')

    const field = composable.sections.value[0]!.fields![0]!
    // Rolled back to the prior value — UI doesn't lie about state.
    expect(field.value).toBe('window')
    // Failed writes never engage the dirty/yellow state.
    expect(composable.pendingRestartFieldIds.value.size).toBe(0)
    // Inline error pill surfaces the IPC message.
    expect(composable.fieldErrorMessages.value.get('launchMode')).toBe('boom')
    scope.stop()
  })

  it('treats a 5s+ IPC stall as a timeout and rolls back with a timeout-flavoured message', async () => {
    // updateInstallation never settles — the 5s timeout should win and roll back.
    vi.useFakeTimers()
    try {
      const updateInstallation = vi.fn().mockReturnValue(new Promise<void>(() => { }))
      const { composable, scope } = await mountWithField('a', 'window', { updateInstallation })
      markRunning('a')

      const updatePromise = composable.updateField(
        makeRestartField('launchMode', 'window'),
        'console',
      )
      // Advance past the 5s deadline to trigger the timeout branch.
      await vi.advanceTimersByTimeAsync(5_001)
      await updatePromise

      const timeoutField = composable.sections.value[0]!.fields![0]!
      expect(timeoutField.value).toBe('window')
      expect(composable.pendingRestartFieldIds.value.size).toBe(0)
      expect(composable.fieldErrorMessages.value.get('launchMode')).toBe(
        "Couldn't reach app — try again",
      )
      scope.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the per-install dirty + error entries when the install transitions to not-running', async () => {
    const updateInstallation = vi.fn().mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined)
    const { composable, scope } = await mountWithField('a', 'window', { updateInstallation })
    markRunning('a')

    // First call fails → error pill present.
    await composable.updateField(makeRestartField('launchMode', 'window'), 'console')
    expect(composable.fieldErrorMessages.value.get('launchMode')).toBe('boom')

    // Second call succeeds → dirty engaged.
    await composable.updateField(makeRestartField('launchMode', 'window'), 'console')
    expect(composable.pendingRestartFieldIds.value.has('launchMode')).toBe(true)

    // Stop the install — both per-install entries should drop because
    // the next launch will pick up the new value.
    useSessionStore().runningInstances.delete('a')
    await nextTick()
    expect(composable.pendingRestartFieldIds.value.size).toBe(0)
    expect(composable.fieldErrorMessages.value.size).toBe(0)
    scope.stop()
  })

  it('considers envVars equal when keys and values match (revert clears dirty)', async () => {
    const initialField: DetailField = {
      id: 'envVars',
      label: 'envVars',
      value: { FOO: 'bar' } as DetailField['value'],
      editable: true,
      editType: 'env-vars',
      requiresRestart: true,
    }
    const installation = ref<Installation | null>(makeInstall('a', 'A'))
    installMockApi({
      getDetailSections: vi.fn().mockResolvedValue([makeSectionWithField(initialField)]),
    })
    const scope = effectScope()
    let composable!: ReturnType<typeof useComfyUISettings>
    scope.run(() => {
      composable = useComfyUISettings({ installation, onShowProgress: vi.fn() })
    })
    await nextTick()
    await Promise.resolve()
    await Promise.resolve()
    markRunning('a')

    await composable.updateField(initialField, { FOO: 'bar', BAZ: 'qux' })
    expect(composable.pendingRestartFieldIds.value.has('envVars')).toBe(true)

    // Revert to the baseline object — equality is by keys+values, not
    // by reference, so a fresh `{ FOO: 'bar' }` object still matches.
    await composable.updateField({ ...initialField, value: { FOO: 'bar', BAZ: 'qux' } } as DetailField, {
      FOO: 'bar',
    })
    expect(composable.pendingRestartFieldIds.value.has('envVars')).toBe(false)
    scope.stop()
  })
})

describe('useComfyUISettings — renameInstallation', () => {
  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }))
    dialogsSpies.alert.mockReset()
  })

  async function mountRename(api: MockApi) {
    const installation = ref<Installation | null>(makeInstall('a', 'Old Name'))
    const scope = effectScope()
    let composable!: ReturnType<typeof useComfyUISettings>
    scope.run(() => {
      composable = useComfyUISettings({ installation, onShowProgress: vi.fn() })
    })
    await nextTick()
    await Promise.resolve()
    await Promise.resolve()
    return { composable, scope, api }
  }

  it('commits a fresh name, reloads sections, and resolves true', async () => {
    const api = installMockApi({ updateInstallation: vi.fn().mockResolvedValue({ ok: true }) })
    const { composable, scope } = await mountRename(api)
    api.getDetailSections.mockClear()

    const committed = await composable.renameInstallation('New Name')

    expect(committed).toBe(true)
    expect(api.updateInstallation).toHaveBeenCalledWith('a', { name: 'New Name' })
    expect(api.getDetailSections).toHaveBeenCalled() // reload() ran
    expect(dialogsSpies.alert).not.toHaveBeenCalled()
    scope.stop()
  })

  it('trims surrounding whitespace before committing', async () => {
    const api = installMockApi({ updateInstallation: vi.fn().mockResolvedValue({ ok: true }) })
    const { composable, scope } = await mountRename(api)

    await composable.renameInstallation('  Padded  ')

    expect(api.updateInstallation).toHaveBeenCalledWith('a', { name: 'Padded' })
    scope.stop()
  })

  it('is a no-op (no IPC) when the trimmed name is empty or unchanged', async () => {
    const api = installMockApi()
    const { composable, scope } = await mountRename(api)

    expect(await composable.renameInstallation('   ')).toBe(false)
    expect(await composable.renameInstallation('Old Name')).toBe(false)
    expect(api.updateInstallation).not.toHaveBeenCalled()
    scope.stop()
  })

  it('surfaces a rejection (duplicate name) as an alert and resolves false', async () => {
    const api = installMockApi({
      updateInstallation: vi.fn().mockResolvedValue({ ok: false, message: 'taken' }),
    })
    const { composable, scope } = await mountRename(api)
    api.getDetailSections.mockClear()

    const committed = await composable.renameInstallation('Dupe')

    expect(committed).toBe(false)
    expect(dialogsSpies.alert).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'taken' }),
    )
    expect(api.getDetailSections).not.toHaveBeenCalled() // no reload on failure
    scope.stop()
  })
})
