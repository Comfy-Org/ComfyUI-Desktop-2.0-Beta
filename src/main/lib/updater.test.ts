import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let mockPlatform = 'linux'
let mockAppImage: string | undefined
let mockIsPackaged = true
let mockExePath = '/opt/Comfy Desktop/comfyui-desktop-2'

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mockIsPackaged
    },
    getPath: (name: string) => {
      if (name === 'exe') return mockExePath
      return ''
    }
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

vi.mock('../settings', () => ({
  get: vi.fn()
}))

vi.mock('./quit-state', () => ({
  clearQuitReason: vi.fn(),
  setQuitReason: vi.fn()
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
    mockAppImage = '/home/user/ComfyUI-Desktop-2.0.AppImage'
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
