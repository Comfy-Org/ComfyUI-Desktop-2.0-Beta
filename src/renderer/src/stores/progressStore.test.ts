import { createTestingPinia } from '@pinia/testing'
import { setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ActionResult } from '../types/ipc'
import type * as TelemetryModule from '../lib/telemetry'
import { useProgressStore } from './progressStore'
import { useSessionStore } from './sessionStore'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key
  })
}))

// progressStore now emits `comfy.desktop.op.result` via `emitTelemetryAction`,
// which dispatches a CustomEvent on `window`. The `vi.stubGlobal('window',
// …)` below replaces window with a plain object that drops prototype
// methods like `dispatchEvent`, so stub the telemetry helper out — these
// tests cover op lifecycle, not telemetry dispatch. `toErrorBucket` is
// kept real (pure function used inside the store's emit path).
vi.mock('../lib/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof TelemetryModule>()),
  emitTelemetryAction: vi.fn()
}))

vi.stubGlobal('window', {
  ...window,
  api: {
    getInstallations: vi.fn().mockResolvedValue([]),
    onInstallationsChanged: vi.fn(),
    onInstallationsVersionsUpdated: vi.fn(),
    onInstallProgress: vi.fn(() => vi.fn()),
    onComfyOutput: vi.fn(() => vi.fn()),
    logsSnapshot: vi.fn().mockResolvedValue(''),
    cancelOperation: vi.fn(),
    stopComfyUI: vi.fn(),
    getRunningInstances: vi.fn().mockResolvedValue([]),
    onInstanceStarted: vi.fn(() => vi.fn()),
    onInstanceStopped: vi.fn(() => vi.fn()),
    onComfyExited: vi.fn(() => vi.fn()),
    onErrorDetail: vi.fn(() => vi.fn())
  }
})

describe('useProgressStore', () => {
  let store: ReturnType<typeof useProgressStore>
  let sessionStore: ReturnType<typeof useSessionStore>

  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }))
    store = useProgressStore()
    sessionStore = useSessionStore()
    vi.clearAllMocks()
  })

  describe('getProgressInfo', () => {
    it('returns null when no operation exists', () => {
      expect(store.getProgressInfo('inst-1')).toBeNull()
    })

    it('returns null when operation is finished', async () => {
      const apiCall = vi.fn().mockResolvedValue({ ok: true } as ActionResult)
      store.startOperation({
        installationId: 'inst-1',
        title: 'Install',
        apiCall
      })

      await vi.waitFor(() => {
        expect(store.operations.get('inst-1')?.finished).toBe(true)
      })

      expect(store.getProgressInfo('inst-1')).toBeNull()
    })

    it('returns flat status and percent when no steps defined', () => {
      const apiCall = () => new Promise<ActionResult>(() => { }) // never resolves
      store.startOperation({
        installationId: 'inst-1',
        title: 'Install',
        apiCall
      })

      const op = store.operations.get('inst-1')!
      op.flatStatus = 'Downloading...'
      op.flatPercent = 42

      const info = store.getProgressInfo('inst-1')
      expect(info).toEqual({ status: 'Downloading...', percent: 42 })
    })

    it('returns step-based status when steps and activePhase are set', () => {
      const apiCall = () => new Promise<ActionResult>(() => { })
      store.startOperation({
        installationId: 'inst-1',
        title: 'Install',
        apiCall
      })

      const op = store.operations.get('inst-1')!
      op.steps = [
        { phase: 'download', label: 'Download' },
        { phase: 'extract', label: 'Extract' }
      ]
      op.activePhase = 'download'
      op.lastStatus['download'] = 'Fetching files...'
      op.activePercent = 75

      const info = store.getProgressInfo('inst-1')
      expect(info).toEqual({ status: 'Fetching files...', percent: 75 })
    })

    it('falls back to step label, not the raw phase id, when lastStatus has no entry', () => {
      const apiCall = () => new Promise<ActionResult>(() => { })
      store.startOperation({
        installationId: 'inst-1',
        title: 'Install',
        apiCall
      })

      const op = store.operations.get('inst-1')!
      op.steps = [{ phase: 'download', label: 'Download' }]
      op.activePhase = 'download'
      op.activePercent = 0

      // Without an explicit status string from main, ambient consumers
      // should see the registered step label rather than the dev-y phase
      // slug. Phase id only surfaces when no label exists either.
      const info = store.getProgressInfo('inst-1')
      expect(info).toEqual({ status: 'Download', percent: 0 })
    })

    it('falls back to title when flatStatus is empty', () => {
      const apiCall = () => new Promise<ActionResult>(() => { })
      store.startOperation({
        installationId: 'inst-1',
        title: 'Install',
        apiCall
      })

      const op = store.operations.get('inst-1')!
      op.flatStatus = ''

      const info = store.getProgressInfo('inst-1')
      expect(info?.status).toBe('Install')
    })
  })

  describe('startOperation', () => {
    it('clears a pre-existing error instance for the same installation', () => {
      sessionStore.startSession('inst-1')
      sessionStore.errorInstances.set('inst-1', {
        installationName: 'Test',
        message: 'previous failure'
      })

      store.startOperation({
        installationId: 'inst-1',
        title: 'Delete',
        apiCall: () => new Promise<ActionResult>(() => { })
      })

      expect(sessionStore.errorInstances.has('inst-1')).toBe(false)
    })

    it('creates an operation and sets up session', () => {
      const apiCall = () => new Promise<ActionResult>(() => { })
      store.startOperation({
        installationId: 'inst-1',
        title: 'Install ComfyUI',
        apiCall
      })

      expect(store.operations.has('inst-1')).toBe(true)
      const op = store.operations.get('inst-1')!
      expect(op.title).toBe('Install ComfyUI')
      expect(op.finished).toBe(false)
      expect(op.error).toBeNull()
    })

    it('subscribes to progress and output IPC', () => {
      const apiCall = () => new Promise<ActionResult>(() => { })
      store.startOperation({
        installationId: 'inst-1',
        title: 'Install',
        apiCall
      })

      expect(window.api.onInstallProgress).toHaveBeenCalled()
      expect(window.api.onComfyOutput).toHaveBeenCalled()
    })

    it('marks operation finished with error on apiCall rejection', async () => {
      const apiCall = vi.fn().mockRejectedValue(new Error('Network failure'))
      store.startOperation({
        installationId: 'inst-1',
        title: 'Install',
        apiCall
      })

      await vi.waitFor(() => {
        expect(store.operations.get('inst-1')?.finished).toBe(true)
      })

      const op = store.operations.get('inst-1')!
      expect(op.error).toBe('Network failure')
    })

    it('marks operation finished on successful apiCall', async () => {
      const apiCall = vi.fn().mockResolvedValue({ ok: true } as ActionResult)
      store.startOperation({
        installationId: 'inst-1',
        title: 'Install',
        apiCall
      })

      await vi.waitFor(() => {
        expect(store.operations.get('inst-1')?.finished).toBe(true)
      })

      const op = store.operations.get('inst-1')!
      expect(op.error).toBeNull()
      expect(op.result).toEqual({ ok: true })
    })

    it('sets error on non-ok result', async () => {
      const apiCall = vi
        .fn()
        .mockResolvedValue({ ok: false, message: 'Bad config' } as ActionResult)
      store.startOperation({
        installationId: 'inst-1',
        title: 'Install',
        apiCall
      })

      await vi.waitFor(() => {
        expect(store.operations.get('inst-1')?.finished).toBe(true)
      })

      const op = store.operations.get('inst-1')!
      expect(op.error).toBe('Bad config')
      expect(sessionStore.errorInstances.has('inst-1')).toBe(true)
    })

    it('does not set error on cancelled result', async () => {
      const apiCall = vi.fn().mockResolvedValue({ ok: false, cancelled: true } as ActionResult)
      store.startOperation({
        installationId: 'inst-1',
        title: 'Launch',
        apiCall
      })

      await vi.waitFor(() => {
        expect(store.operations.get('inst-1')?.finished).toBe(true)
      })

      const op = store.operations.get('inst-1')!
      expect(op.error).toBeNull()
      expect(op.result?.cancelled).toBe(true)
      expect(sessionStore.errorInstances.has('inst-1')).toBe(false)
    })

    it('clears active session on cancellation', async () => {
      const apiCall = vi.fn().mockResolvedValue({ ok: false, cancelled: true } as ActionResult)
      store.startOperation({
        installationId: 'inst-1',
        title: 'Launch',
        apiCall
      })

      await vi.waitFor(() => {
        expect(store.operations.get('inst-1')?.finished).toBe(true)
      })

      expect(sessionStore.activeSessions.has('inst-1')).toBe(false)
    })

    it('cleans up previous operation for same installationId', () => {
      const unsub1 = vi.fn()
      vi.mocked(window.api.onInstallProgress).mockReturnValueOnce(unsub1)

      store.startOperation({
        installationId: 'inst-1',
        title: 'First',
        apiCall: () => new Promise<ActionResult>(() => { })
      })

      store.startOperation({
        installationId: 'inst-1',
        title: 'Second',
        apiCall: () => new Promise<ActionResult>(() => { })
      })

      expect(store.operations.get('inst-1')?.title).toBe('Second')
    })

    it('sets result on port conflict without error', async () => {
      const portConflictInfo = { port: 8188, pids: [123], isComfy: true }
      const apiCall = vi
        .fn()
        .mockResolvedValue({ ok: false, portConflict: portConflictInfo } as ActionResult)
      store.startOperation({
        installationId: 'inst-1',
        title: 'Launch',
        apiCall
      })

      await vi.waitFor(() => {
        expect(store.operations.get('inst-1')?.finished).toBe(true)
      })

      const op = store.operations.get('inst-1')!
      expect(op.error).toBeNull()
      expect(op.result?.portConflict).toEqual(portConflictInfo)
      expect(sessionStore.errorInstances.has('inst-1')).toBe(false)
    })

    it('handles synchronous apiCall throw', () => {
      const apiCall = () => {
        throw new Error('Sync boom')
      }
      store.startOperation({
        installationId: 'inst-1',
        title: 'Install',
        apiCall: apiCall as unknown as () => Promise<ActionResult>
      })

      const op = store.operations.get('inst-1')!
      expect(op.error).toBe('Sync boom')
      expect(op.finished).toBe(true)
    })
  })

  describe('cancelOperation', () => {
    it('sets cancelRequested and calls IPC cancel/stop', () => {
      store.startOperation({
        installationId: 'inst-1',
        title: 'Install',
        apiCall: () => new Promise<ActionResult>(() => { })
      })

      store.cancelOperation('inst-1')

      const op = store.operations.get('inst-1')!
      expect(op.cancelRequested).toBe(true)
      expect(window.api.cancelOperation).toHaveBeenCalledWith('inst-1')
      expect(window.api.stopComfyUI).toHaveBeenCalledWith('inst-1')
    })

    it('is safe to cancel a nonexistent operation', () => {
      expect(() => store.cancelOperation('nonexistent')).not.toThrow()
    })

    it('does NOT stop ComfyUI when the op has already finished', async () => {
      // Silent takeover→takeover overlay swaps fire `onCancel`
      // indiscriminately. Stopping ComfyUI for a finished op would tear
      // down the relaunched session (or the next op's session).
      let resolve: ((value: ActionResult) => void) | null = null
      store.startOperation({
        installationId: 'inst-1',
        title: 'Install',
        apiCall: () =>
          new Promise<ActionResult>((r) => {
            resolve = r
          })
      })
      resolve!({ ok: true })
      await Promise.resolve()
      await Promise.resolve()
      const op = store.operations.get('inst-1')!
      expect(op.finished).toBe(true)

      vi.mocked(window.api.stopComfyUI).mockClear()
      vi.mocked(window.api.cancelOperation).mockClear()
      store.cancelOperation('inst-1')

      expect(window.api.stopComfyUI).not.toHaveBeenCalled()
      expect(window.api.cancelOperation).not.toHaveBeenCalled()
      expect(op.cancelRequested).toBe(false)
    })
  })

  describe('onErrorDetail subscription', () => {
    it('does not throw at construction when window.api.onErrorDetail is undefined', () => {
      // The picker popup's `window.api` shim does not forward
      // `onErrorDetail` (it's a panel-side IPC subscription, not a
      // shim-routed call). A hard call would throw at store
      // construction and silently blank the entire
      // ComfyUISettingsContent right pane.
      const orig = window.api.onErrorDetail
      // @ts-expect-error — testing the missing-method case the shim hits.
      window.api.onErrorDetail = undefined
      try {
        setActivePinia(createTestingPinia({ stubActions: false }))
        expect(() => useProgressStore()).not.toThrow()
      } finally {
        window.api.onErrorDetail = orig
      }
    })
  })

  describe('cleanupOperation', () => {
    it('calls unsubscribe functions', () => {
      const unsubProgress = vi.fn()
      const unsubOutput = vi.fn()
      vi.mocked(window.api.onInstallProgress).mockReturnValueOnce(unsubProgress)
      vi.mocked(window.api.onComfyOutput).mockReturnValueOnce(unsubOutput)

      store.startOperation({
        installationId: 'inst-1',
        title: 'Install',
        apiCall: () => new Promise<ActionResult>(() => { })
      })

      store.cleanupOperation('inst-1')

      expect(unsubProgress).toHaveBeenCalled()
      expect(unsubOutput).toHaveBeenCalled()
    })

    it('is safe to cleanup a nonexistent operation', () => {
      expect(() => store.cleanupOperation('nonexistent')).not.toThrow()
    })
  })

  describe('Operation.chainSpan', () => {
    it('persists chainSpan on the Operation when set', () => {
      store.startOperation({
        installationId: 'inst-1',
        title: 'Installing — DevFixture',
        apiCall: () => new Promise<ActionResult>(() => { }),
        chainSpan: 'install'
      })
      expect(store.operations.get('inst-1')?.chainSpan).toBe('install')
    })

    it('persists chainSpan=launch for the launch leg of a chain', () => {
      store.startOperation({
        installationId: 'inst-2',
        title: 'Launching — DevFixture',
        apiCall: () => new Promise<ActionResult>(() => { }),
        chainSpan: 'launch'
      })
      expect(store.operations.get('inst-2')?.chainSpan).toBe('launch')
    })

    it('defaults chainSpan to null when omitted', () => {
      store.startOperation({
        installationId: 'inst-3',
        title: 'Standalone op',
        apiCall: () => new Promise<ActionResult>(() => { })
      })
      // null (not undefined) so the Operation literal stays well-typed.
      expect(store.operations.get('inst-3')?.chainSpan).toBeNull()
    })

    it('seeds the launch leg terminalOutput from logsSnapshot (log continuity)', async () => {
      vi.mocked(window.api.logsSnapshot).mockResolvedValueOnce('install-leg lines\n')
      store.startOperation({
        installationId: 'inst-snap',
        title: 'Launching',
        apiCall: () => new Promise<ActionResult>(() => { }),
        chainSpan: 'launch'
      })
      expect(window.api.logsSnapshot).toHaveBeenCalledWith('inst-snap')
      await Promise.resolve() // let the snapshot promise + its .then settle
      await Promise.resolve()
      expect(store.operations.get('inst-snap')?.terminalOutput).toBe('install-leg lines\n')
    })

    it('does not seed from logsSnapshot for a non-launch op', () => {
      vi.mocked(window.api.logsSnapshot).mockClear()
      store.startOperation({
        installationId: 'inst-nosnap',
        title: 'Install',
        apiCall: () => new Promise<ActionResult>(() => { }),
        chainSpan: 'install'
      })
      expect(window.api.logsSnapshot).not.toHaveBeenCalled()
    })

    it('caps the install leg of a chain at 0–70% of the continuous bar', () => {
      // globalProgressFor now folds the install/launch split in directly: a
      // chainSpan='install' op fills 0–70 (reserving 70–100 for the launch
      // leg) so the two legs read as one continuous bar.
      store.startOperation({
        installationId: 'inst-4',
        title: 'Installing',
        apiCall: () => new Promise<ActionResult>(() => { }),
        chainSpan: 'install'
      })
      const op = store.operations.get('inst-4')!
      op.steps = [
        { phase: 'download', label: 'Download' },
        { phase: 'extract', label: 'Extract' }
      ]
      op.activePhase = 'download'
      op.activePercent = 50

      const result = store.globalProgressFor(op)
      expect(result.percent).toBeGreaterThan(0)
      expect(result.percent).toBeLessThan(70)
      expect(result.indeterminate).toBe(false)
    })

    it('a finished+ok install leg reports 70, not 100 (chain hands off to launch)', () => {
      // The install leg completing is NOT the end of the journey — capping it
      // at the 70% boundary stops the bar flashing full before the launch leg
      // ("Starting ComfyUI") takes over.
      store.startOperation({
        installationId: 'inst-5',
        title: 'Installing',
        apiCall: () => new Promise<ActionResult>(() => { }),
        chainSpan: 'install'
      })
      const op = store.operations.get('inst-5')!
      op.steps = [{ phase: 'download', label: 'Download' }]
      op.finished = true
      op.result = { ok: true } as ActionResult

      expect(store.globalProgressFor(op).percent).toBe(70)
    })

    it('a finished+ok standalone op reports 100', () => {
      store.startOperation({
        installationId: 'inst-6',
        title: 'Updating',
        apiCall: () => new Promise<ActionResult>(() => { })
      })
      const op = store.operations.get('inst-6')!
      op.finished = true
      op.result = { ok: true } as ActionResult

      expect(store.globalProgressFor(op).percent).toBe(100)
    })
  })
})
