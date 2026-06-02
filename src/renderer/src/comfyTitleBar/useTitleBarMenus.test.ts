import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h, shallowRef, type ShallowRef } from 'vue'
import { mount } from '@vue/test-utils'
import { useTitleBarMenus } from './useTitleBarMenus'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (k: string) => k }) }))

type TitleMenuKind = 'menu' | 'downloads' | 'instance-picker'

interface Bridge {
  openFileMenu: ReturnType<typeof vi.fn>
  dismissFileMenu: ReturnType<typeof vi.fn>
  clickDownloadsTray: ReturnType<typeof vi.fn>
  clickInstallPill: ReturnType<typeof vi.fn>
  onMenuOpened: (cb: (info: { menu: TitleMenuKind }) => void) => () => void
  onMenuClosed: (cb: (info: { menu: TitleMenuKind }) => void) => () => void
  onDownloadsChanged: (cb: (s: unknown) => void) => () => void
}

/** Mount the composable in a throwaway host so its `onMounted` bridge
 *  subscriptions fire, then drive it via the captured menu-opened/closed
 *  callbacks the title bar would receive from main. */
function setup() {
  const opened: ((info: { menu: TitleMenuKind }) => void)[] = []
  const closed: ((info: { menu: TitleMenuKind }) => void)[] = []
  const bridge: Bridge = {
    openFileMenu: vi.fn(),
    dismissFileMenu: vi.fn(),
    clickDownloadsTray: vi.fn(),
    clickInstallPill: vi.fn(),
    onMenuOpened: (cb) => { opened.push(cb); return () => {} },
    onMenuClosed: (cb) => { closed.push(cb); return () => {} },
    onDownloadsChanged: () => () => {},
  }
  const nullRef = shallowRef<HTMLElement | null>(null) as Readonly<ShallowRef<HTMLElement | null>>
  let api!: ReturnType<typeof useTitleBarMenus>
  const Host = defineComponent({
    setup() {
      api = useTitleBarMenus({
        bridge: bridge as never,
        hideTip: () => {},
        fileBtnRef: nullRef,
        downloadsBtnRef: nullRef,
        installPillRef: nullRef,
      })
      return () => h('div')
    },
  })
  mount(Host)
  return {
    api,
    bridge,
    openMenu: (menu: TitleMenuKind) => opened.forEach((cb) => cb({ menu })),
    closeMenu: (menu: TitleMenuKind) => closed.forEach((cb) => cb({ menu })),
  }
}

describe('useTitleBarMenus — handleFileMenu toggle gate', () => {
  it('opens the file menu when the instance picker is the open popup (does not toggle-close)', () => {
    const { api, bridge, openMenu } = setup()
    openMenu('instance-picker')
    api.handleFileMenu()
    expect(bridge.openFileMenu).toHaveBeenCalledTimes(1)
    expect(bridge.dismissFileMenu).not.toHaveBeenCalled()
  })

  it('opens the file menu when the downloads tray is the open popup', () => {
    const { api, bridge, openMenu } = setup()
    openMenu('downloads')
    api.handleFileMenu()
    expect(bridge.openFileMenu).toHaveBeenCalledTimes(1)
    expect(bridge.dismissFileMenu).not.toHaveBeenCalled()
  })

  it('toggle-closes only when the file menu itself is open', () => {
    const { api, bridge, openMenu } = setup()
    openMenu('menu')
    api.handleFileMenu()
    expect(bridge.dismissFileMenu).toHaveBeenCalledTimes(1)
    expect(bridge.openFileMenu).not.toHaveBeenCalled()
  })

  it('a picker close (menu-closed: instance-picker) does not arm the file-menu reopen guard', () => {
    const { api, bridge, openMenu, closeMenu } = setup()
    openMenu('instance-picker')
    closeMenu('instance-picker')
    api.handleFileMenu()
    expect(bridge.openFileMenu).toHaveBeenCalledTimes(1)
  })
})
