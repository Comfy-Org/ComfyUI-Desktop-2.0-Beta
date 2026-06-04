import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

interface MockDownloadsTrayEntry {
  url: string
  filename: string
  directory?: string
  progress: number
  status: 'pending' | 'downloading' | 'paused' | 'completed' | 'error' | 'cancelled'
  error?: string
}
interface MockDownloadsTrayState {
  active: MockDownloadsTrayEntry[]
  recent: MockDownloadsTrayEntry[]
}

interface MockBridgeState {
  panelChangedCallbacks: ((panel: string) => void)[]
  titleChangedCallbacks: ((title: string) => void)[]
  sourceCategoryChangedCallbacks: ((category: string | null) => void)[]
  zoomChangedCallbacks: ((level: number) => void)[]
  themeChangedCallbacks: ((theme: { bg: string; text: string }) => void)[]
  fullscreenChangedCallbacks: ((fullscreen: boolean) => void)[]
  menuOpenedCallbacks: ((info: { menu: 'menu' }) => void)[]
  menuClosedCallbacks: ((info: { menu: 'menu' }) => void)[]
  firstUseModeChangedCallbacks: ((mode: 'none' | 'consent-lockdown' | 'post-consent' | 'loading-lockdown') => void)[]
  previewModeChangedCallbacks: ((preview: boolean) => void)[]
  installationIdChangedCallbacks: ((installationId: string | null) => void)[]
  appUpdateStateCallbacks: ((state: {
    kind: 'available' | 'ready' | null
    version: string | null
    autoUpdate: boolean
  }) => void)[]
  installUpdateAvailableCallbacks: ((state: { available: boolean; version: string | null }) => void)[]
  downloadsChangedCallbacks: ((state: MockDownloadsTrayState) => void)[]
  setPanelCalls: string[]
  newWindowCalls: number
  fileMenuAnchors: { x: number; y: number }[]
  fileMenuDismisses: number
  appUpdatePillClicks: number
  installUpdatePillClicks: number
  downloadsTrayClicks: number
  installPillClicks: { x: number; y: number }[]
  feedbackClicks: number
  refreshInstanceClicks: number
  resetZoomClicks: number
  showTooltipCalls: { text: string; leftX: number; rightX: number; bottomY: number }[]
  hideTooltipCalls: number
  showCoachmarkCalls: {
    title: string
    body: string
    dismissLabel: string
    leftX: number
    rightX: number
    bottomY: number
  }[]
  hideCoachmarkCalls: number
  coachmarkDismissedCallbacks: (() => void)[]
  readyCalls: number
}

function installMockBridge(opts: { isMac?: boolean; installationId?: string | null } = {}): MockBridgeState {
  const state: MockBridgeState = {
    panelChangedCallbacks: [],
    titleChangedCallbacks: [],
    sourceCategoryChangedCallbacks: [],
    zoomChangedCallbacks: [],
    themeChangedCallbacks: [],
    fullscreenChangedCallbacks: [],
    menuOpenedCallbacks: [],
    menuClosedCallbacks: [],
    firstUseModeChangedCallbacks: [],
    previewModeChangedCallbacks: [],
    installationIdChangedCallbacks: [],
    appUpdateStateCallbacks: [],
    installUpdateAvailableCallbacks: [],
    downloadsChangedCallbacks: [],
    setPanelCalls: [],
    newWindowCalls: 0,
    fileMenuAnchors: [],
    fileMenuDismisses: 0,
    appUpdatePillClicks: 0,
    installUpdatePillClicks: 0,
    downloadsTrayClicks: 0,
    installPillClicks: [],
    feedbackClicks: 0,
    refreshInstanceClicks: 0,
    resetZoomClicks: 0,
    showTooltipCalls: [],
    hideTooltipCalls: 0,
    showCoachmarkCalls: [],
    hideCoachmarkCalls: 0,
    coachmarkDismissedCallbacks: [],
    readyCalls: 0,
  }
  const installationId = opts.installationId === undefined ? 'test-id' : opts.installationId
  const bridge = {
    getInstallationId: () => installationId,
    isMac: () => !!opts.isMac,
    setPanel: (panel: string) => state.setPanelCalls.push(panel),
    openNewWindow: () => { state.newWindowCalls += 1 },
    openFileMenu: (anchor: { x: number; y: number }) => { state.fileMenuAnchors.push(anchor) },
    dismissFileMenu: () => { state.fileMenuDismisses += 1 },
    onPanelChanged: (cb: (panel: string) => void) => {
      state.panelChangedCallbacks.push(cb)
      return () => { }
    },
    onTitleChanged: (cb: (title: string) => void) => {
      state.titleChangedCallbacks.push(cb)
      return () => { }
    },
    onSourceCategoryChanged: (cb: (category: string | null) => void) => {
      state.sourceCategoryChangedCallbacks.push(cb)
      return () => { }
    },
    onZoomChanged: (cb: (level: number) => void) => {
      state.zoomChangedCallbacks.push(cb)
      return () => { }
    },
    onThemeChanged: (cb: (theme: { bg: string; text: string }) => void) => {
      state.themeChangedCallbacks.push(cb)
      return () => { }
    },
    onFullscreenChanged: (cb: (fullscreen: boolean) => void) => {
      state.fullscreenChangedCallbacks.push(cb)
      return () => { }
    },
    onMenuOpened: (cb: (info: { menu: 'menu' }) => void) => {
      state.menuOpenedCallbacks.push(cb)
      return () => { }
    },
    onMenuClosed: (cb: (info: { menu: 'menu' }) => void) => {
      state.menuClosedCallbacks.push(cb)
      return () => { }
    },
    onFirstUseModeChanged: (cb: (mode: 'none' | 'consent-lockdown' | 'post-consent' | 'loading-lockdown') => void) => {
      state.firstUseModeChangedCallbacks.push(cb)
      return () => { }
    },
    onPreviewModeChanged: (cb: (preview: boolean) => void) => {
      state.previewModeChangedCallbacks.push(cb)
      return () => { }
    },
    onInstallationIdChanged: (cb: (installationId: string | null) => void) => {
      state.installationIdChangedCallbacks.push(cb)
      return () => { }
    },
    onAppUpdateStateChanged: (
      cb: (next: {
        kind: 'available' | 'ready' | null
        version: string | null
        autoUpdate: boolean
      }) => void,
    ) => {
      state.appUpdateStateCallbacks.push(cb)
      return () => { }
    },
    onInstallUpdateAvailable: (cb: (next: { available: boolean; version: string | null }) => void) => {
      state.installUpdateAvailableCallbacks.push(cb)
      return () => { }
    },
    clickAppUpdatePill: () => {
      state.appUpdatePillClicks += 1
    },
    clickInstallUpdatePill: () => {
      state.installUpdatePillClicks += 1
    },
    onDownloadsChanged: (cb: (next: MockDownloadsTrayState) => void) => {
      state.downloadsChangedCallbacks.push(cb)
      return () => { }
    },
    clickDownloadsTray: () => {
      state.downloadsTrayClicks += 1
    },
    clickInstallPill: (anchor: { x: number; y: number }) => {
      state.installPillClicks.push(anchor)
    },
    clickFeedback: () => {
      state.feedbackClicks += 1
    },
    clickRefreshInstance: () => {
      state.refreshInstanceClicks += 1
    },
    resetZoom: () => {
      state.resetZoomClicks += 1
    },
    showTooltip: (payload: { text: string; leftX: number; rightX: number; bottomY: number }) => {
      state.showTooltipCalls.push(payload)
    },
    hideTooltip: () => {
      state.hideTooltipCalls += 1
    },
    showCoachmark: (payload: {
      title: string
      body: string
      dismissLabel: string
      leftX: number
      rightX: number
      bottomY: number
    }) => {
      state.showCoachmarkCalls.push(payload)
    },
    hideCoachmark: () => {
      state.hideCoachmarkCalls += 1
    },
    onCoachmarkDismissed: (cb: () => void) => {
      state.coachmarkDismissedCallbacks.push(cb)
      return () => {}
    },
    ready: () => {
      state.readyCalls += 1
    },
  }
    ; (window as unknown as { __comfyTitleBar: typeof bridge }).__comfyTitleBar = bridge
  return state
}

describe('TitleBarApp', () => {
  let bridgeState: MockBridgeState

  beforeEach(() => {
    bridgeState = installMockBridge()
    vi.resetModules()
  })

  it('renders the app menu button and a center install pill', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    // Icon-only so the host-app menu doesn't clash with ComfyUI's own File menu.
    const fileBtn = wrapper.find('.title-menu-button')
    expect(fileBtn.exists()).toBe(true)
    expect(fileBtn.attributes('aria-label')).toBe('Menu')
    expect(fileBtn.classes()).toContain('title-menu-button--icon')
    const pill = wrapper.find('.title-install-pill')
    expect(pill.exists()).toBe(true)
    // role=button div (not native <button>) so it can hold the nested Update chip.
    expect(pill.element.tagName).toBe('DIV')
    expect(pill.attributes('role')).toBe('button')
    expect(pill.attributes('aria-haspopup')).toBe('dialog')
    expect(wrapper.find('.title-install-name').text()).toBe('ComfyUI')
    expect(wrapper.find('.title-install-caret').exists()).toBe(true)
  })

  it('signals readiness so main can push initial state', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    mount(TitleBarApp)
    await flushPromises()
    expect(bridgeState.readyCalls).toBe(1)
  })

  it('routes pill clicks to the install-picker bridge handler with an anchor', async () => {
    // Pill click opens the picker popup, NOT a `setPanel` route.
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp, { attachTo: document.body })
    await flushPromises()
    await wrapper.find('.title-install-pill').trigger('click')
    expect(bridgeState.setPanelCalls).toEqual([])
    expect(bridgeState.installPillClicks.length).toBe(1)
    const anchor = bridgeState.installPillClicks[0]!
    expect(typeof anchor.x).toBe('number')
    expect(typeof anchor.y).toBe('number')
    wrapper.unmount()
  })

  it('asks main to pop the native File menu when the File button is clicked', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp, { attachTo: document.body })
    await flushPromises()
    await wrapper.find('.title-menu-button').trigger('click')
    expect(bridgeState.fileMenuAnchors.length).toBe(1)
    // jsdom returns 0/0 rects; assert the anchor contract is well-formed.
    const anchor = bridgeState.fileMenuAnchors[0]!
    expect(typeof anchor.x).toBe('number')
    expect(typeof anchor.y).toBe('number')
    wrapper.unmount()
  })

  it('renders the install-less pill as an interactive opener for the instance picker', async () => {
    bridgeState = installMockBridge({ installationId: null })
    vi.resetModules()
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp, { attachTo: document.body })
    await flushPromises()
    const pill = wrapper.find('.title-install-pill')
    expect(pill.exists()).toBe(true)
    expect(pill.element.tagName).toBe('DIV')
    expect(pill.attributes('role')).toBe('button')
    expect(pill.classes()).toContain('is-install-less')
    expect(wrapper.find('.title-install-caret').exists()).toBe(true)
    wrapper.unmount()
  })

  it('updates the install pill label when main pushes a title', async () => {
    // The install name reads bare; the category surfaces as an icon.
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    bridgeState.titleChangedCallbacks.forEach((cb) => cb('MyInstall'))
    await flushPromises()
    expect(wrapper.find('.title-install-name').text()).toBe('MyInstall')
  })

  it('does not mark the install pill active for any panel — pill is an identity label, not a tab', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    bridgeState.panelChangedCallbacks.forEach((cb) => cb('comfy'))
    await flushPromises()
    expect(wrapper.find('.title-install-pill').classes()).not.toContain('active')
    bridgeState.panelChangedCallbacks.forEach((cb) => cb('settings'))
    await flushPromises()
    expect(wrapper.find('.title-install-pill').classes()).not.toContain('active')
  })

  it('does not render any title-bar nav buttons (back/forward chevrons removed with the takeover layout)', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    expect(wrapper.findAll('.title-nav-button').length).toBe(0)
  })

  it('applies the is-mac class when running on macOS', async () => {
    bridgeState = installMockBridge({ isMac: true })
    vi.resetModules()
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    expect(wrapper.find('header').classes()).toContain('is-mac')
  })

  it('shows the dropdown caret on install-less host windows so the picker opener reads as actionable', async () => {
    bridgeState = installMockBridge({ installationId: null })
    vi.resetModules()
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    expect(wrapper.find('.title-install-name').exists()).toBe(true)
    expect(wrapper.find('.title-install-caret').exists()).toBe(true)
  })

  it('accepts the install-less fallback label pushed by main', async () => {
    bridgeState = installMockBridge({ installationId: null })
    vi.resetModules()
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    bridgeState.titleChangedCallbacks.forEach((cb) => cb('Comfy Desktop'))
    await flushPromises()
    expect(wrapper.find('.title-install-name').text()).toBe('Comfy Desktop')
  })

  it('suppresses menu re-open immediately after a menu close (click-to-toggle dismiss)', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp, { attachTo: document.body })
    await flushPromises()

    await wrapper.find('.title-menu-button').trigger('click')
    expect(bridgeState.fileMenuAnchors.length).toBe(1)

    // Simulate the close callback stamping the suppression timestamp.
    bridgeState.menuClosedCallbacks.forEach((cb) => cb({ menu: 'menu' }))
    await flushPromises()

    // Second click within the suppression window must NOT open the menu.
    await wrapper.find('.title-menu-button').trigger('click')
    expect(bridgeState.fileMenuAnchors.length).toBe(1)

    wrapper.unmount()
  })

  it('locks chrome through the first-use takeover and restores it during loading-lockdown', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    // Steady state — every button is rendered.
    expect(wrapper.find('.title-menu-button--icon').exists()).toBe(true)
    expect(wrapper.find('.title-downloads-tray').exists()).toBe(true)
    expect(wrapper.find('.title-feedback-button').exists()).toBe(true)
    expect(wrapper.find('.title-install-pill.is-interactive').exists()).toBe(true)
    expect(wrapper.find('header').classes()).not.toContain('is-consent-lockdown')

    // Consent step — full strip.
    bridgeState.firstUseModeChangedCallbacks.forEach((cb) => cb('consent-lockdown'))
    await flushPromises()
    expect(wrapper.find('header').classes()).toContain('is-consent-lockdown')
    expect(wrapper.find('.title-menu-button--icon').exists()).toBe(false)
    expect(wrapper.find('.title-downloads-tray').exists()).toBe(false)
    expect(wrapper.find('.title-feedback-button').exists()).toBe(false)
    expect(wrapper.find('.title-install-pill.is-interactive').exists()).toBe(false)

    // Post-consent — waffle returns (Skip Onboarding lives there); rest hidden.
    bridgeState.firstUseModeChangedCallbacks.forEach((cb) => cb('post-consent'))
    await flushPromises()
    expect(wrapper.find('header').classes()).not.toContain('is-consent-lockdown')
    expect(wrapper.find('.title-menu-button--icon').exists()).toBe(true)
    expect(wrapper.find('.title-downloads-tray').exists()).toBe(false)
    expect(wrapper.find('.title-feedback-button').exists()).toBe(false)
    expect(wrapper.find('.title-install-pill.is-interactive').exists()).toBe(false)

    // Loading-lockdown — every chrome button stays live (not a chrome lockdown).
    bridgeState.firstUseModeChangedCallbacks.forEach((cb) => cb('loading-lockdown'))
    await flushPromises()
    expect(wrapper.find('header').classes()).not.toContain('is-consent-lockdown')
    expect(wrapper.find('.title-menu-button--icon').exists()).toBe(true)
    expect(wrapper.find('.title-downloads-tray').exists()).toBe(true)
    expect(wrapper.find('.title-feedback-button').exists()).toBe(true)
    expect(wrapper.find('.title-install-pill.is-interactive').exists()).toBe(true)

    // Takeover dismissed — back to steady state.
    bridgeState.firstUseModeChangedCallbacks.forEach((cb) => cb('none'))
    await flushPromises()
    expect(wrapper.find('header').classes()).not.toContain('is-consent-lockdown')
    expect(wrapper.find('.title-menu-button--icon').exists()).toBe(true)
    expect(wrapper.find('.title-downloads-tray').exists()).toBe(true)
    expect(wrapper.find('.title-feedback-button').exists()).toBe(true)
    expect(wrapper.find('.title-install-pill.is-interactive').exists()).toBe(true)
    wrapper.unmount()
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

  it('hides the install-type icon by default until main pushes a category', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    expect(wrapper.find('.title-install-type-icon').exists()).toBe(false)
  })

  it('renders the install-type icon when main pushes a recognized source category', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    bridgeState.sourceCategoryChangedCallbacks.forEach((cb) => cb('local'))
    await flushPromises()
    const icon = wrapper.find('.title-install-type-icon')
    expect(icon.exists()).toBe(true)
    // Tooltip mirrors the i18n `installType.standalone` value.
    expect(icon.attributes('title')).toBe('Standalone')
    expect(icon.attributes('aria-label')).toBe('Standalone')
  })

  it('switches the install-type icon tooltip when main pushes a different category', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    bridgeState.sourceCategoryChangedCallbacks.forEach((cb) => cb('cloud'))
    await flushPromises()
    expect(wrapper.find('.title-install-type-icon').attributes('title')).toBe('Cloud')
    bridgeState.sourceCategoryChangedCallbacks.forEach((cb) => cb('desktop'))
    await flushPromises()
    expect(wrapper.find('.title-install-type-icon').attributes('title')).toBe('Legacy Desktop')
  })

  it('suppresses the install-type icon on install-less host windows even when a category arrives', async () => {
    bridgeState = installMockBridge({ installationId: null })
    vi.resetModules()
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    bridgeState.sourceCategoryChangedCallbacks.forEach((cb) => cb('local'))
    await flushPromises()
    expect(wrapper.find('.title-install-type-icon').exists()).toBe(false)
  })

  it('hides the install-type icon when main pushes null (e.g. unresolved source)', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    bridgeState.sourceCategoryChangedCallbacks.forEach((cb) => cb('local'))
    await flushPromises()
    expect(wrapper.find('.title-install-type-icon').exists()).toBe(true)
    bridgeState.sourceCategoryChangedCallbacks.forEach((cb) => cb(null))
    await flushPromises()
    expect(wrapper.find('.title-install-type-icon').exists()).toBe(false)
  })


  it('hides both status pills by default (no update available, no install update)', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    expect(wrapper.find('.title-update-pill.is-app-update').exists()).toBe(false)
    expect(wrapper.find('.title-update-pill.is-install-update').exists()).toBe(false)
  })

  it('renders the app-update pill with "Desktop Update" copy when state.kind=available (auto-updates OFF)', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    bridgeState.appUpdateStateCallbacks.forEach((cb) =>
      cb({ kind: 'available', version: '2.3.4', autoUpdate: false }),
    )
    await flushPromises()
    const pill = wrapper.find('.title-update-pill.is-app-update')
    expect(pill.exists()).toBe(true)
    expect(pill.classes()).not.toContain('is-ready')
    expect(pill.text()).toContain('Desktop Update')
    expect(pill.attributes('title')).toBe('Desktop Update (v2.3.4)')
    expect(pill.attributes('aria-label')).toBe('Desktop Update (v2.3.4)')
  })

  it('renders the app-update pill with "Desktop Update Ready" copy when state.kind=ready (auto-updates OFF)', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    bridgeState.appUpdateStateCallbacks.forEach((cb) =>
      cb({ kind: 'ready', version: '2.3.4', autoUpdate: false }),
    )
    await flushPromises()
    const pill = wrapper.find('.title-update-pill.is-app-update')
    expect(pill.exists()).toBe(true)
    expect(pill.classes()).toContain('is-ready')
    expect(pill.text()).toContain('Desktop Update Ready')
    expect(pill.attributes('title')).toBe('Desktop Update Ready (v2.3.4)')
  })

  it('renders the app-update pill with "Desktop Update Ready" copy when state.kind=ready (auto-updates ON)', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    bridgeState.appUpdateStateCallbacks.forEach((cb) =>
      cb({ kind: 'ready', version: '2.3.4', autoUpdate: true }),
    )
    await flushPromises()
    const pill = wrapper.find('.title-update-pill.is-app-update')
    expect(pill.exists()).toBe(true)
    expect(pill.classes()).toContain('is-ready')
    expect(pill.text()).toContain('Desktop Update Ready')
  })

  it('renders the install-update chip inside the center pill when onInstallUpdateAvailable=true', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    expect(wrapper.find('.title-install-update-chip').exists()).toBe(false)
    bridgeState.installUpdateAvailableCallbacks.forEach((cb) => cb({ available: true, version: null }))
    await flushPromises()
    const chip = wrapper.find('.title-install-update-chip')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toBe('Update')
  })

  it('keeps the chip label short and carries the version in its tooltip', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    bridgeState.installUpdateAvailableCallbacks.forEach((cb) =>
      cb({ available: true, version: 'v1.2.3' }),
    )
    await flushPromises()
    const chip = wrapper.find('.title-install-update-chip')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toBe('Update')
    expect(chip.attributes('title')).toBe('ComfyUI v1.2.3')
    expect(chip.attributes('aria-label')).toBe('ComfyUI v1.2.3')
  })

  it('suppresses the install-update pill on install-less host windows even when push fires', async () => {
    bridgeState = installMockBridge({ installationId: null })
    vi.resetModules()
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    bridgeState.installUpdateAvailableCallbacks.forEach((cb) => cb({ available: true, version: null }))
    await flushPromises()
    expect(wrapper.find('.title-install-update-chip').exists()).toBe(false)
  })

  it('forwards app-update pill clicks through the bridge', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp, { attachTo: document.body })
    await flushPromises()
    bridgeState.appUpdateStateCallbacks.forEach((cb) =>
      cb({ kind: 'available', version: '1.0.0', autoUpdate: false }),
    )
    await flushPromises()
    await wrapper.find('.title-update-pill.is-app-update').trigger('click')
    expect(bridgeState.appUpdatePillClicks).toBe(1)
    wrapper.unmount()
  })

  it('forwards install-update chip clicks through the bridge', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp, { attachTo: document.body })
    await flushPromises()
    bridgeState.installUpdateAvailableCallbacks.forEach((cb) => cb({ available: true, version: null }))
    await flushPromises()
    await wrapper.find('.title-install-update-chip').trigger('click')
    expect(bridgeState.installUpdatePillClicks).toBe(1)
    wrapper.unmount()
  })

  it('hides the app-update pill when state transitions back to kind=null', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    bridgeState.appUpdateStateCallbacks.forEach((cb) =>
      cb({ kind: 'ready', version: '2.0.0', autoUpdate: false }),
    )
    await flushPromises()
    expect(wrapper.find('.title-update-pill.is-app-update').exists()).toBe(true)
    bridgeState.appUpdateStateCallbacks.forEach((cb) =>
      cb({ kind: null, version: null, autoUpdate: true }),
    )
    await flushPromises()
    expect(wrapper.find('.title-update-pill.is-app-update').exists()).toBe(false)
  })

  it('renders the downloads tray with no badge in the empty steady state', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    const tray = wrapper.find('.title-downloads-tray')
    expect(tray.exists()).toBe(true)
    expect(wrapper.find('.title-downloads-badge').exists()).toBe(false)
    expect(tray.attributes('title')).toBe('Downloads')
  })

  it('renders the downloads tray with a badge counter when there are in-flight downloads', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    bridgeState.downloadsChangedCallbacks.forEach((cb) =>
      cb({
        active: [
          {
            url: 'https://example.com/a.safetensors',
            filename: 'a.safetensors',
            directory: 'checkpoints',
            progress: 0.4,
            status: 'downloading',
          },
          {
            url: 'https://example.com/b.safetensors',
            filename: 'b.safetensors',
            directory: 'loras',
            progress: 0.1,
            status: 'pending',
          },
        ],
        recent: [],
      }),
    )
    await flushPromises()
    const tray = wrapper.find('.title-downloads-tray')
    expect(tray.exists()).toBe(true)
    // Badge shows the in-flight count; recent entries don't bump it.
    const badge = wrapper.find('.title-downloads-badge')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('2')
    expect(tray.attributes('title')).toBe('2 downloads in progress')
    expect(tray.attributes('aria-label')).toBe('2 downloads in progress')
  })

  it('treats recent entries already present on the first push as already-acknowledged', async () => {
    // `recent` entries in the initial push finished before this window opened,
    // so the unseen indicator must not misfire on mount.
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    bridgeState.downloadsChangedCallbacks.forEach((cb) =>
      cb({
        active: [],
        recent: [
          {
            url: 'https://example.com/a.safetensors',
            filename: 'a.safetensors',
            directory: 'checkpoints',
            progress: 1,
            status: 'completed',
          },
        ],
      }),
    )
    await flushPromises()
    expect(wrapper.find('.title-downloads-tray').exists()).toBe(true)
    expect(wrapper.find('.title-downloads-badge').exists()).toBe(false)
    expect(wrapper.find('.title-downloads-tray').classes()).not.toContain('has-unseen')
    expect(wrapper.find('.title-downloads-tray').attributes('title')).toBe('Downloads')
  })

  it('marks the tray as unseen when a download completes after the initial state', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    bridgeState.downloadsChangedCallbacks.forEach((cb) =>
      cb({ active: [], recent: [] }),
    )
    await flushPromises()
    bridgeState.downloadsChangedCallbacks.forEach((cb) =>
      cb({
        active: [
          {
            url: 'https://example.com/a.safetensors',
            filename: 'a.safetensors',
            progress: 0.4,
            status: 'downloading',
          },
        ],
        recent: [],
      }),
    )
    await flushPromises()
    bridgeState.downloadsChangedCallbacks.forEach((cb) =>
      cb({
        active: [],
        recent: [
          {
            url: 'https://example.com/a.safetensors',
            filename: 'a.safetensors',
            progress: 1,
            status: 'completed',
          },
        ],
      }),
    )
    await flushPromises()
    const tray = wrapper.find('.title-downloads-tray')
    expect(tray.classes()).toContain('has-unseen')
    expect(tray.classes()).not.toContain('has-active')
    const badge = wrapper.find('.title-downloads-badge.is-unseen')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('1')
    expect(tray.attributes('title')).toBe('1 download finished — click to review')
  })

  it('clears the unseen indicator when the downloads popup is opened', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    bridgeState.downloadsChangedCallbacks.forEach((cb) =>
      cb({ active: [], recent: [] }),
    )
    await flushPromises()
    bridgeState.downloadsChangedCallbacks.forEach((cb) =>
      cb({
        active: [],
        recent: [
          {
            url: 'https://example.com/a.safetensors',
            filename: 'a.safetensors',
            progress: 1,
            status: 'completed',
          },
        ],
      }),
    )
    await flushPromises()
    expect(wrapper.find('.title-downloads-tray').classes()).toContain('has-unseen')
    bridgeState.menuOpenedCallbacks.forEach((cb) =>
      cb({ menu: 'downloads' } as { menu: 'menu' }),
    )
    await flushPromises()
    const tray = wrapper.find('.title-downloads-tray')
    expect(tray.classes()).not.toContain('has-unseen')
    expect(wrapper.find('.title-downloads-badge.is-unseen').exists()).toBe(false)
    expect(tray.attributes('title')).toBe('Downloads')
  })

  it('flashes the tray when a brand-new active download appears', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    // Initial empty state so the next push counts as a real new arrival.
    bridgeState.downloadsChangedCallbacks.forEach((cb) =>
      cb({ active: [], recent: [] }),
    )
    await flushPromises()
    bridgeState.downloadsChangedCallbacks.forEach((cb) =>
      cb({
        active: [
          {
            url: 'https://example.com/a.safetensors',
            filename: 'a.safetensors',
            progress: 0.1,
            status: 'pending',
          },
        ],
        recent: [],
      }),
    )
    await flushPromises()
    expect(wrapper.find('.title-downloads-tray').classes()).toContain('is-flashing')
  })

  it('uses singular copy when exactly one download is in flight', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    bridgeState.downloadsChangedCallbacks.forEach((cb) =>
      cb({
        active: [
          {
            url: 'https://example.com/a.safetensors',
            filename: 'a.safetensors',
            directory: 'checkpoints',
            progress: 0.4,
            status: 'downloading',
          },
        ],
        recent: [],
      }),
    )
    await flushPromises()
    expect(wrapper.find('.title-downloads-tray').attributes('title')).toBe('1 download in progress')
  })

  it('clears the badge when the state transitions back to empty (button stays visible)', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    bridgeState.downloadsChangedCallbacks.forEach((cb) =>
      cb({
        active: [
          {
            url: 'https://example.com/a.safetensors',
            filename: 'a.safetensors',
            directory: 'checkpoints',
            progress: 0.5,
            status: 'downloading',
          },
        ],
        recent: [],
      }),
    )
    await flushPromises()
    expect(wrapper.find('.title-downloads-tray').exists()).toBe(true)
    expect(wrapper.find('.title-downloads-badge').exists()).toBe(true)
    bridgeState.downloadsChangedCallbacks.forEach((cb) => cb({ active: [], recent: [] }))
    await flushPromises()
    expect(wrapper.find('.title-downloads-tray').exists()).toBe(true)
    expect(wrapper.find('.title-downloads-badge').exists()).toBe(false)
  })

  it('forwards downloads-tray clicks through the bridge', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp, { attachTo: document.body })
    await flushPromises()
    bridgeState.downloadsChangedCallbacks.forEach((cb) =>
      cb({
        active: [
          {
            url: 'https://example.com/a.safetensors',
            filename: 'a.safetensors',
            directory: 'checkpoints',
            progress: 0.5,
            status: 'downloading',
          },
        ],
        recent: [],
      }),
    )
    await flushPromises()
    await wrapper.find('.title-downloads-tray').trigger('click')
    expect(bridgeState.downloadsTrayClicks).toBe(1)
    wrapper.unmount()
  })

  it('renders a Send Feedback button and forwards clicks through the bridge', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp, { attachTo: document.body })
    await flushPromises()
    const btn = wrapper.find('.title-feedback-button')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('aria-label')).toBe('Feedback')
    expect(btn.text()).toBe('')
    await btn.trigger('click')
    expect(bridgeState.feedbackClicks).toBe(1)
    wrapper.unmount()
  })

  it('hides the Send Feedback button for the full first-use takeover (consent + post-consent)', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    bridgeState.firstUseModeChangedCallbacks.forEach((cb) => cb('consent-lockdown'))
    await flushPromises()
    expect(wrapper.find('.title-feedback-button').exists()).toBe(false)
    bridgeState.firstUseModeChangedCallbacks.forEach((cb) => cb('post-consent'))
    await flushPromises()
    expect(wrapper.find('.title-feedback-button').exists()).toBe(false)
    bridgeState.firstUseModeChangedCallbacks.forEach((cb) => cb('none'))
    await flushPromises()
    expect(wrapper.find('.title-feedback-button').exists()).toBe(true)
  })

  it('renders the downloads tray on install-less (chooser-host) windows too — downloads are global, not per-install', async () => {
    bridgeState = installMockBridge({ installationId: null })
    vi.resetModules()
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    bridgeState.downloadsChangedCallbacks.forEach((cb) =>
      cb({
        active: [
          {
            url: 'https://example.com/a.safetensors',
            filename: 'a.safetensors',
            directory: 'checkpoints',
            progress: 0.5,
            status: 'downloading',
          },
        ],
        recent: [],
      }),
    )
    await flushPromises()
    expect(wrapper.find('.title-downloads-tray').exists()).toBe(true)
  })

  // macOS routes hover through the bridge; Win/Linux must use the native
  // `title` only (else two tooltips render).
  it('does NOT route hover through showTooltip on Win/Linux (native title is reliable there)', async () => {
    bridgeState = installMockBridge({ isMac: false })
    vi.resetModules()
    vi.useFakeTimers()
    try {
      const { default: TitleBarApp } = await import('./TitleBarApp.vue')
      const wrapper = mount(TitleBarApp, { attachTo: document.body })
      await flushPromises()
      const btn = wrapper.find('.title-menu-button').element as HTMLElement
      // Dispatch on the button so it bubbles to the window-level listener.
      btn.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }))
      // Even past the show delay the bridge should NOT be called on Win/Linux.
      vi.advanceTimersByTime(1000)
      await flushPromises()
      expect(bridgeState.showTooltipCalls.length).toBe(0)
      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits `title` only on Win/Linux and `data-title-tooltip` only on macOS so the two tooltip systems can never both fire', async () => {
    bridgeState = installMockBridge({ isMac: true })
    vi.resetModules()
    {
      const { default: TitleBarApp } = await import('./TitleBarApp.vue')
      const wrapper = mount(TitleBarApp)
      await flushPromises()
      const btn = wrapper.find('.title-menu-button')
      expect(btn.attributes('aria-label')).toBe('Menu')
      expect(btn.attributes('data-title-tooltip')).toBe('Menu')
      expect(btn.attributes('title')).toBeUndefined()
      wrapper.unmount()
    }
    bridgeState = installMockBridge({ isMac: false })
    vi.resetModules()
    {
      const { default: TitleBarApp } = await import('./TitleBarApp.vue')
      const wrapper = mount(TitleBarApp)
      await flushPromises()
      const btn = wrapper.find('.title-menu-button')
      expect(btn.attributes('aria-label')).toBe('Menu')
      expect(btn.attributes('title')).toBe('Menu')
      expect(btn.attributes('data-title-tooltip')).toBeUndefined()
      wrapper.unmount()
    }
  })

  it('routes hover through showTooltip on macOS, with the trigger text and anchor', async () => {
    bridgeState = installMockBridge({ isMac: true })
    vi.resetModules()
    vi.useFakeTimers()
    try {
      const { default: TitleBarApp } = await import('./TitleBarApp.vue')
      const wrapper = mount(TitleBarApp, { attachTo: document.body })
      await flushPromises()
      const btn = wrapper.find('.title-menu-button').element as HTMLElement
      // Stub a deterministic geometry — JSDOM returns 0×0 by default.
      btn.getBoundingClientRect = () =>
        ({ left: 20, top: 6, right: 50, bottom: 30, width: 30, height: 24, x: 20, y: 6 } as DOMRect)
      btn.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }))
      // Advance past the show delay.
      vi.advanceTimersByTime(500)
      await flushPromises()
      expect(bridgeState.showTooltipCalls.length).toBe(1)
      const call = bridgeState.showTooltipCalls[0]
      expect(call.text).toBe('Menu')
      // Both edges sent so main can anchor left, falling back to right on overflow.
      expect(call.leftX).toBe(20)
      expect(call.rightX).toBe(50)
      expect(call.bottomY).toBe(30)
      const root = wrapper.find('header').element as HTMLElement
      root.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }))
      // The listener is on documentElement; dispatch there too since JSDOM
      // doesn't bubble custom PointerEvents to the document root.
      document.documentElement.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }))
      await flushPromises()
      expect(bridgeState.hideTooltipCalls).toBeGreaterThanOrEqual(1)
      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  // Centered-pill mirror: the trailing cluster's width is reflected onto
  // `--title-trailing-width`, which the left cluster reads as `min-width` so the
  // centre track stays equidistant and the pill anchors to true window centre.
  describe('trailing-width mirror (true-centered install pill)', () => {
    type ResizeCallback = (entries: ResizeObserverEntry[], obs: ResizeObserver) => void
    interface ResizeObserverHandle {
      observed: Element[]
      fire: (width: number) => void
    }

    let handles: ResizeObserverHandle[]
    let originalResizeObserver: typeof globalThis.ResizeObserver | undefined

    function installStub(): void {
      function StubCtor(this: unknown, cb: ResizeCallback) {
        const self = this as { observed: Element[]; cb: ResizeCallback }
        self.observed = []
        self.cb = cb
        const handle: ResizeObserverHandle = {
          observed: self.observed,
          fire(width: number) {
            self.cb(
              [{ contentRect: { width, height: 28 } as DOMRectReadOnly } as ResizeObserverEntry],
              self as unknown as ResizeObserver,
            )
          },
        }
        handles.push(handle)
      }
      StubCtor.prototype.observe = function observe(this: { observed: Element[] }, el: Element) {
        this.observed.push(el)
      }
      StubCtor.prototype.disconnect = function disconnect(this: { observed: Element[] }) {
        this.observed.length = 0
      }
      StubCtor.prototype.unobserve = function unobserve() {
        // no-op
      }
      ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
        StubCtor as unknown as typeof globalThis.ResizeObserver
    }

    beforeEach(() => {
      handles = []
      originalResizeObserver = (globalThis as { ResizeObserver?: typeof globalThis.ResizeObserver })
        .ResizeObserver
      installStub()
    })

    afterEach(() => {
      if (originalResizeObserver) {
        ;(globalThis as { ResizeObserver?: typeof globalThis.ResizeObserver }).ResizeObserver =
          originalResizeObserver
      } else {
        delete (globalThis as { ResizeObserver?: typeof globalThis.ResizeObserver }).ResizeObserver
      }
    })

    it('observes the trailing cluster on mount and disconnects on unmount', async () => {
      const mod = await import('./TitleBarApp.vue')
      const wrapper = mount(mod.default, { attachTo: document.body })
      await flushPromises()
      // Two observers: the trailing-cluster mirror (this test) and the fit controller.
      expect(handles).toHaveLength(2)
      const trailingEl = wrapper.find('.title-trailing').element
      const handle = handles.find((h) => h.observed[0] === trailingEl)
      expect(handle).toBeDefined()
      wrapper.unmount()
      for (const h of handles) {
        expect(h.observed).toHaveLength(0)
      }
    })

    it('mirrors trailing width onto the title bar as `--title-trailing-width`', async () => {
      const mod = await import('./TitleBarApp.vue')
      const wrapper = mount(mod.default, { attachTo: document.body })
      await flushPromises()
      const titleBar = wrapper.find('.title-bar').element as HTMLElement
      const handle = handles[0]!
      // Initial state — no resize fired yet, var resolves to 0px.
      expect(titleBar.style.getPropertyValue('--title-trailing-width')).toBe('0px')
      handle.fire(240)
      await flushPromises()
      expect(titleBar.style.getPropertyValue('--title-trailing-width')).toBe('240px')
      handle.fire(520)
      await flushPromises()
      expect(titleBar.style.getPropertyValue('--title-trailing-width')).toBe('520px')
      wrapper.unmount()
    })

    it('does not update the CSS var when the width is unchanged (avoids redundant style writes)', async () => {
      const mod = await import('./TitleBarApp.vue')
      const wrapper = mount(mod.default, { attachTo: document.body })
      await flushPromises()
      const titleBar = wrapper.find('.title-bar').element as HTMLElement
      const handle = handles[0]!
      handle.fire(300)
      await flushPromises()
      expect(titleBar.style.getPropertyValue('--title-trailing-width')).toBe('300px')
      // Firing the same width is a no-op (the callback guards the assignment).
      handle.fire(300)
      await flushPromises()
      expect(titleBar.style.getPropertyValue('--title-trailing-width')).toBe('300px')
      wrapper.unmount()
    })

    it('rounds fractional widths up so the left-cluster reservation never under-shoots', async () => {
      // Round up: a sub-pixel under-shoot would nudge the centre off true centre.
      const mod = await import('./TitleBarApp.vue')
      const wrapper = mount(mod.default, { attachTo: document.body })
      await flushPromises()
      const titleBar = wrapper.find('.title-bar').element as HTMLElement
      const handle = handles[0]!
      handle.fire(287.4)
      await flushPromises()
      expect(titleBar.style.getPropertyValue('--title-trailing-width')).toBe('288px')
      wrapper.unmount()
    })

    it('does not crash if ResizeObserver is unavailable (older Electron / SSR-safety)', async () => {
      delete (globalThis as { ResizeObserver?: typeof globalThis.ResizeObserver }).ResizeObserver
      const mod = await import('./TitleBarApp.vue')
      const wrapper = mount(mod.default, { attachTo: document.body })
      await flushPromises()
      // No observer, but the component renders; the var falls back to 0px.
      const titleBar = wrapper.find('.title-bar').element as HTMLElement
      expect(titleBar.style.getPropertyValue('--title-trailing-width')).toBe('0px')
      expect(wrapper.find('.title-install-pill').exists()).toBe(true)
      wrapper.unmount()
    })
  })

  describe('first-instance pill coachmark', () => {
    let getSetting: ReturnType<typeof vi.fn>
    let setSetting: ReturnType<typeof vi.fn>

    beforeEach(() => {
      getSetting = vi.fn().mockResolvedValue(undefined)
      setSetting = vi.fn().mockResolvedValue(undefined)
      ;(window as unknown as { api: unknown }).api = { getSetting, setSetting }
      // Run the deferred rAF synchronously so the coachmark trigger
      // resolves within a flushPromises() tick.
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        cb(0)
        return 0
      })
    })

    afterEach(() => {
      vi.restoreAllMocks()
      delete (window as unknown as { api?: unknown }).api
    })

    it('shows the coachmark when a window attaches to an instance AFTER mount', async () => {
      // The watcher must re-attempt when isInstallLess flips false post-attach.
      bridgeState = installMockBridge({ installationId: null })
      vi.resetModules()
      const { default: TitleBarApp } = await import('./TitleBarApp.vue')
      const wrapper = mount(TitleBarApp, { attachTo: document.body })
      await flushPromises()
      // Install-less at mount → no coachmark yet.
      expect(bridgeState.showCoachmarkCalls.length).toBe(0)

      // Main pushes an installation id — the window is now install-backed.
      bridgeState.installationIdChangedCallbacks.forEach((cb) => cb('inst-1'))
      await flushPromises()

      expect(bridgeState.showCoachmarkCalls.length).toBe(1)
      const payload = bridgeState.showCoachmarkCalls[0]
      expect(payload.title).toBe('Switch & manage instances')
      wrapper.unmount()
    })

    it('does not show the coachmark on an install-less (dashboard) window', async () => {
      bridgeState = installMockBridge({ installationId: null })
      vi.resetModules()
      const { default: TitleBarApp } = await import('./TitleBarApp.vue')
      const wrapper = mount(TitleBarApp, { attachTo: document.body })
      await flushPromises()
      expect(bridgeState.showCoachmarkCalls.length).toBe(0)
      wrapper.unmount()
    })

    it('does not show the coachmark when already seen', async () => {
      getSetting.mockImplementation((key: string) =>
        key === 'hasSeenCentralPillHint' ? Promise.resolve(true) : Promise.resolve(undefined),
      )
      bridgeState = installMockBridge({ installationId: 'inst-1' })
      vi.resetModules()
      const { default: TitleBarApp } = await import('./TitleBarApp.vue')
      const wrapper = mount(TitleBarApp, { attachTo: document.body })
      await flushPromises()
      expect(bridgeState.showCoachmarkCalls.length).toBe(0)
      wrapper.unmount()
    })

    it('waits for loading-lockdown to clear (ComfyUI screen visible) before showing', async () => {
      // Must not show the coachmark over the loader; fire only once lockdown clears.
      bridgeState = installMockBridge({ installationId: 'inst-1' })
      vi.resetModules()
      const { default: TitleBarApp } = await import('./TitleBarApp.vue')
      const wrapper = mount(TitleBarApp, { attachTo: document.body })
      bridgeState.firstUseModeChangedCallbacks.forEach((cb) => cb('loading-lockdown'))
      await flushPromises()
      expect(bridgeState.showCoachmarkCalls.length).toBe(0)

      // Loader finished → ComfyUI is visible.
      bridgeState.firstUseModeChangedCallbacks.forEach((cb) => cb('none'))
      await flushPromises()
      expect(bridgeState.showCoachmarkCalls.length).toBe(1)
      wrapper.unmount()
    })

    it('lifts the pill to the brand-open state while the coachmark is showing', async () => {
      bridgeState = installMockBridge({ installationId: 'inst-1' })
      vi.resetModules()
      const { default: TitleBarApp } = await import('./TitleBarApp.vue')
      const wrapper = mount(TitleBarApp, { attachTo: document.body })
      await flushPromises()
      expect(bridgeState.showCoachmarkCalls.length).toBe(1)
      expect(wrapper.find('.title-install-pill.is-coachmark').exists()).toBe(true)
      wrapper.unmount()
    })
  })
})
