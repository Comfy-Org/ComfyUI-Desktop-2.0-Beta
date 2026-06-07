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
      back: 'Back',
    },
    launch: {
      viewLogs: 'View logs',
    },
    comfyLifecycle: {
      preparingTitle: 'Preparing…',
      launchingTitle: 'Starting ComfyUI…',
      stoppingTitle: 'Stopping ComfyUI…',
      crashedTitle: 'ComfyUI exited unexpectedly',
      crashedDesc: 'The ComfyUI process exited. You can restart it below.',
      crashedDescWithCode:
        'The ComfyUI process exited (exit code {code}). You can restart it below.',
      crashedDescWithSignal:
        'The ComfyUI process was terminated by {signal}. You can restart it below.',
      crashedDescWithCodeAndSignal:
        'The ComfyUI process was terminated by {signal} (exit code {code}). You can restart it below.',
      crashedDescLogsHint: 'See the logs for details.',
      restart: 'Restart ComfyUI',
      stoppedTitle: 'ComfyUI is stopped',
      stoppedDesc:
        "The ComfyUI server is stopped. This window stayed open — relaunch it below whenever you're ready.",
      relaunch: 'Relaunch ComfyUI',
      launchProgressTitle: 'Starting ComfyUI',
    },
    dashboard: {
      confirmStopLocal: {
        title: 'Return to Dashboard?',
        message: 'This will stop the current ComfyUI.',
        confirmLabel: 'Return to Dashboard',
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
  onInstanceCrashed: ReturnType<typeof vi.fn>
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
    onInstanceCrashed: vi.fn(() => () => {}),
    ...overrides,
  }
  ;(window as unknown as { api: MockApi }).api = api
  return api
}

// Stub BrandTakeoverLayout to skip its Teleport-to-body so assertions render inline.
const brandTakeoverStub = {
  name: 'BrandTakeoverLayout',
  template: '<div class="brand-takeover-stub"><slot /><slot name="footer" /></div>',
}

function mountView(installationId = 'inst-1', installation: Installation | null = SAMPLE_INSTALL) {
  return mount(ComfyLifecycleView, {
    props: { installationId, installation },
    // No createPinia() here — beforeEach's setActivePinia must own the instance so its mutations land.
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
    // The view gates on sessionStore.ready; tests bypass init() so flip it manually.
    useSessionStore().ready = true
  })

  it('renders the stopped surface in the not-running state so a clean stop is not a black window', async () => {
    // A user-initiated Stop leaves no live ComfyUI view covering the panel, so
    // the not-running state must paint its own relaunch card (regression: it
    // previously rendered nothing → black window).
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.text()).toContain('ComfyUI is stopped')
    // Neutral surface, not the crashed/error chrome.
    expect(wrapper.find('.brand-progress__banner--error').exists()).toBe(false)
    expect(wrapper.find('.lifecycle-placeholder').exists()).toBe(false)
    const button = wrapper.find('button.brand-primary')
    expect(button.exists()).toBe(true)
    expect(button.text()).toContain('Relaunch ComfyUI')
  })

  it('labels the stopped-surface back button "Return to Dashboard" and routes to the dashboard', async () => {
    const wrapper = mountView()
    await flushPromises()
    const back = wrapper.findAll('button').find((b) => b.text().includes('Return to Dashboard'))
    expect(back?.exists()).toBe(true)
    expect(back!.classes()).toContain('brand-ghost')
    await back!.trigger('click')
    await flushPromises()
    const api = (window as unknown as { api: MockApi }).api
    expect(api.returnToDashboard).toHaveBeenCalled()
  })

  it('relaunches from the stopped surface via a launch show-progress', async () => {
    const wrapper = mountView()
    await flushPromises()
    await wrapper.find('button.brand-primary').trigger('click')
    const evts = wrapper.emitted('show-progress')
    expect(evts).toBeTruthy()
    const opts = evts![0]![0] as { opKind: string; apiCall: () => unknown }
    expect(opts.opKind).toBe('launch')
  })

  it('shows the in-flight placeholder while sessionStore reports the install as launching', async () => {
    const wrapper = mountView()
    const sessionStore = useSessionStore()
    sessionStore.launchingInstances.set('inst-1', { installationName: 'My Local Install' })
    await flushPromises()
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

  it('renders the POSIX signal in the crashed message when signal alone is present', async () => {
    const wrapper = mountView()
    const sessionStore = useSessionStore()
    sessionStore.errorInstances.set('inst-1', {
      installationName: 'My Local Install',
      signal: 'SIGKILL',
    })
    await flushPromises()
    expect(wrapper.text()).toContain('terminated by SIGKILL')
    expect(wrapper.text()).not.toContain('exit code')
  })

  it('falls back to the generic crashed copy when neither exit code nor signal is recorded', async () => {
    const wrapper = mountView()
    const sessionStore = useSessionStore()
    sessionStore.errorInstances.set('inst-1', {
      installationName: 'My Local Install',
    })
    await flushPromises()
    expect(wrapper.text()).toContain('The ComfyUI process exited.')
    expect(wrapper.text()).not.toContain('exit code')
    expect(wrapper.text()).not.toContain('terminated by')
  })

  it('renders both signal and exit code in the crashed message when both are present', async () => {
    const wrapper = mountView()
    const sessionStore = useSessionStore()
    sessionStore.errorInstances.set('inst-1', {
      installationName: 'My Local Install',
      exitCode: 137,
      signal: 'SIGKILL',
    })
    await flushPromises()
    expect(wrapper.text()).toContain('terminated by SIGKILL')
    expect(wrapper.text()).toContain('exit code 137')
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
    expect(wrapper.text()).toContain('View logs')
  })

  it('renders user home paths in stderr verbatim — local logs must not be PII-scrubbed', async () => {
    const wrapper = mountView()
    const sessionStore = useSessionStore()
    sessionStore.errorInstances.set('inst-1', {
      installationName: 'My Local Install',
      exitCode: 1,
      lastStderr:
        'Traceback (most recent call last):\n' +
        '  File "C:\\Users\\alice\\ComfyUI\\main.py", line 1, in <module>\n' +
        '  File "/Users/bob/ComfyUI/main.py", line 1, in <module>\n' +
        '  File "/home/carol/ComfyUI/main.py", line 1, in <module>\n' +
        "ImportError: No module named 'torch'",
    })
    await flushPromises()
    const logs = wrapper.find('.brand-progress__logs')
    expect(logs.exists()).toBe(true)
    // PII scrubbing belongs on the telemetry path, not the local-UI path.
    // If any of these fail, we've regressed back to scrubbing logs the user
    // sees on their own machine (issue #674).
    expect(logs.text()).toContain('C:\\Users\\alice\\ComfyUI\\main.py')
    expect(logs.text()).toContain('/Users/bob/ComfyUI/main.py')
    expect(logs.text()).toContain('/home/carol/ComfyUI/main.py')
    expect(logs.text()).not.toContain('[REDACTED]')
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
    expect(wrapper.text()).not.toContain('See the logs for details.')
  })

  it('appends the logs hint to the crashed message when stderr is captured', async () => {
    const wrapper = mountView()
    const sessionStore = useSessionStore()
    sessionStore.errorInstances.set('inst-1', {
      installationName: 'My Local Install',
      exitCode: 1,
      lastStderr: "ImportError: No module named 'torch'",
    })
    await flushPromises()
    expect(wrapper.text()).toContain('exit code 1')
    expect(wrapper.text()).toContain('See the logs for details.')
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
    // The live IPC handler wins over the on-mount fetch.
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
    // The best-effort buffer fetch must not clobber the fresher live event.
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

  it('emits show-progress with a launch apiCall when Restart is clicked from the crashed surface', async () => {
    const wrapper = mountView()
    const sessionStore = useSessionStore()
    sessionStore.errorInstances.set('inst-1', {
      installationName: 'My Local Install',
      exitCode: 1,
    })
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

    await payload.apiCall()
    const api = (window as unknown as { api: MockApi }).api
    expect(api.runAction).toHaveBeenCalledWith('inst-1', 'launch')
  })

  it('renders a Back ghost button in the crashed-state error-actions row and calls returnToDashboard without confirm', async () => {
    const wrapper = mountView()
    const sessionStore = useSessionStore()
    sessionStore.errorInstances.set('inst-1', {
      installationName: 'My Local Install',
      exitCode: 1,
    })
    await flushPromises()
    const errorActions = wrapper.find('.brand-progress__error-actions')
    expect(errorActions.exists()).toBe(true)
    const buttons = errorActions.findAll('button')
    const back = buttons.find((b) => b.text().includes('Back'))
    expect(back?.exists()).toBe(true)
    expect(back!.classes()).toContain('brand-ghost')
    // Back on the left, Restart on the right.
    expect(buttons[0]!.text()).toContain('Back')
    expect(buttons[1]!.text()).toContain('Restart')
    await back!.trigger('click')
    await flushPromises()
    const api = (window as unknown as { api: MockApi }).api
    expect(api.returnToDashboard).toHaveBeenCalled()
  })
})
