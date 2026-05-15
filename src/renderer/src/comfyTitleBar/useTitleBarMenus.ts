import { computed, onMounted, onUnmounted, ref, type ComputedRef, type Ref, type ShallowRef } from 'vue'
import { useI18n } from 'vue-i18n'

interface MenuAnchor {
  x: number
  y: number
}

interface DownloadsTrayEntry {
  url: string
  filename: string
  directory?: string
  progress: number
  status: 'pending' | 'downloading' | 'paused' | 'completed' | 'error' | 'cancelled'
  error?: string
}

interface DownloadsTrayState {
  active: DownloadsTrayEntry[]
  recent: DownloadsTrayEntry[]
}

interface TitleBarMenusBridge {
  openFileMenu: (anchor: MenuAnchor) => void
  dismissFileMenu: () => void
  clickDownloadsTray: (anchor: MenuAnchor) => void
  onMenuOpened: (cb: (info: { menu: 'menu' | 'downloads' }) => void) => () => void
  onMenuClosed: (cb: (info: { menu: 'menu' | 'downloads' }) => void) => () => void
  onDownloadsChanged: (cb: (state: DownloadsTrayState) => void) => () => void
}

interface UseTitleBarMenusOpts {
  bridge: TitleBarMenusBridge | undefined
  /** Hide any in-flight tooltip — the menu will obscure the same area
   *  and the click won't fire pointerleave. */
  hideTip: () => void
  /** Template ref for the waffle / file-menu button. */
  fileBtnRef: Readonly<ShallowRef<HTMLElement | null>>
  /** Template ref for the downloads-tray button. */
  downloadsBtnRef: Readonly<ShallowRef<HTMLElement | null>>
}

interface TitleBarMenusApi {
  isMenuOpen: Ref<boolean>
  downloadsState: Ref<DownloadsTrayState>
  downloadsActiveCount: ComputedRef<number>
  downloadsTrayLabel: ComputedRef<string>
  handleFileMenu: () => void
  handleDownloadsTray: () => void
}

/**
 * Title-bar native-menu openers + downloads-tray state.
 *
 * Both popups (the waffle / file menu and the downloads tray) share a
 * single WebContentsView in main, so they share dismiss / reopen
 * behaviour:
 *   - `isMenuOpen` is mirrored from main via `onMenuOpened` /
 *     `onMenuClosed` so click handlers can toggle-close instead of
 *     racing the OS-driven dismiss.
 *   - `menuClosedAt` per-kind suppression catches the platform case
 *     where the dismiss propagates before our click handler runs (the
 *     same click that closed the popup also retargets the opener
 *     button); without it the popup flickers immediately back open.
 *
 * Tracked per-kind because the waffle and the downloads-tray live on
 * separate buttons — clicking one shouldn't suppress a fresh open of
 * the other.
 */
export function useTitleBarMenus(opts: UseTitleBarMenusOpts): TitleBarMenusApi {
  const { t } = useI18n()

  /** Per-menu suppression window: the OS dismisses the popup before
   *  the click event reaches the renderer, so a naïve handler would
   *  re-pop the popup on the same click. 100ms covers the worst-case
   *  Windows / Linux retarget gap. */
  const MENU_REOPEN_GUARD_MS = 100
  const menuClosedAt: Record<'menu' | 'downloads', number> = { menu: 0, downloads: 0 }

  const isMenuOpen = ref(false)
  const downloadsState = ref<DownloadsTrayState>({ active: [], recent: [] })

  const downloadsActiveCount = computed(() => downloadsState.value.active.length)
  const downloadsTrayLabel = computed<string>(() => {
    const n = downloadsActiveCount.value
    if (n === 0) return t('titleBar.downloads')
    return t('titleBar.downloadsInProgress', { n }, n)
  })

  /** Anchor a native menu just below `el`'s bottom-left corner.
   *  Coordinates are title-bar-local px; main translates to window
   *  coords (the title-bar view sits at parent (0,0)). */
  function anchorBelow(el: HTMLElement | null | undefined): MenuAnchor {
    if (!el) return { x: 0, y: 0 }
    const rect = el.getBoundingClientRect()
    return { x: Math.round(rect.left), y: Math.round(rect.bottom) }
  }

  function handleFileMenu(): void {
    opts.hideTip()
    // Toggle-close: on macOS clicking a sibling WebContentsView in the
    // same parent window doesn't reliably blur the popup webContents,
    // so the renderer asks main to dismiss explicitly.
    if (isMenuOpen.value) {
      opts.bridge?.dismissFileMenu()
      return
    }
    if (Date.now() - menuClosedAt.menu < MENU_REOPEN_GUARD_MS) return
    opts.bridge?.openFileMenu(anchorBelow(opts.fileBtnRef.value))
  }

  function handleDownloadsTray(): void {
    opts.hideTip()
    if (isMenuOpen.value) {
      opts.bridge?.dismissFileMenu()
      return
    }
    if (Date.now() - menuClosedAt.downloads < MENU_REOPEN_GUARD_MS) return
    opts.bridge?.clickDownloadsTray(anchorBelow(opts.downloadsBtnRef.value))
  }

  let unsubMenuOpened: (() => void) | undefined
  let unsubMenuClosed: (() => void) | undefined
  let unsubDownloads: (() => void) | undefined

  onMounted(() => {
    if (!opts.bridge) return
    unsubMenuOpened = opts.bridge.onMenuOpened(() => {
      isMenuOpen.value = true
    })
    unsubMenuClosed = opts.bridge.onMenuClosed(({ menu }) => {
      menuClosedAt[menu] = Date.now()
      isMenuOpen.value = false
    })
    unsubDownloads = opts.bridge.onDownloadsChanged((next) => {
      downloadsState.value = next
    })
  })

  onUnmounted(() => {
    unsubMenuOpened?.()
    unsubMenuClosed?.()
    unsubDownloads?.()
  })

  return {
    isMenuOpen,
    downloadsState,
    downloadsActiveCount,
    downloadsTrayLabel,
    handleFileMenu,
    handleDownloadsTray,
  }
}
