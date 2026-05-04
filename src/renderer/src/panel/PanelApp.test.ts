import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../main', () => ({
  i18n: {
    global: { t: (key: string) => key },
  },
}))

vi.mock('../composables/useTheme', () => ({ useTheme: () => ({ theme: 'dark' }) }))
vi.mock('../composables/useModal', () => ({
  useModal: () => ({ alert: vi.fn(), confirm: vi.fn(), close: vi.fn() }),
}))

// Stub the heavy children so we can assert which sub-panel is rendered.
vi.mock('../views/SettingsView.vue', () => ({
  default: {
    name: 'SettingsView',
    template: '<div data-testid="settings-view" />',
    methods: { loadSettings: vi.fn() },
  },
}))
vi.mock('../views/DetailModal.vue', () => ({
  default: {
    name: 'DetailModal',
    props: ['installation', 'inline', 'initialTab', 'autoAction'],
    template:
      '<div data-testid="detail-modal" :data-installation-id="installation?.id" :data-inline="inline" />',
  },
}))
vi.mock('../views/ProgressModal.vue', () => ({
  default: {
    name: 'ProgressModal',
    props: ['installationId'],
    template: '<div data-testid="progress-modal" />',
    methods: { startOperation: vi.fn(), showOperation: vi.fn() },
  },
}))
vi.mock('../components/ModalDialog.vue', () => ({
  default: { name: 'ModalDialog', template: '<div />' },
}))
vi.mock('./ComfyLifecycleView.vue', () => ({
  default: {
    name: 'ComfyLifecycleView',
    props: ['installation', 'installationId'],
    template:
      '<div data-testid="comfy-lifecycle" :data-installation-id="installationId" />',
  },
}))
vi.mock('../views/DirectoriesView.vue', () => ({
  default: {
    name: 'DirectoriesView',
    template: '<div data-testid="directories-view" />',
    methods: { loadAll: vi.fn(), loadModels: vi.fn(), loadMedia: vi.fn() },
  },
}))

import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'
import PanelApp from './PanelApp.vue'

const messages = {
  en: {
    titleBar: {
      panelComfy: 'ComfyUI',
      panelInstallSettings: 'Install Settings',
      panelLauncherSettings: 'Launcher Settings',
      installSettingsComingSoon: 'Coming soon',
      installationLabel: 'Installation',
    },
    common: {
      loading: 'Loading…',
    },
  },
}

function createTestI18n() {
  return createI18n({ legacy: false, locale: 'en', messages })
}

interface InstallationLike {
  id: string
  name: string
  sourceLabel: string
  sourceCategory: string
}

interface MockApiState {
  panelSwitchCallbacks: ((data: { panel: string; installationId?: string }) => void)[]
  installationsChangedCallbacks: (() => void)[]
  installations: InstallationLike[]
  getInstallations: ReturnType<typeof vi.fn>
}

function installMockApi(initial?: { installations?: InstallationLike[] }): MockApiState {
  const installations: InstallationLike[] = initial?.installations ?? []
  const state: MockApiState = {
    panelSwitchCallbacks: [],
    installationsChangedCallbacks: [],
    installations,
    getInstallations: vi.fn(async () => state.installations),
  }
  const api = {
    getLocaleMessages: vi.fn().mockResolvedValue(messages.en),
    onLocaleChanged: vi.fn(() => () => {}),
    onPanelSwitch: vi.fn((cb: (d: { panel: string; installationId?: string }) => void) => {
      state.panelSwitchCallbacks.push(cb)
      return () => {}
    }),
    onSettingsChanged: vi.fn(() => () => {}),
    onInstallationsChanged: vi.fn((cb: () => void) => {
      state.installationsChangedCallbacks.push(cb)
      return () => {}
    }),
    onInstallationsVersionsUpdated: vi.fn(() => () => {}),
    getInstallations: state.getInstallations,
    getRunningInstances: vi.fn().mockResolvedValue([]),
    onInstanceLaunching: vi.fn(() => () => {}),
    onInstanceLaunchFailed: vi.fn(() => () => {}),
    onInstanceStarted: vi.fn(() => () => {}),
    onInstanceStopped: vi.fn(() => () => {}),
    onInstanceStopping: vi.fn(() => () => {}),
    onComfyOutput: vi.fn(() => () => {}),
    onComfyExited: vi.fn(() => () => {}),
    onErrorDetail: vi.fn(() => () => {}),
    getSetting: vi.fn().mockResolvedValue(undefined),
  }
  ;(window as unknown as { api: typeof api }).api = api
  return state
}

function mountPanel() {
  return mount(PanelApp, {
    global: { plugins: [createTestI18n(), createPinia()] },
  })
}

const SAMPLE_INSTALL: InstallationLike = {
  id: 'test-id',
  name: 'Test Install',
  sourceLabel: 'Standalone',
  sourceCategory: 'local',
}

describe('PanelApp', () => {
  let mockState: MockApiState

  beforeEach(() => {
    setActivePinia(createPinia())
    mockState = installMockApi({ installations: [SAMPLE_INSTALL] })
    // Default URL — individual tests override.
    window.history.replaceState({}, '', '/?installationId=test-id')
  })

  it('renders the launcher-settings sub-view by default', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('[data-testid="settings-view"]').exists()).toBe(true)
  })

  it('switches sub-view in response to onPanelSwitch IPC events', async () => {
    // Regression test for the mid-load race: a panel created with one initial
    // panel must still update when main pushes a different panel after load.
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('[data-testid="settings-view"]').exists()).toBe(true)

    expect(mockState.panelSwitchCallbacks.length).toBeGreaterThan(0)
    mockState.panelSwitchCallbacks.forEach((cb) => cb({ panel: 'install-settings' }))
    await flushPromises()
    expect(wrapper.find('[data-testid="settings-view"]').exists()).toBe(false)
  })

  it('ignores unknown panel keys from onPanelSwitch', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('[data-testid="settings-view"]').exists()).toBe(true)

    mockState.panelSwitchCallbacks.forEach((cb) => cb({ panel: 'not-a-real-panel' }))
    await flushPromises()
    expect(wrapper.find('[data-testid="settings-view"]').exists()).toBe(true)
  })

  it('renders the install-settings DetailModal for the URL installationId', async () => {
    window.history.replaceState({}, '', '/?installationId=test-id&panel=install-settings')
    const wrapper = mountPanel()
    await flushPromises()
    const detail = wrapper.find('[data-testid="detail-modal"]')
    expect(detail.exists()).toBe(true)
    expect(detail.attributes('data-installation-id')).toBe('test-id')
    expect(detail.attributes('data-inline')).toBe('true')
  })

  it('refetches the installation when onInstallationsChanged fires', async () => {
    window.history.replaceState({}, '', '/?installationId=test-id&panel=install-settings')
    const wrapper = mountPanel()
    await flushPromises()
    expect(mockState.getInstallations).toHaveBeenCalledTimes(1)

    // Mutate the underlying list, then fire the broadcast.
    mockState.installations = [{ ...SAMPLE_INSTALL, name: 'Renamed Install' }]
    expect(mockState.installationsChangedCallbacks.length).toBeGreaterThan(0)
    mockState.installationsChangedCallbacks.forEach((cb) => cb())
    await flushPromises()

    expect(mockState.getInstallations).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="detail-modal"]').exists()).toBe(true)
  })

  it('shows a placeholder when the installationId does not match any install', async () => {
    window.history.replaceState({}, '', '/?installationId=missing-id&panel=install-settings')
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('[data-testid="detail-modal"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('missing-id')
  })

  it('renders the comfy-lifecycle view when initialised with that panel', async () => {
    // Main initialises panel.html with `panel=comfy-lifecycle` when the
    // Comfy tab body needs to show the lifecycle UI (instance not running).
    window.history.replaceState({}, '', '/?installationId=test-id&panel=comfy-lifecycle')
    const wrapper = mountPanel()
    await flushPromises()
    const lifecycle = wrapper.find('[data-testid="comfy-lifecycle"]')
    expect(lifecycle.exists()).toBe(true)
    expect(lifecycle.attributes('data-installation-id')).toBe('test-id')
  })

  it('renders the directories view when initialised with panel=directories', async () => {
    window.history.replaceState({}, '', '/?installationId=test-id&panel=directories')
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('[data-testid="directories-view"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="settings-view"]').exists()).toBe(false)
  })

  it('switches to the directories view in response to a panel-switch IPC event', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('[data-testid="settings-view"]').exists()).toBe(true)

    mockState.panelSwitchCallbacks.forEach((cb) => cb({ panel: 'directories' }))
    await flushPromises()
    expect(wrapper.find('[data-testid="settings-view"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="directories-view"]').exists()).toBe(true)
  })

  it('switches to the comfy-lifecycle view in response to a panel-switch IPC event', async () => {
    // Main flips us into 'comfy-lifecycle' when the install transitions out
    // of running (stop / crash) while the user is on the Comfy tab.
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('[data-testid="settings-view"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="comfy-lifecycle"]').exists()).toBe(false)

    mockState.panelSwitchCallbacks.forEach((cb) => cb({ panel: 'comfy-lifecycle' }))
    await flushPromises()
    expect(wrapper.find('[data-testid="settings-view"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="comfy-lifecycle"]').exists()).toBe(true)
  })
})
