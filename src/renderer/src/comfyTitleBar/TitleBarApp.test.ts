import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

interface MockBridgeState {
  panelChangedCallbacks: ((panel: string) => void)[]
  navStateChangedCallbacks: ((state: { canBack: boolean; canForward: boolean }) => void)[]
  titleChangedCallbacks: ((title: string) => void)[]
  themeChangedCallbacks: ((theme: { bg: string; text: string }) => void)[]
  fullscreenChangedCallbacks: ((fullscreen: boolean) => void)[]
  menuClosedCallbacks: ((info: { menu: 'file' | 'install' }) => void)[]
  inertChangedCallbacks: ((inert: boolean) => void)[]
  appUpdateStateCallbacks: ((state: {
    kind: 'available' | 'ready' | null
    version: string | null
  }) => void)[]
  installUpdateAvailableCallbacks: ((state: { available: boolean; version: string | null }) => void)[]
  setPanelCalls: string[]
  newWindowCalls: number
  fileMenuAnchors: { x: number; y: number }[]
  installMenuAnchors: { x: number; y: number }[]
  goBackCalls: number
  goForwardCalls: number
  appUpdatePillClicks: number
  installUpdatePillClicks: number
  readyCalls: number
}

function installMockBridge(opts: { isMac?: boolean; installationId?: string | null } = {}): MockBridgeState {
  const state: MockBridgeState = {
    panelChangedCallbacks: [],
    navStateChangedCallbacks: [],
    titleChangedCallbacks: [],
    themeChangedCallbacks: [],
    fullscreenChangedCallbacks: [],
    menuClosedCallbacks: [],
    inertChangedCallbacks: [],
    appUpdateStateCallbacks: [],
    installUpdateAvailableCallbacks: [],
    setPanelCalls: [],
    newWindowCalls: 0,
    fileMenuAnchors: [],
    installMenuAnchors: [],
    goBackCalls: 0,
    goForwardCalls: 0,
    appUpdatePillClicks: 0,
    installUpdatePillClicks: 0,
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
    onInertChanged: (cb: (inert: boolean) => void) => {
      state.inertChangedCallbacks.push(cb)
      return () => {}
    },
    onAppUpdateStateChanged: (
      cb: (next: { kind: 'available' | 'ready' | null; version: string | null }) => void,
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
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    bridgeState.titleChangedCallbacks.forEach((cb) => cb('MyInstall — Standalone'))
    await flushPromises()
    expect(wrapper.find('.title-install-name').text()).toBe('MyInstall — Standalone')
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

  it('disables install pill and back/forward when onInertChanged fires true, but leaves the file menu live', async () => {
    // Phase 3 §17 — Tier 3 takeover broadcasts an inert flag through
    // main → title bar so the user can't dismiss the takeover by
    // hitting the title-bar controls. Window controls (× / □) sit
    // outside this view and stay live regardless.
    //
    // Track C bug fix — the file/waffle menu is intentionally NOT
    // gated by `isInert`. The user must always retain a reachable
    // escape hatch from inside a takeover (Return to Dashboard /
    // Close Window / New Window), so the menu stays both `:enabled`
    // and click-active even when every other title-bar control is
    // inert.
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp, { attachTo: document.body })
    await flushPromises()
    // Enable back/forward so we can prove they're disabled by inert,
    // not just by the absence of nav state.
    bridgeState.navStateChangedCallbacks.forEach((cb) => cb({ canBack: true, canForward: true }))
    await flushPromises()
    const fileBtn = wrapper.find('.title-menu-button')
    const pill = wrapper.find('.title-install-pill')
    const navButtons = wrapper.findAll('.title-nav-button')
    expect((fileBtn.element as HTMLButtonElement).disabled).toBe(false)
    expect((pill.element as HTMLButtonElement).disabled).toBe(false)
    expect((navButtons[0]!.element as HTMLButtonElement).disabled).toBe(false)
    expect((navButtons[1]!.element as HTMLButtonElement).disabled).toBe(false)

    // Flip into takeover.
    bridgeState.inertChangedCallbacks.forEach((cb) => cb(true))
    await flushPromises()
    expect(wrapper.find('header').classes()).toContain('is-inert')
    // File menu stays live so the user can navigate out of the
    // takeover via the menu items.
    expect((fileBtn.element as HTMLButtonElement).disabled).toBe(false)
    expect((pill.element as HTMLButtonElement).disabled).toBe(true)
    expect((navButtons[0]!.element as HTMLButtonElement).disabled).toBe(true)
    expect((navButtons[1]!.element as HTMLButtonElement).disabled).toBe(true)

    // File menu click reaches the bridge even while inert; pill and
    // nav clicks stay no-ops.
    await fileBtn.trigger('click')
    await pill.trigger('click')
    await navButtons[0]!.trigger('click')
    await navButtons[1]!.trigger('click')
    expect(bridgeState.fileMenuAnchors.length).toBe(1)
    expect(bridgeState.installMenuAnchors.length).toBe(0)
    expect(bridgeState.goBackCalls).toBe(0)
    expect(bridgeState.goForwardCalls).toBe(0)

    // Flip back out — controls become live again.
    bridgeState.inertChangedCallbacks.forEach((cb) => cb(false))
    await flushPromises()
    expect(wrapper.find('header').classes()).not.toContain('is-inert')
    expect((fileBtn.element as HTMLButtonElement).disabled).toBe(false)
    expect((pill.element as HTMLButtonElement).disabled).toBe(false)
    expect((navButtons[0]!.element as HTMLButtonElement).disabled).toBe(false)
    expect((navButtons[1]!.element as HTMLButtonElement).disabled).toBe(false)
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
  // Phase 3 §18 — title-bar status pills (app-update + install-update)
  // ===================================================================

  it('hides both status pills by default (no update available, no install update)', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    expect(wrapper.find('.title-update-pill.is-app-update').exists()).toBe(false)
    expect(wrapper.find('.title-update-pill.is-install-update').exists()).toBe(false)
  })

  it('renders the app-update pill with version label when state.kind=available', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    bridgeState.appUpdateStateCallbacks.forEach((cb) =>
      cb({ kind: 'available', version: '2.3.4' }),
    )
    await flushPromises()
    const pill = wrapper.find('.title-update-pill.is-app-update')
    expect(pill.exists()).toBe(true)
    expect(pill.classes()).not.toContain('is-ready')
    expect(pill.text()).toContain('Update 2.3.4')
  })

  it('renders the app-update pill with restart label and is-ready when state.kind=ready', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    bridgeState.appUpdateStateCallbacks.forEach((cb) =>
      cb({ kind: 'ready', version: '2.3.4' }),
    )
    await flushPromises()
    const pill = wrapper.find('.title-update-pill.is-app-update')
    expect(pill.exists()).toBe(true)
    expect(pill.classes()).toContain('is-ready')
    expect(pill.text()).toContain('Restart to update')
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
      cb({ kind: 'available', version: '1.0.0' }),
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

  it('disables both status pills while the title bar is inert (Tier 3 takeover)', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp, { attachTo: document.body })
    await flushPromises()
    bridgeState.appUpdateStateCallbacks.forEach((cb) =>
      cb({ kind: 'available', version: '1.0.0' }),
    )
    bridgeState.installUpdateAvailableCallbacks.forEach((cb) => cb({ available: true, version: null }))
    await flushPromises()
    const appPill = wrapper.find('.title-update-pill.is-app-update')
    const installPill = wrapper.find('.title-update-pill.is-install-update')
    expect((appPill.element as HTMLButtonElement).disabled).toBe(false)
    expect((installPill.element as HTMLButtonElement).disabled).toBe(false)

    bridgeState.inertChangedCallbacks.forEach((cb) => cb(true))
    await flushPromises()
    expect((appPill.element as HTMLButtonElement).disabled).toBe(true)
    expect((installPill.element as HTMLButtonElement).disabled).toBe(true)
    wrapper.unmount()
  })

  it('does not forward pill clicks while inert (clicks are no-ops)', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp, { attachTo: document.body })
    await flushPromises()
    bridgeState.appUpdateStateCallbacks.forEach((cb) =>
      cb({ kind: 'available', version: '1.0.0' }),
    )
    bridgeState.installUpdateAvailableCallbacks.forEach((cb) => cb({ available: true, version: null }))
    bridgeState.inertChangedCallbacks.forEach((cb) => cb(true))
    await flushPromises()
    await wrapper.find('.title-update-pill.is-app-update').trigger('click')
    await wrapper.find('.title-update-pill.is-install-update').trigger('click')
    expect(bridgeState.appUpdatePillClicks).toBe(0)
    expect(bridgeState.installUpdatePillClicks).toBe(0)
    wrapper.unmount()
  })

  it('hides the app-update pill when state transitions back to kind=null', async () => {
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    bridgeState.appUpdateStateCallbacks.forEach((cb) =>
      cb({ kind: 'ready', version: '2.0.0' }),
    )
    await flushPromises()
    expect(wrapper.find('.title-update-pill.is-app-update').exists()).toBe(true)
    bridgeState.appUpdateStateCallbacks.forEach((cb) =>
      cb({ kind: null, version: null }),
    )
    await flushPromises()
    expect(wrapper.find('.title-update-pill.is-app-update').exists()).toBe(false)
  })
})
