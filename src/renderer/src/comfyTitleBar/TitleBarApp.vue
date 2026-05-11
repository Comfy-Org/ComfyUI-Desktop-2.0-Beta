<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowDownToLine,
  Download,
  Loader2,
  Menu as MenuIcon,
  MessageSquarePlus,
  RefreshCw,
} from 'lucide-vue-next'
import { installTypeMetaFor } from '../lib/installTypeIcon'

const { t } = useI18n()

// Inlined to keep the title-bar renderer self-contained — the preload TS
// file isn't visible to tsconfig.web (only its .d.ts would be). Kept in
// sync with the literal union in src/preload/comfyTitleBarPreload.ts and
// the ComfyPanelKey export in src/main/index.ts.
type ComfyPanelKey =
  | 'comfy'
  | 'settings'
  | 'new-install'
  | 'track'
  | 'load-snapshot'
  | 'quick-install'

/** Position passed to main so the native menu pops below the anchor button.
 *  Coordinates are in title-bar-local pixels — main translates to window
 *  coordinates (titleBarView is at y=0 so they're already aligned). */
interface MenuAnchor {
  x: number
  y: number
}

/** Single download entry surfaced by the title-bar tray.
 *  Inline mirror of `DownloadsTrayEntry` in
 *  `src/preload/comfyTitleBarPreload.ts` — kept in sync because the
 *  title-bar renderer can't import preload TS directly (only its
 *  generated `.d.ts` would be visible, and we ship neither). */
interface DownloadsTrayEntry {
  url: string
  filename: string
  directory?: string
  progress: number
  status: 'pending' | 'downloading' | 'paused' | 'completed' | 'error' | 'cancelled'
  error?: string
}

/** Payload pushed by main on `comfy-titlebar:downloads-changed`.
 *  Inline mirror of `DownloadsTrayState` in the preload file. */
interface DownloadsTrayState {
  active: DownloadsTrayEntry[]
  recent: DownloadsTrayEntry[]
}

interface Bridge {
  getInstallationId: () => string | null
  isMac: () => boolean
  setPanel: (panel: ComfyPanelKey) => void
  openNewWindow: () => void
  /** Pop the File menu natively (avoids WebContentsView clipping the popup). */
  openFileMenu: (anchor: MenuAnchor) => void
  /** Ask main to dismiss the File menu popup (toggle-close). */
  dismissFileMenu: () => void
  /** Issue #514 — show a hover tooltip in the cached title-bar tooltip
   *  popup. macOS-only path: native HTML `title` tooltips don't appear
   *  reliably for sibling chrome WebContentsViews on macOS, so the
   *  renderer routes hover through main → cached `WebContentsView`
   *  popup. `leftX` / `rightX` / `bottomY` are title-bar-local pixels
   *  (the title-bar view sits at parent-window content (0,0) so they
   *  map directly to window coords on the main side). Main prefers to
   *  anchor the bubble's left edge to `leftX` so the bubble extends
   *  rightward from the trigger; it falls back to right-aligning
   *  `rightX` when growing rightward would overflow. */
  showTooltip: (payload: {
    text: string
    leftX: number
    rightX: number
    bottomY: number
  }) => void
  /** Issue #514 — hide the title-bar hover tooltip popup. */
  hideTooltip: () => void
  onPanelChanged: (cb: (panel: ComfyPanelKey) => void) => () => void
  onTitleChanged: (cb: (title: string) => void) => () => void
  /** Install source-category pushes from main. The raw category
   *  string drives the install-type icon next to the install name
   *  (Standalone / Cloud / Legacy Desktop / …). `null` for
   *  install-less host windows; the renderer suppresses the icon in
   *  that case. */
  onSourceCategoryChanged: (cb: (category: string | null) => void) => () => void
  onThemeChanged: (cb: (theme: { bg: string; text: string }) => void) => () => void
  onFullscreenChanged: (cb: (fullscreen: boolean) => void) => () => void
  onMenuOpened: (cb: (info: { menu: 'menu' | 'downloads' }) => void) => () => void
  onMenuClosed: (cb: (info: { menu: 'menu' | 'downloads' }) => void) => () => void
  /** First-use takeover step pushes from main. Drives the T&C-step
   *  lockdown that hides the waffle menu (the otherwise-always-live
   *  escape hatch) so the user has to either accept consent or close
   *  the window via OS chrome — there's no in-app affordance that
   *  drops them past the T&C without a recorded answer. The
   *  post-consent steps stay normal except for the Skip Onboarding
   *  entry the menu builder adds. */
  onFirstUseModeChanged: (
    cb: (mode: 'none' | 'consent-lockdown' | 'post-consent') => void,
  ) => () => void
  /** App-update state pushes from main. `kind` is `'available'`
   *  after `update-available`, `'ready'` after `update-downloaded`,
   *  and `null` when nothing is pending. Drives the title-bar
   *  app-update pill that sits to the right of the hamburger menu.
   *
   *  `autoUpdate` mirrors the `autoUpdate` setting at the moment the
   *  state was committed. With auto-updates ON the
   *  `'available'` state never fires (main triggers the download
   *  itself); the `'ready'` state then reads "Update will apply on
   *  restart". With auto-updates OFF the `'available'` pill reads
   *  "Update v{version} available" and the `'ready'` pill keeps the
   *  existing "Restart to update" copy. */
  onAppUpdateStateChanged: (
    cb: (state: {
      kind: 'available' | 'downloading' | 'ready' | null
      version: string | null
      autoUpdate: boolean
    }) => void,
  ) => () => void
  /** Install-update flag pushes from main. `available` is `true`
   *  when the install's `statusTag.style === 'update'`; `version`
   *  carries the target release version when known so the pill can
   *  read "Update v{version}". Only meaningful on install-backed
   *  host windows; install-less hosts never receive this signal.
   *  Drives the title-bar install-update pill. */
  onInstallUpdateAvailable: (
    cb: (state: { available: boolean; version: string | null }) => void,
  ) => () => void
  /** Click handler for the app-update pill. */
  clickAppUpdatePill: () => void
  /** Click handler for the install-update pill. */
  clickInstallUpdatePill: () => void
  /** Downloads tray state pushes from main. The payload
   *  carries both in-flight downloads (`active`) and the most recent
   *  terminal entries (`recent`, capped server-side at 10). The tray
   *  is hidden entirely when both arrays are empty so it doesn't
   *  squat in the steady state. Pushed initially on `ready()` and
   *  on every state change (broadcast by the download manager). */
  onDownloadsChanged: (cb: (state: DownloadsTrayState) => void) => () => void
  /** Click handler for the downloads tray. Opens the title-bar
   *  dropdown popup in `'downloads'` mode anchored under the tray
   *  button. */
  clickDownloadsTray: (anchor: MenuAnchor) => void
  /** Click handler for the title-bar Send Feedback button. Main
   *  forwards `comfy-panel:open-feedback` to the panel renderer,
   *  which fires the `desktop2.feedback.opened` telemetry action and
   *  opens the support URL via `openExternal`. */
  clickFeedback: () => void
  ready: () => void
}

const bridge = (window as unknown as { __comfyTitleBar?: Bridge }).__comfyTitleBar

const isMac = ref(bridge?.isMac() ?? false)
const isFullscreen = ref(false)
/**
 * `:hover` gating for the title-bar. The title bar lives in its own
 * WebContentsView, which doesn't receive a `mouseleave` when a native
 * OS menu (Menu.popup, install pill dropdown, etc.) opens over it,
 * and the renderer's last-known cursor position stays "frozen" while
 * the OS menu has the input. Plain `window.blur`/`focus` is not
 * enough on its own — the user can dismiss the menu by clicking back
 * inside the title bar, which immediately refocuses the renderer
 * with a stale cursor position still pointing at the button that
 * opened the menu, leaving `:hover` stuck.
 *
 * The fix is two-step:
 *   1. On `window.blur`, drop the hover gate (`isHoverActive = false`).
 *   2. Re-enable the gate ONLY after a fresh `pointermove` arrives —
 *      i.e. once we know the cursor's position is current. Pure
 *      `window.focus` does NOT re-enable hover, because focus can
 *      return without the cursor having moved (clicking back into
 *      the title bar to dismiss the menu does exactly that).
 *
 * Hover styles are keyed on `.title-bar.is-hover-active` in scoped
 * CSS, so flipping this single flag covers menu, nav, and pill
 * buttons uniformly.
 */
const isHoverActive = ref(true)
/** Active body-mode pill, mirrored from main. Drives the native Install
 *  menu's checkmark for install-scoped pages (Install Settings /
 *  Directories). The pill itself no longer reflects this — the pill is
 *  an identity label, not a tab indicator. */
const activePanel = ref<ComfyPanelKey>('comfy')
/**
 * First-use takeover step pushed from main via
 * `comfy-titlebar:first-use-mode-changed`. The renderer uses the
 * value to lock down the title bar during the T&C consent step
 * (`'consent-lockdown'`) by hiding the waffle menu — the only
 * always-live escape hatch the user would otherwise have out of the
 * binding takeover. Post-consent steps (`'post-consent'`) leave the
 * title bar normal so the file-menu Skip Onboarding entry stays
 * reachable. `'none'` is the steady state with no takeover mounted.
 *
 * State is local, main does NOT cache the value here (it's cached on
 * the host entry main-side, see `ComfyWindowEntry.firstUseMode`),
 * matching how panel-changed / theme-changed already work.
 */
const firstUseMode = ref<'none' | 'consent-lockdown' | 'post-consent'>('none')
const isConsentLockdown = computed(() => firstUseMode.value === 'consent-lockdown')
/**
 * Install-less host window flag. When true, the center
 * install pill labels itself "Desktop 2.0 Beta" (set by the initial
 * title push from main) and the install-type icon next to the label is
 * suppressed. The center pill is no longer clickable in either mode —
 * Settings now lives on the File / waffle menu via the unified Settings
 * modal — so this flag only affects the rendered identity, not the
 * interaction model.
 */
const isInstallLess = ref((bridge?.getInstallationId() ?? '') === '')
/** Install identity ("MyInstall") — main pushes this on ready.
 *  The source-category suffix (`— Standalone` / `— Cloud` / …) is
 *  not part of the label; it's rendered as an icon next to the name
 *  via `installTypeIcon`. */
const installLabel = ref('ComfyUI')
/**
 * Raw `sourceCategory` string pushed by main on the
 * `comfy-titlebar:source-category-changed` channel. Drives the
 * install-type icon next to the install name (Standalone laptop /
 * Cloud / Legacy Desktop tower / …) via the shared
 * `installTypeMetaFor()` helper. `null` for install-less host
 * windows; the icon is suppressed entirely in that case so the
 * "Desktop 2.0 Beta" label reads bare.
 */
const sourceCategory = ref<string | null>(null)
/** Resolved icon metadata for the active install. Wraps
 *  `installTypeMetaFor()` so the helper isn't called inline in the
 *  template (keeps Vue's reactivity watcher minimal). */
const installTypeMeta = computed(() => installTypeMetaFor(sourceCategory.value))
/** Tooltip for the install-type icon. `installTypeMetaFor` returns
 *  dotted keys like `installType.standalone` that match the en
 *  catalog one-to-one. */
const installTypeLabel = computed(() => {
  return t(installTypeMeta.value.labelKey, t('installType.unknown'))
})
/** Whether to render the install-type icon. Suppressed on
 *  install-less host windows (no install backing the entry) so the
 *  "Desktop 2.0 Beta" identity label reads bare. */
const showInstallTypeIcon = computed(
  () => !isInstallLess.value && sourceCategory.value !== null,
)
const themeBg = ref<string | null>(null)
const themeText = ref<string | null>(null)

/**
 * Title-bar status pills.
 *
 * The app-update pill (right of the hamburger) shows when the
 * auto-updater has either downloaded an update (`'ready'`, prompts
 * Restart-to-update via the popover) or detected one is available
 * (`'available'`, prompts Download via the popover). State is pushed
 * from main on `comfy-titlebar:app-update-state-changed`; the pill
 * disappears entirely when `kind` is `null` so the title bar reads
 * clean in the steady state.
 *
 * The install-update pill (right of the install pill in the center)
 * fires when the active install's `statusTag.style === 'update'` —
 * the same signal the chooser tile's "Update" pill consumes. State is
 * pushed from main on `comfy-titlebar:install-update-changed` and is
 * gated on `!isInstallLess` (install-less hosts have no install backing
 * the window, so an install-scoped pill is meaningless there).
 */
const appUpdateState = ref<{
  kind: 'available' | 'downloading' | 'ready' | null
  version: string | null
  autoUpdate: boolean
}>({ kind: null, version: null, autoUpdate: true })
const installUpdateState = ref<{ available: boolean; version: string | null }>({
  available: false,
  version: null,
})

const appUpdatePillLabel = computed<string | null>(() => {
  const s = appUpdateState.value
  if (!s.kind) return null
  if (s.kind === 'ready') return t('titleBar.desktopUpdateReady')
  if (s.kind === 'downloading') return t('titleBar.desktopUpdateDownloading')
  // 'available' — only fires with auto-updates OFF (main suppresses
  // it when ON and triggers the download itself).
  return t('titleBar.desktopUpdateAvailable')
})

/** Tooltip / aria-label augments the pill label with the version when
 *  one is known, so the compact pill stays scan-friendly while the
 *  full "Desktop Update Ready (v1.2.3)" detail is one hover away. */
const appUpdatePillTooltip = computed<string>(() => {
  const label = appUpdatePillLabel.value
  if (!label) return ''
  const v = appUpdateState.value.version
  return v
    ? t('titleBar.desktopUpdateWithVersion', { label, version: v })
    : label
})

/** Install-update pill copy. Mirrors the app-update pill's
 *  "Update {version}" format when main carries a target version
 *  through the install's status tag, falling back to the generic
 *  "Update available" label when no version is known. */
const installUpdatePillLabel = computed<string>(() => {
  const v = installUpdateState.value.version
  return v
    ? t('titleBar.installUpdateVersion', { version: v })
    : t('titleBar.installUpdateAvailable')
})

const showAppUpdatePill = computed(() => appUpdateState.value.kind !== null)
const showInstallUpdatePill = computed(
  () => !isInstallLess.value && installUpdateState.value.available,
)

function handleAppUpdatePill(): void {
  bridge?.clickAppUpdatePill()
}
function handleInstallUpdatePill(): void {
  bridge?.clickInstallUpdatePill()
}

/**
 * Title-bar downloads tray. Always-visible icon button sitting in the
 * center cluster immediately left of the install pill. Distinct from
 * the update pills in two ways so the user reads them at a glance:
 *   - Icon (`ArrowDownToLine` vs `Download` / `RefreshCw`).
 *   - Chrome (neutral surface tint vs blue/green accent).
 *
 * The badge counts in-flight downloads only; recently-completed
 * entries surface in the popup but don't bump the count (so the
 * count reads as "what's still working"). Click opens the title-bar
 * dropdown popup in `'downloads'` mode; the popup carries the
 * empty-state copy so the title-bar button stays present even when
 * nothing is downloading.
 *
 * Stays visible during the consent lockdown so an in-flight model
 * download remains reachable while the waffle / feedback are hidden.
 */
const downloadsState = ref<DownloadsTrayState>({ active: [], recent: [] })

const downloadsActiveCount = computed(() => downloadsState.value.active.length)
const downloadsTrayLabel = computed<string>(() => {
  const n = downloadsActiveCount.value
  if (n === 0) return t('titleBar.downloads')
  return t('titleBar.downloadsInProgress', { n }, n)
})

const downloadsBtnRef = useTemplateRef<HTMLButtonElement>('downloadsBtn')

function handleDownloadsTray(): void {
  // Toggle-close + reopen guard mirror `handleFileMenu` — the popup is
  // a single shared WebContentsView, so the same dismiss / reopen
  // behaviour the waffle has applies. Without this the tray button
  // would re-pop the popup immediately after the user's click on it
  // dismissed it, looking like the popup never closes.
  if (isMenuOpen.value) {
    bridge?.dismissFileMenu()
    return
  }
  if (Date.now() - menuClosedAt.downloads < MENU_REOPEN_GUARD_MS) return
  bridge?.clickDownloadsTray(anchorBelow(downloadsBtnRef.value))
}

/** Title-bar Send Feedback button. Routes through main, which forwards
 *  `comfy-panel:open-feedback` to the panel renderer — the renderer
 *  fires the `desktop2.feedback.opened` telemetry action and opens the
 *  support URL via `openExternal`. The waffle menu's "Send Feedback"
 *  entry lands on the same panel-side handler. */
function handleFeedback(): void {
  bridge?.clickFeedback()
}

/** Body luminance test — drives is-light styling (lighter hover state). */
const isLight = computed(() => {
  const bg = themeBg.value
  if (!bg) return false
  // Round-trip through canvas to normalise any color string into #rrggbb.
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return false
  ctx.fillStyle = bg
  const hex = ctx.fillStyle as string
  if (!hex.startsWith('#') || hex.length < 7) return false
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return (r * 299 + g * 587 + b * 114) / 1000 >= 128
})

const fileBtnRef = useTemplateRef<HTMLButtonElement>('fileBtn')

/** Per-menu suppression window. When the popup closes, we stamp
 *  `Date.now()` against its kind. The next click on the same opener
 *  button within `MENU_REOPEN_GUARD_MS` is treated as "the same click
 *  that just dismissed the popup" and is dropped, preventing the
 *  popup from flickering open immediately after the user clicked the
 *  open button to dismiss it. The OS dismisses the popup first, then
 *  the click event reaches our renderer button — without this guard
 *  the handler would ask main to pop the popup again. Tracked per
 *  popup kind because the waffle and the downloads tray are separate
 *  buttons; clicking the downloads button shouldn't suppress a fresh
 *  waffle open and vice versa. */
const MENU_REOPEN_GUARD_MS = 100
const menuClosedAt: Record<'menu' | 'downloads', number> = { menu: 0, downloads: 0 }

/** Tracks whether the popup is currently visible. Set by main via
 *  `onMenuOpened` / `onMenuClosed` IPCs. The timestamp guard above
 *  is unreliable on macOS because the click event can fire before
 *  the blur-driven dismiss propagates back; checking `isMenuOpen`
 *  catches that case — the click's blur will dismiss the popup, so
 *  we just don't ask main to reopen. */
const isMenuOpen = ref(false)

/** Anchor a native menu just below `el`'s bottom-left corner.
 *  Coordinates are in title-bar-local pixels (y is rounded down so the
 *  popup always sits flush with — never above — the button). */
function anchorBelow(el: HTMLElement | null | undefined): MenuAnchor {
  if (!el) return { x: 0, y: 0 }
  const rect = el.getBoundingClientRect()
  return { x: Math.round(rect.left), y: Math.round(rect.bottom) }
}

/**
 * Issue #514 — macOS hover-tooltip plumbing.
 *
 * On macOS the native HTML `title` tooltip does not reliably fire for
 * controls inside a sibling chrome `WebContentsView` that isn't the
 * focused web contents (Electron + Cocoa quirk). The title bar always
 * sits in such a view, so on macOS we route hover through main, which
 * positions a cached `WebContentsView` popup attached to the host
 * window — that popup escapes the title-bar view's 37px clip. On
 * Windows / Linux the native `title` attribute renders Chromium's own
 * tooltip widget reliably; the JS handlers below are no-ops in that
 * case so we don't end up with two tooltips.
 *
 * Implementation is delegated: a single `pointermove` / `pointerleave`
 * pair on the header root finds the closest `[data-title-tooltip]`
 * ancestor and fires `showTip` / `hideTip`. New tooltipped elements
 * just need the data attribute — no per-element wiring.
 */
/** Initial show delay (ms). Matches the cadence of native HTML
 *  tooltips on macOS / Win so a quick fly-by across the title bar
 *  doesn't flash bubbles. */
const TOOLTIP_SHOW_DELAY_MS = 400
/** Hover-handoff window (ms). If a tooltip was visible up to this
 *  long ago, the next hover over a different tooltipped element shows
 *  immediately — same convention as native macOS / browser tooltips,
 *  where the first hover earns the wait but subsequent ones in a
 *  scanning gesture feel snappy. */
const TOOLTIP_HANDOFF_WINDOW_MS = 1500
let tooltipShowTimer: number | null = null
/** Text of the tooltip the renderer most recently asked main to show
 *  (or queue). `null` while nothing is pending or visible. */
let activeTooltipText: string | null = null
/** True between `bridge.showTooltip()` and the corresponding
 *  `bridge.hideTooltip()` — i.e., a tooltip is currently visible. The
 *  pending-but-not-yet-shown state has this `false`. */
let isTooltipVisible = false
/** `performance.now()` timestamp of the most recent
 *  `bridge.hideTooltip()`. Drives the hover-handoff fast path. */
let lastHiddenAt = -Infinity

/**
 * Single source of truth for tooltip-related attributes on title-bar
 * controls. Cocoa's native HTML `title` tooltip occasionally DOES
 * fire for our sibling-view buttons even though it's documented as
 * unreliable; when it does, the user gets two bubbles at once (the
 * native one plus our custom popup). Keep them mutually exclusive at
 * the source by emitting `title` only off-mac and `data-title-tooltip`
 * only on mac. `aria-label` is unconditional so screen readers see
 * the same string regardless of platform — pass `ariaLabel` separately
 * when the visible label and the tooltip copy intentionally differ
 * (e.g. the Send Feedback button shows "Beta Feedback" but the
 * tooltip reads "Send Feedback").
 */
function tooltipAttrs(text: string, ariaLabel?: string): Record<string, string> {
  const base: Record<string, string> = { 'aria-label': ariaLabel ?? text }
  if (isMac.value) {
    base['data-title-tooltip'] = text
  } else {
    base.title = text
  }
  return base
}

function findTooltipTarget(target: EventTarget | null): {
  text: string
  rect: DOMRect
} | null {
  if (!(target instanceof Element)) return null
  const el = target.closest('[data-title-tooltip]') as HTMLElement | SVGElement | null
  if (!el) return null
  const text = el.getAttribute('data-title-tooltip')
  if (!text) return null
  return { text, rect: el.getBoundingClientRect() }
}

function cancelPendingTooltipShow(): void {
  if (tooltipShowTimer !== null) {
    window.clearTimeout(tooltipShowTimer)
    tooltipShowTimer = null
  }
}

function hideTip(): void {
  cancelPendingTooltipShow()
  if (activeTooltipText === null) return
  activeTooltipText = null
  if (isTooltipVisible) {
    isTooltipVisible = false
    lastHiddenAt = performance.now()
  }
  bridge?.hideTooltip()
}

function fireShowTooltip(text: string, rect: DOMRect): void {
  bridge?.showTooltip({
    text,
    leftX: Math.round(rect.left),
    rightX: Math.round(rect.right),
    bottomY: Math.round(rect.bottom),
  })
  isTooltipVisible = true
}

function handleTooltipPointer(event: PointerEvent): void {
  if (!isMac.value) return
  const found = findTooltipTarget(event.target)
  if (!found) {
    hideTip()
    return
  }
  if (found.text === activeTooltipText) {
    // Same trigger as before — no work needed. (Either we're still
    // waiting on the show timer, or the tooltip is already visible;
    // either way we don't reset state mid-hover.)
    return
  }
  // Different (or first) tooltipped target. Hide any in-flight tooltip
  // and queue the new one. If we were just showing a tooltip moments
  // ago (hover-handoff), skip the show delay so scanning across the
  // title bar feels instant — matches native macOS behaviour.
  const handoff =
    isTooltipVisible || performance.now() - lastHiddenAt < TOOLTIP_HANDOFF_WINDOW_MS
  hideTip()
  const captured = found
  activeTooltipText = captured.text
  if (handoff) {
    fireShowTooltip(captured.text, captured.rect)
    return
  }
  tooltipShowTimer = window.setTimeout(() => {
    tooltipShowTimer = null
    if (activeTooltipText !== captured.text) return
    fireShowTooltip(captured.text, captured.rect)
  }, TOOLTIP_SHOW_DELAY_MS)
}

function handleFileMenu(): void {
  // Hide any in-flight tooltip — the menu will obscure the same area
  // and the click won't fire pointerleave.
  hideTip()
  // Toggle-close: if the popup is open at click time, actively ask
  // main to dismiss it. The blur-driven dismiss path can't be relied
  // on here — on macOS clicking a sibling WebContentsView in the
  // same parent window doesn't reliably trigger a `blur` on the
  // popup webContents, so the popup would otherwise stay open.
  if (isMenuOpen.value) {
    bridge?.dismissFileMenu()
    return
  }
  // Suppress reopen on platforms where the dismiss did propagate
  // before the click event fires (Windows / Linux): the same click
  // that dismissed the popup also retargets the menu button, and
  // without this guard handleFileMenu would ask main to pop the
  // menu again.
  if (Date.now() - menuClosedAt.menu < MENU_REOPEN_GUARD_MS) return
  bridge?.openFileMenu(anchorBelow(fileBtnRef.value))
}
let unsubPanel: (() => void) | undefined
let unsubTitle: (() => void) | undefined
let unsubSourceCategory: (() => void) | undefined
let unsubTheme: (() => void) | undefined
let unsubFullscreen: (() => void) | undefined
let unsubMenuOpened: (() => void) | undefined
let unsubMenuClosed: (() => void) | undefined
let unsubFirstUseMode: (() => void) | undefined
let unsubAppUpdate: (() => void) | undefined
let unsubInstallUpdate: (() => void) | undefined
let unsubDownloads: (() => void) | undefined

/** Drop the hover gate immediately when input leaves the title-bar
 *  webContents — covers the case where a native menu (Menu.popup) or
 *  another view receives focus. Also dismisses any in-flight tooltip
 *  for the same reason. */
const handleWindowBlur = (): void => {
  isHoverActive.value = false
  hideTip()
}
/** Re-enable the hover gate only on a fresh `pointermove`. We do NOT
 *  re-enable on `window.focus` alone, because focus can return without
 *  any cursor movement (clicking back into the title bar to dismiss
 *  the menu refocuses the renderer with a stale cursor position).
 *  Also drives the macOS tooltip dispatcher (issue #514). */
const handlePointerMove = (event: PointerEvent): void => {
  if (!isHoverActive.value) isHoverActive.value = true
  handleTooltipPointer(event)
}
/** Belt-and-braces: if the cursor leaves the title-bar's bounds, drop
 *  the gate. The renderer should normally see a `mouseleave` here, but
 *  on some platforms / WebContentsView setups the leave doesn't fire
 *  reliably, so we mirror the blur path. */
const handlePointerLeave = (): void => {
  isHoverActive.value = false
  hideTip()
}

onMounted(() => {
  if (!bridge) return
  unsubPanel = bridge.onPanelChanged((panel) => {
    activePanel.value = panel
  })
  unsubTitle = bridge.onTitleChanged((title) => {
    installLabel.value = title || 'ComfyUI'
  })
  unsubSourceCategory = bridge.onSourceCategoryChanged((category) => {
    sourceCategory.value = category
  })
  unsubTheme = bridge.onThemeChanged(({ bg, text }) => {
    themeBg.value = bg
    themeText.value = text
  })
  unsubFullscreen = bridge.onFullscreenChanged((fullscreen) => {
    isFullscreen.value = fullscreen
  })
  unsubMenuOpened = bridge.onMenuOpened(() => {
    isMenuOpen.value = true
  })
  unsubMenuClosed = bridge.onMenuClosed(({ menu }) => {
    menuClosedAt[menu] = Date.now()
    isMenuOpen.value = false
  })
  unsubFirstUseMode = bridge.onFirstUseModeChanged((mode) => {
    firstUseMode.value = mode
  })
  unsubAppUpdate = bridge.onAppUpdateStateChanged((next) => {
    appUpdateState.value = next
  })
  unsubInstallUpdate = bridge.onInstallUpdateAvailable((next) => {
    installUpdateState.value = next
  })
  unsubDownloads = bridge.onDownloadsChanged((next) => {
    downloadsState.value = next
  })
  window.addEventListener('blur', handleWindowBlur)
  window.addEventListener('pointermove', handlePointerMove)
  document.documentElement.addEventListener('pointerleave', handlePointerLeave)
  // Initial state — assume hover is inert until the user actually
  // moves the mouse over the title bar. This matches the post-blur
  // behaviour: no hover styling without a fresh pointer position.
  isHoverActive.value = false
  bridge.ready()
})

onUnmounted(() => {
  unsubPanel?.()
  unsubTitle?.()
  unsubSourceCategory?.()
  unsubTheme?.()
  unsubFullscreen?.()
  unsubMenuOpened?.()
  unsubMenuClosed?.()
  unsubFirstUseMode?.()
  unsubAppUpdate?.()
  unsubInstallUpdate?.()
  unsubDownloads?.()
  window.removeEventListener('blur', handleWindowBlur)
  window.removeEventListener('pointermove', handlePointerMove)
  document.documentElement.removeEventListener('pointerleave', handlePointerLeave)
  hideTip()
})
</script>

<template>
  <header
    class="title-bar"
    :class="{
      'is-mac': isMac,
      'is-light': isLight,
      'is-fullscreen': isFullscreen,
      'is-hover-active': isHoverActive,
      'is-consent-lockdown': isConsentLockdown,
    }"
    :style="{
      background: themeBg ?? undefined,
      color: themeText ?? undefined,
    }"
  >
    <!-- Left: app menu (hamburger). Anchors a native OS menu in main —
         HTML popups would be clipped by the title bar's WebContentsView
         bounds. We previously labelled this "File", but install-backed
         windows host a ComfyUI WebContentsView whose own menus often
         carry their own "File" — having two "File" entries stacked
         vertically read as redundant. The hamburger reads as a
         host-app-level menu and stays out of ComfyUI's namespace. -->
    <!-- Left cluster: waffle menu + app-update pill. Both stay live
         during Tier 3 takeovers so the user can reach Return-to-Dashboard
         / Close-Window / Skip Onboarding without dismissing the
         takeover. Exception: during the first-use T&C consent step
         (`isConsentLockdown`) the waffle is hidden entirely so the
         user must either accept consent or close the window via OS
         chrome; the waffle reappears once the takeover advances to
         `'post-consent'`. -->
    <div class="title-cluster">
      <button
        v-if="!isConsentLockdown"
        ref="fileBtn"
        type="button"
        class="title-menu-button title-menu-button--icon"
        aria-haspopup="menu"
        v-bind="tooltipAttrs(t('titleBar.menu'))"
        @click="handleFileMenu"
      >
        <MenuIcon :size="18" />
      </button>
      <!-- App-update pill (issue #488) — disappears entirely in the
           steady state. Click routes through main, which fires the
           appropriate confirm modal in the panel. -->
      <button
        v-if="showAppUpdatePill"
        type="button"
        class="title-update-pill is-app-update"
        :class="{
          'is-ready': appUpdateState.kind === 'ready',
          'is-downloading': appUpdateState.kind === 'downloading',
        }"
        v-bind="tooltipAttrs(appUpdatePillTooltip)"
        @click="handleAppUpdatePill"
      >
        <Download v-if="appUpdateState.kind === 'available'" :size="14" />
        <Loader2
          v-else-if="appUpdateState.kind === 'downloading'"
          :size="14"
          class="title-update-pill-spinner"
        />
        <RefreshCw v-else-if="appUpdateState.kind === 'ready'" :size="14" />
        <span class="title-update-pill-label">{{ appUpdatePillLabel }}</span>
      </button>
    </div>

    <!-- Center: downloads tray + install pill + install-update pill.
         Single click target on the pill opens the unified Settings
         modal; the downloads tray is always-visible (the empty-state
         copy lives inside the popup) and the install-update pill
         only mounts when an install update is available. -->
    <div class="title-center">
      <!-- Always-visible downloads tray. Click opens the title-bar
           dropdown popup in `'downloads'` mode anchored under the
           button. The icon (`ArrowDownToLine`) is intentionally
           distinct from the update pills' `Download` icon so the
           user reads "downloads tray" vs "update available pill"
           at a glance. Stays visible during `isConsentLockdown` so
           in-flight model downloads remain reachable while the
           waffle is hidden. -->
      <button
        ref="downloadsBtn"
        type="button"
        class="title-downloads-tray"
        :class="{ 'has-active': downloadsActiveCount > 0 }"
        v-bind="tooltipAttrs(downloadsTrayLabel)"
        @click="handleDownloadsTray"
      >
        <ArrowDownToLine :size="14" />
        <span
          v-if="downloadsActiveCount > 0"
          class="title-downloads-badge"
          aria-hidden="true"
        >{{ downloadsActiveCount }}</span>
      </button>
      <!-- Center identity pill. Install-backed hosts show the install's
           name + install-type icon; install-less hosts show the static
           `Desktop 2.0 Beta` label. The pill is a non-interactive label
           — Settings now opens from the File / waffle menu via the
           unified Settings modal, so the pill no longer needs to be a
           click target. -->
      <div
        class="title-install-pill"
        :class="{ 'is-install-less': isInstallLess }"
      >
        <!-- Install-type icon (Standalone laptop / Cloud / Legacy
             Desktop tower / …). Sized at 14px to fit inside the
             36px content area without growing the pill. -->
        <component
          :is="installTypeMeta.icon"
          v-if="showInstallTypeIcon"
          :size="14"
          class="title-install-type-icon"
          v-bind="tooltipAttrs(installTypeLabel)"
        />
        <span class="title-install-name">{{ installLabel }}</span>
      </div>
      <!-- Install-update pill. Suppressed in install-less
           mode (no install backing the host) and in the steady state
           (status tag isn't `update`). Click sends a panel-trigger to
           open the manage overlay on the update tab — same surface the
           chooser kebab "Update…" entry lands on. -->
      <button
        v-if="showInstallUpdatePill"
        type="button"
        class="title-update-pill is-install-update"
        v-bind="tooltipAttrs(installUpdatePillLabel)"
        @click="handleInstallUpdatePill"
      >
        <Download :size="14" />
        <span class="title-update-pill-label">{{ installUpdatePillLabel }}</span>
      </button>
    </div>

    <div class="drag-spacer"></div>

    <!-- Trailing cluster: Send Feedback. Hidden during the consent
         lockdown for the same reason the waffle is — the only
         first-use gesture we want available is consent or OS-chrome
         close. -->
    <div class="title-trailing">
      <button
        v-if="!isConsentLockdown"
        type="button"
        class="title-menu-button title-feedback-button"
        v-bind="tooltipAttrs(t('titleBar.feedbackTooltip'), t('titleBar.feedback'))"
        @click="handleFeedback"
      >
        <MessageSquarePlus :size="16" />
        <span class="title-feedback-label">{{ t('titleBar.feedback') }}</span>
      </button>
    </div>
  </header>
</template>

<style scoped>
.title-bar {
  position: relative;
  display: flex;
  align-items: center;
  /* Symmetric base padding. OS-chrome reservations live on the side
     children so the center cluster anchors to true window center. */
  height: 100vh;
  width: 100vw;
  padding-left: 12px;
  padding-right: 12px;
  box-sizing: border-box;
  background: var(--surface);
  color: var(--text-muted);
  border-bottom: 1px solid var(--border);
  font: 12px/1 var(--font-sans, 'Inter', system-ui, sans-serif);
  user-select: none;
  -webkit-app-region: drag;
  gap: 8px;
}

/* The container DIVs stay drag-region so empty space around the buttons
   is still draggable — only the actual interactive elements opt out via
   `-webkit-app-region: no-drag` (set on each <button> below). Marking
   the containers no-drag would consume the entire title bar width and
   leave only the small left/right padding zones draggable. */
.title-cluster {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  /* Sits above the absolutely-positioned center cluster so the
     hamburger / app-update pill remain clickable if the window
     narrows enough that the centered pill would otherwise overlap
     them. Must be > .title-center's z-index, otherwise DOM order wins
     and the later-painted center cluster covers the cluster's
     buttons. */
  z-index: 2;
}
/* macOS: shift past the traffic lights (78px reservation − 12px base padding). */
.title-bar.is-mac .title-cluster {
  margin-left: 66px;
}
/* Traffic lights vanish in macOS fullscreen — reclaim the inset. */
.title-bar.is-mac.is-fullscreen .title-cluster {
  margin-left: 0;
}

.title-center {
  /* Anchored to true window center; shrink-wraps around its content. */
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 0;
  max-width: calc(100% - 24px);
  /* Sits above the elastic drag-spacer so the always-visible
     downloads tray and the install-update pill stay clickable when
     the window narrows. */
  z-index: 1;
}

.title-trailing {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  margin-left: 12px;
  /* Same precedence rule as `.title-cluster` — must outrank
     `.title-center` so the feedback button stays clickable when a
     wide center cluster encroaches. */
  z-index: 2;
}
/* Win/Linux: native close / min / max controls overlay the right
   ~140px of the window. Push the trailing cluster past them so the
   feedback button doesn't sit underneath the OS chrome. */
.title-bar:not(.is-mac) .title-trailing {
  margin-right: 128px;
}

.drag-spacer {
  /* Eats the remaining flex space between the center cluster and the
     trailing cluster so the bar's drag region fills the row. */
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
}

/* --- App / hamburger menu button --- */
.title-menu-button {
  -webkit-app-region: no-drag;
  background: transparent;
  color: inherit;
  border: 1px solid transparent;
  padding: 4px 10px;
  font: inherit;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0.85;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition: background-color 0.12s, opacity 0.12s, border-color 0.12s;
}
.title-bar.is-hover-active .title-menu-button:hover {
  opacity: 1;
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.18);
}
.title-bar.is-light.is-hover-active .title-menu-button:hover {
  background: rgba(0, 0, 0, 0.06);
  border-color: rgba(0, 0, 0, 0.18);
}

/* Icon-only variant — square padding so the hamburger sits centred. */
.title-menu-button--icon {
  padding: 4px 6px;
  gap: 0;
}

/* --- Install pill (center) — single click target. The whole pill
       opens the native install menu on install-backed windows and
       renders the static `Desktop 2.0 Beta` label on install-less host
       windows. Identity-only — Settings now opens from the File / waffle
       menu via the unified Settings modal, so the pill is no longer
       clickable and shows no caret or hover affordance. --- */
.title-install-pill {
  -webkit-app-region: no-drag;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  /* Pill shape — pill-radius (999px) + horizontal padding for breathing
     room around the install name. */
  padding: 4px 12px;
  border-radius: 999px;
  /* Solid surface fill so the pill still reads as a chip, not as bare
     text. Subtle border for definition on light themes. */
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.14);
  color: inherit;
  font: inherit;
  font-weight: 500;
  cursor: default;
  max-width: 480px;
}
.title-bar.is-light .title-install-pill {
  background: rgba(0, 0, 0, 0.04);
  border-color: rgba(0, 0, 0, 0.14);
}
/* Install-less host windows: identity-only `Desktop 2.0 Beta` label. */
.title-install-pill.is-install-less {
  opacity: 0.85;
}

.title-install-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
/* Install-type icon. Sized to fit the 36px content area of the title
   bar without growing it; opacity matches the caret so the icon
   reads as a calm visual cue rather than competing with the install
   name. */
.title-install-type-icon {
  flex-shrink: 0;
  opacity: 0.85;
}

/* --- Status pills (app-update + install-update) ---
   Compact chip styling. The pills must fit inside the 36px content
   area of the 37px title bar (1px bottom border) without growing it,
   so padding/font-size are kept tight. Default colour palette tracks
   the title bar text colour with a coloured tint so the pill draws
   the eye but doesn't dominate the bar. */
.title-update-pill {
  -webkit-app-region: no-drag;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  font: inherit;
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
  border-radius: 999px;
  cursor: pointer;
  background: rgba(96, 165, 250, 0.18);
  color: inherit;
  border: 1px solid rgba(96, 165, 250, 0.35);
  transition: background-color 0.12s, border-color 0.12s, opacity 0.12s;
}
.title-bar.is-hover-active .title-update-pill:hover:not(:disabled) {
  background: rgba(96, 165, 250, 0.28);
  border-color: rgba(96, 165, 250, 0.5);
}
.title-update-pill.is-ready {
  background: rgba(34, 197, 94, 0.18);
  border-color: rgba(34, 197, 94, 0.4);
}
.title-bar.is-hover-active .title-update-pill.is-ready:hover:not(:disabled) {
  background: rgba(34, 197, 94, 0.28);
  border-color: rgba(34, 197, 94, 0.55);
}
.title-update-pill.is-downloading {
  background: rgba(148, 163, 184, 0.18);
  border-color: rgba(148, 163, 184, 0.4);
}
.title-bar.is-hover-active .title-update-pill.is-downloading:hover:not(:disabled) {
  background: rgba(148, 163, 184, 0.28);
  border-color: rgba(148, 163, 184, 0.55);
}
.title-update-pill-spinner {
  animation: title-update-pill-spin 1s linear infinite;
}
@keyframes title-update-pill-spin {
  to { transform: rotate(360deg); }
}
.title-update-pill:focus-visible {
  outline: 2px solid var(--accent, #60a5fa);
  outline-offset: 2px;
}
.title-update-pill-label {
  white-space: nowrap;
}

/* --- Downloads tray ---
   Icon-only chip sitting next to the app-update pill. Distinct from
   the update pills in three ways so the user reads them at a glance
   as separate things:
     1. Icon: `ArrowDownToLine` (vs Download / RefreshCw on the
        update pills).
     2. Chrome: neutral surface tint (no blue/green accent) — the
        tray is a passive informational entry-point, not a CTA.
     3. Shape: square-ish padding + rounded corners (vs the update
        pills' fully-pilled radius).
   Padding/font-size kept tight (matching the update pills) so the
   tray fits in the 36px content area of the 37px title bar without
   growing it. */
.title-downloads-tray {
  -webkit-app-region: no-drag;
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 3px 6px;
  font: inherit;
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
  border-radius: 6px;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.06);
  color: inherit;
  border: 1px solid rgba(255, 255, 255, 0.14);
  transition: background-color 0.12s, border-color 0.12s, opacity 0.12s;
}
.title-bar.is-hover-active .title-downloads-tray:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.14);
  border-color: rgba(255, 255, 255, 0.28);
}
.title-bar.is-light .title-downloads-tray {
  background: rgba(0, 0, 0, 0.04);
  border-color: rgba(0, 0, 0, 0.14);
}
.title-bar.is-light.is-hover-active .title-downloads-tray:hover:not(:disabled) {
  background: rgba(0, 0, 0, 0.09);
  border-color: rgba(0, 0, 0, 0.24);
}
.title-downloads-tray:focus-visible {
  outline: 2px solid var(--accent, #60a5fa);
  outline-offset: 2px;
}
/* Badge counter — small numeric pill next to the icon when there
   are in-flight downloads. Suppressed in the icon-only case (recent
   entries with no active ones) so the tray collapses to just the
   icon when nothing is moving. */
.title-downloads-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 14px;
  height: 14px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--accent, #60a5fa);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
}

/* Dropdown popups are now native OS menus rendered via Menu.popup() in
   main — no HTML popup styles needed here. */
</style>
