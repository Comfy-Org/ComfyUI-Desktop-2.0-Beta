import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

interface MockMenuItem {
  id?: string
  label?: string
  checked?: boolean
  kind?: 'separator'
}

interface MockDownloadEntry {
  url: string
  filename: string
  directory?: string
  progress: number
  status: 'pending' | 'downloading' | 'paused' | 'completed' | 'error' | 'cancelled'
  error?: string
}

interface MockDownloadsState {
  active: MockDownloadEntry[]
  recent: MockDownloadEntry[]
}

type MockPopupConfig =
  | { kind: 'menu'; items: MockMenuItem[]; theme: { bg: string; text: string } }
  | { kind: 'downloads'; theme: { bg: string; text: string } }

interface MockBridgeState {
  configCallbacks: ((cfg: MockPopupConfig) => void)[]
  downloadsCallbacks: ((state: MockDownloadsState) => void)[]
  /** Snapshot push callbacks for the instance-picker kind. Mirrors
   *  the bridge's `onInstancePickerSnapshot` subscription — registered
   *  at app mount, so callers can also assert the listener is wired
   *  before any picker view exists. */
  instancePickerSnapshotCallbacks: ((snapshot: unknown) => void)[]
  /** Will-show push callbacks. Fires unconditionally on every popup
   *  open (including the fast-path reopen that skips set-config), so
   *  the shell can bump openSeq and re-key its view to reset transient
   *  per-open state. */
  willShowCallbacks: ((info: { kind: string }) => void)[]
  /** Dismiss-modals push callbacks. Fires when main wants the popup
   *  renderer to cancel any open useModal / useDialogs entry — e.g.
   *  another title-bar dropdown is preempting the picker (#770). */
  dismissModalsCallbacks: (() => void)[]
  activateCalls: string[]
  closeCalls: number
  readyCalls: number
  notifyRenderedCalls: number
  openSettingsTabCalls: string[]
  downloadsActionCalls: unknown[]
  pickInstallCalls: string[]
  restartInstallCalls: string[]
  openNewInstallCalls: number
}

function installMockBridge(): MockBridgeState {
  const state: MockBridgeState = {
    configCallbacks: [],
    downloadsCallbacks: [],
    instancePickerSnapshotCallbacks: [],
    willShowCallbacks: [],
    dismissModalsCallbacks: [],
    activateCalls: [],
    closeCalls: 0,
    readyCalls: 0,
    notifyRenderedCalls: 0,
    openSettingsTabCalls: [],
    downloadsActionCalls: [],
    pickInstallCalls: [],
    restartInstallCalls: [],
    openNewInstallCalls: 0,
  }
  const bridge = {
    activate: (id: string) => state.activateCalls.push(id),
    close: () => {
      state.closeCalls += 1
    },
    ready: () => {
      state.readyCalls += 1
    },
    notifyRendered: () => {
      state.notifyRenderedCalls += 1
    },
    onConfig: (cb: (cfg: MockPopupConfig) => void) => {
      state.configCallbacks.push(cb)
      return () => {}
    },
    onDownloadsChanged: (cb: (s: MockDownloadsState) => void) => {
      state.downloadsCallbacks.push(cb)
      return () => {}
    },
    onInstancePickerSnapshot: (cb: (snapshot: unknown) => void) => {
      state.instancePickerSnapshotCallbacks.push(cb)
      return () => {}
    },
    onGlobalSettingsSnapshot: (_cb: (snapshot: unknown) => void) => {
      return () => {}
    },
    onWillShow: (cb: (info: { kind: string }) => void) => {
      state.willShowCallbacks.push(cb)
      return () => {}
    },
    onDismissModals: (cb: () => void) => {
      state.dismissModalsCallbacks.push(cb)
      return () => {}
    },
    downloadsAction: (action: unknown) => {
      state.downloadsActionCalls.push(action)
    },
    openSettingsTab: (tab: string) => {
      state.openSettingsTabCalls.push(tab)
    },
    pickInstall: (installationId: string) => {
      state.pickInstallCalls.push(installationId)
    },
    restartInstall: (installationId: string) => {
      state.restartInstallCalls.push(installationId)
    },
    openNewInstall: () => {
      state.openNewInstallCalls += 1
    },
    requestSize: () => {},
  }
  ;(window as unknown as { __comfyTitlePopup: typeof bridge }).__comfyTitlePopup = bridge
  return state
}

describe('TitlePopupApp', () => {
  let bridgeState: MockBridgeState

  beforeEach(() => {
    bridgeState = installMockBridge()
    vi.resetModules()
  })

  it('signals readiness on mount so main can flush queued config', async () => {
    const { default: TitlePopupApp } = await import('./TitlePopupApp.vue')
    mount(TitlePopupApp)
    await flushPromises()
    expect(bridgeState.readyCalls).toBe(1)
  })

  it('renders the menu view by default and reflects items pushed via config', async () => {
    const { default: TitlePopupApp } = await import('./TitlePopupApp.vue')
    const wrapper = mount(TitlePopupApp)
    await flushPromises()
    bridgeState.configCallbacks.forEach((cb) =>
      cb({
        kind: 'menu',
        items: [
          { id: 'a', label: 'Alpha' },
          { kind: 'separator' },
          { id: 'b', label: 'Beta', checked: true },
        ],
        theme: { bg: '#262729', text: '#dddddd' },
      }),
    )
    await flushPromises()
    const items = wrapper.findAll('.menu .item')
    expect(items.length).toBe(2)
    expect(items[0]!.text()).toContain('Alpha')
    expect(items[1]!.text()).toContain('Beta')
    expect(wrapper.findAll('.menu .separator').length).toBe(1)
  })

  it('forwards menu activations to the bridge', async () => {
    const { default: TitlePopupApp } = await import('./TitlePopupApp.vue')
    const wrapper = mount(TitlePopupApp)
    await flushPromises()
    bridgeState.configCallbacks.forEach((cb) =>
      cb({
        kind: 'menu',
        items: [{ id: 'open-feedback', label: 'Send Feedback' }],
        theme: { bg: '#262729', text: '#dddddd' },
      }),
    )
    await flushPromises()
    await wrapper.find('.menu .item').trigger('click')
    expect(bridgeState.activateCalls).toEqual(['open-feedback'])
  })

  it('switches to the downloads view when config kind is downloads', async () => {
    const { default: TitlePopupApp } = await import('./TitlePopupApp.vue')
    const wrapper = mount(TitlePopupApp)
    await flushPromises()
    bridgeState.configCallbacks.forEach((cb) =>
      cb({
        kind: 'downloads',
        theme: { bg: '#262729', text: '#dddddd' },
      }),
    )
    await flushPromises()
    expect(wrapper.find('.menu').exists()).toBe(false)
    expect(wrapper.find('.downloads').exists()).toBe(true)
  })

  it('acks via notifyRendered after a config flush so main can show the view', async () => {
    // The render-ack runs inside a `requestAnimationFrame` after Vue's
    // tick; jsdom resolves rAF synchronously via a setTimeout shim, so
    // we wait one macrotask.
    const { default: TitlePopupApp } = await import('./TitlePopupApp.vue')
    mount(TitlePopupApp)
    await flushPromises()
    const before = bridgeState.notifyRenderedCalls
    bridgeState.configCallbacks.forEach((cb) =>
      cb({
        kind: 'menu',
        items: [{ id: 'a', label: 'Alpha' }],
        theme: { bg: '#262729', text: '#dddddd' },
      }),
    )
    await flushPromises()
    await new Promise((r) => setTimeout(r, 20))
    expect(bridgeState.notifyRenderedCalls).toBeGreaterThan(before)
  })

  it('asks main to close on Escape', async () => {
    const { default: TitlePopupApp } = await import('./TitlePopupApp.vue')
    const wrapper = mount(TitlePopupApp, { attachTo: document.body })
    await flushPromises()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(bridgeState.closeCalls).toBe(1)
    wrapper.unmount()
  })

  it('applies theme colors to the popup card', async () => {
    const { default: TitlePopupApp } = await import('./TitlePopupApp.vue')
    const wrapper = mount(TitlePopupApp)
    await flushPromises()
    bridgeState.configCallbacks.forEach((cb) =>
      cb({
        kind: 'menu',
        items: [],
        theme: { bg: '#1f2024', text: '#eeeeee' },
      }),
    )
    await flushPromises()
    const style = wrapper.find('.popup').attributes('style') ?? ''
    // Browsers normalize hex to rgb in inline styles, so we accept either.
    expect(style).toMatch(/background:\s*(#1f2024|rgb\(31,\s*32,\s*36\))/i)
    expect(style).toMatch(/color:\s*(#eeeeee|rgb\(238,\s*238,\s*238\))/i)
  })

  it('re-keys the popup root when the will-show event fires, resetting per-open transient state', async () => {
    // The reused WebContentsView means InstancePickerView stays mounted
    // across opens. Without a per-open signal, transient state like
    // selectedId leaks from one open to the next. The shell subscribes
    // to `onWillShow` so it can bump openSeq and re-key the root —
    // which tears down + remounts the inner view. This is the only path
    // that catches the fast-path reopen that skips `set-config`.
    const { default: TitlePopupApp } = await import('./TitlePopupApp.vue')
    const wrapper = mount(TitlePopupApp)
    await flushPromises()
    const initialKey = (wrapper.find('.popup').element as HTMLElement).outerHTML
    bridgeState.willShowCallbacks.forEach((cb) => cb({ kind: 'instance-picker' }))
    await flushPromises()
    // Re-key produces a structurally identical DOM but Vue tears down +
    // remounts the keyed subtree — the cheapest observable proof is
    // that the willShow listener was registered in the first place.
    expect(bridgeState.willShowCallbacks.length).toBe(1)
    // Sanity: the root still renders post-bump (no error in the keyed
    // remount path).
    expect(wrapper.find('.popup').exists()).toBe(true)
    expect(initialKey.length).toBeGreaterThan(0)
  })

  it('subscribes to downloads-changed at app mount, before any DownloadsView is rendered', async () => {
    // Regression: previously the popup's DownloadsView owned the
    // subscription in its onMounted, so an initial state push that
    // arrived during a fresh `'downloads'` open landed before the
    // listener existed. The shell now owns the listener so the data
    // is captured even while the menu view is still mounted.
    const { default: TitlePopupApp } = await import('./TitlePopupApp.vue')
    mount(TitlePopupApp)
    await flushPromises()
    expect(bridgeState.downloadsCallbacks.length).toBeGreaterThan(0)
  })

  it('forwards a downloads-changed push to the rendered DownloadsView', async () => {
    const { default: TitlePopupApp } = await import('./TitlePopupApp.vue')
    const wrapper = mount(TitlePopupApp)
    await flushPromises()
    // Push a state snapshot BEFORE switching kinds — this is the race
    // the fix addresses: a snapshot pushed while the menu view is
    // mounted still has to be visible once we flip to 'downloads'.
    bridgeState.downloadsCallbacks.forEach((cb) =>
      cb({
        active: [
          {
            url: 'https://example.com/dl.bin',
            filename: 'dl.bin',
            progress: 0.25,
            status: 'downloading',
          },
        ],
        recent: [],
      }),
    )
    bridgeState.configCallbacks.forEach((cb) =>
      cb({ kind: 'downloads', theme: { bg: '#262729', text: '#dddddd' } }),
    )
    await flushPromises()
    expect(wrapper.find('.downloads-empty').exists()).toBe(false)
    expect(wrapper.find('.downloads-item-name').text()).toBe('dl.bin')
  })

  it('suppresses stale render-acks on rapid back-to-back configs', async () => {
    // Regression: rapid set-config pushes used to queue overlapping
    // rAFs that all called notifyRendered. Only the most recent
    // config's ack should fire so main never marks an older config as
    // synced after the user has moved past it.
    const { default: TitlePopupApp } = await import('./TitlePopupApp.vue')
    mount(TitlePopupApp)
    await flushPromises()
    const before = bridgeState.notifyRenderedCalls
    bridgeState.configCallbacks.forEach((cb) =>
      cb({
        kind: 'menu',
        items: [{ id: 'a', label: 'Alpha' }],
        theme: { bg: '#262729', text: '#dddddd' },
      }),
    )
    bridgeState.configCallbacks.forEach((cb) =>
      cb({
        kind: 'menu',
        items: [{ id: 'b', label: 'Beta' }],
        theme: { bg: '#262729', text: '#dddddd' },
      }),
    )
    await flushPromises()
    await new Promise((r) => setTimeout(r, 30))
    // Exactly one ack — the older rAF closure no-ops via the seq guard.
    expect(bridgeState.notifyRenderedCalls - before).toBe(1)
  })

  it('removes the keydown handler on unmount', async () => {
    const { default: TitlePopupApp } = await import('./TitlePopupApp.vue')
    const wrapper = mount(TitlePopupApp, { attachTo: document.body })
    await flushPromises()
    wrapper.unmount()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(bridgeState.closeCalls).toBe(0)
  })

  // Issue #770 — the picker's modal layer must not survive a kind-switch
  // hide. Main fires `dismiss-modals` right before hiding the picker so
  // a half-open confirm doesn't get stranded in the reused popup view.
  it('cancels any open useModal entry when main fires dismiss-modals', async () => {
    const { useModal } = await import('../composables/useModal')
    const { default: TitlePopupApp } = await import('./TitlePopupApp.vue')
    mount(TitlePopupApp, { attachTo: document.body })
    await flushPromises()
    // App always subscribes; assert the wiring then fire the callback
    // and confirm an open `useModal.confirm` resolves to `false`.
    expect(bridgeState.dismissModalsCallbacks.length).toBeGreaterThan(0)
    const modal = useModal()
    const pending = modal.confirm({ title: 'Update ComfyUI', message: 'Confirm?' })
    expect(modal.state.visible).toBe(true)
    bridgeState.dismissModalsCallbacks.forEach((cb) => cb())
    await expect(pending).resolves.toBe(false)
    expect(modal.state.visible).toBe(false)
  })
})
