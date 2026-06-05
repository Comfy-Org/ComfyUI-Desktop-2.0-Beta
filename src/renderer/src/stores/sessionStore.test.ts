import { createTestingPinia } from '@pinia/testing'
import { setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useSessionStore } from './sessionStore'

describe('useSessionStore', () => {
  let store: ReturnType<typeof useSessionStore>

  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }))
    store = useSessionStore()
    vi.clearAllMocks()
  })

  describe('setActiveSession', () => {
    it('clears error for same installation id', () => {
      store.errorInstances.set('inst-1', { installationName: 'Test' })

      store.setActiveSession('inst-1', 'Label')

      expect(store.errorInstances.has('inst-1')).toBe(false)
    })
  })

  describe('clearActiveSession', () => {
    beforeEach(() => {
      store.setActiveSession('inst-1', 'Label 1')
      store.setActiveSession('inst-2', 'Label 2')
    })

    it('clears a specific session when id is provided', () => {
      store.clearActiveSession('inst-1')

      expect(store.activeSessions.has('inst-1')).toBe(false)
      expect(store.activeSessions.has('inst-2')).toBe(true)
    })

    it('clears all sessions when no id is provided', () => {
      store.clearActiveSession()

      expect(store.activeSessions.size).toBe(0)
    })
  })

  describe('clearErrorInstance', () => {
    it('deletes both the error instance and its session', () => {
      store.startSession('inst-1')
      store.errorInstances.set('inst-1', { installationName: 'Test' })

      store.clearErrorInstance('inst-1')

      expect(store.errorInstances.has('inst-1')).toBe(false)
      expect(store.sessions.has('inst-1')).toBe(false)
    })
  })

  describe('appendOutput', () => {
    it('appends text to an existing session', () => {
      store.startSession('inst-1')
      store.appendOutput('inst-1', 'hello ')
      store.appendOutput('inst-1', 'world')

      expect(store.getSession('inst-1')?.output).toBe('hello world')
    })

    it('creates a new session if one does not exist', () => {
      store.appendOutput('inst-1', 'auto-created')

      expect(store.hasSession('inst-1')).toBe(true)
      expect(store.getSession('inst-1')?.output).toBe('auto-created')
    })

    it('handles \\r by replacing the current line (tqdm-style)', () => {
      store.startSession('inst-1')
      store.appendOutput('inst-1', 'progress: 0%\rprogress: 50%')

      expect(store.getSession('inst-1')?.output).toBe('progress: 50%')
    })

    it('handles \\r after a newline, replacing only the last line', () => {
      store.startSession('inst-1')
      store.appendOutput('inst-1', 'line1\nline2\rprogress: 100%')

      expect(store.getSession('inst-1')?.output).toBe('line1\nprogress: 100%')
    })

    it('handles multiple \\r in sequence, keeping only the last segment', () => {
      store.startSession('inst-1')
      store.appendOutput('inst-1', 'a\rb\rc')

      expect(store.getSession('inst-1')?.output).toBe('c')
    })

    it('handles \\r across multiple appendOutput calls', () => {
      store.startSession('inst-1')
      store.appendOutput('inst-1', 'header\ndownloading: 0%')
      store.appendOutput('inst-1', '\rdownloading: 50%')
      store.appendOutput('inst-1', '\rdownloading: 100%')

      expect(store.getSession('inst-1')?.output).toBe('header\ndownloading: 100%')
    })

    it('preserves Windows CRLF line endings', () => {
      store.startSession('inst-1')
      store.appendOutput('inst-1', 'line1\r\nline2\r\nline3')

      expect(store.getSession('inst-1')?.output).toBe('line1\r\nline2\r\nline3')
    })

    it('ignores trailing bare \\r without deleting current line', () => {
      store.startSession('inst-1')
      store.appendOutput('inst-1', 'progress: 50%\r')

      expect(store.getSession('inst-1')?.output).toBe('progress: 50%')
    })
  })

  describe('runningTabCount', () => {
    it('sums both active sessions and running instances', () => {
      store.setActiveSession('inst-1', 'A')
      store.runningInstances.set('inst-2', {
        installationId: 'inst-2',
        installationName: 'Test',
        mode: 'run'
      })

      expect(store.runningTabCount).toBe(2)
    })
  })

  describe('hasErrors', () => {
    it('reflects whether error instances exist', () => {
      expect(store.hasErrors).toBe(false)

      store.errorInstances.set('inst-1', { installationName: 'Test' })

      expect(store.hasErrors).toBe(true)
    })
  })

  describe('launchingInstances', () => {
    it('isLaunching returns false when no instance is launching', () => {
      expect(store.isLaunching('inst-1')).toBe(false)
    })

    it('isLaunching returns true after adding to launchingInstances', () => {
      store.launchingInstances.set('inst-1', { installationName: 'Test' })

      expect(store.isLaunching('inst-1')).toBe(true)
    })

    it('isLaunching returns false after removing from launchingInstances', () => {
      store.launchingInstances.set('inst-1', { installationName: 'Test' })
      store.launchingInstances.delete('inst-1')

      expect(store.isLaunching('inst-1')).toBe(false)
    })
  })

  describe('init IPC event handling', () => {
    let handlers: Record<string, (data: unknown) => void>

    beforeEach(async () => {
      handlers = {}
      ;(window as Record<string, unknown>).api = {
        getRunningInstances: vi.fn().mockResolvedValue([]),
        getLaunchingInstances: vi.fn().mockResolvedValue([]),
        getStoppingInstances: vi.fn().mockResolvedValue([]),
        getCrashInstances: vi.fn().mockResolvedValue([]),
        onInstanceLaunching: vi.fn((cb: (data: unknown) => void) => {
          handlers['instance-launching'] = cb
          return () => {}
        }),
        onInstanceLaunchFailed: vi.fn((cb: (data: unknown) => void) => {
          handlers['instance-launch-failed'] = cb
          return () => {}
        }),
        onInstanceStarted: vi.fn((cb: (data: unknown) => void) => {
          handlers['instance-started'] = cb
          return () => {}
        }),
        onInstanceStopped: vi.fn((cb: (data: unknown) => void) => {
          handlers['instance-stopped'] = cb
          return () => {}
        }),
        onInstanceStopping: vi.fn((cb: (data: unknown) => void) => {
          handlers['instance-stopping'] = cb
          return () => {}
        }),
        onComfyOutput: vi.fn(() => () => {}),
        onComfyExited: vi.fn(() => () => {}),
        onInstanceCrashed: vi.fn((cb: (data: unknown) => void) => {
          handlers['instance-crashed'] = cb
          return () => {}
        }),
      }
      await store.init()
    })

    it('tracks launching instances via instance-launching event', () => {
      handlers['instance-launching']!({ installationId: 'inst-1', installationName: 'My Install' })

      expect(store.isLaunching('inst-1')).toBe(true)
      expect(store.launchingInstances.get('inst-1')?.installationName).toBe('My Install')
    })

    it('clears launching on instance-launch-failed event', () => {
      handlers['instance-launching']!({ installationId: 'inst-1', installationName: 'My Install' })
      handlers['instance-launch-failed']!({ installationId: 'inst-1' })

      expect(store.isLaunching('inst-1')).toBe(false)
    })

    it('transitions from launching to running on instance-started event', () => {
      handlers['instance-launching']!({ installationId: 'inst-1', installationName: 'My Install' })
      handlers['instance-started']!({
        installationId: 'inst-1',
        installationName: 'My Install',
        port: 8188,
        mode: 'window',
      })

      expect(store.isLaunching('inst-1')).toBe(false)
      expect(store.isRunning('inst-1')).toBe(true)
    })

    it('records an error from the broadcast instance-crashed event', () => {
      handlers['instance-crashed']!({
        installationId: 'inst-1',
        installationName: 'My Install',
        crashed: true,
        exitCode: 1,
        signal: undefined,
        lastStderr: 'boom',
        crashedAtMs: 123,
      })

      expect(store.errorInstances.has('inst-1')).toBe(true)
      const err = store.errorInstances.get('inst-1')
      expect(err?.installationName).toBe('My Install')
      expect(err?.exitCode).toBe(1)
      expect(err?.lastStderr).toBe('boom')
      expect(err?.crashedAtMs).toBe(123)
    })

    it('clears a prior error when the install is relaunched (instance-launching)', () => {
      store.errorInstances.set('inst-1', { installationName: 'My Install', exitCode: 1 })
      handlers['instance-launching']!({ installationId: 'inst-1', installationName: 'My Install' })

      expect(store.errorInstances.has('inst-1')).toBe(false)
    })

    it('clears a prior error when the install reaches running (instance-started)', () => {
      store.errorInstances.set('inst-1', { installationName: 'My Install', exitCode: 1 })
      handlers['instance-started']!({
        installationId: 'inst-1',
        installationName: 'My Install',
        port: 8188,
        mode: 'window',
      })

      expect(store.errorInstances.has('inst-1')).toBe(false)
    })
  })

  describe('init hydration', () => {
    function installApi(
      snapshots: { running?: unknown[]; launching?: unknown[]; stopping?: unknown[]; crashes?: unknown[] } = {},
    ): void {
      ;(window as Record<string, unknown>).api = {
        getRunningInstances: vi.fn().mockResolvedValue(snapshots.running ?? []),
        getLaunchingInstances: vi.fn().mockResolvedValue(snapshots.launching ?? []),
        getStoppingInstances: vi.fn().mockResolvedValue(snapshots.stopping ?? []),
        getCrashInstances: vi.fn().mockResolvedValue(snapshots.crashes ?? []),
        onInstanceLaunching: vi.fn(() => () => {}),
        onInstanceLaunchFailed: vi.fn(() => () => {}),
        onInstanceStarted: vi.fn(() => () => {}),
        onInstanceStopped: vi.fn(() => () => {}),
        onInstanceStopping: vi.fn(() => () => {}),
        onComfyOutput: vi.fn(() => () => {}),
        onComfyExited: vi.fn(() => () => {}),
        onInstanceCrashed: vi.fn(() => () => {}),
      }
    }

    it('hydrates in-flight launches so a window opened mid-launch shows the launching state', async () => {
      installApi({ launching: [{ installationId: 'inst-1', installationName: 'My Install' }] })

      await store.init()

      expect(store.isLaunching('inst-1')).toBe(true)
      expect(store.launchingInstances.get('inst-1')?.installationName).toBe('My Install')
    })

    it('does not re-mark an install as launching when it already hydrated as running', async () => {
      installApi({
        running: [{ installationId: 'inst-1', installationName: 'My Install', port: 8188, mode: 'window' }],
        launching: [{ installationId: 'inst-1', installationName: 'My Install' }],
      })

      await store.init()

      expect(store.isRunning('inst-1')).toBe(true)
      expect(store.isLaunching('inst-1')).toBe(false)
    })

    it('hydrates in-flight stops so a window opened mid-stop shows the stopping state', async () => {
      installApi({ stopping: ['inst-1'] })

      await store.init()

      expect(store.isStopping('inst-1')).toBe(true)
    })

    it('hydrates retained crashes so a freshly-opened window shows the error state', async () => {
      installApi({
        crashes: [
          {
            installationId: 'inst-1',
            installationName: 'My Install',
            crashed: true,
            exitCode: 1,
            lastStderr: 'boom',
            crashedAtMs: 123,
          },
        ],
      })

      await store.init()

      expect(store.errorInstances.has('inst-1')).toBe(true)
      const err = store.errorInstances.get('inst-1')
      expect(err?.installationName).toBe('My Install')
      expect(err?.exitCode).toBe(1)
      expect(err?.lastStderr).toBe('boom')
    })

    it('does not hydrate a crash for an install that is mid-launch', async () => {
      installApi({
        launching: [{ installationId: 'inst-1', installationName: 'My Install' }],
        crashes: [{ installationId: 'inst-1', installationName: 'My Install', crashed: true, exitCode: 1 }],
      })

      await store.init()

      expect(store.isLaunching('inst-1')).toBe(true)
      expect(store.errorInstances.has('inst-1')).toBe(false)
    })

    it('does not hydrate a crash for an install that is already running', async () => {
      installApi({
        running: [{ installationId: 'inst-1', installationName: 'My Install', port: 8188, mode: 'window' }],
        crashes: [{ installationId: 'inst-1', installationName: 'My Install', crashed: true, exitCode: 1 }],
      })

      await store.init()

      expect(store.isRunning('inst-1')).toBe(true)
      expect(store.errorInstances.has('inst-1')).toBe(false)
    })

    it('tolerates a preload without the snapshot hydration methods', async () => {
      ;(window as Record<string, unknown>).api = {
        getRunningInstances: vi.fn().mockResolvedValue([]),
        onInstanceLaunching: vi.fn(() => () => {}),
        onInstanceLaunchFailed: vi.fn(() => () => {}),
        onInstanceStarted: vi.fn(() => () => {}),
        onInstanceStopped: vi.fn(() => () => {}),
        onInstanceStopping: vi.fn(() => () => {}),
        onComfyOutput: vi.fn(() => () => {}),
        onComfyExited: vi.fn(() => () => {}),
        onInstanceCrashed: vi.fn(() => () => {}),
      }

      await expect(store.init()).resolves.toBeUndefined()
      expect(store.launchingInstances.size).toBe(0)
      expect(store.stoppingInstances.size).toBe(0)
      expect(store.errorInstances.size).toBe(0)
    })
  })
})
