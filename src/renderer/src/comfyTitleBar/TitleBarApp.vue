<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowDownToLine,
  Check,
  ChevronDown,
  Download,
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
  if (!bridge) return
  unsubPanel = bridge.onPanelChanged((panel) => {
    activePanel.value = panel
  })
  bridge.ready()
})

onUnmounted(() => {
  unsubPanel?.()
  hideTip()
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
      color: themeText ?? undefined
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
      <button
        v-if="!isInstallLess && !isFirstUseTakeover"
        ref="installPill"
        type="button"
        class="title-install-pill"
        :class="{ 'is-open': isInstancePickerOpen }"
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
        :class="{ 'is-install-less': isInstallLess }"
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
      <!-- Install-update pill. Suppressed in install-less
           mode (no install backing the host) and in the steady state
           (status tag isn't `update`). Click sends a panel-trigger to
           open the manage overlay on the update tab — same surface the
           chooser kebab "Update…" entry lands on. -->
    </div>

    <div class="drag-spacer"></div>

    <div class="title-trailing">
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
      <!-- App-update pill (issue #488) — disappears entirely in the
           steady state. Click routes through main, which fires the
           appropriate confirm modal in the panel. The neutral pill
           styling uses the new brand spec; state is communicated
           via icon (download / spinner / refresh) rather than tint. -->
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
        <Download v-if="appUpdateState.kind === 'available'" :size="14" />
        <Loader2
          v-else-if="appUpdateState.kind === 'downloading'"
          :size="14"
          class="title-update-pill-spinner"
        />
        <RefreshCw v-else-if="appUpdateState.kind === 'ready'" :size="14" />
        <span class="title-update-pill-label">{{ appUpdatePillLabel ?? 'Update Available' }}</span>
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
        <span v-if="downloadsActiveCount > 0" class="title-downloads-badge" aria-hidden="true">{{
          downloadsActiveCount
        }}</span>
        <span
          v-else-if="unseenFinishedCount > 0"
          class="title-downloads-badge is-unseen"
          aria-hidden="true"
        >
          <Check :size="9" :stroke-width="3" />
          <span class="title-downloads-badge-count">{{ unseenFinishedCount }}</span>
        </span>
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
  display: flex;
  align-items: center;
  /* Symmetric base padding. OS-chrome reservations live on the side
     children so the center cluster anchors to true window center. */
  height: 100vh;
  width: 100vw;
  padding-left: 12px;
  padding-right: 12px;
  box-sizing: border-box;
  background: var(--titlebar-bg);
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
  width: 360px;
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
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.04);
  color: var(--neutral-100);
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
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.18);
}
.title-bar.is-light .title-update-pill {
  background: rgba(0, 0, 0, 0.04);
  border-color: rgba(0, 0, 0, 0.1);
  color: var(--neutral-700);
}
.title-bar.is-light.is-hover-active .title-update-pill:hover:not(:disabled) {
  background: rgba(0, 0, 0, 0.08);
  border-color: rgba(0, 0, 0, 0.18);
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
  padding: 0;
  transition: color 0.12s;
}
.title-bar.is-hover-active .title-downloads-tray:hover:not(:disabled) {
  color: var(--comfy-yellow);
}
.title-bar.is-light .title-downloads-tray {
  color: var(--comfy-yellow);
}

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
  gap: 2px;
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
  background: #22c55e;
  padding: 0 4px;
}
.title-downloads-badge.is-unseen .title-downloads-badge-count {
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
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
</style>
