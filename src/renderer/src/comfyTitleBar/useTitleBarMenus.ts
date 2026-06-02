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
  /** Mirror of `isMenuOpen` scoped to the downloads-tray popup only.
   *  Used by the title-bar to highlight the download-tray icon (brand
   *  yellow) while the popover is showing — matches the convention
   *  the waffle button already enjoys via its native-menu open state. */
  isDownloadsOpen: Ref<boolean>
  downloadsState: Ref<DownloadsTrayState>
  downloadsActiveCount: ComputedRef<number>
  /** Number of `recent` (terminal) entries the user hasn't reviewed
   *  yet. Reset to zero whenever the downloads popup is opened. */
  unseenFinishedCount: ComputedRef<number>
  /** Subset of `unseenFinishedCount` limited to failures (`error`) —
   *  drives the red error badge. */
  unseenErrorCount: ComputedRef<number>
  /** Tooltip / aria-label for the tray button — switches between an
   *  in-progress label, an unseen-finished label, and the idle
   *  "Downloads" label. */
  downloadsTrayLabel: ComputedRef<string>
  /** Monotonic timestamp bumped each time a brand-new active download
   *  appears so the title bar can play a one-shot "downloads started"
   *  attention animation. `0` means "no pulse yet" — the renderer can
   *  treat it as a guard for the initial mount. */
  downloadsStartedAt: Ref<number>
  /** Mirror of `isMenuOpen` scoped to the instance-picker popup.
   *  Drives the centre pill's `is-open` pressed-state styling so the
   *  pill reads as actively engaged while the popover is showing — same
   *  convention the waffle + downloads tray buttons use. */
  isInstancePickerOpen: Ref<boolean>
  handleFileMenu: () => void
  handleDownloadsTray: () => void
  /** Click handler for the centre install pill. Toggle-closes if the
   *  picker is already open; otherwise opens the popup anchored
   *  beneath the pill's bottom edge. */
  handleInstallPill: () => void
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
 *
 * The composable also owns the "unseen finished" book-keeping for the
 * downloads tray (issue #558): when downloads complete while the user
 * isn't looking, the tray tags itself as unseen until the popup is
 * opened. URLs already in `recent` on first sight are treated as
 * already-acknowledged so a window opening mid-flow doesn't paint a
 * stale indicator.
 */
export function useTitleBarMenus(opts: UseTitleBarMenusOpts): TitleBarMenusApi {
  const { t } = useI18n()

  /** Per-menu suppression window: the OS dismisses the popup before
   *  the click event reaches the renderer, so a naïve handler would
   *  re-pop the popup on the same click. 100ms covers the worst-case
   *  Windows / Linux retarget gap. */
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
  /** URLs the user has already acknowledged. Used to derive the
   *  unseen-finished count without persisting per-entry state on the
   *  upstream payload. */
  const seenUrls = reactive(new Set<string>())
  /** Last set of active URLs — diffed against the next push to detect
   *  "a new download appeared". */
  const previousActiveUrls = new Set<string>()
  let firstDownloadsPush = true
  const downloadsStartedAt = ref(0)

  const downloadsActiveCount = computed(() => downloadsState.value.active.length)
  const unseenFinishedCount = computed(() =>
    downloadsState.value.recent.filter((d) => !seenUrls.has(d.url)).length,
  )
  /** Unseen *failures* only (`error`, not user-initiated `cancelled`) —
   *  drives the red error badge that takes precedence over the green
   *  "completed" badge so a failed download never reads as success. */
  const unseenErrorCount = computed(() =>
    downloadsState.value.recent.filter((d) => d.status === 'error' && !seenUrls.has(d.url)).length,
  )
  const downloadsTrayLabel = computed<string>(() => {
    const active = downloadsActiveCount.value
    const errors = unseenErrorCount.value
    if (active > 0) {
      // Surface a mid-batch failure in the tooltip too — the red dot is
      // the visual cue, this is its accessible/explanatory counterpart.
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
    // Toggle-close only when the file menu itself is open. macOS doesn't
    // reliably blur a sibling WebContentsView, so dismiss explicitly.
    if (isFileMenuOpen.value) {
      opts.bridge?.dismissFileMenu()
      return
    }
    if (Date.now() - menuClosedAt.menu < MENU_REOPEN_GUARD_MS) return
    opts.bridge?.openFileMenu(anchorBelow(opts.fileBtnRef.value))
  }

  function handleDownloadsTray(): void {
    opts.hideTip()
    /** Toggle + reopen suppression live in main (see `click-downloads-
     *  tray` handler in titlePopup.ts) — the renderer just dispatches.
     *  Reading `isMenuOpen` here used to race the blur-driven close,
     *  causing the "click closes, immediately reopens" symptom. */
    opts.bridge?.clickDownloadsTray(anchorDownloadsBelow(opts.downloadsBtnRef.value))
  }

  function handleInstallPill(): void {
    opts.hideTip()
    // Main owns the toggle + reopen-suppression for the picker —
    // single source of truth. The renderer just dispatches the click;
    // main checks `titlePopupsByParent` to decide open vs close vs
    // suppress-spurious-reopen-after-blur. This eliminates the IPC
    // race between the blur-driven close (fires on focus shift /
    // mousedown) and the renderer's `menu-closed` listener (lags by
    // an IPC roundtrip) — the renderer's `isMenuOpen` could be
    // wrong at the moment the click handler runs, so trusting it
    // here was the source of the "click closes, immediately
    // reopens, click again to actually close" bug.
    opts.bridge?.clickInstallPill(anchorDownloadsBelow(opts.installPillRef.value))
  }

  /** Mark every current `recent` entry as seen. Triggered by main
   *  pushing `menu: 'downloads'` in `onMenuOpened` so opening the
   *  popup is what acknowledges the indicator. */
  function acknowledgeRecent(): void {
    for (const d of downloadsState.value.recent) seenUrls.add(d.url)
  }

  /** Diff helper — returns true if `next.active` carries a URL that
   *  wasn't in the previous active set. Used to bump the "started"
   *  timestamp once per new in-flight item. */
  function hasNewActive(next: DownloadsTrayState): boolean {
    for (const d of next.active) {
      if (!previousActiveUrls.has(d.url)) return true
    }
    return false
  }

  function ingestDownloadsState(next: DownloadsTrayState): void {
    if (firstDownloadsPush) {
      // The first push happens after main's `ready()` and reflects
      // whatever was in flight when the window came up. Treat all
      // entries (active + recent) as already-known so we don't fire
      // the "started" pulse for downloads the user already initiated
      // and don't paint an unseen indicator for items that finished
      // before the window opened.
      for (const d of next.active) previousActiveUrls.add(d.url)
      for (const d of next.recent) seenUrls.add(d.url)
      firstDownloadsPush = false
      downloadsState.value = next
      return
    }
    if (hasNewActive(next)) downloadsStartedAt.value = Date.now()
    previousActiveUrls.clear()
    for (const d of next.active) previousActiveUrls.add(d.url)
    // Drop seen URLs that no longer appear in `recent` so the set
    // doesn't grow unbounded across the window's lifetime.
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
