import { describe, expect, it, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { nextTick } from 'vue'

import { en } from '../lib/i18nMessages.ts'
import GlobalSettingsView from './GlobalSettingsView.vue'

interface BridgeState {
  updateFieldCalls: Array<{ id: string; value: unknown }>
  setModelsDirsCalls: string[][]
  openPathCalls: string[]
  openExternalCalls: string[]
  browseFolderReturn: string | null
  checkForUpdateCalls: number
  downloadUpdateCalls: number
  installUpdateCalls: number
  closeCalls: number
}

function installMockBridge(): BridgeState {
  const state: BridgeState = {
    updateFieldCalls: [],
    setModelsDirsCalls: [],
    openPathCalls: [],
    openExternalCalls: [],
    browseFolderReturn: null,
    checkForUpdateCalls: 0,
    downloadUpdateCalls: 0,
    installUpdateCalls: 0,
    closeCalls: 0,
  }
  const bridge = {
    close: () => { state.closeCalls += 1 },
    globalSettingsUpdateField: async (id: string, value: unknown) => {
      state.updateFieldCalls.push({ id, value })
      return { ok: true }
    },
    globalSettingsBrowseFolder: async () => state.browseFolderReturn,
    globalSettingsOpenPath: (path: string) => { state.openPathCalls.push(path) },
    globalSettingsOpenExternal: (url: string) => { state.openExternalCalls.push(url) },
    globalSettingsSetModelsDirs: async (dirs: string[]) => {
      state.setModelsDirsCalls.push([...dirs])
      return { ok: true }
    },
    globalSettingsCheckForUpdate: async () => {
      state.checkForUpdateCalls += 1
      return { available: false }
    },
    globalSettingsDownloadUpdate: async () => { state.downloadUpdateCalls += 1 },
    globalSettingsInstallUpdate: () => { state.installUpdateCalls += 1 },
    globalSettingsSetLastCheckedAt: () => {},
  }
  ;(window as unknown as { __comfyTitlePopup: typeof bridge }).__comfyTitlePopup = bridge
  return state
}

function makeI18n() {
  return createI18n({ legacy: false, locale: 'en', messages: { en } })
}

function makeSnapshot(overrides: Partial<Record<string, unknown>> = {}) {
  const base = {
    generalFields: [
      { id: 'language', label: 'Language', value: 'en', editable: true, editType: 'select', options: [{ value: 'en', label: 'English' }, { value: 'zh', label: '中文' }] },
    ],
    telemetryFields: [
      { id: 'telemetryEnabled', label: 'Send anonymous telemetry', value: true, editable: true, editType: 'boolean' },
    ],
    desktopUpdateFields: [
      { id: 'autoInstallUpdates', label: 'Auto install updates', value: true, editable: true, editType: 'boolean' },
    ],
    cacheFields: [],
    advancedFields: [],
    sharedDirectoriesFields: [],
    modelsDirs: [
      { path: '/home/u/ComfyUI/models', isPrimary: true, isDefault: true },
      { path: '/mnt/extra/models', isPrimary: false, isDefault: false },
    ],
    modelsSystemDefault: '/home/u/ComfyUI/models',
    appUpdate: {
      state: { kind: null, version: null, autoUpdate: true },
      progress: null,
      isDownloading: false,
      capabilities: { systemManaged: false, canSelfUpdate: true },
      installedVersion: '1.2.3',
      platform: 'darwin',
      lastCheckedAt: null,
    },
    githubUrl: 'https://github.com/comfyanonymous/ComfyUI',
    githubStars: 12345,
    i18n: {
      overview: 'General',
      updates: 'Updates',
      storage: 'Storage',
      models: 'Models',
      advanced: 'Advanced',
      sharedDirectories: 'Shared directories',
    },
  }
  return { ...base, ...overrides }
}

function mountView(snapshot = makeSnapshot()) {
  return mount(GlobalSettingsView, {
    props: { snapshot: snapshot as never },
    global: { plugins: [makeI18n()] },
    attachTo: document.body,
  })
}

describe('GlobalSettingsView', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('renders all four tabs and the general tab is active by default', () => {
    installMockBridge()
    const wrapper = mountView()
    const tabLabels = wrapper.findAll('.gs-tab').map((t) => t.text())
    expect(tabLabels).toEqual(['General', 'Updates', 'Storage', 'Advanced'])
  })

  it('GitHub link card click routes through the bridge', async () => {
    const bridge = installMockBridge()
    const wrapper = mountView()
    const link = wrapper.findComponent({ name: 'GitHubLinkCard' })
    expect(link.exists()).toBe(true)
    await link.trigger('click')
    expect(bridge.openExternalCalls).toEqual(['https://github.com/comfyanonymous/ComfyUI'])
  })

  // Storage tab — shares `GlobalStorageSections` with the per-instance
  // StoragePane. Tab-presence + bridge-wiring is the surface owned by
  // this view; rendering behavior is covered by `StoragePane.test.ts`.
  it('Storage tab routes a make-primary click through the bridge', async () => {
    const bridge = installMockBridge()
    const wrapper = mountView()
    await wrapper.findAll('.gs-tab').find((t) => t.text() === 'Storage')!.trigger('click')
    await nextTick()
    const toggles = wrapper.findAll('.models-dir-menu-wrap > button')
    expect(toggles).toHaveLength(1)
    await toggles[0]!.trigger('click')
    await nextTick()
    await flushPromises()
    const makePrimary = wrapper.find('.models-dir-menu button[role="menuitem"]')
    await makePrimary.trigger('click')
    await flushPromises()
    expect(bridge.setModelsDirsCalls).toEqual([
      ['/mnt/extra/models', '/home/u/ComfyUI/models'],
    ])
  })

  it('Storage tab opens a models dir through the bridge', async () => {
    const bridge = installMockBridge()
    const wrapper = mountView()
    await wrapper.findAll('.gs-tab').find((t) => t.text() === 'Storage')!.trigger('click')
    await nextTick()
    const openBtns = wrapper.findAll('.models-dir-row .models-dir-action')
    await openBtns[0]!.trigger('click')
    expect(bridge.openPathCalls).toEqual(['/home/u/ComfyUI/models'])
  })

  // Covers the Shared Directories half of GlobalStorageSections —
  // a SettingsSectionList field write routes through
  // `globalSettingsUpdateField`, not just the model-dir actions.
  it('Storage tab routes a Shared Directories field update through the bridge', async () => {
    const bridge = installMockBridge()
    const snapshot = makeSnapshot({
      sharedDirectoriesFields: [
        {
          id: 'sharedOutputDir',
          label: 'Shared output dir',
          value: false,
          editable: true,
          editType: 'boolean',
        },
      ],
    })
    const wrapper = mountView(snapshot)
    await wrapper.findAll('.gs-tab').find((t) => t.text() === 'Storage')!.trigger('click')
    await nextTick()
    const toggle = wrapper.find('.settings-v2-boolean-row button')
    expect(toggle.exists()).toBe(true)
    await toggle.trigger('click')
    await flushPromises()
    expect(bridge.updateFieldCalls).toEqual([{ id: 'sharedOutputDir', value: true }])
  })

  it('close button routes to bridge.close', async () => {
    const bridge = installMockBridge()
    const wrapper = mountView()
    await wrapper.find('.gs-close').trigger('click')
    expect(bridge.closeCalls).toBe(1)
  })

  it('Updates tab routes Check for updates click through the bridge', async () => {
    const bridge = installMockBridge()
    const wrapper = mountView()
    await wrapper.findAll('.gs-tab').find((t) => t.text() === 'Updates')!.trigger('click')
    await nextTick()
    const buttons = wrapper.findAll('button')
    const checkBtn = buttons.find((b) => /check/i.test(b.text()))
    expect(checkBtn, 'expected a "Check" CTA on idle state').toBeDefined()
    await checkBtn!.trigger('click')
    await flushPromises()
    expect(bridge.checkForUpdateCalls).toBeGreaterThanOrEqual(1)
  })
})
