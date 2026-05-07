import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  navStateChangedCallbacks: ((state: { canBack: boolean; canForward: boolean }) => void)[]
  titleChangedCallbacks: ((title: string) => void)[]
  sourceCategoryChangedCallbacks: ((category: string | null) => void)[]
  themeChangedCallbacks: ((theme: { bg: string; text: string }) => void)[]
  fullscreenChangedCallbacks: ((fullscreen: boolean) => void)[]
  menuClosedCallbacks: ((info: { menu: 'file' | 'install' }) => void)[]
  firstUseModeChangedCallbacks: ((mode: 'none' | 'consent-lockdown' | 'post-consent') => void)[]
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
  installMenuAnchors: { x: number; y: number }[]
  goBackCalls: number
  goForwardCalls: number
  appUpdatePillClicks: number
  installUpdatePillClicks: number
  downloadsTrayClicks: number
  readyCalls: number
}

function installMockBridge(opts: { isMac?: boolean; installationId?: string | null } = {}): MockBridgeState {
  const state: MockBridgeState = {
    panelChangedCallbacks: [],
    navStateChangedCallbacks: [],
    titleChangedCallbacks: [],
    sourceCategoryChangedCallbacks: [],
    themeChangedCallbacks: [],
    fullscreenChangedCallbacks: [],
    menuClosedCallbacks: [],
    firstUseModeChangedCallbacks: [],
    appUpdateStateCallbacks: [],
    installUpdateAvailableCallbacks: [],
    downloadsChangedCallbacks: [],
    setPanelCalls: [],
    newWindowCalls: 0,
    fileMenuAnchors: [],
    installMenuAnchors: [],
    goBackCalls: 0,
    goForwardCalls: 0,
    appUpdatePillClicks: 0,
    installUpdatePillClicks: 0,
    downloadsTrayClicks: 0,
    readyCalls: 0,
  }
  const installationId = opts.installationId === undefined ? 'test-id' : opts.installationId
  const bridge = {
    getInstallationId: () => installationId,
    isMac: () => !!opts.isMac,
    setPanel: (panel: string) => state.setPanelCalls.push(panel),
    openNewWindow: () => { state.newWindowCalls += 1 },
    openFileMenu: (anchor: { x: number; y: number }) => { state.fileMenuAnchors.push(anchor) },
    openInstallMenu: (anchor: { x: number; y: number }) => { state.installMenuAnchors.push(anchor) },
    goBack: () => { state.goBackCalls += 1 },
    goForward: () => { state.goForwardCalls += 1 },
    onPanelChanged: (cb: (panel: string) => void) => {
      state.panelChangedCallbacks.push(cb)
      return () => {}
    },
    onNavStateChanged: (cb: (state: { canBack: boolean; canForward: boolean }) => void) => {
      state.navStateChangedCallbacks.push(cb)
      return () => {}
    },
    onTitleChanged: (cb: (title: string) => void) => {
      state.titleChangedCallbacks.push(cb)
      return () => {}
    },
    onSourceCategoryChanged: (cb: (category: string | null) => void) => {
      state.sourceCategoryChangedCallbacks.push(cb)
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
    onMenuClosed: (cb: (info: { menu: 'file' | 'install' }) => void) => {
      state.menuClosedCallbacks.push(cb)
      return () => {}
    },
    onFirstUseModeChanged: (cb: (mode: 'none' | 'consent-lockdown' | 'post-consent') => void) => {
      state.firstUseModeChangedCallbacks.push(cb)
      return () => {}
    },
    onAppUpdateStateChanged: (
      cb: (next: {
        kind: 'available' | 'ready' | null
        version: string | null
        autoUpdate: boolean
      }) => void,
    ) => {
      state.appUpdateStateCallbacks.push(cb)
      return () => {}
    },
    onInstallUpdateAvailable: (cb: (next: { available: boolean; version: string | null }) => void) => {
      state.installUpdateAvailableCallbacks.push(cb)
      return () => {}
    },
    clickAppUpdatePill: () => {
      state.appUpdatePillClicks += 1
    },
    clickInstallUpdatePill: () => {
      state.installUpdatePillClicks += 1
    },
    onDownloadsChanged: (cb: (next: MockDownloadsTrayState) => void) => {
      state.downloadsChangedCallbacks.push(cb)
      return () => {}
    },
    clickDownloadsTray: () => {
      state.downloadsTrayClicks += 1
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

  it('renders the app menu button and a center install pill', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    // App / hamburger menu button on the left. We use an icon (no text
    // label) so that on install-backed windows the host-app menu
    // doesn't visually clash with ComfyUI's own "File" menu inside the
    // Comfy WebContentsView.
    const fileBtn = wrapper.find('.title-menu-button')
    expect(fileBtn.exists()).toBe(true)
    expect(fileBtn.attributes('aria-label')).toBe('Menu')
    expect(fileBtn.classes()).toContain('title-menu-button--icon')
    // Install pill in the center — single button. Install-backed (mock
    // returns 'test-id') so the chevron caret is rendered inside as
    // decoration. The pill itself is the click target — the caret is
    // not a separate button anymore.
    const pill = wrapper.find('.title-install-pill')
    expect(pill.exists()).toBe(true)
    expect(pill.element.tagName).toBe('BUTTON')
    expect(wrapper.find('.title-install-name').text()).toBe('ComfyUI')
    expect(wrapper.find('.title-install-caret').exists()).toBe(true)
    // Caret is decoration (an SVG), not a button.
    expect(wrapper.find('.title-install-caret').element.tagName).toBe('svg')
  })

  it('signals readiness so main can push initial state', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    mount(TitleBarApp)
    await flushPromises()
    expect(bridgeState.readyCalls).toBe(1)
  })

  it('opens the native install menu when the install pill is clicked (whole pill is the click target)', async () => {
    // Phase 3 §7 — the pill body and caret are no longer separate
    // hit targets. Clicking anywhere on the pill (including over the
    // name span or the chevron SVG) opens the native install menu.
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp, { attachTo: document.body })
    await flushPromises()
    await wrapper.find('.title-install-pill').trigger('click')
    expect(bridgeState.installMenuAnchors.length).toBe(1)
    const anchor = bridgeState.installMenuAnchors[0]!
    expect(typeof anchor.x).toBe('number')
    expect(typeof anchor.y).toBe('number')
    // The pill no longer routes clicks to setPanel — that gesture went
    // away when the caret/name buttons collapsed into one.
    expect(bridgeState.setPanelCalls).toEqual([])
    wrapper.unmount()
  })

  it('asks main to pop the native File menu when the File button is clicked', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp, { attachTo: document.body })
    await flushPromises()
    await wrapper.find('.title-menu-button').trigger('click')
    expect(bridgeState.fileMenuAnchors.length).toBe(1)
    // Anchor is below the button; jsdom returns 0/0 rects but we assert
    // the contract — anchor object is well-formed.
    const anchor = bridgeState.fileMenuAnchors[0]!
    expect(typeof anchor.x).toBe('number')
    expect(typeof anchor.y).toBe('number')
    wrapper.unmount()
  })

  it('does not open the install menu on install-less host windows (pill is disabled)', async () => {
    // Phase 3 §7 — the install-less host window's pill is rendered
    // disabled (no menu, no caret). Clicks must not reach the bridge.
    bridgeState = installMockBridge({ installationId: null })
    vi.resetModules()
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp, { attachTo: document.body })
    await flushPromises()
    const pill = wrapper.find('.title-install-pill')
    expect(pill.exists()).toBe(true)
    expect((pill.element as HTMLButtonElement).disabled).toBe(true)
    expect(pill.classes()).toContain('is-install-less')
    await pill.trigger('click')
    expect(bridgeState.installMenuAnchors.length).toBe(0)
    wrapper.unmount()
  })

  it('updates the install pill label when main pushes a title', async () => {
    // Track B item 4 — the source-category suffix is no longer
    // appended to the title text in main; the install name reads
    // bare and the category surfaces as an icon (covered by separate
    // tests below). The test value here mirrors the new contract.
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    bridgeState.titleChangedCallbacks.forEach((cb) => cb('MyInstall'))
    await flushPromises()
    expect(wrapper.find('.title-install-name').text()).toBe('MyInstall')
  })

  it('does not mark the install pill active for any panel — pill is an identity label, not a tab', async () => {
    // The pill no longer mirrors `activePanel`. Page navigation is
    // tracked separately via Back/Forward arrows; the pill stays as a
    // pure identity affordance.
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    bridgeState.panelChangedCallbacks.forEach((cb) => cb('comfy'))
    await flushPromises()
    expect(wrapper.find('.title-install-pill').classes()).not.toContain('active')
    bridgeState.panelChangedCallbacks.forEach((cb) => cb('launcher-settings'))
    await flushPromises()
    expect(wrapper.find('.title-install-pill').classes()).not.toContain('active')
  })

  it('renders Back and Forward buttons disabled by default and enables them via onNavStateChanged', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    const navButtons = wrapper.findAll('.title-nav-button')
    expect(navButtons.length).toBe(2)
    const [backBtn, fwdBtn] = navButtons
    expect((backBtn!.element as HTMLButtonElement).disabled).toBe(true)
    expect((fwdBtn!.element as HTMLButtonElement).disabled).toBe(true)

    bridgeState.navStateChangedCallbacks.forEach((cb) => cb({ canBack: true, canForward: false }))
    await flushPromises()
    expect((backBtn!.element as HTMLButtonElement).disabled).toBe(false)
    expect((fwdBtn!.element as HTMLButtonElement).disabled).toBe(true)

    bridgeState.navStateChangedCallbacks.forEach((cb) => cb({ canBack: true, canForward: true }))
    await flushPromises()
    expect((backBtn!.element as HTMLButtonElement).disabled).toBe(false)
    expect((fwdBtn!.element as HTMLButtonElement).disabled).toBe(false)
  })

  it('forwards Back / Forward clicks through the bridge when enabled', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    const navButtons = wrapper.findAll('.title-nav-button')
    const [backBtn, fwdBtn] = navButtons

    // Disabled — clicks should be no-ops.
    await backBtn!.trigger('click')
    await fwdBtn!.trigger('click')
    expect(bridgeState.goBackCalls).toBe(0)
    expect(bridgeState.goForwardCalls).toBe(0)

    // Enable both, then click each.
    bridgeState.navStateChangedCallbacks.forEach((cb) => cb({ canBack: true, canForward: true }))
    await flushPromises()
    await backBtn!.trigger('click')
    await fwdBtn!.trigger('click')
    expect(bridgeState.goBackCalls).toBe(1)
    expect(bridgeState.goForwardCalls).toBe(1)
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
    // the chevron caret SVG inside the pill is omitted because there's
    // no install-scoped menu to expose.
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

  it('suppresses menu re-open immediately after a menu close (click-to-toggle dismiss)', async () => {
    // Phase 3 §7 follow-up — when the user clicks the menu button
    // while the native menu is open, the OS dismisses the menu first
    // and the click event then propagates to the renderer. Without
    // suppression the click handler would ask main to pop the menu
    // again, making the menu flicker open immediately.
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp, { attachTo: document.body })
    await flushPromises()

    // First click opens the file menu.
    await wrapper.find('.title-menu-button').trigger('click')
    expect(bridgeState.fileMenuAnchors.length).toBe(1)

    // Main pops, user clicks the same button → menu dismisses → main
    // fires the popup callback → onMenuClosed handler stamps the
    // suppression timestamp. Simulate that by invoking the registered
    // callback directly.
    bridgeState.menuClosedCallbacks.forEach((cb) => cb({ menu: 'file' }))
    await flushPromises()

    // Second click within the suppression window must NOT open the menu.
    await wrapper.find('.title-menu-button').trigger('click')
    expect(bridgeState.fileMenuAnchors.length).toBe(1)

    // Suppression is per-menu — clicking the install pill (different
    // menu kind) is unaffected.
    await wrapper.find('.title-install-pill').trigger('click')
    expect(bridgeState.installMenuAnchors.length).toBe(1)

    wrapper.unmount()
  })

  it('hides the waffle menu during the first-use T&C consent step (consent-lockdown)', async () => {
    // Modal-unification (Track M-2.3) — the waffle menu is the only
    // always-live affordance during a Tier 3 takeover (it carries the
    // Return-to-Dashboard / Close-Window escape hatch). The first-use
    // T&C consent step deliberately removes that escape hatch so the
    // user has to either accept consent or close the window via OS
    // chrome — matching the binding-flow framing of consent. Once
    // the takeover advances past consent the waffle reappears (the
    // menu builder additionally surfaces the Skip Onboarding entry
    // there, see M-2.2).
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    // Steady state — waffle is rendered.
    expect(wrapper.find('.title-menu-button--icon').exists()).toBe(true)
    expect(wrapper.find('header').classes()).not.toContain('is-consent-lockdown')

    // Consent step on screen — waffle disappears.
    bridgeState.firstUseModeChangedCallbacks.forEach((cb) => cb('consent-lockdown'))
    await flushPromises()
    expect(wrapper.find('header').classes()).toContain('is-consent-lockdown')
    expect(wrapper.find('.title-menu-button--icon').exists()).toBe(false)

    // Advance to post-consent — waffle reappears (Skip Onboarding now
    // available there).
    bridgeState.firstUseModeChangedCallbacks.forEach((cb) => cb('post-consent'))
    await flushPromises()
    expect(wrapper.find('header').classes()).not.toContain('is-consent-lockdown')
    expect(wrapper.find('.title-menu-button--icon').exists()).toBe(true)

    // Takeover dismissed — back to steady state.
    bridgeState.firstUseModeChangedCallbacks.forEach((cb) => cb('none'))
    await flushPromises()
    expect(wrapper.find('header').classes()).not.toContain('is-consent-lockdown')
    expect(wrapper.find('.title-menu-button--icon').exists()).toBe(true)
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

  // ===================================================================
  // Track B item 4 — install-type icon next to the install name
  // (replaces the old `— {label}` textual suffix)
  // ===================================================================

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

  // ===================================================================
  // Phase 3 §18 — title-bar status pills (app-update + install-update)
  // ===================================================================

  it('hides both status pills by default (no update available, no install update)', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    expect(wrapper.find('.title-update-pill.is-app-update').exists()).toBe(false)
    expect(wrapper.find('.title-update-pill.is-install-update').exists()).toBe(false)
  })

  it('renders the app-update pill with "Desktop Update Available" copy when state.kind=available (auto-updates OFF)', async () => {
    // Issue #488 — `kind: 'available'` only fires with auto-updates
    // OFF (main suppresses it when ON and triggers the download
    // itself). The pill label is the bare "Desktop Update Available"
    // string; version moves to the tooltip / aria-label.
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
    expect(pill.text()).toContain('Desktop Update Available')
    expect(pill.attributes('title')).toBe('Desktop Update Available (v2.3.4)')
    expect(pill.attributes('aria-label')).toBe('Desktop Update Available (v2.3.4)')
  })

  it('renders the app-update pill with "Desktop Update Ready" copy when state.kind=ready (auto-updates OFF)', async () => {
    // Issue #488 — both auto-on and auto-off ready states share the
    // same "Desktop Update Ready" label; the click-modal flow is what
    // differs (handled in main, not here).
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
    // Issue #488 — auto-on uses the same "Desktop Update Ready" copy.
    // The click handler in main branches on cached state to fire the
    // restart-now modal directly (no separate "will apply on restart"
    // hint needed in the pill itself).
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

  it('renders the install-update pill on install-backed hosts when onInstallUpdateAvailable=true', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    expect(wrapper.find('.title-update-pill.is-install-update').exists()).toBe(false)
    bridgeState.installUpdateAvailableCallbacks.forEach((cb) => cb({ available: true, version: null }))
    await flushPromises()
    const pill = wrapper.find('.title-update-pill.is-install-update')
    expect(pill.exists()).toBe(true)
    expect(pill.text()).toContain('Update available')
  })

  it('renders the install-update pill with version label when main pushes a target version (Track B item 1)', async () => {
    // Mirrors the app-update pill's "Update {version}" copy so the
    // user reads the install-update pill the same way: the target
    // release is right there in the label, not behind a popover.
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    bridgeState.installUpdateAvailableCallbacks.forEach((cb) =>
      cb({ available: true, version: 'v1.2.3' }),
    )
    await flushPromises()
    const pill = wrapper.find('.title-update-pill.is-install-update')
    expect(pill.exists()).toBe(true)
    expect(pill.text()).toContain('Update v1.2.3')
    // Tooltip + aria-label track the same copy.
    expect(pill.attributes('title')).toBe('Update v1.2.3')
    expect(pill.attributes('aria-label')).toBe('Update v1.2.3')
  })

  it('suppresses the install-update pill on install-less host windows even when push fires', async () => {
    bridgeState = installMockBridge({ installationId: null })
    vi.resetModules()
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    bridgeState.installUpdateAvailableCallbacks.forEach((cb) => cb({ available: true, version: null }))
    await flushPromises()
    expect(wrapper.find('.title-update-pill.is-install-update').exists()).toBe(false)
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

  it('forwards install-update pill clicks through the bridge', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp, { attachTo: document.body })
    await flushPromises()
    bridgeState.installUpdateAvailableCallbacks.forEach((cb) => cb({ available: true, version: null }))
    await flushPromises()
    await wrapper.find('.title-update-pill.is-install-update').trigger('click')
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

  // ===================================================================
  // Track F — title-bar downloads tray
  // ===================================================================

  it('hides the downloads tray when there are no active or recent downloads', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    expect(wrapper.find('.title-downloads-tray').exists()).toBe(false)
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
    // Badge shows the in-flight count (2) — recent entries don't bump
    // the counter.
    const badge = wrapper.find('.title-downloads-badge')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('2')
    // Tooltip + aria-label communicate the same count in plural form.
    expect(tray.attributes('title')).toBe('2 downloads in progress')
    expect(tray.attributes('aria-label')).toBe('2 downloads in progress')
  })

  it('renders the downloads tray icon-only (no badge) when only recent entries exist', async () => {
    // The badge counts ACTIVE downloads, not recent ones — so a tray
    // with only completed entries should still show the icon (so the
    // user can reopen the popover) but without a numeric badge that
    // would otherwise read as "things still working".
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
    // Idle label — no in-flight downloads, but the tray is still
    // reachable so the recent-completed row in the popover stays
    // accessible until the user dismisses it.
    expect(wrapper.find('.title-downloads-tray').attributes('title')).toBe('Downloads')
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

  it('hides the tray again when the state transitions back to empty', async () => {
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
    bridgeState.downloadsChangedCallbacks.forEach((cb) => cb({ active: [], recent: [] }))
    await flushPromises()
    expect(wrapper.find('.title-downloads-tray').exists()).toBe(false)
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
})
