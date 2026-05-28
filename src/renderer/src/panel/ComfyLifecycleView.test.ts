import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'

import ComfyLifecycleView from './ComfyLifecycleView.vue'
import { useSessionStore } from '../stores/sessionStore'
import type { Installation } from '../types/ipc'

const messages = {
  en: {
    common: {
      copy: 'Copy',
    },
    launch: {
      viewLogs: 'View logs',
    },
    comfyLifecycle: {
      preparingTitle: 'Preparing…',
      stoppedTitle: 'ComfyUI is not running',
      stoppedDesc: 'Start ComfyUI to use this installation.',
      launchingTitle: 'Starting ComfyUI…',
      launchingDesc: 'Waiting for the server to come online.',
      stoppingTitle: 'Stopping ComfyUI…',
      stoppingDesc: 'Waiting for the process to shut down cleanly.',
      crashedTitle: 'ComfyUI exited unexpectedly',
      crashedDesc: 'The ComfyUI process exited. You can restart it below.',
      crashedDescWithCode:
        'The ComfyUI process exited (exit code {code}). You can restart it below.',
      crashedDetailsToggle: 'Show error log',
      start: 'Start ComfyUI',
      restart: 'Restart ComfyUI',
      returnToDashboard: 'Return to Dashboard',
      launchProgressTitle: 'Starting ComfyUI',
    },
    dashboard: {
      confirmStopLocal: {
        title: 'Return to Dashboard?',
        message: 'ComfyUI for this installation will be stopped.',
        confirmLabel: 'Stop & Return',
      },
    },
  },
}

function createTestI18n() {
  return createI18n({ legacy: false, locale: 'en', messages })
}

const SAMPLE_INSTALL: Installation = {
  id: 'inst-1',
  name: 'My Local Install',
  sourceId: 'standalone',
  sourceLabel: 'Standalone',
  sourceCategory: 'local',
  status: 'installed',
} as unknown as Installation

interface MockApi {
  runAction: ReturnType<typeof vi.fn>
  getRunningInstances: ReturnType<typeof vi.fn>
  getLastCrashError: ReturnType<typeof vi.fn>
  returnToDashboard: ReturnType<typeof vi.fn>
  onInstanceLaunching: ReturnType<typeof vi.fn>
  onInstanceLaunchFailed: ReturnType<typeof vi.fn>
  onInstanceStarted: ReturnType<typeof vi.fn>
  onInstanceStopped: ReturnType<typeof vi.fn>
  onInstanceStopping: ReturnType<typeof vi.fn>
  onComfyOutput: ReturnType<typeof vi.fn>
  onComfyExited: ReturnType<typeof vi.fn>
}

function installMockApi(overrides: Partial<MockApi> = {}): MockApi {
  const api: MockApi = {
    runAction: vi.fn().mockResolvedValue({ ok: true }),
    getRunningInstances: vi.fn().mockResolvedValue([]),
    getLastCrashError: vi.fn().mockResolvedValue(null),
    returnToDashboard: vi.fn().mockResolvedValue(true),
    onInstanceLaunching: vi.fn(() => () => {}),
    onInstanceLaunchFailed: vi.fn(() => () => {}),
    onInstanceStarted: vi.fn(() => () => {}),
    onInstanceStopped: vi.fn(() => () => {}),
    onInstanceStopping: vi.fn(() => () => {}),
    onComfyOutput: vi.fn(() => () => {}),
    onComfyExited: vi.fn(() => () => {}),
    ...overrides,
  }
  ;(window as unknown as { api: MockApi }).api = api
  return api
}

// Stub BrandTakeoverLayout to skip its Teleport-to-body + focus-trap so
// the BrandFinishedSurface tree renders inline and assertions against it
// don't have to chase the teleported root.
const brandTakeoverStub = {
  name: 'BrandTakeoverLayout',
  template: '<div class="brand-takeover-stub"><slot /><slot name="footer" /></div>',
}

function mountView(installationId = 'inst-1', installation: Installation | null = SAMPLE_INSTALL) {
  return mount(ComfyLifecycleView, {
    props: { installationId, installation },
    // No createPinia() here — beforeEach installs the active pinia via
    // setActivePinia so beforeEach mutations (e.g. ready = true) land on
    // the same instance the component sees via useSessionStore().
    global: {
      plugins: [createTestI18n()],
      stubs: { BrandTakeoverLayout: brandTakeoverStub },
    },
  })
}

describe('ComfyLifecycleView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    installMockApi()
    // The view gates on sessionStore.ready to avoid flashing the stopped
    // surface before hydration. Production flips it after init() — tests
    // bypass init() so flip it manually to opt into rendering.
    useSessionStore().ready = true
  })

  it('renders the stopped state by default with a Start button in brand-finished chrome', async () => {
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.text()).toContain('ComfyUI is not running')
    // brand-cancelled banner variant is what makes the stopped state
    // read as "operation cancelled" continuity from ProgressModal.
    expect(wrapper.find('.brand-progress__banner--cancelled').exists()).toBe(true)
    const button = wrapper.find('button.brand-primary')
    expect(button.exists()).toBe(true)
    expect(button.text()).toContain('Start ComfyUI')
  })

  it('shows the in-flight placeholder while sessionStore reports the install as launching', async () => {
    const wrapper = mountView()
    const sessionStore = useSessionStore()
    sessionStore.launchingInstances.set('inst-1', { installationName: 'My Local Install' })
    await flushPromises()
    // ProgressModal owns the full launching takeover; the lifecycle
    // view renders only the small inline placeholder as a safety-net.
    expect(wrapper.text()).toContain('Starting ComfyUI')
    expect(wrapper.find('.lifecycle-placeholder').exists()).toBe(true)
    expect(wrapper.find('button.brand-primary').exists()).toBe(false)
  })

  it('shows the in-flight placeholder while sessionStore reports the install as stopping', async () => {
    const wrapper = mountView()
    const sessionStore = useSessionStore()
    sessionStore.stoppingInstances.add('inst-1')
    await flushPromises()
    expect(wrapper.text()).toContain('Stopping ComfyUI')
    expect(wrapper.find('.lifecycle-placeholder').exists()).toBe(true)
    expect(wrapper.find('button.brand-primary').exists()).toBe(false)
  })

  it('renders the crashed state in brand-error chrome with exit code', async () => {
    const wrapper = mountView()
    const sessionStore = useSessionStore()
    sessionStore.errorInstances.set('inst-1', {
      installationName: 'My Local Install',
      exitCode: 137,
    })
    await flushPromises()
    expect(wrapper.text()).toContain('ComfyUI exited unexpectedly')
    expect(wrapper.text()).toContain('exit code 137')
    expect(wrapper.find('.brand-progress__banner--error').exists()).toBe(true)
    const button = wrapper.find('button.brand-primary')
    expect(button.exists()).toBe(true)
    expect(button.text()).toContain('Restart ComfyUI')
  })

  it('renders the stderr tail in the brand logs accordion when present', async () => {
    const wrapper = mountView()
    const sessionStore = useSessionStore()
    sessionStore.errorInstances.set('inst-1', {
      installationName: 'My Local Install',
      exitCode: 1,
      lastStderr: "ImportError: No module named 'torch'\n  at /path/to/main.py:42",
    })
    await flushPromises()
    const logs = wrapper.find('.brand-progress__logs')
    expect(logs.exists()).toBe(true)
    expect(logs.text()).toContain('ImportError: No module named')
    expect(logs.text()).toContain('main.py:42')
    // The accordion toggle button uses the shared "View logs" label.
    expect(wrapper.text()).toContain('View logs')
  })

  it('omits the logs accordion when no lastStderr is recorded', async () => {
    const wrapper = mountView()
    const sessionStore = useSessionStore()
    sessionStore.errorInstances.set('inst-1', {
      installationName: 'My Local Install',
      exitCode: 1,
    })
    await flushPromises()
    expect(wrapper.find('.brand-progress__logs').exists()).toBe(false)
    expect(wrapper.find('.brand-progress__logs-toggle').exists()).toBe(false)
  })

  it('hydrates the crashed state from getLastCrashError on mount when no live event has fired', async () => {
    const api = installMockApi({
      getLastCrashError: vi.fn().mockResolvedValue({
        installationId: 'inst-1',
        installationName: 'My Local Install',
        crashed: true,
        exitCode: 9,
        lastStderr: 'Killed by signal 9',
      }),
    })
    const wrapper = mountView()
    await flushPromises()

    expect(api.getLastCrashError).toHaveBeenCalledWith('inst-1')
    expect(wrapper.text()).toContain('ComfyUI exited unexpectedly')
    expect(wrapper.text()).toContain('exit code 9')
    expect(wrapper.find('.brand-progress__logs').text()).toContain('Killed by signal 9')

    const sessionStore = useSessionStore()
    const stored = sessionStore.errorInstances.get('inst-1')
    expect(stored?.lastStderr).toBe('Killed by signal 9')
    expect(stored?.exitCode).toBe(9)
  })

  it('does not overwrite an existing live error when getLastCrashError later resolves', async () => {
    let resolveCrash: ((data: unknown) => void) | undefined
    const api = installMockApi({
      getLastCrashError: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveCrash = resolve as (data: unknown) => void
          }),
      ),
    })

    const wrapper = mountView()
    // The live IPC handler in sessionStore wins over the on-mount fetch.
    const sessionStore = useSessionStore()
    sessionStore.errorInstances.set('inst-1', {
      installationName: 'My Local Install',
      exitCode: 137,
      lastStderr: 'live event stderr',
    })

    resolveCrash?.({
      installationId: 'inst-1',
      installationName: 'My Local Install',
      crashed: true,
      exitCode: 1,
      lastStderr: 'stale buffer stderr',
    })
    await flushPromises()

    expect(api.getLastCrashError).toHaveBeenCalledWith('inst-1')
    const stored = sessionStore.errorInstances.get('inst-1')
    // Live event payload (the freshest) is preserved — the buffer fetch is a
    // best-effort backfill and must not clobber a populated entry.
    expect(stored?.lastStderr).toBe('live event stderr')
    expect(stored?.exitCode).toBe(137)
    expect(wrapper.find('.brand-progress__logs').text()).toContain('live event stderr')
  })

  it('skips the IPC fetch when an error is already in the session store', async () => {
    const api = installMockApi()
    const pinia = createPinia()
    setActivePinia(pinia)
    const sessionStore = useSessionStore()
    sessionStore.errorInstances.set('inst-1', {
      installationName: 'My Local Install',
      exitCode: 1,
      lastStderr: 'preexisting',
    })
    mount(ComfyLifecycleView, {
      props: { installationId: 'inst-1', installation: SAMPLE_INSTALL },
      global: {
        plugins: [createTestI18n(), pinia],
        stubs: { BrandTakeoverLayout: brandTakeoverStub },
      },
    })
    await flushPromises()
    expect(api.getLastCrashError).not.toHaveBeenCalled()
  })

  it('emits show-progress with a launch apiCall when Start is clicked', async () => {
    const wrapper = mountView()
    await flushPromises()
    await wrapper.find('button.brand-primary').trigger('click')
    const events = wrapper.emitted('show-progress')
    expect(events).toBeDefined()
    expect(events!.length).toBe(1)
    const payload = events![0]![0] as {
      installationId: string
      title: string
      apiCall: () => Promise<unknown>
      cancellable?: boolean
    }
    expect(payload.installationId).toBe('inst-1')
    expect(payload.title).toContain('Starting ComfyUI')
    expect(payload.title).toContain('My Local Install')
    expect(payload.cancellable).toBe(true)

    // The apiCall should hit window.api.runAction with the 'launch' action.
    await payload.apiCall()
    const api = (window as unknown as { api: MockApi }).api
    expect(api.runAction).toHaveBeenCalledWith('inst-1', 'launch')
  })

  it('renders a Return to Dashboard ghost button in the stopped state and calls returnToDashboard without confirm', async () => {
    const wrapper = mountView()
    await flushPromises()
    const buttons = wrapper.findAll('button.brand-ghost')
    const ret = buttons.find((b) => b.text().includes('Return to Dashboard'))
    expect(ret?.exists()).toBe(true)
    await ret!.trigger('click')
    await flushPromises()
    const api = (window as unknown as { api: MockApi }).api
    expect(api.returnToDashboard).toHaveBeenCalled()
  })

  it('renders a Return to Dashboard ghost button in the crashed state and calls returnToDashboard without confirm', async () => {
    const wrapper = mountView()
    const sessionStore = useSessionStore()
    sessionStore.errorInstances.set('inst-1', {
      installationName: 'My Local Install',
      exitCode: 1,
    })
    await flushPromises()
    const buttons = wrapper.findAll('button.brand-ghost')
    const ret = buttons.find((b) => b.text().includes('Return to Dashboard'))
    expect(ret?.exists()).toBe(true)
    await ret!.trigger('click')
    await flushPromises()
    const api = (window as unknown as { api: MockApi }).api
    expect(api.returnToDashboard).toHaveBeenCalled()
  })
})
