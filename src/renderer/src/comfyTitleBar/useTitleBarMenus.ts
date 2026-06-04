import { computed, onMounted, onUnmounted, reactive, ref, type ComputedRef, type Ref, type ShallowRef } from 'vue'
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

type TitleMenuKind = 'menu' | 'downloads' | 'instance-picker'

interface TitleBarMenusBridge {
  openFileMenu: (anchor: MenuAnchor) => void
  dismissFileMenu: () => void
  clickDownloadsTray: (anchor: MenuAnchor) => void
  clickInstallPill: (anchor: MenuAnchor) => void
  onMenuOpened: (cb: (info: { menu: TitleMenuKind }) => void) => () => void
  onMenuClosed: (cb: (info: { menu: TitleMenuKind }) => void) => () => void
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
  /** Template ref for the centre install pill — used to anchor the
   *  instance-picker popup below the pill. */
  installPillRef: Readonly<ShallowRef<HTMLElement | null>>
}

interface TitleBarMenusApi {
  isMenuOpen: Ref<boolean>
  /** `isMenuOpen` scoped to the downloads tray; drives the icon highlight. */
  isDownloadsOpen: Ref<boolean>
  downloadsState: Ref<DownloadsTrayState>
  downloadsActiveCount: ComputedRef<number>
  /** Unreviewed terminal entries; reset when the downloads popup opens. */
  unseenFinishedCount: ComputedRef<number>
  /** Subset of `unseenFinishedCount` limited to failures; drives the red badge. */
  unseenErrorCount: ComputedRef<number>
  downloadsTrayLabel: ComputedRef<string>
  /** Bumped when a new active download appears so the title bar can play a
   *  one-shot pulse. `0` = no pulse yet. */
  downloadsStartedAt: Ref<number>
  /** `isMenuOpen` scoped to the instance-picker; drives the pill's pressed state. */
  isInstancePickerOpen: Ref<boolean>
  handleFileMenu: () => void
  handleDownloadsTray: () => void
  handleInstallPill: () => void
}

/**
 * Title-bar menu openers + downloads-tray state. `isMenuOpen` is mirrored from
 * main so click handlers toggle-close instead of racing the OS dismiss;
 * `menuClosedAt` per-kind suppression catches the case where the dismiss lands
 * before the click handler runs (which would flicker the popup back open).
 * Tracked per-kind since the buttons are separate. Also owns the "unseen
 * finished" book-keeping for the downloads tray.
 */
export function useTitleBarMenus(opts: UseTitleBarMenusOpts): TitleBarMenusApi {
  const { t } = useI18n()

  /** Per-menu suppression: the OS dismisses the popup before the click reaches
   *  the renderer, so a naïve handler would re-pop on the same click. 100ms
   *  covers the worst-case Windows/Linux retarget gap. */
  const MENU_REOPEN_GUARD_MS = 100
  const menuClosedAt: Record<TitleMenuKind, number> = {
    menu: 0,
    downloads: 0,
    'instance-picker': 0,
  }

  const isMenuOpen = ref(false)
  const isDownloadsOpen = ref(false)
  const isInstancePickerOpen = ref(false)
  const downloadsState = ref<DownloadsTrayState>({ active: [], recent: [] })
  /** URLs already acknowledged, used to derive the unseen-finished count. */
  const seenUrls = reactive(new Set<string>())
  /** Last active URLs, diffed against the next push to detect a new download. */
  const previousActiveUrls = new Set<string>()
  let firstDownloadsPush = true
  const downloadsStartedAt = ref(0)

  const downloadsActiveCount = computed(() => downloadsState.value.active.length)
  const unseenFinishedCount = computed(() =>
    downloadsState.value.recent.filter((d) => !seenUrls.has(d.url)).length,
  )
  /** Unseen failures only (not user-`cancelled`); the red badge takes
   *  precedence over green so a failure never reads as success. */
  const unseenErrorCount = computed(() =>
    downloadsState.value.recent.filter((d) => d.status === 'error' && !seenUrls.has(d.url)).length,
  )
  const downloadsTrayLabel = computed<string>(() => {
    const active = downloadsActiveCount.value
    const errors = unseenErrorCount.value
    if (active > 0) {
      // Surface a mid-batch failure in the tooltip (accessible counterpart to
      // the red dot).
      const inProgress = t('titleBar.downloadsInProgress', { n: active }, active)
      if (errors > 0) {
        return `${inProgress} · ${t('titleBar.downloadsFailedUnseen', { n: errors }, errors)}`
      }
      return inProgress
    }
    if (errors > 0) return t('titleBar.downloadsFailedUnseen', { n: errors }, errors)
    const unseen = unseenFinishedCount.value
    if (unseen > 0) return t('titleBar.downloadsCompleteUnseen', { n: unseen }, unseen)
    return t('titleBar.downloads')
  })

  /** Anchor a native menu just below `el`'s bottom-left corner.
   *  Coordinates are title-bar-local px; main translates to window
   *  coords (the title-bar view sits at parent (0,0)). */
  function anchorBelow(el: HTMLElement | null | undefined): MenuAnchor {
    if (!el) return { x: 0, y: 0 }
    const rect = el.getBoundingClientRect()
    return { x: Math.round(rect.left), y: Math.round(rect.bottom) }
  }

  /** Same as `anchorBelow` but nudged down so the downloads card clears
   *  the title-bar chrome (border/shadow) instead of sitting flush. */
  function anchorDownloadsBelow(el: HTMLElement | null | undefined): MenuAnchor {
    const base = anchorBelow(el)
    const DOWNLOADS_POPUP_GAP_BELOW_TRIGGER_PX = 12
    return { x: base.x, y: base.y + DOWNLOADS_POPUP_GAP_BELOW_TRIGGER_PX }
  }

  /** True only when the FILE menu (not the picker / downloads) is the open
   *  popup — `isMenuOpen` is set for every kind, so it can't gate the toggle. */
  const isFileMenuOpen = computed(
    () => isMenuOpen.value && !isDownloadsOpen.value && !isInstancePickerOpen.value,
  )

  function handleFileMenu(): void {
    opts.hideTip()
    // Toggle-close explicitly — macOS doesn't reliably blur a sibling view.
    if (isFileMenuOpen.value) {
      opts.bridge?.dismissFileMenu()
      return
    }
    if (Date.now() - menuClosedAt.menu < MENU_REOPEN_GUARD_MS) return
    opts.bridge?.openFileMenu(anchorBelow(opts.fileBtnRef.value))
  }

  function handleDownloadsTray(): void {
    opts.hideTip()
    // Toggle + reopen suppression live in main; the renderer just dispatches.
    // Reading `isMenuOpen` here would race the blur-driven close.
    opts.bridge?.clickDownloadsTray(anchorDownloadsBelow(opts.downloadsBtnRef.value))
  }

  function handleInstallPill(): void {
    opts.hideTip()
    // Main owns the toggle + reopen-suppression; the renderer just dispatches.
    // Trusting the renderer's (IPC-lagged) `isMenuOpen` here raced the
    // blur-driven close.
    opts.bridge?.clickInstallPill(anchorDownloadsBelow(opts.installPillRef.value))
  }

  /** Mark current `recent` entries seen; triggered by main's `onMenuOpened`. */
  function acknowledgeRecent(): void {
    for (const d of downloadsState.value.recent) seenUrls.add(d.url)
  }

  /** True if `next.active` carries a URL not in the previous active set. */
  function hasNewActive(next: DownloadsTrayState): boolean {
    for (const d of next.active) {
      if (!previousActiveUrls.has(d.url)) return true
    }
    return false
  }

  function ingestDownloadsState(next: DownloadsTrayState): void {
    if (firstDownloadsPush) {
      // First push reflects what was in flight at window open; treat all entries
      // as already-known so we don't pulse / flag pre-existing downloads.
      for (const d of next.active) previousActiveUrls.add(d.url)
      for (const d of next.recent) seenUrls.add(d.url)
      firstDownloadsPush = false
      downloadsState.value = next
      return
    }
    if (hasNewActive(next)) downloadsStartedAt.value = Date.now()
    previousActiveUrls.clear()
    for (const d of next.active) previousActiveUrls.add(d.url)
    // Drop seen URLs no longer in `recent` so the set stays bounded.
    const stillRecent = new Set(next.recent.map((d) => d.url))
    for (const url of [...seenUrls]) {
      if (!stillRecent.has(url)) seenUrls.delete(url)
    }
    downloadsState.value = next
  }

  let unsubMenuOpened: (() => void) | undefined
  let unsubMenuClosed: (() => void) | undefined
  let unsubDownloads: (() => void) | undefined

  onMounted(() => {
    if (!opts.bridge) return
    unsubMenuOpened = opts.bridge.onMenuOpened((info) => {
      isMenuOpen.value = true
      if (info.menu === 'downloads') {
        isDownloadsOpen.value = true
        acknowledgeRecent()
      } else if (info.menu === 'instance-picker') {
        isInstancePickerOpen.value = true
      }
    })
    unsubMenuClosed = opts.bridge.onMenuClosed(({ menu }) => {
      menuClosedAt[menu] = Date.now()
      isMenuOpen.value = false
      if (menu === 'downloads') isDownloadsOpen.value = false
      if (menu === 'instance-picker') isInstancePickerOpen.value = false
    })
    unsubDownloads = opts.bridge.onDownloadsChanged(ingestDownloadsState)
  })

  onUnmounted(() => {
    unsubMenuOpened?.()
    unsubMenuClosed?.()
    unsubDownloads?.()
  })

  return {
    isMenuOpen,
    isDownloadsOpen,
    isInstancePickerOpen,
    downloadsState,
    downloadsActiveCount,
    unseenFinishedCount,
    unseenErrorCount,
    downloadsTrayLabel,
    downloadsStartedAt,
    handleFileMenu,
    handleDownloadsTray,
    handleInstallPill,
  }
}
