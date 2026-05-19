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
  titleChangedCallbacks: ((title: string) => void)[]
  sourceCategoryChangedCallbacks: ((category: string | null) => void)[]
  themeChangedCallbacks: ((theme: { bg: string; text: string }) => void)[]
  fullscreenChangedCallbacks: ((fullscreen: boolean) => void)[]
  menuOpenedCallbacks: ((info: { menu: 'menu' }) => void)[]
  menuClosedCallbacks: ((info: { menu: 'menu' }) => void)[]
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
  fileMenuDismisses: number
  appUpdatePillClicks: number
  installUpdatePillClicks: number
  downloadsTrayClicks: number
  installPillClicks: { x: number; y: number }[]
  feedbackClicks: number
  showTooltipCalls: { text: string; leftX: number; rightX: number; bottomY: number }[]
  hideTooltipCalls: number
  readyCalls: number
}

function installMockBridge(opts: { isMac?: boolean; installationId?: string | null } = {}): MockBridgeState {
  const state: MockBridgeState = {
    panelChangedCallbacks: [],
    titleChangedCallbacks: [],
    sourceCategoryChangedCallbacks: [],
    themeChangedCallbacks: [],
    fullscreenChangedCallbacks: [],
    menuOpenedCallbacks: [],
    menuClosedCallbacks: [],
    firstUseModeChangedCallbacks: [],
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
    showTooltipCalls: [],
    hideTooltipCalls: 0,
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
    onMenuOpened: (cb: (info: { menu: 'menu' }) => void) => {
      state.menuOpenedCallbacks.push(cb)
      return () => {}
    },
    onMenuClosed: (cb: (info: { menu: 'menu' }) => void) => {
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
    clickInstallPill: (anchor: { x: number; y: number }) => {
      state.installPillClicks.push(anchor)
    },
    clickFeedback: () => {
      state.feedbackClicks += 1
    },
    showTooltip: (payload: { text: string; leftX: number; rightX: number; bottomY: number }) => {
      state.showTooltipCalls.push(payload)
    },
    hideTooltip: () => {
      state.hideTooltipCalls += 1
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
    // Center identity pill. On install-backed hosts the pill renders
    // as a `<button>` that opens the instance-picker popover —
    // matching the rest of the title-bar dropdown buttons (waffle +
    // downloads). The trailing slot carries a ChevronDown caret so
    // the pill reads as actionable.
    const pill = wrapper.find('.title-install-pill')
    expect(pill.exists()).toBe(true)
    expect(pill.element.tagName).toBe('BUTTON')
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
    // The pill replaces the now-retired Settings click target. Clicking
    // it asks main to open the instance-picker popup anchored beneath
    // the pill — NOT a `setPanel` route. The waffle / downloads-tray
    // / pill clicks all share the `useTitleBarMenus` open/close
    // suppression book-keeping so the three buttons can't fight each
    // other on reclick.
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
    // Anchor is below the button; jsdom returns 0/0 rects but we assert
    // the contract — anchor object is well-formed.
    const anchor = bridgeState.fileMenuAnchors[0]!
    expect(typeof anchor.x).toBe('number')
    expect(typeof anchor.y).toBe('number')
    wrapper.unmount()
  })

  it('renders the install-less pill as a non-interactive identity label', async () => {
    // Install-less host windows show the static `Desktop 2.0 Beta`
    // label set by main's initial title push. The pill is a div
    // (no button, no caret) and carries the `is-install-less`
    // modifier class.
    bridgeState = installMockBridge({ installationId: null })
    vi.resetModules()
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp, { attachTo: document.body })
    await flushPromises()
    const pill = wrapper.find('.title-install-pill')
    expect(pill.exists()).toBe(true)
    expect(pill.element.tagName).toBe('DIV')
    expect(pill.classes()).toContain('is-install-less')
    expect(wrapper.find('.title-install-caret').exists()).toBe(false)
    wrapper.unmount()
  })

  it('updates the install pill label when main pushes a title', async () => {
    // The source-category suffix is not appended to the title text
    // in main; the install name reads bare and the category surfaces
    // as an icon (covered by separate tests below).
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

  it('hides the install caret in install-less host windows', async () => {
    // Install-less host windows (no installationId in the URL, so
    // the preload returns null) only expose the File menu.
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
    // Main now pushes `Desktop 2.0 Beta` for install-less host
    // windows in place of the previous `Choose an install` text.
    bridgeState = installMockBridge({ installationId: null })
    vi.resetModules()
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    bridgeState.titleChangedCallbacks.forEach((cb) => cb('Desktop 2.0 Beta'))
    await flushPromises()
    expect(wrapper.find('.title-install-name').text()).toBe('Desktop 2.0 Beta')
  })

  it('suppresses menu re-open immediately after a menu close (click-to-toggle dismiss)', async () => {
    // When the user clicks the menu button while the popup is open,
    // the OS dismisses the menu first and the click event then
    // propagates to the renderer. Without suppression the click
    // handler would ask main to pop the menu again, making the menu
    // flicker open immediately.
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
    bridgeState.menuClosedCallbacks.forEach((cb) => cb({ menu: 'menu' }))
    await flushPromises()

    // Second click within the suppression window must NOT open the menu.
    await wrapper.find('.title-menu-button').trigger('click')
    expect(bridgeState.fileMenuAnchors.length).toBe(1)

    wrapper.unmount()
  })

  it('hides the waffle menu and downloads tray for the full first-use takeover (consent + post-consent)', async () => {
    // The title bar strips itself down to a minimal identity bar for
    // the entire onboarding flow — waffle, downloads tray, and
    // feedback button all disappear. No installs exist yet so the
    // downloads tray is meaningless, and the takeover screens read
    // cleaner without the surrounding chrome. The chrome returns once
    // `firstUseMode === 'none'` (steady state).
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp)
    await flushPromises()
    // Steady state — waffle + downloads tray are rendered.
    expect(wrapper.find('.title-menu-button--icon').exists()).toBe(true)
    expect(wrapper.find('.title-downloads-tray').exists()).toBe(true)
    expect(wrapper.find('header').classes()).not.toContain('is-consent-lockdown')

    // Consent step on screen — waffle + downloads tray disappear.
    bridgeState.firstUseModeChangedCallbacks.forEach((cb) => cb('consent-lockdown'))
    await flushPromises()
    expect(wrapper.find('header').classes()).toContain('is-consent-lockdown')
    expect(wrapper.find('.title-menu-button--icon').exists()).toBe(false)
    expect(wrapper.find('.title-downloads-tray').exists()).toBe(false)

    // Advance to post-consent — chrome stays stripped (no waffle, no tray).
    bridgeState.firstUseModeChangedCallbacks.forEach((cb) => cb('post-consent'))
    await flushPromises()
    expect(wrapper.find('header').classes()).not.toContain('is-consent-lockdown')
    expect(wrapper.find('.title-menu-button--icon').exists()).toBe(false)
    expect(wrapper.find('.title-downloads-tray').exists()).toBe(false)

    // Takeover dismissed — back to steady state with full chrome.
    bridgeState.firstUseModeChangedCallbacks.forEach((cb) => cb('none'))
    await flushPromises()
    expect(wrapper.find('header').classes()).not.toContain('is-consent-lockdown')
    expect(wrapper.find('.title-menu-button--icon').exists()).toBe(true)
    expect(wrapper.find('.title-downloads-tray').exists()).toBe(true)
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
  // Install-type icon next to the install name
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
  // Title-bar status pills (app-update + install-update)
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

  it('renders the install-update pill with version label when main pushes a target version', async () => {
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
  // Title-bar downloads tray
  // ===================================================================

  it('renders the downloads tray with no badge in the empty steady state', async () => {
    // The downloads tray is always-visible — the empty-state copy
    // ("No downloads yet") lives inside the popup, not in the title
    // bar. The badge stays absent until something is in flight.
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
    // Badge shows the in-flight count (2) — recent entries don't bump
    // the counter.
    const badge = wrapper.find('.title-downloads-badge')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('2')
    // Tooltip + aria-label communicate the same count in plural form.
    expect(tray.attributes('title')).toBe('2 downloads in progress')
    expect(tray.attributes('aria-label')).toBe('2 downloads in progress')
  })

  it('treats recent entries already present on the first push as already-acknowledged', async () => {
    // The first downloads-changed push is the initial state main
    // hands the title bar after `ready()`. Anything `recent` there
    // finished before this window even opened, so we suppress the
    // unseen-finished indicator (it would otherwise misfire on every
    // window mount). The tray collapses back to its idle label and
    // shows neither a numeric nor an unseen badge.
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
    // Idle label — no in-flight downloads, but the tray is still
    // reachable so the recent-completed row in the popover stays
    // accessible until the user dismisses it.
    expect(wrapper.find('.title-downloads-tray').attributes('title')).toBe('Downloads')
  })

  it('marks the tray as unseen when a download completes after the initial state', async () => {
    // Simulate the real flow: the window opens with nothing in flight
    // (initial empty push), then a download starts and finishes. The
    // user never opened the popup, so the tray should switch to its
    // success-coloured unseen state with a labelled badge.
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
    // Restored from the pre-unified-window sidebar — the title-bar
    // entry pairs with the file-menu "Send Feedback" entry. Both
    // route through main → panel renderer (where the telemetry +
    // openExternal side-effects fire); the title-bar half just has
    // to surface the affordance and forward the click.
    const { default: TitleBarApp } = await import('./TitleBarApp.vue')
    const wrapper = mount(TitleBarApp, { attachTo: document.body })
    await flushPromises()
    const btn = wrapper.find('.title-feedback-button')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('aria-label')).toBe('Beta Feedback')
    expect(btn.text()).toContain('Beta Feedback')
    await btn.trigger('click')
    expect(bridgeState.feedbackClicks).toBe(1)
    wrapper.unmount()
  })

  it('hides the Send Feedback button for the full first-use takeover (consent + post-consent)', async () => {
    // Same gating as the waffle: the feedback button stays hidden for
    // the entire onboarding flow (nothing meaningful to feed back about
    // before the user has used the app) and only returns in the steady
    // state.
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

  // ===================================================================
  // Issue #514 — macOS hover-tooltip relay.
  //
  // On macOS the native HTML `title` attribute does not reliably surface
  // tooltips for controls inside a sibling chrome WebContentsView, so
  // the title bar routes hover through the bridge's `showTooltip` /
  // `hideTooltip`. On Windows / Linux the native attribute works fine
  // and the JS handlers must NOT fire (otherwise we'd render two
  // tooltips). The tests below assert the platform-gated behaviour.
  // ===================================================================
  it('does NOT route hover through showTooltip on Win/Linux (native title is reliable there)', async () => {
    bridgeState = installMockBridge({ isMac: false })
    vi.resetModules()
    vi.useFakeTimers()
    try {
      const { default: TitleBarApp } = await import('./TitleBarApp.vue')
      const wrapper = mount(TitleBarApp, { attachTo: document.body })
      await flushPromises()
      const btn = wrapper.find('.title-menu-button').element as HTMLElement
      // Dispatch on the button so the event bubbles up to the
      // window-level pointermove listener carrying btn as event.target.
      btn.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }))
      // Even after the show delay elapses the bridge should NOT be
      // called — Win/Linux uses the native `title` attribute.
      vi.advanceTimersByTime(1000)
      await flushPromises()
      expect(bridgeState.showTooltipCalls.length).toBe(0)
      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits `title` only on Win/Linux and `data-title-tooltip` only on macOS so the two tooltip systems can never both fire', async () => {
    // Cocoa's native HTML `title` tooltip occasionally DOES fire for
    // sibling-WebContentsView buttons on macOS, even though it's
    // documented as unreliable — when it does, the user sees both
    // bubbles at once (native one + our custom popup, in two
    // different fonts/sizes). The fix is to make the two systems
    // mutually exclusive at the source: `title` only off-mac,
    // `data-title-tooltip` only on mac. `aria-label` stays
    // unconditional so screen readers see the same text everywhere.
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
      // Dispatch on the button so the event bubbles up to the
      // window-level pointermove listener carrying btn as event.target.
      btn.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }))
      // Show is gated by a small delay so quick fly-bys don't pop a
      // bubble. Advance past it.
      vi.advanceTimersByTime(500)
      await flushPromises()
      expect(bridgeState.showTooltipCalls.length).toBe(1)
      const call = bridgeState.showTooltipCalls[0]
      expect(call.text).toBe('Menu')
      // The bridge sends both horizontal edges so main can prefer the
      // rightward-anchored layout (bubble.left == leftX) and fall back
      // to right-aligned (bubble.right == rightX) on overflow.
      expect(call.leftX).toBe(20)
      expect(call.rightX).toBe(50)
      expect(call.bottomY).toBe(30)
      // Pointer leaves the title bar; bridge should be told to hide.
      const root = wrapper.find('header').element as HTMLElement
      root.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }))
      // The pointerleave listener is registered on documentElement, so
      // dispatch there too — JSDOM doesn't bubble custom PointerEvents
      // up to the document root the way a real browser does.
      document.documentElement.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }))
      await flushPromises()
      expect(bridgeState.hideTooltipCalls).toBeGreaterThanOrEqual(1)
      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})
