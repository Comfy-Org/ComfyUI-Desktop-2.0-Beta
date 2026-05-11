import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ElectronApi } from '../types/ipc'

vi.mock('../main', () => ({
  i18n: {
    global: {
      t: (key: string) => key,
    },
  },
}))

const mockAlert = vi.fn().mockResolvedValue(undefined)
vi.mock('../composables/useModal', () => ({
  useModal: () => ({
    alert: mockAlert,
    close: vi.fn(),
  }),
}))

// Modal teleports to <body>; replace with a transparent pass-through so
// wrapper.find() can still see the slotted content.
vi.mock('../components/Modal.vue', () => ({
  default: {
    name: 'Modal',
    props: ['binding', 'opacity', 'width', 'contentClass', 'inline'],
    template: '<div data-testid="modal-stub"><slot /></div>',
  },
}))

import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import SettingsView from './SettingsView.vue'

const messages = {
  en: {
    settings: {
      title: 'Settings',
      checkForUpdates: 'Check for updates',
      checkingForUpdates: 'Checking…',
    },
    update: {
      updateCheck: 'Update Check',
      updateError: 'Update Error',
      upToDate: 'You are running the latest version.',
      debUpToDate: 'Updates are delivered through your system package manager (apt).',
    },
    appUpdate: {
      fallbackVersion: 'this update',
      panelIdleTitle: 'Up to date',
      panelAvailableTitle: 'Update {version} available',
      panelReadyTitle: 'Update {version} ready',
      panelDownloadingTitle: 'Downloading {version}…',
      download: 'Download',
      downloading: 'Downloading…',
      restartNow: 'Restart & Update',
    },
  },
}

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'en',
    messages,
    missingWarn: false,
    fallbackWarn: false,
  })
}

function stubApi(overrides: Partial<ElectronApi> = {}): ElectronApi {
  return {
    // Main no longer emits a `'check-for-update'` action — the
    // dedicated AppUpdateAction section owns the affordance now. Stub
    // returns the General section without it so SettingsView's
    // sections-vs-AppUpdateAction split renders the same way it does
    // in production.
    getSettingsSections: vi.fn().mockResolvedValue([
      {
        title: 'General',
        fields: [],
      },
    ]),
    getUpdateCapabilities: vi.fn().mockResolvedValue({ canAutoUpdate: true, systemManaged: false }),
    checkForUpdate: vi.fn().mockResolvedValue({ available: false }),
    // AppUpdateAction owns the state-driven update affordance; it
    // fetches the snapshot on mount and subscribes for live pushes
    // (state, download-progress, and user-action-failed).
    getAppUpdateState: vi.fn().mockResolvedValue({ kind: null, version: null, autoUpdate: true }),
    onAppUpdateStateChanged: vi.fn(() => () => {}),
    onAppUpdateDownloadProgress: vi.fn(() => () => {}),
    onAppUpdateUserActionFailed: vi.fn(() => () => {}),
    openExternal: vi.fn(),
    // Unified Settings modal moved settings-mutation refresh into
    // SettingsView itself, so the component subscribes on mount —
    // tests need an `onSettingsChanged` mock that returns a no-op
    // unsubscribe function.
    onSettingsChanged: vi.fn(() => () => {}),
    ...overrides,
  } as unknown as ElectronApi
}

async function mountAndClickCheck(api: ElectronApi) {
  window.api = api
  const wrapper = mount(SettingsView, {
    global: {
      plugins: [createTestI18n()],
      stubs: { SettingField: true },
    },
  })

  await flushPromises()

  const buttons = wrapper.findAll('button')
  const checkButton = buttons.find((b) => b.text().includes('Check for updates'))
  expect(checkButton).toBeDefined()
  await checkButton!.trigger('click')
  await flushPromises()

  return wrapper
}

describe('SettingsView update check messaging', () => {
  beforeEach(() => {
    mockAlert.mockClear()
    vi.restoreAllMocks()
  })

  it('calls getUpdateCapabilities during loadSettings', async () => {
    const getUpdateCapabilities = vi.fn().mockResolvedValue({ canAutoUpdate: false, systemManaged: true })
    const api = stubApi({ getUpdateCapabilities })
    window.api = api

    mount(SettingsView, {
      global: {
        plugins: [createTestI18n()],
        stubs: { SettingField: true },
      },
    })

    await flushPromises()
    expect(getUpdateCapabilities).toHaveBeenCalled()
  })

  it('calls checkForUpdate when check-for-update action is clicked', async () => {
    const checkForUpdate = vi.fn().mockResolvedValue({ available: false })
    const api = stubApi({ checkForUpdate })
    await mountAndClickCheck(api)

    expect(checkForUpdate).toHaveBeenCalled()
  })

  it('shows standard up-to-date message for standard installs', async () => {
    const api = stubApi({
      getUpdateCapabilities: vi.fn().mockResolvedValue({ canAutoUpdate: true, systemManaged: false }),
      checkForUpdate: vi.fn().mockResolvedValue({ available: false }),
    })
    await mountAndClickCheck(api)

    expect(mockAlert).toHaveBeenCalledWith({
      title: 'Update Check',
      message: 'You are running the latest version.',
    })
  })

  it('shows apt-specific up-to-date message for system-managed installs', async () => {
    const api = stubApi({
      getUpdateCapabilities: vi.fn().mockResolvedValue({ canAutoUpdate: false, systemManaged: true }),
      checkForUpdate: vi.fn().mockResolvedValue({ available: false }),
    })
    await mountAndClickCheck(api)

    expect(mockAlert).toHaveBeenCalledWith({
      title: 'Update Check',
      message: 'Updates are delivered through your system package manager (apt).',
    })
  })
})
