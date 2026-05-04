import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

interface MockBridgeState {
  panelChangedCallbacks: ((panel: string) => void)[]
  titleChangedCallbacks: ((title: string) => void)[]
  themeChangedCallbacks: ((theme: { bg: string; text: string }) => void)[]
  fullscreenChangedCallbacks: ((fullscreen: boolean) => void)[]
  setPanelCalls: string[]
  newWindowCalls: number
  checkForUpdatesCalls: number
  readyCalls: number
}

function installMockBridge(opts: { isMac?: boolean; installationId?: string | null } = {}): MockBridgeState {
  const state: MockBridgeState = {
    panelChangedCallbacks: [],
    titleChangedCallbacks: [],
    themeChangedCallbacks: [],
    fullscreenChangedCallbacks: [],
    setPanelCalls: [],
    newWindowCalls: 0,
    checkForUpdatesCalls: 0,
    readyCalls: 0,
  }
  const installationId = opts.installationId === undefined ? 'test-id' : opts.installationId
  const bridge = {
    getInstallationId: () => installationId,
    isMac: () => !!opts.isMac,
    setPanel: (panel: string) => state.setPanelCalls.push(panel),
    openNewWindow: () => { state.newWindowCalls += 1 },
    checkForUpdates: () => { state.checkForUpdatesCalls += 1 },
    onPanelChanged: (cb: (panel: string) => void) => {
      state.panelChangedCallbacks.push(cb)
      return () => {}
    },
    onTitleChanged: (cb: (title: string) => void) => {
      state.titleChangedCallbacks.push(cb)
      return () => {}
    },
    onThemeChanged: (cb: (theme: { bg: string; text: string }) => void) => {
      state.themeChangedCallbacks.push(cb)
      return () => {}
    },
    onFullscreenChanged: (cb: (fullscreen: boolean) => void) => {
      state.fullscreenChangedCallbacks.push(cb)
      return () => {}
    },
    ready: () => {
      state.readyCalls += 1
    },
  }
  ;(window as unknown as { __comfyTitleBar: typeof bridge }).__comfyTitleBar = bridge
  return state
}

describe('TitleBarApp', () => {
  let bridgeState: MockBridgeState

  beforeEach(() => {
    bridgeState = installMockBridge()
    vi.resetModules()
  })

  it('renders File menu button and a center install pill', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    // File menu button on the left.
    const fileBtn = wrapper.find('.title-menu-button')
    expect(fileBtn.exists()).toBe(true)
    expect(fileBtn.text()).toContain('File')
    // Install pill in the center — install-backed (mock returns 'test-id')
    // so the caret button is present.
    expect(wrapper.find('.title-install-pill').exists()).toBe(true)
    expect(wrapper.find('.title-install-name').text()).toBe('ComfyUI')
    expect(wrapper.find('.title-install-caret').exists()).toBe(true)
  })

  it('signals readiness so main can push initial state', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    mount(TitleBarApp)
    await flushPromises()
    expect(bridgeState.readyCalls).toBe(1)
  })

  it('forwards center-pill clicks to bridge.setPanel("comfy")', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    await wrapper.find('.title-install-name').trigger('click')
    expect(bridgeState.setPanelCalls).toEqual(['comfy'])
  })

  it('opens the File menu and routes Desktop 2 Settings to setPanel("launcher-settings")', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    await wrapper.find('.title-menu-button').trigger('click')
    const items = wrapper.findAll('.title-menu-item')
    expect(items.length).toBe(2)
    const settingsItem = items.find((i) => i.text().includes('Desktop 2 Settings'))
    expect(settingsItem).toBeTruthy()
    await settingsItem!.trigger('click')
    expect(bridgeState.setPanelCalls).toEqual(['launcher-settings'])
  })

  it('opens the File menu and routes New Window to bridge.openNewWindow', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    await wrapper.find('.title-menu-button').trigger('click')
    const items = wrapper.findAll('.title-menu-item')
    const newWindowItem = items.find((i) => i.text().includes('New Window'))
    expect(newWindowItem).toBeTruthy()
    await newWindowItem!.trigger('click')
    expect(bridgeState.newWindowCalls).toBe(1)
  })

  it('opens the install caret menu and routes Install Settings to setPanel', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    await wrapper.find('.title-install-caret').trigger('click')
    const items = wrapper.findAll('.title-menu-item')
    expect(items.length).toBe(2)
    const installSettingsItem = items.find((i) => i.text().includes('Install Settings'))
    expect(installSettingsItem).toBeTruthy()
    await installSettingsItem!.trigger('click')
    expect(bridgeState.setPanelCalls).toEqual(['install-settings'])
  })

  it('opens the install caret menu and routes Check for Updates to bridge.checkForUpdates', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    await wrapper.find('.title-install-caret').trigger('click')
    const items = wrapper.findAll('.title-menu-item')
    const checkItem = items.find((i) => i.text().includes('Check for Updates'))
    expect(checkItem).toBeTruthy()
    await checkItem!.trigger('click')
    expect(bridgeState.checkForUpdatesCalls).toBe(1)
  })

  it('updates the install pill label when main pushes a title', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    bridgeState.titleChangedCallbacks.forEach((cb) => cb('MyInstall — Standalone'))
    await flushPromises()
    expect(wrapper.find('.title-install-name').text()).toBe('MyInstall — Standalone')
  })

  it('marks the install pill active when main reports the comfy panel is active', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    bridgeState.panelChangedCallbacks.forEach((cb) => cb('comfy'))
    await flushPromises()
    expect(wrapper.find('.title-install-pill').classes()).toContain('active')
  })

  it('applies the is-mac class when running on macOS', async () => {
    bridgeState = installMockBridge({ isMac: true })
    vi.resetModules()
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    expect(wrapper.find('header').classes()).toContain('is-mac')
  })

  it('hides the install caret in install-less host windows', async () => {
    // Phase 3 step 2c — install-less host windows (no installationId in
    // the URL, so the preload returns null) only expose the File menu.
    // The install pill name still renders (with the fallback label) but
    // the caret/dropdown is hidden because there's no install-scoped
    // menu to expose.
    bridgeState = installMockBridge({ installationId: null })
    vi.resetModules()
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    expect(wrapper.find('.title-install-name').exists()).toBe(true)
    expect(wrapper.find('.title-install-caret').exists()).toBe(false)
  })

  it('accepts the install-less fallback label pushed by main', async () => {
    bridgeState = installMockBridge({ installationId: null })
    vi.resetModules()
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    bridgeState.titleChangedCallbacks.forEach((cb) => cb('Choose an install'))
    await flushPromises()
    expect(wrapper.find('.title-install-name').text()).toBe('Choose an install')
  })

  it('toggles is-fullscreen in response to onFullscreenChanged', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    bridgeState.fullscreenChangedCallbacks.forEach((cb) => cb(true))
    await flushPromises()
    expect(wrapper.find('header').classes()).toContain('is-fullscreen')
    bridgeState.fullscreenChangedCallbacks.forEach((cb) => cb(false))
    await flushPromises()
    expect(wrapper.find('header').classes()).not.toContain('is-fullscreen')
  })
})
