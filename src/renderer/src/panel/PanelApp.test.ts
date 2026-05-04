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
  default: { name: 'SettingsView', template: '<div data-testid="settings-view" />' },
}))
vi.mock('../components/ModalDialog.vue', () => ({
  default: { name: 'ModalDialog', template: '<div />' },
}))

import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
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
  },
}

function createTestI18n() {
  return createI18n({ legacy: false, locale: 'en', messages })
}

interface MockApiState {
  panelSwitchCallbacks: ((data: { panel: string; installationId?: string }) => void)[]
}

function installMockApi(): MockApiState {
  const state: MockApiState = { panelSwitchCallbacks: [] }
  const api = {
    getLocaleMessages: vi.fn().mockResolvedValue({}),
    onLocaleChanged: vi.fn(() => () => {}),
    onPanelSwitch: vi.fn((cb: (d: { panel: string; installationId?: string }) => void) => {
      state.panelSwitchCallbacks.push(cb)
      return () => {}
    }),
    onSettingsChanged: vi.fn(() => () => {}),
  }
  ;(window as unknown as { api: typeof api }).api = api
  return state
}

describe('PanelApp', () => {
  let mockState: MockApiState

  beforeEach(() => {
    mockState = installMockApi()
    // Default URL — individual tests override.
    window.history.replaceState({}, '', '/?installationId=test-id')
  })

  it('renders the launcher-settings sub-view by default', async () => {
    const wrapper = mount(PanelApp, { global: { plugins: [createTestI18n()] } })
    await flushPromises()
    expect(wrapper.find('[data-testid="settings-view"]').exists()).toBe(true)
  })

  it('switches sub-view in response to onPanelSwitch IPC events', async () => {
    // Regression test for the mid-load race: a panel created with one initial
    // panel must still update when main pushes a different panel after load.
    const wrapper = mount(PanelApp, { global: { plugins: [createTestI18n()] } })
    await flushPromises()
    expect(wrapper.find('[data-testid="settings-view"]').exists()).toBe(true)

    expect(mockState.panelSwitchCallbacks.length).toBeGreaterThan(0)
    mockState.panelSwitchCallbacks.forEach((cb) => cb({ panel: 'install-settings' }))
    await flushPromises()
    expect(wrapper.find('[data-testid="settings-view"]').exists()).toBe(false)
  })

  it('ignores unknown panel keys from onPanelSwitch', async () => {
    const wrapper = mount(PanelApp, { global: { plugins: [createTestI18n()] } })
    await flushPromises()
    expect(wrapper.find('[data-testid="settings-view"]').exists()).toBe(true)

    mockState.panelSwitchCallbacks.forEach((cb) => cb({ panel: 'not-a-real-panel' }))
    await flushPromises()
    expect(wrapper.find('[data-testid="settings-view"]').exists()).toBe(true)
  })
})
