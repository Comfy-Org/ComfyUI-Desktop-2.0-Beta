<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowDownToLine,
  ChevronDown,
  CloudDownload,
  Loader2,
  Menu as MenuIcon,
  MessageSquarePlus,
  RefreshCw
} from 'lucide-vue-next'
import { useTitleBarTooltip } from './useTitleBarTooltip'
import { useTitleBarMenus } from './useTitleBarMenus'
import { useTitleBarIdentity } from './useTitleBarIdentity'
import { useUpdatePills } from './useUpdatePills'
import { useTitleBarHoverGate } from './useTitleBarHoverGate'
import ComfyCLogo from '../components/icons/ComfyCLogo.vue'

const { t, locale } = useI18n()

// Inlined to keep the title-bar renderer self-contained — the preload TS
// file isn't visible to tsconfig.web (only its .d.ts would be). Kept in
// sync with the literal union in src/preload/comfyTitleBarPreload.ts and
// the ComfyPanelKey export in src/main/index.ts.
type ComfyPanelKey = 'comfy' | 'new-install' | 'track' | 'load-snapshot' | 'quick-install'

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
  showTooltip: (payload: { text: string; leftX: number; rightX: number; bottomY: number }) => void
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
    cb: (mode: 'none' | 'consent-lockdown' | 'post-consent') => void
  ) => () => void
  /** Preview-mode flag pushed by main. `true` while an in-progress
   *  install identity preview is active on a chooser host (an op was
   *  claimed and the install's title + source icon are showing in the
   *  title bar but the host is still install-less); `false`
   *  otherwise. Drives renderer gates that would normally suppress
   *  install-scoped chrome on install-less hosts so the previewed
   *  install's identity surfaces cleanly. */
  onPreviewModeChanged: (cb: (preview: boolean) => void) => () => void
  /** Installation-id pushes from main. The title bar is a long-lived
   *  view across attach / detach (no URL reload), so the URL query
   *  param is only a cold-boot seed; this push is the
   *  runtime-authoritative source of truth that drives `isInstallLess`
   *  and any install-scoped chrome gated by the install id. `null`
   *  for install-less hosts. */
  onInstallationIdChanged: (cb: (installationId: string | null) => void) => () => void
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
    }) => void
  ) => () => void
  /** Install-update flag pushes from main. `available` is `true`
   *  when the install's `statusTag.style === 'update'`; `version`
   *  carries the target release version when known so the pill can
   *  read "Update v{version}". Only meaningful on install-backed
   *  host windows; install-less hosts never receive this signal.
   *  Drives the title-bar install-update pill. */
  onInstallUpdateAvailable: (
    cb: (state: { available: boolean; version: string | null }) => void
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
  /** Click handler for the centre install pill. Opens the instance-
   *  picker popover anchored beneath the pill. Main filters install-
   *  less hosts (the chooser host pill stays non-interactive — the
   *  dashboard body already IS the picker, so a smaller copy on top
   *  would be redundant). */
  clickInstallPill: (anchor: MenuAnchor) => void
  /** Click handler for the title-bar Send Feedback button. Main
   *  forwards `comfy-panel:open-feedback` to the panel renderer,
   *  which fires the `desktop2.feedback.opened` telemetry action and
   *  opens the support URL via `openExternal`. */
  clickFeedback: () => void
  ready: () => void
}

const bridge = (window as unknown as { __comfyTitleBar?: Bridge }).__comfyTitleBar

const isMac = ref(bridge?.isMac() ?? false)
/** Active body-mode pill, mirrored from main. Drives the native Install
 *  menu's checkmark for install-scoped pages (Install Settings /
 *  Directories). The pill itself no longer reflects this — the pill is
 *  an identity label, not a tab indicator. */
const activePanel = ref<ComfyPanelKey>('comfy')
/**
 * Install-less host window flag — `true` when the host has no install
 * backing it. Drives the center pill's static identity label and
 * suppresses the install-type icon. Seeded from the URL `installationId`
 * query param so the first paint reads correctly, then updated reactively
 * via `onInstallationIdChanged` pushes from main as the host transitions
 * across attach / detach without a title-bar URL reload.
 */
const isInstallLess = ref((bridge?.getInstallationId() ?? '') === '')

const {
  installLabel,
  sourceCategory,
  themeText,
  isFullscreen,
  firstUseMode,
  isConsentLockdown,
  isFirstUseLockdown,
  installTypeMeta,
  installTypeLabel,
  showInstallTypeIcon,
  showBrandMark,
  isLight
} = useTitleBarIdentity({ bridge, isInstallLess })
// Mark unused — sourceCategory feeds installTypeMeta inside the
// composable, but the template doesn't reference it directly.
// firstUseMode is consumed by isFirstUseLockdown / isConsentLockdown
// inside the composable; the template only reads the derived booleans.
void sourceCategory
void firstUseMode

/**
 * Title-bar chrome lockdown. True whenever the bar should collapse to
 * just the static centre pill:
 *   - First-use takeover (consent + post-consent steps).
 *   - ProgressModal takeover (`'loading-lockdown'`) for any long-running
 *     op (install / update / migrate / snapshot / launch).
 * Single derived flag — every gate below reads the same source.
 * `isConsentLockdown` is kept around for the existing CSS class hook
 * on the bar root.
 */

const {
  appUpdateState,
  appUpdatePillLabel,
  appUpdatePillTooltip,
  installUpdatePillLabel,
  showAppUpdatePill,
  showInstallUpdatePill,
  handleAppUpdatePill,
  handleInstallUpdatePill
} = useUpdatePills({ bridge, isInstallLess })

/** Title-bar Send Feedback button. Routes through main, which forwards
 *  `comfy-panel:open-feedback` to the panel renderer — the renderer
 *  fires the `desktop2.feedback.opened` telemetry action and opens the
 *  support URL via `openExternal`. The waffle menu's "Send Feedback"
 *  entry lands on the same panel-side handler. */
function handleFeedback(): void {
  bridge?.clickFeedback()
}

// Icon is ComfyUI-tab only; also visible while the drawer is open so
const titleBarRef = useTemplateRef<HTMLElement>('titleBar')
const fileBtnRef = useTemplateRef<HTMLButtonElement>('fileBtn')
const downloadsBtnRef = useTemplateRef<HTMLButtonElement>('downloadsBtn')
const installPillRef = useTemplateRef<HTMLElement>('installPill')
const titleTrailingRef = useTemplateRef<HTMLElement>('titleTrailing')

/** Mirrors the trailing cluster's measured width onto the title bar as
 *  `--title-trailing-width`, which the left cluster reads as a
 *  `min-width` reservation. This keeps the install pill anchored to
 *  true window center even when only the right side has variable
 *  content (update pills, feedback collapsing to icon, etc.) — the
 *  left cluster grows to match so both 1fr-flanking tracks stay equal.
 *
 *  Pure-CSS can't do this because the left and right clusters have
 *  asymmetric content (waffle menu vs. 5 pills), so neither side can
 *  be a `1fr` mirror of the other. ResizeObserver is the standard
 *  pattern apps like Figma use for the same problem. */
const trailingWidthPx = ref(0)
let trailingObserver: ResizeObserver | undefined

/** Responsive collapse mode for the trailing cluster.
 *
 *  Three tiers, decided from real measured geometry (not bar-width
 *  breakpoints) so the decision actually accounts for the centre
 *  install pill's current position and width:
 *
 *    - 'full'        — Feedback + Desktop Update labels visible.
 *    - 'no-feedback' — Feedback collapsed to icon-only.
 *    - 'icons-only'  — Both Feedback and Desktop Update collapsed.
 *
 *  Each resize frame measures the gap between the install pill's
 *  right edge and the trailing cluster's left edge. With the trailing
 *  mirror live the left-side gap is equal by construction, so the
 *  right gap alone is sufficient. When the gap drops below
 *  `MIN_GAP_PX` the controller advances one tier; it only walks back
 *  when the gap comfortably exceeds the *learned* width cost of
 *  restoring the hidden label plus `RESTORE_BUFFER_PX`. Hysteresis is
 *  essential — collapsing the trailing cluster immediately frees
 *  enough gap to consider re-expanding; the restore-cost guard
 *  prevents that flap. */
type CollapseMode = 'full' | 'no-feedback' | 'icons-only'
const collapseMode = ref<CollapseMode>('full')
const collapsedFeedback = computed(
  () => collapseMode.value === 'no-feedback' || collapseMode.value === 'icons-only'
)
const collapsedUpdate = computed(() => collapseMode.value === 'icons-only')

const MIN_GAP_PX = 16
const RESTORE_BUFFER_PX = 24
/** Learned at runtime via the before/after measurement around each
 *  transition — we don't know analytically how wide each label is
 *  (font, locale, version-string length all vary). The cost is the
 *  drop in `.title-trailing`'s own width, NOT the change in the pill
 *  gap, because the user can be actively dragging a resize during
 *  the rAF settle window and the bar width would otherwise poison
 *  the delta. Trailing width is independent of bar width.
 *
 *  Initialized to 0 so the first transition pair learns the real
 *  cost; until then `RESTORE_BUFFER_PX` is the only guard. */
let feedbackRestoreCostPx = 0
let updateRestoreCostPx = 0
let fitObserver: ResizeObserver | undefined
let fitRaf: number | null = null
let transitionRaf: number | null = null
let unmounted = false

interface FitMeasurement {
  gap: number
  trailingWidth: number
}

/** Measure the gap between the install pill and the trailing cluster,
 *  plus the trailing cluster's own width. Returns sentinels when refs
 *  aren't mounted yet (so the fit controller stays at `'full'` until
 *  layout exists) or when the bar is hidden / detached (rect width 0). */
function measureFit(): FitMeasurement {
  const bar = titleBarRef.value
  const trailing = titleTrailingRef.value
  const pill = installPillRef.value
  if (!bar || !trailing || !pill) return { gap: Infinity, trailingWidth: NaN }
  const barRect = bar.getBoundingClientRect()
  if (barRect.width === 0) return { gap: Infinity, trailingWidth: NaN }
  const trailingRect = trailing.getBoundingClientRect()
  const pillRect = pill.getBoundingClientRect()
  return { gap: trailingRect.left - pillRect.right, trailingWidth: trailingRect.width }
}

function scheduleFit(): void {
  if (unmounted || fitRaf !== null) return
  fitRaf = requestAnimationFrame(() => {
    fitRaf = null
    if (unmounted) return
    evaluateFit()
  })
}

function evaluateFit(): void {
  const { gap } = measureFit()
  if (!Number.isFinite(gap)) return
  const mode = collapseMode.value
  if (mode === 'full') {
    if (gap < MIN_GAP_PX) transitionTo('no-feedback')
  } else if (mode === 'no-feedback') {
    if (gap < MIN_GAP_PX) transitionTo('icons-only')
    else if (gap > feedbackRestoreCostPx + RESTORE_BUFFER_PX) transitionTo('full')
  } else {
    if (gap > updateRestoreCostPx + RESTORE_BUFFER_PX) transitionTo('no-feedback')
  }
}

function transitionTo(next: CollapseMode): void {
  const prev = collapseMode.value
  if (prev === next) return
  const before = measureFit()
  collapseMode.value = next
  // Wait for Vue to flush the DOM update + the browser to lay out,
  // then learn how much trailing width restoring the hidden label
  // would cost. Tracking the rAF lets `onUnmounted` cancel it so
  // teardown doesn't race against a pending measurement callback.
  void nextTick().then(() => {
    if (unmounted) return
    transitionRaf = requestAnimationFrame(() => {
      transitionRaf = null
      if (unmounted) return
      const after = measureFit()
      if (Number.isFinite(before.trailingWidth) && Number.isFinite(after.trailingWidth)) {
        // Trailing shrinks when a label is hidden; the drop is the
        // width the gap will gain back if we restore the label.
        const delta = before.trailingWidth - after.trailingWidth
        if (prev === 'full' && next === 'no-feedback') {
          feedbackRestoreCostPx = Math.max(feedbackRestoreCostPx, delta)
        } else if (prev === 'no-feedback' && next === 'icons-only') {
          updateRestoreCostPx = Math.max(updateRestoreCostPx, delta)
        }
      }
      // Re-evaluate in case one transition didn't free enough room.
      scheduleFit()
    })
  })
}

/** Discard learned restore costs whenever something that changes the
 *  trailing cluster's content width is mutated (locale switch, update
 *  state, install-update flag, …). The next collapse transition then
 *  re-learns the cost from the new label widths. */
function invalidateRestoreCosts(): void {
  feedbackRestoreCostPx = 0
  updateRestoreCostPx = 0
  scheduleFit()
}

const { tooltipAttrs, handleTooltipPointer, hideTip } = useTitleBarTooltip({
  bridge,
  isMac
})

const { isHoverActive } = useTitleBarHoverGate({ hideTip, handleTooltipPointer })

const {
  isDownloadsOpen,
  isInstancePickerOpen,
  downloadsActiveCount,
  unseenFinishedCount,
  unseenErrorCount,
  downloadsTrayLabel,
  downloadsStartedAt,
  handleFileMenu,
  handleDownloadsTray,
  handleInstallPill
} = useTitleBarMenus({
  bridge,
  hideTip,
  fileBtnRef,
  downloadsBtnRef,
  installPillRef
})

/** One-shot "downloads started" attention flash. Driven by
 *  `downloadsStartedAt` from the menus composable, which bumps each
 *  time a brand-new active download appears. The flash is purely
 *  decorative — it overlays the existing pulsing badge / count so the
 *  user immediately notices the tray came alive even if they were
 *  looking elsewhere on screen. The 1600 ms window matches one full
 *  cycle of the underlying CSS keyframes. */
const downloadsFlash = ref(false)
let flashTimer: ReturnType<typeof setTimeout> | null = null
watch(downloadsStartedAt, (next) => {
  if (next === 0) return
  downloadsFlash.value = true
  if (flashTimer) clearTimeout(flashTimer)
  flashTimer = setTimeout(() => {
    downloadsFlash.value = false
    flashTimer = null
  }, 1600)
})

let unsubPanel: (() => void) | undefined
let unsubInstallationId: (() => void) | undefined

onMounted(() => {
  // Observe the trailing cluster so the left cluster can mirror its
  // width (keeps the centered install pill at true window centre).
  // Pills appearing/disappearing (update pills, feedback collapse)
  // change the trailing width — ResizeObserver fires on each.
  if (titleTrailingRef.value && typeof ResizeObserver !== 'undefined') {
    trailingObserver = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const width = Math.ceil(entry.contentRect.width)
      if (width !== trailingWidthPx.value) {
        trailingWidthPx.value = width
      }
    })
    trailingObserver.observe(titleTrailingRef.value)
  }

  // Observe the title bar itself for resize so the fit controller can
  // re-evaluate whether the trailing labels still fit alongside the
  // centre pill. Bar-only is sufficient — install-pill width and
  // trailing width changes propagate through layout and either resize
  // the bar (no, fixed `100vw`) or change the measured rects we read
  // inside `evaluateFit`. The locale/state watches below handle
  // changes that don't trigger a bar resize.
  if (titleBarRef.value && typeof ResizeObserver !== 'undefined') {
    fitObserver = new ResizeObserver(() => scheduleFit())
    fitObserver.observe(titleBarRef.value)
  }
  // Initial pass synchronously on mount so we start in the right tier
  // before the first paint instead of flashing 'full' for one frame
  // on a narrow boot width.
  evaluateFit()

  if (!bridge) return
  unsubPanel = bridge.onPanelChanged((panel) => {
    activePanel.value = panel
  })
  unsubInstallationId = bridge.onInstallationIdChanged((installationId) => {
    isInstallLess.value = installationId === null
  })
  bridge.ready()
})

// Invalidate the learned restore costs when anything that materially
// changes the trailing cluster's content width flips. The fit
// controller re-learns the cost on the next transition.
watch(
  [
    locale,
    installLabel,
    appUpdatePillLabel,
    showAppUpdatePill,
    showInstallUpdatePill,
    // Trailing pills (update / feedback / downloads) hide on
    // first-use lockdown only; loading-lockdown keeps them live, so
    // the legacy `isChromeLocked` would over-invalidate.
    isFirstUseLockdown
  ],
  () => invalidateRestoreCosts()
)

onUnmounted(() => {
  unmounted = true
  unsubPanel?.()
  unsubInstallationId?.()
  hideTip()
  trailingObserver?.disconnect()
  trailingObserver = undefined
  fitObserver?.disconnect()
  fitObserver = undefined
  if (fitRaf !== null) {
    cancelAnimationFrame(fitRaf)
    fitRaf = null
  }
  if (transitionRaf !== null) {
    cancelAnimationFrame(transitionRaf)
    transitionRaf = null
  }
  if (flashTimer) {
    clearTimeout(flashTimer)
    flashTimer = null
  }
})
</script>

<template>
  <header
    ref="titleBar"
    class="title-bar"
    :class="{
      'is-mac': isMac,
      'is-light': isLight,
      'is-fullscreen': isFullscreen,
      'is-hover-active': isHoverActive,
      'is-consent-lockdown': isConsentLockdown,
      'is-collapsed-feedback': collapsedFeedback,
      'is-collapsed-update': collapsedUpdate
    }"
    :data-collapse-mode="collapseMode"
    :style="{
      color: themeText ?? undefined,
      '--title-trailing-width': `${trailingWidthPx}px`
    }"
  >
    <!-- Left: app menu (hamburger). Anchors a native OS menu in main —
         HTML popups would be clipped by the title bar's WebContentsView
         bounds. We previously labelled this "File", but install-backed
         windows host a ComfyUI WebContentsView whose own menus often
         carry their own "File" — having two "File" entries stacked
         vertically read as redundant. The hamburger reads as a
         host-app-level menu and stays out of ComfyUI's namespace. -->
    <!-- Left cluster: waffle menu. The app-update pill moved to the
         right trailing cluster so all user-action controls
         (update / feedback / downloads / settings) live together.
         Hidden only on `consent-lockdown` — `post-consent` still
         surfaces the "Skip Onboarding" escape, and `loading-lockdown`
         keeps the full menu so the user can open a fresh window,
         settings, feedback, or quit cleanly while an op runs. -->
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
    </div>

    <!-- Center: install pill + install-update pill. The downloads tray
         moved to the right trailing cluster alongside the other
         user-action controls; the install-update pill remains here so
         it stays adjacent to the install identity. -->
    <div class="title-center">
      <!-- Center identity pill. Install-backed hosts render as a
           button that opens the instance-picker popover (matching the
           rest of the title-bar dropdown buttons — waffle menu +
           downloads tray). Install-less hosts (the chooser host) AND
           first-use-takeover steps render as a static label — the
           chooser body already IS the picker, and the takeover locks
           down all chrome to avoid wandering out of bootstrap.
           `loading-lockdown` keeps the pill interactive so the user
           can open the picker (switch / open another install) while
           an op runs in the background. -->
      <!-- Interactive on every mode except first-use lockdown. The
           bootstrap UX is the only flow that needs to keep the user
           inside one window; long-running ops mount the ProgressModal
           in this window but leave the title bar free to navigate. -->
      <div
        v-if="!isFirstUseLockdown"
        ref="installPill"
        class="title-install-pill is-interactive"
        :class="{
          'is-open': isInstancePickerOpen,
          'is-install-less': isInstallLess
        }"
        role="button"
        tabindex="0"
        aria-haspopup="dialog"
        :aria-expanded="isInstancePickerOpen"
        @click="handleInstallPill"
        @keydown.enter.prevent="handleInstallPill"
        @keydown.space.prevent="handleInstallPill"
      >
        <!-- Leading mark: the Comfy logo only on the bare dashboard; on an
             actual instance the pill leads with that install's source/type
             icon so the brand logo isn't repeated on every window. -->
        <div class="title-install-slot title-install-slot--leading">
          <ComfyCLogo v-if="showBrandMark" class="title-install-brand-mark" :size="16" />
          <component
            :is="installTypeMeta.icon"
            v-else-if="showInstallTypeIcon"
            :size="16"
            class="title-install-type-icon"
            v-bind="tooltipAttrs(installTypeLabel)"
          />
        </div>
        <div class="title-install-slot title-install-slot--center">
          <span class="title-install-name">{{ installLabel }}</span>
          <!-- Instance update CTA, inline after the name. Its own click
               target — stops propagation so it updates without also
               opening the picker; the rest of the pill still opens it. -->
          <button
            v-if="showInstallUpdatePill"
            type="button"
            class="title-install-update-chip"
            v-bind="tooltipAttrs(installUpdatePillLabel)"
            @click.stop="handleInstallUpdatePill"
            @keydown.enter.stop
            @keydown.space.stop
          >
            {{ t('titleBar.installUpdateShort') }}
          </button>
        </div>
        <!-- Trailing slot: dropdown caret. Marks the pill as an
             interactive opener so the user reads it as actionable. -->
        <div class="title-install-slot title-install-slot--trailing">
          <ChevronDown :size="12" class="title-install-caret" aria-hidden="true" />
        </div>
      </div>
      <div v-else ref="installPill" class="title-install-pill">
        <div class="title-install-slot title-install-slot--leading">
          <ComfyCLogo v-if="showBrandMark" class="title-install-brand-mark" :size="16" />
          <component
            :is="installTypeMeta.icon"
            v-else-if="showInstallTypeIcon"
            :size="16"
            class="title-install-type-icon"
            v-bind="tooltipAttrs(installTypeLabel)"
          />
        </div>
        <div class="title-install-slot title-install-slot--center">
          <span class="title-install-name">{{ installLabel }}</span>
        </div>
        <div class="title-install-slot title-install-slot--trailing"></div>
      </div>
    </div>

    <div ref="titleTrailing" class="title-trailing">
      <!-- App-update pill ("Desktop Update") lives in the trailing
           cluster. The instance-update CTA now lives inside the center
           identity pill (next to the install name) so the two updates
           stay visually distinct: install update = in the center pill;
           Desktop app update = here. -->
      <button
        v-if="!isFirstUseLockdown && showAppUpdatePill"
        type="button"
        class="title-update-pill is-app-update"
        :class="{
          'is-ready': appUpdateState.kind === 'ready',
          'is-downloading': appUpdateState.kind === 'downloading'
        }"
        v-bind="tooltipAttrs(appUpdatePillTooltip)"
        @click="handleAppUpdatePill"
      >
        <CloudDownload v-if="appUpdateState.kind === 'available'" :size="14" />
        <Loader2
          v-else-if="appUpdateState.kind === 'downloading'"
          :size="14"
          class="title-update-pill-spinner"
        />
        <RefreshCw v-else-if="appUpdateState.kind === 'ready'" :size="14" />
        <span class="title-update-pill-label">{{ appUpdatePillLabel ?? 'Desktop Update' }}</span>
      </button>
      <button
        v-if="!isFirstUseLockdown"
        type="button"
        class="title-menu-button title-feedback-button"
        v-bind="tooltipAttrs(t('titleBar.feedbackTooltip'), t('titleBar.feedback'))"
        @click="handleFeedback"
      >
        <MessageSquarePlus :size="16" />
        <span class="title-feedback-label">{{ t('titleBar.feedback') }}</span>
      </button>
      <!-- Downloads tray. Click opens the title-bar dropdown popup in
           `'downloads'` mode anchored under the button. Distinct
           `ArrowDownToLine` icon vs. the update pills' `Download` so
           the user reads "downloads tray" vs "update available" at a
           glance. Hidden during first-use takeover — no installs yet.
           Visible during loading-lockdown so model downloads kicked
           off in parallel with an install/update remain reachable. -->
      <button
        v-if="!isFirstUseLockdown"
        ref="downloadsBtn"
        type="button"
        class="title-downloads-tray"
        :class="{
          'has-active': downloadsActiveCount > 0,
          'has-error': unseenErrorCount > 0,
          'has-unseen':
            downloadsActiveCount === 0 && unseenErrorCount === 0 && unseenFinishedCount > 0,
          'is-flashing': downloadsFlash,
          'is-open': isDownloadsOpen
        }"
        v-bind="tooltipAttrs(downloadsTrayLabel)"
        @click="handleDownloadsTray"
      >
        <ArrowDownToLine :size="16" />
        <span v-if="downloadsActiveCount > 0" class="title-downloads-badge" aria-hidden="true">{{
          downloadsActiveCount
        }}</span>
        <span
          v-else-if="unseenErrorCount > 0"
          class="title-downloads-badge is-error"
          aria-hidden="true"
          >{{ unseenErrorCount }}</span
        >
        <span
          v-else-if="unseenFinishedCount > 0"
          class="title-downloads-badge is-unseen"
          aria-hidden="true"
          >{{ unseenFinishedCount }}</span
        >
        <!-- Mid-batch failure marker: while downloads are still active the
             badge shows the active count, so layer a small red dot on top
             to surface a failure the instant it happens rather than waiting
             for the queue to drain. -->
        <span
          v-if="downloadsActiveCount > 0 && unseenErrorCount > 0"
          class="title-downloads-error-dot"
          aria-hidden="true"
        />
      </button>
    </div>
  </header>
</template>

<style scoped>
.title-bar {
  position: relative;
  /* Three-track grid: [left auto | center 1fr | trailing auto]. Each
     cluster owns its own track, so they cannot overlap regardless of
     how wide the center cluster's content gets. The center pill stays
     visually centered via `justify-self: center` on `.title-center`
     while the 1fr track absorbs all remaining space.

     This replaces an earlier `display: flex` + `position: absolute;
     left: 50%` center cluster that didn't know the trailing cluster's
     width and could be painted under the right-side pills when both
     update pills + Feedback were showing. Grid makes that overlap
     structurally impossible. */
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  height: 100vh;
  width: 100vw;
  /* OS-chrome reservations live in the title-bar padding (NOT in
     cluster margins) so the grid tracks see clean inner space. Mac
     reserves 78px on the left for traffic lights (vanishes in
     fullscreen via the .is-fullscreen override below); Win/Linux
     reserves 140px on the right for native min/max/close. */
  padding: 0 12px;
  box-sizing: border-box;
  background: var(--titlebar-bg);
  color: var(--text-muted);
  border-bottom: 1px solid var(--border);
  font: 12px/1 var(--font-sans, 'Inter', system-ui, sans-serif);
  user-select: none;
  -webkit-app-region: drag;
  column-gap: 12px;
  /* Container scope so the install pill's `max-inline-size:
     clamp(..., 22cqi, ...)` resolves against the bar's inline size
     rather than the viewport. Bar is `100vw` today so the two are
     equivalent, but the explicit container keeps the intent and
     stays correct if the bar ever lives inside a narrower frame. */
  container: title-bar / inline-size;
}
/* macOS: reserve 78px on the left for the traffic-light cluster. */
.title-bar.is-mac {
  padding-left: 78px;
}
/* Traffic lights vanish in macOS fullscreen — reclaim the inset. */
.title-bar.is-mac.is-fullscreen {
  padding-left: 12px;
}
/* Win/Linux: reserve 140px on the right for native window controls. */
.title-bar:not(.is-mac) {
  padding-right: 140px;
}

/* The container DIVs stay drag-region so empty space around the buttons
   is still draggable — only the actual interactive elements opt out via
   `-webkit-app-region: no-drag` (set on each <button> below). Marking
   the containers no-drag would consume the entire title bar width and
   leave only the small left/right padding zones draggable. */
.title-cluster {
  display: flex;
  align-items: center;
  gap: 4px;
  /* Mirror the trailing cluster's measured width (set by the
     ResizeObserver in <script>) so the left + trailing grid tracks
     stay equal-width. With symmetric OS-chrome padding (macOS, where
     the left traffic-light inset is handled below) this centres the
     1fr track at true window centre. */
  min-width: var(--title-trailing-width, 0px);
}
/* Win/Linux: the native window controls reserve 140px on the RIGHT, vs the
   12px base padding on the left. Mirroring only the trailing width centres
   the pill in the *content box*, which the asymmetric reservation shifts
   64px left of true window centre — this is the off-centre pill on Windows.
   Claim the 128px delta (140px controls − 12px base padding) as extra left
   min-width so the 1fr centre track is pushed back to true window centre.
   Keep this value in sync with the `padding-right` above. */
.title-bar:not(.is-mac) .title-cluster {
  min-width: calc(var(--title-trailing-width, 0px) + 128px);
}

.title-center {
  /* Lives in the middle 1fr grid track and is centered within it via
     `justify-self`, so the install pill anchors to the visual centre
     of whatever space the track has — without overlapping the left
     or trailing tracks. */
  justify-self: center;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
}

.title-trailing {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-self: end;
}

/* --- App / hamburger menu button --- */
.title-menu-button {
  -webkit-app-region: no-drag;
  background: transparent;
  color: var(--titlebar-icon);
  border: 1px solid transparent;
  padding: 4px 10px;
  font: inherit;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0.85;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition:
    background-color 0.12s,
    opacity 0.12s,
    border-color 0.12s;
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
.title-menu-button--icon {
  padding: 4px 6px;
  gap: 0;
}
.title-feedback-button {
  color: var(--titlebar-icon);
}
.title-install-pill {
  -webkit-app-region: no-drag;
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  /* Shrink-to-content with bounded floor + ceiling. `inline-size:
     fit-content` lets the pill tighten around short install names
     (e.g. "ComfyUI") so the layout budget isn't held hostage by a
     220px reservation that the content doesn't need. The min keeps
     the pill from looking puny on a wide bar; the max preserves the
     fluid 22cqi growth up to a 360px ceiling, with ellipsis on the
     name beyond that — matching the dashboard pill. */
  inline-size: fit-content;
  min-inline-size: 176px;
  max-inline-size: clamp(176px, 22cqi, 360px);
  height: 28px;
  padding: 5px 8px;
  border-radius: 999px;
  background: var(--chooser-surface-bg);
  color: var(--neutral-100);
  font: inherit;
  font-size: 12px;
  cursor: default;
  transition:
    background-color 120ms ease,
    border-color 120ms ease,
    color 120ms ease;
}
/* Interactive variant — install-backed hosts. The pill is an actionable
 * picker opener (a div with role=button so it can hold the nested update
 * chip): hover repaints to the brand-surface hover token, open state
 * lifts border/text/logo to brand yellow (--neutral-50) so the pill
 * reads as engaged. */
.title-install-pill.is-interactive {
  cursor: pointer;
}
.title-install-pill.is-interactive:hover,
.title-install-pill.is-interactive:focus-visible {
  background: var(--brand-surface-bg-hover);
  outline: none;
}
.title-install-pill.is-interactive.is-open {
  /* Lift border + text to brand yellow when the picker is showing.
   * The brand mark + caret both use `currentColor` so they inherit
   * this lift automatically — one source of truth for the open tint. */
  border-color: var(--neutral-50);
  color: var(--neutral-50);
}

/* Inline instance-update CTA, sitting just after the install name inside
 * the identity pill. Brand-yellow chip so it reads as the actionable
 * "there is an update" affordance without competing with the name. */
.title-install-update-chip {
  -webkit-app-region: no-drag;
  flex-shrink: 0;
  /* A little extra breathing room from the name (on top of the slot's
     6px gap) so the chip doesn't read as crammed against it. */
  margin-left: 4px;
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--comfy-yellow) 55%, transparent);
  background: color-mix(in srgb, var(--comfy-yellow) 12%, transparent);
  color: var(--comfy-yellow);
  font: inherit;
  font-size: 11px;
  line-height: 16px;
  cursor: pointer;
  transition:
    background-color 0.12s,
    border-color 0.12s;
}
.title-bar.is-hover-active .title-install-update-chip:hover {
  background: color-mix(in srgb, var(--comfy-yellow) 20%, transparent);
  border-color: var(--comfy-yellow);
}
.title-install-update-chip:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 1px;
}
.title-bar.is-light .title-install-update-chip {
  background: color-mix(in srgb, var(--comfy-yellow) 22%, transparent);
  border-color: color-mix(in srgb, var(--comfy-yellow) 70%, var(--neutral-700));
  color: var(--neutral-700);
}
.title-install-caret {
  color: currentColor;
  opacity: 0.7;
  flex-shrink: 0;
}
/* Install-less host windows: identity-only `Desktop 2.0 Beta` label. */
.title-install-pill.is-install-less {
  opacity: 0.85;
}

.title-install-slot {
  display: inline-flex;
  align-items: center;
  flex: 0 0 18px;
}
.title-install-slot--center {
  flex: 1 1 auto;
  justify-content: center;
  gap: 6px;
  min-width: 0;
}
/* Brand-mark tracks the pill's `color` token so it lifts to brand
   yellow alongside the border / name / caret when the picker opens.
   `currentColor` keeps it in sync without a separate hover/open rule. */
.title-install-brand-mark {
  flex-shrink: 0;
  color: currentColor;
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
   Neutral pill rendered in the right trailing cluster. State is
   communicated via icon (Download / Loader2 / RefreshCw), not tint —
   the chrome stays the same across `available`, `downloading`, and
   `ready` so the eye lands on the icon for status. Sized to fit
   inside the 36px content area of the 37px title bar without growing
   it.
   TODO(brand-cleanup): the white-alpha-04/10 values aren't tokenized
   yet; the existing `--brand-surface-*` recipe is .05/.09. Migrate to
   a shared `--white-alpha-*` ramp when one is introduced. */
.title-update-pill {
  -webkit-app-region: no-drag;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 10px;
  border-radius: 999px;
  /* High-attention tint: updates are user-actionable CTAs, not passive
     status indicators — they earn the brand-yellow lift to compete
     with the surrounding neutrals. Background stays calm so the
     border + text/icon carry the accent. */
  border: 1px solid color-mix(in srgb, var(--comfy-yellow) 55%, transparent);
  background: color-mix(in srgb, var(--comfy-yellow) 8%, transparent);
  color: var(--comfy-yellow);
  font: inherit;
  font-size: 12px;
  font-weight: 400;
  line-height: 16px;
  cursor: pointer;
  transition:
    background-color 0.12s,
    border-color 0.12s,
    opacity 0.12s;
}
.title-bar.is-hover-active .title-update-pill:hover:not(:disabled) {
  background: color-mix(in srgb, var(--comfy-yellow) 14%, transparent);
  border-color: var(--comfy-yellow);
}
.title-bar.is-light .title-update-pill {
  /* Light theme: brand yellow on white needs darker text for contrast.
     Keep the yellow border + tinted background as the visual signal;
     text drops to neutral-700 for readability. */
  background: color-mix(in srgb, var(--comfy-yellow) 18%, transparent);
  border-color: color-mix(in srgb, var(--comfy-yellow) 65%, var(--neutral-700));
  color: var(--neutral-700);
}
.title-bar.is-light.is-hover-active .title-update-pill:hover:not(:disabled) {
  background: color-mix(in srgb, var(--comfy-yellow) 26%, transparent);
  border-color: color-mix(in srgb, var(--comfy-yellow) 85%, var(--neutral-700));
}
.title-update-pill:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}
.title-update-pill-spinner {
  animation: title-update-pill-spin 1s linear infinite;
}
@keyframes title-update-pill-spin {
  to {
    transform: rotate(360deg);
  }
}
.title-update-pill-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  /* Cap the label width so unusually long version strings (or longer
     localized labels) don't push the trailing cluster wide enough to
     shove the centered install pill off-center. Tooltips on each pill
     carry the full label, so truncated state stays accessible. */
  max-width: clamp(80px, 14cqi, 200px);
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
  cursor: pointer;
  color: var(--titlebar-icon);
  background: transparent;
  border: 1px solid transparent;
  /* Pad the button so the icon centers freely and the badge has a
   * corner to anchor into without crowding the glyph. */
  padding: 4px 6px;
  border-radius: 8px;
  transition: color 0.12s;
}
.title-bar.is-hover-active .title-downloads-tray:hover:not(:disabled) {
  color: var(--comfy-yellow);
}
.title-bar.is-light .title-downloads-tray {
  color: var(--comfy-yellow);
}

.title-downloads-badge {
  /* Standard notification-badge pattern: small pill floating in the
   * top-right corner of the button, anchored to the existing
   * `position: relative` on `.title-downloads-tray`. The icon below
   * gets the full button real-estate; the badge layers above without
   * competing for inline space. */
  position: absolute;
  top: -4px;
  right: -4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 14px;
  height: 14px;
  padding: 0 4px;
  border-radius: 999px;
  /* Subtle ring against the title-bar background so the badge reads
   * as a separate token from the icon underneath at any zoom. */
  box-shadow: 0 0 0 2px var(--titlebar-bg, var(--neutral-900));
  background: var(--accent, #60a5fa);
  color: #fff;
  font-size: 9px;
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}

.title-downloads-tray.has-active {
  border-color: rgba(96, 165, 250, 0.55);
  background: rgba(96, 165, 250, 0.16);
}
.title-bar.is-light .title-downloads-tray.has-active {
  border-color: rgba(37, 99, 235, 0.55);
  background: rgba(37, 99, 235, 0.12);
}
.title-downloads-tray.has-active .title-downloads-badge {
  animation: title-downloads-pulse 1.6s ease-in-out infinite;
}

.title-downloads-tray.is-open,
.title-bar.is-hover-active .title-downloads-tray.is-open:hover {
  color: var(--neutral-50);
}

.title-downloads-tray.is-flashing .title-downloads-badge {
  animation:
    title-downloads-flash 0.55s cubic-bezier(0.2, 0.9, 0.3, 1.4) 1,
    title-downloads-pulse 1.6s ease-in-out infinite 0.6s;
}
.title-downloads-tray.is-flashing {
  animation: title-downloads-tray-flash 0.9s ease-out 1;
}

.title-downloads-tray.has-unseen {
  border-color: rgba(34, 197, 94, 0.55);
  background: rgba(34, 197, 94, 0.16);
}
.title-bar.is-light .title-downloads-tray.has-unseen {
  border-color: rgba(22, 163, 74, 0.55);
  background: rgba(22, 163, 74, 0.12);
}
.title-downloads-badge.is-unseen {
  /* Colour-only delta against the active variant — the green tone
   * carries the "done, unseen" meaning so the icon+count combo can
   * stay identical in shape and size. */
  background: #22c55e;
}

.title-downloads-tray.has-error {
  border-color: color-mix(in srgb, var(--danger) 55%, transparent);
  background: color-mix(in srgb, var(--danger) 16%, transparent);
}
.title-downloads-badge.is-error {
  /* Same shape as the other variants — the danger tone carries the
   * "a download failed" meaning and takes precedence over the green
   * "done, unseen" badge. */
  background: var(--danger);
}

.title-downloads-error-dot {
  /* Mid-batch failure marker. While downloads are still active the
   * count badge occupies the top-right corner, so the failure dot
   * anchors top-LEFT to avoid overlap. The red icon tint
   * (`.has-error`) carries the colour meaning; this dot makes the
   * failure legible at the badge level too. */
  position: absolute;
  top: -3px;
  left: -3px;
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--danger);
  box-shadow: 0 0 0 2px var(--titlebar-bg, var(--neutral-900));
  pointer-events: none;
}

@keyframes title-downloads-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(96, 165, 250, 0.55);
  }
  50% {
    box-shadow: 0 0 0 4px rgba(96, 165, 250, 0);
  }
}
@keyframes title-downloads-flash {
  0% {
    transform: scale(0.6);
    opacity: 0;
  }
  60% {
    transform: scale(1.25);
    opacity: 1;
  }
  100% {
    transform: scale(1);
    opacity: 1;
  }
}
@keyframes title-downloads-tray-flash {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(96, 165, 250, 0);
  }
  20% {
    box-shadow: 0 0 0 4px rgba(96, 165, 250, 0.55);
  }
}

/* Honour reduced-motion preferences — fall back to a static accent
   border for the running state and skip the bounce / pulse loops
   entirely. */
@media (prefers-reduced-motion: reduce) {
  .title-downloads-tray.has-active .title-downloads-badge,
  .title-downloads-tray.is-flashing,
  .title-downloads-tray.is-flashing .title-downloads-badge {
    animation: none;
  }
}

/* --- Responsive pill collapse ---
   Driven by the JS fit controller in <script>, not container queries.
   The controller measures the actual gap between the centre install
   pill rect and the trailing cluster rect each resize frame, then
   advances through three modes (`full` → `no-feedback` → `icons-only`)
   when the gap falls below `MIN_GAP_PX`, walking back with hysteresis
   tied to the learned restore cost of each hidden label.

   Two boolean class hooks mirror that state for CSS:

     - `.is-collapsed-feedback` — Feedback label is hidden.
     - `.is-collapsed-update`   — Desktop Update label is hidden
                                  (implies `.is-collapsed-feedback`).

   Tooltips on every pill carry the full label, so icon-only states
   stay accessible without extra markup. */

.title-bar.is-collapsed-feedback .title-feedback-label {
  display: none;
}
.title-bar.is-collapsed-feedback .title-feedback-button {
  padding: 4px 6px;
  gap: 0;
}

/* When the update label collapses the pill drops to a 24×24 circle
   (matching the Settings + other icon-only chrome) instead of staying
   an oval, so it reads as an icon affordance not a "shrunk pill". */
.title-bar.is-collapsed-update .title-update-pill-label {
  display: none;
}
.title-bar.is-collapsed-update .title-update-pill {
  width: 24px;
  height: 24px;
  padding: 0;
  gap: 0;
  justify-content: center;
  border-radius: 999px;
}
</style>
