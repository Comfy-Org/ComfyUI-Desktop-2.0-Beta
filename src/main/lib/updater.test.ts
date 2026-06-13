import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let mockPlatform = 'linux'
let mockAppImage: string | undefined
let mockIsPackaged = true
let mockExePath = '/opt/Comfy Desktop/comfyui-desktop-2'
let mockAppVersion = '1.0.0'

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mockIsPackaged
    },
    getPath: (name: string) => {
      if (name === 'exe') return mockExePath
      return ''
    },
    getVersion: () => mockAppVersion,
    releaseSingleInstanceLock: vi.fn()
  },
  ipcMain: {
    handle: vi.fn()
  },
  BrowserWindow: {
    getAllWindows: () => []
  }
}))

vi.mock('@todesktop/runtime', () => ({
  default: { autoUpdater: null }
}))

vi.mock('electron-updater', () => ({
  autoUpdater: { autoInstallOnAppQuit: true }
}))

vi.mock('../settings', () => ({
  get: vi.fn(),
  set: vi.fn()
}))

vi.mock('./quit-state', () => ({
  clearQuitReason: vi.fn(),
  setQuitReason: vi.fn(),
  isSessionEnding: vi.fn(() => false)
}))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

describe('isSystemPackageInstall (via get-update-capabilities)', () => {
  let registeredHandlers: Record<string, (...args: unknown[]) => unknown>

  beforeEach(async () => {
    registeredHandlers = {}
    const { ipcMain } = await import('electron')
    vi.mocked(ipcMain.handle).mockImplementation(((
      channel: string,
      handler: (...args: unknown[]) => unknown
    ) => {
      registeredHandlers[channel] = handler
    }) as typeof ipcMain.handle)

    mockPlatform = 'linux'
    mockAppImage = undefined
    mockIsPackaged = true
    mockExePath = '/opt/Comfy Desktop/comfyui-desktop-2'

    delete process.env.APPIMAGE
    Object.defineProperty(process, 'platform', { value: mockPlatform, configurable: true })

    vi.resetModules()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
  })

  async function getCapabilities(): Promise<{ canAutoUpdate: boolean; systemManaged: boolean }> {
    Object.defineProperty(process, 'platform', { value: mockPlatform, configurable: true })
    if (mockAppImage) {
      process.env.APPIMAGE = mockAppImage
    } else {
      delete process.env.APPIMAGE
    }

    vi.resetModules()
    const updater = await import('./updater')
    updater.register()
    const handler = registeredHandlers['get-update-capabilities']!
    return handler() as { canAutoUpdate: boolean; systemManaged: boolean }
  }

  it('detects .deb install under /opt/', async () => {
    mockExePath = '/opt/Comfy Desktop/comfyui-desktop-2'
    const caps = await getCapabilities()
    expect(caps).toEqual({ canAutoUpdate: false, systemManaged: true })
  })

  it('detects .deb install under /usr/', async () => {
    mockExePath = '/usr/lib/comfyui-desktop-2/comfyui-desktop-2'
    const caps = await getCapabilities()
    expect(caps).toEqual({ canAutoUpdate: false, systemManaged: true })
  })

  it('returns standard for AppImage (APPIMAGE env set)', async () => {
    mockAppImage = '/home/user/Comfy-Desktop.AppImage'
    const caps = await getCapabilities()
    expect(caps).toEqual({ canAutoUpdate: true, systemManaged: false })
  })

  it('returns standard for Windows', async () => {
    mockPlatform = 'win32'
    const caps = await getCapabilities()
    expect(caps).toEqual({ canAutoUpdate: true, systemManaged: false })
  })

  it('returns standard for macOS', async () => {
    mockPlatform = 'darwin'
    const caps = await getCapabilities()
    expect(caps).toEqual({ canAutoUpdate: true, systemManaged: false })
  })

  it('returns standard when not packaged (dev mode)', async () => {
    mockIsPackaged = false
    const caps = await getCapabilities()
    expect(caps).toEqual({ canAutoUpdate: true, systemManaged: false })
  })

  it('returns standard for Linux exe under /home/ (manual extract)', async () => {
    mockExePath = '/home/user/apps/comfyui-desktop-2'
    const caps = await getCapabilities()
    expect(caps).toEqual({ canAutoUpdate: true, systemManaged: false })
  })

  it('returns standard for Linux exe under /tmp/ (temp location)', async () => {
    mockExePath = '/tmp/.mount_comfyui/comfyui-desktop-2'
    const caps = await getCapabilities()
    expect(caps).toEqual({ canAutoUpdate: true, systemManaged: false })
  })
})

/**
 * Regression guard for the 2026-06-02 volume incident: PostHog received
 * ~3M of each of `comfy.desktop.app_update.{available, download_started,
 * download_complete}` in 24h across ~27 users, traced to (a) a
 * recursive `runCheck('auto-download')` call inside the
 * `update-available` handler and (b) the underlying updater re-firing
 * `update-available` / `update-downloaded` on every periodic check. The
 * fix introduced a `(event-name × version)` dedup map and dropped the
 * recursive `runCheck`. These tests pin both pieces of the contract.
 */
describe('app-update telemetry dedup (volume regression)', () => {
  let emitTelemetryMock: ReturnType<typeof vi.fn>
  let listeners: Record<string, Array<(...args: unknown[]) => void>>
  let fakeUpdater: { on: typeof vi.fn; checkForUpdates: ReturnType<typeof vi.fn> }
  let isAutoInstallOn: boolean

  beforeEach(async () => {
    vi.resetModules()
    listeners = {}
    emitTelemetryMock = vi.fn()
    isAutoInstallOn = true
    fakeUpdater = {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        listeners[event] = listeners[event] || []
        listeners[event].push(cb)
      }) as unknown as typeof vi.fn,
      checkForUpdates: vi.fn(async () => ({ updateInfo: { version: 'unused' } }))
    }
    vi.doMock('@todesktop/runtime', () => ({ default: { autoUpdater: fakeUpdater } }))
    vi.doMock('./telemetry', () => ({
      emit: emitTelemetryMock,
      bucketError: (s: string) => s
    }))
    vi.doMock('../settings', () => ({
      get: vi.fn((key: string) => (key === 'autoInstallUpdates' ? isAutoInstallOn : undefined))
    }))
  })

  function fire(eventName: string, payload: unknown): void {
    for (const cb of listeners[eventName] || []) cb(payload)
  }

  it('emits comfy.desktop.app_update.available at most once per version (auto-on)', async () => {
    const updater = await import('./updater')
    updater.register()

    fire('update-available', { version: '9.9.9' })
    fire('update-available', { version: '9.9.9' })
    fire('update-available', { version: '9.9.9' })

    const availableEmits = emitTelemetryMock.mock.calls.filter(
      (c) => c[0] === 'comfy.desktop.app_update.available'
    )
    expect(availableEmits).toHaveLength(1)
    expect(availableEmits[0]?.[1]).toMatchObject({ version: '9.9.9', auto_update_setting: 'on' })
  })

  it('emits download_started at most once per version (auto-on)', async () => {
    const updater = await import('./updater')
    updater.register()

    fire('update-available', { version: '9.9.9' })
    fire('update-downloaded', { version: '9.9.9' })
    fire('update-available', { version: '9.9.9' })
    fire('update-available', { version: '9.9.9' })

    const downloadStartedEmits = emitTelemetryMock.mock.calls.filter(
      (c) => c[0] === 'comfy.desktop.app_update.download_started'
    )
    expect(downloadStartedEmits).toHaveLength(1)
  })

  it('emits download_complete at most once per version even if updater re-fires', async () => {
    const updater = await import('./updater')
    updater.register()

    fire('update-downloaded', { version: '9.9.9' })
    fire('update-downloaded', { version: '9.9.9' })
    fire('update-downloaded', { version: '9.9.9' })

    const completeEmits = emitTelemetryMock.mock.calls.filter(
      (c) => c[0] === 'comfy.desktop.app_update.download_complete'
    )
    expect(completeEmits).toHaveLength(1)
  })

  it('does NOT call checkForUpdates from inside update-available (no recursion)', async () => {
    const updater = await import('./updater')
    updater.register()

    fire('update-available', { version: '9.9.9' })
    fire('update-available', { version: '9.9.9' })

    // The pre-fix bug: `runCheck('auto-download')` inside the
    // update-available handler called `updater.checkForUpdates`
    // recursively. Post-fix the handler relies on electron-updater's
    // default `autoDownload: true` and never re-enters. Pinning this:
    // no auto-download trigger means no checkForUpdates call from the
    // handler path.
    expect(fakeUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('new version after old can fire again (dedup is per-version, not absolute)', async () => {
    const updater = await import('./updater')
    updater.register()

    fire('update-available', { version: '9.9.9' })
    fire('update-available', { version: '9.9.10' })
    fire('update-downloaded', { version: '9.9.9' })
    fire('update-downloaded', { version: '9.9.10' })

    const availableEmits = emitTelemetryMock.mock.calls.filter(
      (c) => c[0] === 'comfy.desktop.app_update.available'
    )
    const completeEmits = emitTelemetryMock.mock.calls.filter(
      (c) => c[0] === 'comfy.desktop.app_update.download_complete'
    )
    expect(availableEmits).toHaveLength(2)
    expect(completeEmits).toHaveLength(2)
  })

  it('checked event suppressed for auto-* triggers (no signal, only noise)', async () => {
    fakeUpdater.checkForUpdates = vi.fn(async () => ({ updateInfo: { version: '9.9.9' } }))
    const updater = await import('./updater')
    updater.register()

    await updater.runCheck('auto-check')

    const checkedEmits = emitTelemetryMock.mock.calls.filter(
      (c) => c[0] === 'comfy.desktop.app_update.checked'
    )
    expect(checkedEmits).toHaveLength(0)
  })

  it('checked event fires for manual-check trigger when an update is available', async () => {
    fakeUpdater.checkForUpdates = vi.fn(async () => ({ updateInfo: { version: '9.9.9' } }))
    const updater = await import('./updater')
    updater.register()

    await updater.runCheck('manual-check')

    const checkedEmits = emitTelemetryMock.mock.calls.filter(
      (c) => c[0] === 'comfy.desktop.app_update.checked'
    )
    expect(checkedEmits).toHaveLength(1)
    expect(checkedEmits[0]?.[1]).toMatchObject({ trigger: 'manual-check', result: 'available' })
  })
})

/**
 * Issue #1065 — install staged Desktop updates at startup (Option C) instead of
 * silently on quit, and never spawn the installer while the OS session is
 * ending. Installing on quit is what a Windows shutdown interrupts mid-write,
 * corrupting the install and forcing endless reinstalls.
 */
describe('startup update install + session-end guard (issue #1065)', () => {
  let settingsStore: Record<string, unknown>
  let listeners: Record<string, Array<(...args: unknown[]) => void>>
  let fakeUpdater: {
    on: ReturnType<typeof vi.fn>
    checkForUpdates: ReturnType<typeof vi.fn>
    restartAndInstall: ReturnType<typeof vi.fn>
  }
  let electronUpdaterMock: { autoInstallOnAppQuit: boolean }
  let emitMock: ReturnType<typeof vi.fn>
  let sessionEnding: boolean
  let readyVersion: string | null

  const originalPlat = Object.getOwnPropertyDescriptor(process, 'platform')!

  beforeEach(() => {
    vi.resetModules()
    settingsStore = {}
    // These tests exercise the gated "Option C" startup-install path, so enable
    // the local flag. Individual default-mode tests delete it.
    settingsStore['installUpdatesOnStartup'] = true
    listeners = {}
    sessionEnding = false
    readyVersion = null
    mockAppVersion = '1.0.0'
    delete process.env.E2E
    // Non-system, non-darwin platform so isSystemPackageInstall() is false and
    // installUpdate() skips the darwin single-instance-lock dance.
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

    fakeUpdater = {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        listeners[event] = listeners[event] || []
        listeners[event].push(cb)
      }) as ReturnType<typeof vi.fn>,
      // Mimic the ToDesktop wrapper: a successful check of an already-downloaded
      // update re-emits `update-downloaded`, which flips state to 'ready'.
      checkForUpdates: vi.fn(async () => {
        if (readyVersion) {
          for (const cb of listeners['update-downloaded'] || []) cb({ version: readyVersion })
          return { updateInfo: { version: readyVersion } }
        }
        return { updateInfo: null }
      }),
      restartAndInstall: vi.fn()
    }
    electronUpdaterMock = { autoInstallOnAppQuit: true }
    emitMock = vi.fn()

    vi.doMock('@todesktop/runtime', () => ({ default: { autoUpdater: fakeUpdater } }))
    vi.doMock('electron-updater', () => ({ autoUpdater: electronUpdaterMock }))
    vi.doMock('./telemetry', () => ({ emit: emitMock, bucketError: (s: string) => s }))
    vi.doMock('./quit-state', () => ({
      clearQuitReason: vi.fn(),
      setQuitReason: vi.fn(),
      isSessionEnding: vi.fn(() => sessionEnding)
    }))
    vi.doMock('../settings', () => ({
      get: vi.fn((key: string) => settingsStore[key]),
      set: vi.fn((key: string, value: unknown) => {
        if (value === undefined) delete settingsStore[key]
        else settingsStore[key] = value
      })
    }))
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlat)
  })

  /** All `emit()` telemetry calls recorded for a given event name. Shared so the
   *  assertions can't drift apart on the filter predicate. */
  const findEmitCalls = (event: string): unknown[][] =>
    emitMock.mock.calls.filter((c) => c[0] === event)

  it('register() leaves install-on-quit enabled by default (Option B)', async () => {
    delete settingsStore['installUpdatesOnStartup']
    const updater = await import('./updater')
    updater.register()
    // Default mode keeps electron-updater's install-on-quit; it's only suppressed
    // when the OS session ends (see suppressInstallOnQuit).
    expect(electronUpdaterMock.autoInstallOnAppQuit).toBe(true)
  })

  it('register() disables install-on-quit when the startup-install flag is on (Option C)', async () => {
    const updater = await import('./updater')
    updater.register()
    expect(electronUpdaterMock.autoInstallOnAppQuit).toBe(false)
  })

  it('startup install is inert on non-Windows even when the flag is on', async () => {
    // macOS (Squirrel.Mac / ShipIt) and Linux don't have the NSIS shutdown
    // corruption, so Option C must stay off there regardless of the setting.
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    settingsStore['installUpdatesOnStartup'] = true
    settingsStore['pendingDownloadedUpdateVersion'] = '1.0.1'
    readyVersion = '1.0.1'
    const updater = await import('./updater')
    updater.register()
    // register() must NOT disable install-on-quit on macOS.
    expect(electronUpdaterMock.autoInstallOnAppQuit).toBe(true)
    expect(updater.hasPendingStartupUpdate()).toBe(false)
    expect(await updater.applyPendingUpdateOnStartup()).toBe(false)
    expect(fakeUpdater.restartAndInstall).not.toHaveBeenCalled()
  })

  it('suppressInstallOnQuit() disables install-on-quit (Option B session-end guard)', async () => {
    delete settingsStore['installUpdatesOnStartup']
    const updater = await import('./updater')
    updater.register()
    expect(electronUpdaterMock.autoInstallOnAppQuit).toBe(true)
    updater.suppressInstallOnQuit()
    expect(electronUpdaterMock.autoInstallOnAppQuit).toBe(false)
  })

  it('startup install is inert when the flag is off, even with a staged update', async () => {
    delete settingsStore['installUpdatesOnStartup']
    settingsStore['pendingDownloadedUpdateVersion'] = '1.0.1'
    readyVersion = '1.0.1'
    const updater = await import('./updater')
    updater.register()
    expect(updater.hasPendingStartupUpdate()).toBe(false)
    expect(await updater.applyPendingUpdateOnStartup()).toBe(false)
    expect(fakeUpdater.restartAndInstall).not.toHaveBeenCalled()
  })

  it('installUpdate() is a no-op while the OS session is ending', async () => {
    sessionEnding = true
    const updater = await import('./updater')
    updater.register()
    updater.installUpdate()
    expect(fakeUpdater.restartAndInstall).not.toHaveBeenCalled()
  })

  it('installUpdate() installs silently by default (showInstallerUI off)', async () => {
    delete settingsStore['showInstallerUI']
    const updater = await import('./updater')
    updater.register()
    updater.installUpdate()
    expect(fakeUpdater.restartAndInstall).toHaveBeenCalledWith({ isSilent: true })
  })

  it('installUpdate() shows the NSIS installer UI when showInstallerUI is on', async () => {
    settingsStore['showInstallerUI'] = true
    const updater = await import('./updater')
    updater.register()
    updater.installUpdate()
    expect(fakeUpdater.restartAndInstall).toHaveBeenCalledWith({ isSilent: false })
  })

  it('installUpdate() ignores showInstallerUI off Windows (isSilent stays true)', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    settingsStore['showInstallerUI'] = true
    const updater = await import('./updater')
    updater.register()
    updater.installUpdate()
    expect(fakeUpdater.restartAndInstall).toHaveBeenCalledWith({ isSilent: true })
  })

  it('hasPendingStartupUpdate() reflects the staged-update markers', async () => {
    const updater = await import('./updater')

    expect(updater.hasPendingStartupUpdate()).toBe(false)

    settingsStore['pendingDownloadedUpdateVersion'] = '1.0.1'
    expect(updater.hasPendingStartupUpdate()).toBe(true)

    // Staged version is already what we are running.
    settingsStore['pendingDownloadedUpdateVersion'] = '1.0.0'
    expect(updater.hasPendingStartupUpdate()).toBe(false)

    // Loop-breaker: already auto-attempted this version.
    settingsStore['pendingDownloadedUpdateVersion'] = '1.0.1'
    settingsStore['lastStartupUpdateAttemptVersion'] = '1.0.1'
    expect(updater.hasPendingStartupUpdate()).toBe(false)
  })

  it('applyPendingUpdateOnStartup() installs a staged update and records the attempt', async () => {
    settingsStore['pendingDownloadedUpdateVersion'] = '1.0.1'
    readyVersion = '1.0.1'
    const updater = await import('./updater')
    updater.register()

    const installing = await updater.applyPendingUpdateOnStartup()

    expect(installing).toBe(true)
    expect(fakeUpdater.restartAndInstall).toHaveBeenCalledTimes(1)
    expect(settingsStore['lastStartupUpdateAttemptVersion']).toBe('1.0.1')
  })

  it('applyPendingUpdateOnStartup() holds the install until the splash minimum elapses', async () => {
    vi.useFakeTimers()
    try {
      settingsStore['pendingDownloadedUpdateVersion'] = '1.0.1'
      readyVersion = '1.0.1' // check resolves instantly (cached installer)
      const updater = await import('./updater')
      updater.register()

      // Splash just went up, so the full minimum (5000ms) must elapse first.
      const pending = updater.applyPendingUpdateOnStartup(Date.now())

      // Let the (instant) ready check settle, but stay short of the floor.
      await vi.advanceTimersByTimeAsync(4000)
      expect(fakeUpdater.restartAndInstall).not.toHaveBeenCalled()

      // Cross the floor — the install now fires.
      await vi.advanceTimersByTimeAsync(1200)
      expect(await pending).toBe(true)
      expect(fakeUpdater.restartAndInstall).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('applyPendingUpdateOnStartup() does nothing when no update is staged', async () => {
    const updater = await import('./updater')
    updater.register()
    expect(await updater.applyPendingUpdateOnStartup()).toBe(false)
    expect(fakeUpdater.restartAndInstall).not.toHaveBeenCalled()
  })

  it('applyPendingUpdateOnStartup() does not install when the check cannot confirm a ready update', async () => {
    vi.useFakeTimers()
    try {
      settingsStore['pendingDownloadedUpdateVersion'] = '1.0.1'
      readyVersion = null // e.g. cached installer invalid / offline
      const updater = await import('./updater')
      updater.register()
      const pending = updater.applyPendingUpdateOnStartup()
      // No 'ready' transition arrives, so the bounded wait falls through on its
      // timeout rather than hanging boot forever. Advance just past the 5000ms
      // timeout so the check settles regardless of event-loop boundary timing.
      await vi.advanceTimersByTimeAsync(5100)
      expect(await pending).toBe(false)
      expect(fakeUpdater.restartAndInstall).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('loop-breaker: a previously-attempted version is not auto-retried', async () => {
    settingsStore['pendingDownloadedUpdateVersion'] = '1.0.1'
    settingsStore['lastStartupUpdateAttemptVersion'] = '1.0.1'
    readyVersion = '1.0.1'
    const updater = await import('./updater')
    updater.register()
    expect(await updater.applyPendingUpdateOnStartup()).toBe(false)
    expect(fakeUpdater.restartAndInstall).not.toHaveBeenCalled()
  })

  it('emits startup_install_skipped with the loop_breaker reason', async () => {
    settingsStore['pendingDownloadedUpdateVersion'] = '1.0.1'
    settingsStore['lastStartupUpdateAttemptVersion'] = '1.0.1'
    readyVersion = '1.0.1'
    const updater = await import('./updater')
    updater.register()
    await updater.applyPendingUpdateOnStartup()
    const skipped = findEmitCalls('comfy.desktop.app_update.startup_install_skipped')
    expect(skipped).toHaveLength(1)
    expect(skipped[0]?.[1]).toMatchObject({ reason: 'loop_breaker', version: '1.0.1' })
  })

  it('emits startup_install_skipped with not_ready when the check cannot confirm a ready update', async () => {
    vi.useFakeTimers()
    try {
      settingsStore['pendingDownloadedUpdateVersion'] = '1.0.1'
      readyVersion = null
      const updater = await import('./updater')
      updater.register()
      const pending = updater.applyPendingUpdateOnStartup()
      // Past the 5000ms bounded-check timeout (buffer avoids boundary races).
      await vi.advanceTimersByTimeAsync(5100)
      await pending
      const skipped = findEmitCalls('comfy.desktop.app_update.startup_install_skipped')
      expect(skipped).toHaveLength(1)
      expect(skipped[0]?.[1]).toMatchObject({ reason: 'not_ready', version: '1.0.1' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears stale markers once the staged version is actually running', async () => {
    settingsStore['pendingDownloadedUpdateVersion'] = '1.0.0'
    settingsStore['lastStartupUpdateAttemptVersion'] = '1.0.0'
    mockAppVersion = '1.0.0' // install succeeded; we now run it
    const updater = await import('./updater')
    updater.register()
    await updater.applyPendingUpdateOnStartup()
    expect(settingsStore['pendingDownloadedUpdateVersion']).toBeUndefined()
    expect(settingsStore['lastStartupUpdateAttemptVersion']).toBeUndefined()
  })
})
