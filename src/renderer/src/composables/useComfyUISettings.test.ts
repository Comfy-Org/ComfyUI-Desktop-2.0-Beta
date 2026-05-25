import { createTestingPinia } from '@pinia/testing'
import { setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}))

// Shared spies so tests can assert on the modal/actionGuard calls. The
// composable invokes `useModal()` / `useActionGuard()` once at setup, so
// we can't reach into a fresh-per-call factory — hoisted spies are the
// only way to capture the messages passed to `modal.confirm`, etc.
const modalSpies = vi.hoisted(() => ({
  confirm: vi.fn(),
  prompt: vi.fn(),
  select: vi.fn(),
  confirmWithOptions: vi.fn(),
  alert: vi.fn(),
}))
const actionGuardSpies = vi.hoisted(() => ({
  checkBeforeAction: vi.fn(),
}))

vi.mock('./useModal', () => ({
  useModal: () => modalSpies,
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
import type { ActionDef, ActionResult, DetailSection, Installation, ShowProgressOpts } from '../types/ipc'

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
  // Stamp the section title with the install name so test assertions
  // can distinguish "install A's payload" from "install B's payload".
  return {
    tab: 'status',
    title: `Sections for ${installName}`,
    fields: [],
  } as DetailSection
}

interface MockApi {
  getDetailSections: ReturnType<typeof vi.fn>
  getDiskSpace: ReturnType<typeof vi.fn>
  stopComfyUI: ReturnType<typeof vi.fn>
  runAction: ReturnType<typeof vi.fn>
}

function installMockApi(overrides: Partial<MockApi> = {}): MockApi {
  const api: MockApi = {
    getDetailSections: vi.fn().mockResolvedValue([]),
    getDiskSpace: vi.fn().mockResolvedValue(null),
    stopComfyUI: vi.fn().mockResolvedValue(undefined),
    runAction: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  }
  ;(window as unknown as { api: MockApi }).api = api
  return api
}

describe('useComfyUISettings — staleness clearing (regression for #582)', () => {
  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }))
  })

  it('clears sections + diskSpace synchronously when the install id changes so the old install\'s data does not flash', async () => {
    // Two installs with distinct section payloads. The IPC for install B
    // is held open until we explicitly resolve it — this models the
    // real disk-bound delay in `getDetailSections` for an install with
    // many snapshots.
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

    // Now switch to install B. The watcher fires `reload(B)` which
    // calls `loadAll('b', ...)`. The fix clears `sections.value`
    // BEFORE awaiting, so the next microtask should already see an
    // empty sections array (and `loading: true`).
    installation.value = makeInstall('b', 'B')
    await nextTick()

    expect(composable.loading.value).toBe(true)
    expect(composable.sections.value).toEqual([])
    expect(composable.diskSpace.value).toBeNull()

    // Resolve install B's IPC; sections + loading flip to the new
    // payload.
    resolveB!([makeSection('B')])
    await Promise.resolve()
    await Promise.resolve()
    await nextTick()

    expect(composable.loading.value).toBe(false)
    expect(composable.sections.value.map((s) => s.title)).toEqual([
      'Sections for B',
    ])
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
    scope.stop()
  })

  it('does NOT clear sections on a same-install reload (only on install switches)', async () => {
    // Same-install reloads happen after `updateField` / action completion.
    // Blanking the pane in that case would be a regression — the user
    // would see Loading… flash for an edit they didn't expect to clear
    // the view. Switching installs is the only trigger for the clear.
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

    // Second reload for the SAME install. Should NOT blank the pane
    // mid-flight; sections.value stays at the previous payload until
    // the new one arrives.
    await composable.reload()
    expect(composable.sections.value.length).toBeGreaterThan(0)
    expect(composable.sections.value.map((s) => s.title)).toEqual(['Sections for A-call-2'])

    scope.stop()
  })

  it('discards an out-of-order older response (A → B → A returning B late)', async () => {
    // Three resolvers — A1 resolves immediately, then we switch to B
    // (resolveB held open), then back to A2 (immediate). When B finally
    // resolves AFTER A2, its sections must NOT overwrite A2's payload.
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
    actionGuardSpies.checkBeforeAction.mockReset()
    actionGuardSpies.checkBeforeAction.mockResolvedValue('proceed')
  })

  /** Mark an install as running in the session store so `runAction`'s
   *  `wasRunning = sessionStore.isRunning(...)` capture flips to true.
   *  The runningInstances map is plain reactive state, so we can poke
   *  it directly under `stubActions: false`. */
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
    scope: ReturnType<typeof effectScope>
  } {
    const installationRef = ref<Installation | null>(installation)
    const scope = effectScope()
    let composable!: ReturnType<typeof useComfyUISettings>
    scope.run(() => {
      composable = useComfyUISettings({ installation: installationRef, onShowProgress })
    })
    return { composable, onShowProgress, scope }
  }

  it('prepends the willStopRunning warning to the action confirm message when the install is running', async () => {
    installMockApi()
    markRunning('a', 'A')
    modalSpies.confirm.mockResolvedValue(false) // user cancels — composable returns early
    const { composable, scope } = mountComposable(makeInstall('a', 'A'))

    await composable.runAction({
      id: 'update-comfyui',
      label: 'Update ComfyUI',
      confirm: { title: 'Update?', message: 'This will pull the latest ComfyUI.' },
    } as ActionDef)

    expect(modalSpies.confirm).toHaveBeenCalledTimes(1)
    const callArg = modalSpies.confirm.mock.calls[0][0] as { message: string }
    // The shared `augmentMessageWithStopWarning` helper joins with `\n\n`
    // so the warning visually owns its own paragraph above the action's
    // own copy.
    expect(callArg.message).toBe('errors.willStopRunning\n\nThis will pull the latest ComfyUI.')
    scope.stop()
  })

  it('synthesizes a confirm dialog carrying just the warning when the action has neither confirm nor prompt', async () => {
    installMockApi()
    markRunning('a', 'A')
    modalSpies.confirm.mockResolvedValue(false)
    const { composable, scope } = mountComposable(makeInstall('a', 'A'))

    await composable.runAction({
      id: 'snapshot-restore',
      label: 'Restore Snapshot',
    } as ActionDef)

    expect(modalSpies.confirm).toHaveBeenCalledTimes(1)
    const callArg = modalSpies.confirm.mock.calls[0][0] as { message: string; title: string }
    expect(callArg.message).toBe('errors.willStopRunning')
    expect(callArg.title).toBe('Restore Snapshot')
    scope.stop()
  })

  it('does NOT prepend the warning when the install is not running', async () => {
    installMockApi()
    // No markRunning — sessionStore.isRunning('a') === false.
    modalSpies.confirm.mockResolvedValue(false)
    const { composable, scope } = mountComposable(makeInstall('a', 'A'))

    await composable.runAction({
      id: 'update-comfyui',
      label: 'Update ComfyUI',
      confirm: { title: 'Update?', message: 'This will pull the latest ComfyUI.' },
    } as ActionDef)

    expect(modalSpies.confirm).toHaveBeenCalledTimes(1)
    const callArg = modalSpies.confirm.mock.calls[0][0] as { message: string }
    expect(callArg.message).toBe('This will pull the latest ComfyUI.')
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
    modalSpies.confirm.mockResolvedValue(true)

    const onShowProgress = vi.fn()
    const { composable, scope } = mountComposable(makeInstall('a', 'A'), onShowProgress)

    await composable.runAction({
      id: 'update-comfyui',
      label: 'Update ComfyUI',
      showProgress: true,
      confirm: { message: 'Update?' },
    } as ActionDef)

    expect(onShowProgress).toHaveBeenCalledTimes(1)
    const opts = onShowProgress.mock.calls[0][0] as ShowProgressOpts
    // triggersInstanceStart reflects the relaunch that the apiCall will
    // append — ProgressModal needs it to wire up the instance-started
    // listener that closes the chooser host.
    expect(opts.triggersInstanceStart).toBe(true)

    // Invoke the closure-bound apiCall the way ProgressModal would.
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
    // Mirrors the e2e test install where the standalone source's
    // update-comfyui has no release metadata so it returns { ok: false } —
    // we must NOT relaunch on a failed update.
    const api = installMockApi({
      stopComfyUI: vi.fn().mockImplementation(async (id: string) => {
        useSessionStore().runningInstances.delete(id)
      }),
      runAction: vi.fn().mockResolvedValue({ ok: false, message: 'no update available' }),
    })
    markRunning('a', 'A')
    modalSpies.confirm.mockResolvedValue(true)
    const onShowProgress = vi.fn()
    const { composable, scope } = mountComposable(makeInstall('a', 'A'), onShowProgress)

    await composable.runAction({
      id: 'update-comfyui',
      label: 'Update ComfyUI',
      showProgress: true,
      confirm: { message: 'Update?' },
    } as ActionDef)

    const opts = onShowProgress.mock.calls[0][0] as ShowProgressOpts
    await opts.apiCall()

    expect(api.stopComfyUI).toHaveBeenCalledTimes(1)
    expect(api.runAction).toHaveBeenCalledTimes(1)
    expect(api.runAction).toHaveBeenCalledWith('a', 'update-comfyui', undefined)
    scope.stop()
  })

  it('REQUIRES_STOPPED-but-not-IN_PLACE_RELAUNCH apiCall stops and runs the op without an auto-relaunch (e.g. copy-update)', async () => {
    // copy / copy-update / release-update return a newInstallationId
    // that opens in its own window (FLOW 2) — the source install is
    // intentionally left stopped, so no relaunch.
    const api = installMockApi({
      stopComfyUI: vi.fn().mockImplementation(async (id: string) => {
        useSessionStore().runningInstances.delete(id)
      }),
      runAction: vi.fn().mockResolvedValue({ ok: true, newInstallationId: 'a-prime' }),
    })
    markRunning('a', 'A')
    modalSpies.confirm.mockResolvedValue(true)
    const onShowProgress = vi.fn()
    const { composable, scope } = mountComposable(makeInstall('a', 'A'), onShowProgress)

    await composable.runAction({
      id: 'copy-update',
      label: 'Copy & Update',
      showProgress: true,
      confirm: { message: 'Copy & update?' },
    } as ActionDef)

    const opts = onShowProgress.mock.calls[0][0] as ShowProgressOpts
    // No auto-relaunch wired in → triggersInstanceStart stays false; the
    // new install opens in its own chooser-host window instead.
    expect(opts.triggersInstanceStart).toBe(false)
    await opts.apiCall()

    expect(api.stopComfyUI).toHaveBeenCalledTimes(1)
    expect(api.runAction).toHaveBeenCalledTimes(1)
    expect(api.runAction).toHaveBeenCalledWith('a', 'copy-update', undefined)
    scope.stop()
  })

  it('apiCall does not stop or relaunch when the install is not running', async () => {
    // Wasn't running → nothing to stop, nothing to relaunch even for
    // IN_PLACE_RELAUNCH actions. Just invoke the op directly.
    const api = installMockApi({
      runAction: vi.fn().mockResolvedValue({ ok: true }),
    })
    modalSpies.confirm.mockResolvedValue(true)
    const onShowProgress = vi.fn()
    const { composable, scope } = mountComposable(makeInstall('a', 'A'), onShowProgress)

    await composable.runAction({
      id: 'update-comfyui',
      label: 'Update ComfyUI',
      showProgress: true,
      confirm: { message: 'Update?' },
    } as ActionDef)

    const opts = onShowProgress.mock.calls[0][0] as ShowProgressOpts
    expect(opts.triggersInstanceStart).toBe(false)
    await opts.apiCall()

    expect(api.stopComfyUI).not.toHaveBeenCalled()
    expect(api.runAction).toHaveBeenCalledTimes(1)
    expect(api.runAction).toHaveBeenCalledWith('a', 'update-comfyui', undefined)
    scope.stop()
  })

  it('inline (no showProgress) REQUIRES_STOPPED action self-stops before invoking the backend', async () => {
    // Inline path mirrors the showProgress path's self-stop so the
    // backend's running-check doesn't race the stop on a running install.
    const api = installMockApi({
      stopComfyUI: vi.fn().mockImplementation(async (id: string) => {
        useSessionStore().runningInstances.delete(id)
      }),
      runAction: vi.fn().mockResolvedValue({ ok: true }),
    })
    markRunning('a', 'A')
    modalSpies.confirm.mockResolvedValue(true)
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
