<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowDownToLine,
  ChevronDown,
  CloudDownload,
  Loader2,
  Menu as MenuIcon,
  MessageSquarePlus,
  RefreshCw,
  Settings as SettingsIcon
} from 'lucide-vue-next'
import { useTitleBarTooltip } from './useTitleBarTooltip'
import { useTitleBarMenus } from './useTitleBarMenus'
import { useTitleBarIdentity } from './useTitleBarIdentity'
import { useUpdatePills } from './useUpdatePills'
import { useTitleBarHoverGate } from './useTitleBarHoverGate'
import ComfyCLogo from '../components/icons/ComfyCLogo.vue'

const { t } = useI18n()

// Inlined to keep the title-bar renderer self-contained — the preload TS
// file isn't visible to tsconfig.web (only its .d.ts would be). Kept in
// sync with the literal union in src/preload/comfyTitleBarPreload.ts and
// the ComfyPanelKey export in src/main/index.ts.
type ComfyPanelKey =
  | 'comfy'
  | 'settings'
  | 'settings-v2'
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
  /** Title-bar Settings icon close path. Routes through main → panel
   *  renderer → drawer's local `requestClose()` so the slide-out
   *  animation runs before `layoutViews` collapses the panelView. */
  requestCloseDrawer: () => void
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
 * Install-less host window flag — true when the host has no install
 * backing it. Drives the center pill's static identity label and
 * suppresses the install-type icon. Computed once on construction;
 * the bridge never changes this for a given title-bar instance.
 */
const isInstallLess = ref((bridge?.getInstallationId() ?? '') === '')

const {
  installLabel,
  sourceCategory,
  themeText,
  isFullscreen,
  firstUseMode,
  isConsentLockdown,
  installTypeMeta,
  installTypeLabel,
  showInstallTypeIcon,
  isLight
} = useTitleBarIdentity({ bridge, isInstallLess })
// Mark unused — sourceCategory feeds installTypeMeta inside the
// composable, but the template doesn't reference it directly.
void sourceCategory

/**
 * Any active first-use takeover step (consent + post-consent). During
 * onboarding the title bar strips itself down to a minimal identity
 * bar: hamburger, downloads tray, and feedback button all hide,
 * leaving just the centered brand pill. Reverts to the full
 * steady-state chrome once `firstUseMode === 'none'`. `isConsentLockdown`
 * is kept around for the existing CSS class hook on the bar root.
 */
const isFirstUseTakeover = computed(
  () => firstUseMode.value === 'consent-lockdown' || firstUseMode.value === 'post-consent'
)

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
// it can act as the close toggle. Hidden during any first-use takeover
// step (consent + post-consent) so it matches the waffle/tray/feedback
// chrome that also strips out during onboarding.
const showSettingsIcon = computed(
  () =>
    !isInstallLess.value &&
    !isFirstUseTakeover.value &&
    (activePanel.value === 'comfy' || activePanel.value === 'settings-v2')
)

// Open is synchronous (`setPanel`); close routes through main → panel
// renderer so the drawer's leave animation can complete before
// `layoutViews` collapses the panelView.
function handleSettingsToggle(): void {
  if (!bridge) return
  if (activePanel.value === 'settings-v2') {
    bridge.requestCloseDrawer()
  } else {
    bridge.setPanel('settings-v2')
  }
}

const fileBtnRef = useTemplateRef<HTMLButtonElement>('fileBtn')
const downloadsBtnRef = useTemplateRef<HTMLButtonElement>('downloadsBtn')
const installPillRef = useTemplateRef<HTMLButtonElement>('installPill')
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

  if (!bridge) return
  unsubPanel = bridge.onPanelChanged((panel) => {
    activePanel.value = panel
  })
  bridge.ready()
})

onUnmounted(() => {
  unsubPanel?.()
  hideTip()
  trailingObserver?.disconnect()
  trailingObserver = undefined
  if (flashTimer) {
    clearTimeout(flashTimer)
    flashTimer = null
  }
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
      'is-consent-lockdown': isConsentLockdown
    }"
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
         (update / feedback / downloads / settings) live together. -->
    <div class="title-cluster">
      <button
        v-if="!isFirstUseTakeover"
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
           down all chrome to avoid wandering out of bootstrap. -->
      <!-- Interactive on both install-backed AND install-less (chooser)
           hosts so the user has one consistent way to switch instances
           from anywhere in the app. First-use takeover still renders the
           static label — the bootstrap UX locks down all chrome to keep
           the user inside the flow. -->
      <button
        v-if="!isFirstUseTakeover"
        ref="installPill"
        type="button"
        class="title-install-pill"
        :class="{ 'is-open': isInstancePickerOpen, 'is-install-less': isInstallLess }"
        aria-haspopup="dialog"
        :aria-expanded="isInstancePickerOpen"
        @click="handleInstallPill"
      >
        <div class="title-install-slot title-install-slot--leading">
          <ComfyCLogo class="title-install-brand-mark" :size="16" />
        </div>
        <div class="title-install-slot title-install-slot--center">
          <component
            :is="installTypeMeta.icon"
            v-if="showInstallTypeIcon"
            :size="14"
            class="title-install-type-icon"
            v-bind="tooltipAttrs(installTypeLabel)"
          />
          <span class="title-install-name">{{ installLabel }}</span>
        </div>
        <!-- Trailing slot: dropdown caret. Marks the pill as an
             interactive opener so the user reads it as actionable. -->
        <div class="title-install-slot title-install-slot--trailing">
          <ChevronDown :size="12" class="title-install-caret" aria-hidden="true" />
        </div>
      </button>
      <div
        v-else
        class="title-install-pill"
      >
        <div class="title-install-slot title-install-slot--leading">
          <ComfyCLogo class="title-install-brand-mark" :size="16" />
        </div>
        <div class="title-install-slot title-install-slot--center">
          <component
            :is="installTypeMeta.icon"
            v-if="showInstallTypeIcon"
            :size="14"
            class="title-install-type-icon"
            v-bind="tooltipAttrs(installTypeLabel)"
          />
          <span class="title-install-name">{{ installLabel }}</span>
        </div>
        <div class="title-install-slot title-install-slot--trailing"></div>
      </div>
    </div>

    <div ref="titleTrailing" class="title-trailing">
      <!-- Install-update pill ("ComfyUI X.Y.Z") and app-update pill
           ("Desktop Update") both live in the trailing cluster so the
           center stays clean — only the install identity sits at true
           window center. The two updates read as a paired CTA group:
           ComfyCLogo icon = ComfyUI core; CloudDownload icon = Desktop
           app. Same chrome (brand-yellow tint), different icons. -->
      <button
        v-if="showInstallUpdatePill"
        type="button"
        class="title-update-pill is-install-update"
        v-bind="tooltipAttrs(installUpdatePillLabel)"
        @click="handleInstallUpdatePill"
      >
        <ComfyCLogo :size="14" class="title-update-pill-glyph" />
        <span class="title-update-pill-label">{{ installUpdatePillLabel }}</span>
      </button>
      <button
        v-if="showAppUpdatePill"
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
        v-if="!isFirstUseTakeover"
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
           glance. Hidden during first-use takeover — no installs yet. -->
      <button
        v-if="!isFirstUseTakeover"
        ref="downloadsBtn"
        type="button"
        class="title-downloads-tray"
        :class="{
          'has-active': downloadsActiveCount > 0,
          'has-unseen': downloadsActiveCount === 0 && unseenFinishedCount > 0,
          'is-flashing': downloadsFlash,
          'is-open': isDownloadsOpen
        }"
        v-bind="tooltipAttrs(downloadsTrayLabel)"
        @click="handleDownloadsTray"
      >
        <ArrowDownToLine :size="16" />
        <span
          v-if="downloadsActiveCount > 0"
          class="title-downloads-badge"
          aria-hidden="true"
        >{{ downloadsActiveCount }}</span>
        <span
          v-else-if="unseenFinishedCount > 0"
          class="title-downloads-badge is-unseen"
          aria-hidden="true"
        >{{ unseenFinishedCount }}</span>
      </button>
      <button
        v-if="showSettingsIcon"
        type="button"
        class="title-menu-button title-menu-button--icon title-settings-button"
        :class="{ 'is-active': activePanel === 'settings-v2' }"
        :aria-pressed="activePanel === 'settings-v2'"
        v-bind="
          tooltipAttrs(
            t('titleBar.settingsTooltip', 'Settings'),
            t('titleBar.settings', 'Settings')
          )
        "
        @click="handleSettingsToggle"
      >
        <SettingsIcon :size="16" />
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
  /* Container query root for responsive pill collapse. The breakpoint
     rules below (`@container title-bar`) read the title bar's own
     inline size so the layout responds correctly regardless of which
     OS reservation is in play. */
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
     stay equal-width. This keeps the centre 1fr track perfectly
     window-centred regardless of which side has more content — the
     install pill anchors to true window centre at every width. */
  min-width: var(--title-trailing-width, 0px);
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
  color: var(--text-muted);
}
.title-settings-button {
  display: inline-flex;
  width: 24px;
  height: 24px;
  padding: 0;
  justify-content: center;
  align-items: center;
  border-radius: 999px;
  color: var(--text-muted);
}
.title-settings-button.is-active,
.title-settings-button.is-active:hover {
  color: var(--comfy-yellow);
  border-color: var(--comfy-yellow);
  opacity: 1;
}

.title-install-pill {
  -webkit-app-region: no-drag;
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  /* Fluid width: floor at 220px (enough for brand mark + install-type
     icon + caret + ~14 chars of name before ellipsis), preferred
     ~22% of title-bar inline size, ceiling at 360px. Tuned to coexist
     with the adjacent install-update pill in the center cluster +
     leave the right cluster room for the desktop-update pill and
     trailing buttons without overlap. */
  width: clamp(220px, 22cqi, 360px);
  height: 28px;
  padding: 5px 8px;
  border-radius: 999px;
  background: var(--brand-surface-bg);
  border: 1px solid var(--neutral-100);
  color: var(--neutral-100);
  font: inherit;
  font-size: 12px;
  cursor: default;
  transition:
    background-color 120ms ease,
    border-color 120ms ease,
    color 120ms ease;
}
/* Button variant — install-backed hosts. The pill is an actionable
 * picker opener: hover repaints to the brand-surface hover token,
 * open state lifts border/text/logo to brand yellow (--neutral-50)
 * so the pill reads as engaged. */
button.title-install-pill {
  cursor: pointer;
}
button.title-install-pill:hover,
button.title-install-pill:focus-visible {
  background: var(--brand-surface-bg-hover);
  outline: none;
}
button.title-install-pill.is-open {
  /* Lift border + text to brand yellow when the picker is showing.
   * The brand mark + caret both use `currentColor` so they inherit
   * this lift automatically — one source of truth for the open tint. */
  border-color: var(--neutral-50);
  color: var(--neutral-50);
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
  color: var(--text-muted);
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
   Container queries read `.title-bar`'s own inline size (set up via
   `container: title-bar / inline-size` above). Two tiers:

     - Mid  (≤ 1199px on Mac, ≤ 1279px on Win): Feedback label drops
       to icon-only. Saves ~80px on the trailing cluster.
     - Narrow (≤ 899px on Mac, ≤ 979px on Win): both update pill
       labels drop to icon-only. Saves another ~140–180px.

   Tooltips already carry the full label on every pill (see
   `tooltipAttrs(...)` bindings on each <button>), so icon-only states
   remain accessible without extra markup.

   The Win thresholds are higher because the trailing cluster reserves
   128px on the right for native window controls vs. Mac's 66px
   left-side traffic-light reservation — Win needs to collapse earlier
   to keep the same effective usable width as Mac. */

/* Mid tier — Feedback label collapses. */
@container title-bar (max-width: 1199px) {
  .title-bar.is-mac .title-feedback-label {
    display: none;
  }
  .title-bar.is-mac .title-feedback-button {
    padding: 4px 6px;
    gap: 0;
  }
}
@container title-bar (max-width: 1279px) {
  .title-bar:not(.is-mac) .title-feedback-label {
    display: none;
  }
  .title-bar:not(.is-mac) .title-feedback-button {
    padding: 4px 6px;
    gap: 0;
  }
}

/* Narrow tier — both update pill labels collapse to icon-only. The
   collapsed pill becomes a 24×24 circle (matching the Settings + other
   icon buttons) instead of an oval, so it reads as an icon affordance
   not a "shrunk pill". */
@container title-bar (max-width: 1099px) {
  .title-bar.is-mac .title-update-pill-label {
    display: none;
  }
  .title-bar.is-mac .title-update-pill {
    width: 24px;
    height: 24px;
    padding: 0;
    gap: 0;
    justify-content: center;
    border-radius: 999px;
  }
}
@container title-bar (max-width: 1179px) {
  .title-bar:not(.is-mac) .title-update-pill-label {
    display: none;
  }
  .title-bar:not(.is-mac) .title-update-pill {
    width: 24px;
    height: 24px;
    padding: 0;
    gap: 0;
    justify-content: center;
    border-radius: 999px;
  }
}
</style>
