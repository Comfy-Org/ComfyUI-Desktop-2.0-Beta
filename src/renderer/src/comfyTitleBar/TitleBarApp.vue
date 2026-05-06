<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, useTemplateRef } from 'vue'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Menu as MenuIcon,
  RefreshCw,
} from 'lucide-vue-next'

// Inlined to keep the title-bar renderer self-contained — the preload TS
// file isn't visible to tsconfig.web (only its .d.ts would be). Kept in
// sync with the literal union in src/preload/comfyTitleBarPreload.ts and
// the ComfyPanelKey export in src/main/index.ts.
type ComfyPanelKey =
  | 'comfy'
  | 'install-settings'
  | 'launcher-settings'
  | 'directories'
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

interface Bridge {
  getInstallationId: () => string | null
  isMac: () => boolean
  setPanel: (panel: ComfyPanelKey) => void
  openNewWindow: () => void
  /** Pop the File menu natively (avoids WebContentsView clipping the popup). */
  openFileMenu: (anchor: MenuAnchor) => void
  /** Pop the Install caret menu natively. No-op for install-less host windows. */
  openInstallMenu: (anchor: MenuAnchor) => void
  goBack: () => void
  goForward: () => void
  onPanelChanged: (cb: (panel: ComfyPanelKey) => void) => () => void
  onNavStateChanged: (cb: (state: { canBack: boolean; canForward: boolean }) => void) => () => void
  onTitleChanged: (cb: (title: string) => void) => () => void
  onThemeChanged: (cb: (theme: { bg: string; text: string }) => void) => () => void
  onFullscreenChanged: (cb: (fullscreen: boolean) => void) => () => void
  onMenuClosed: (cb: (info: { menu: 'file' | 'install' }) => void) => () => void
  onInertChanged: (cb: (inert: boolean) => void) => () => void
  /** Phase 3 §18 — app-update state pushes from main. `kind` is
   *  `'available'` after `update-available`, `'ready'` after
   *  `update-downloaded`, and `null` when nothing is pending.
   *  Drives the title-bar app-update pill that sits to the right of
   *  the hamburger menu.
   *
   *  Track B item 2 — `autoUpdate` mirrors the `autoUpdate` setting
   *  at the moment the state was committed. With auto-updates ON the
   *  `'available'` state never fires (main triggers the download
   *  itself); the `'ready'` state then reads "Update will apply on
   *  restart". With auto-updates OFF the `'available'` pill reads
   *  "Update v{version} available" and the `'ready'` pill keeps the
   *  existing "Restart to update" copy. */
  onAppUpdateStateChanged: (
    cb: (state: {
      kind: 'available' | 'ready' | null
      version: string | null
      autoUpdate: boolean
    }) => void,
  ) => () => void
  /** Phase 3 §18 — install-update flag pushes from main. `available`
   *  is `true` when the install's `statusTag.style === 'update'`;
   *  `version` carries the target release version when known so the
   *  pill can read "Update v{version}" (Track B item 1). Only
   *  meaningful on install-backed host windows; install-less hosts
   *  never receive this signal. Drives the title-bar install-update
   *  pill. */
  onInstallUpdateAvailable: (
    cb: (state: { available: boolean; version: string | null }) => void,
  ) => () => void
  /** Phase 3 §18 — click handler for the app-update pill. */
  clickAppUpdatePill: () => void
  /** Phase 3 §18 — click handler for the install-update pill. */
  clickInstallUpdatePill: () => void
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
/** Browser-style Back/Forward enabledness, pushed by main after every
 *  navigation. Disabled-by-default until the first nav-state event. */
const canBack = ref(false)
const canForward = ref(false)
/**
 * Tier 3 takeover flag (Phase 3 §17). When true, the panel renderer
 * has a full-window takeover mounted; the title bar stays visible but
 * its interactive bits become inert so the user can't dismiss the
 * takeover by hitting File / install pill / Back / Forward. The OS
 * window controls (× / □) sit outside this view and stay live — the
 * user always retains an "interrupt" affordance via close.
 *
 * Driven by `comfy-titlebar:inert-changed` from main, which forwards
 * the panel renderer's `setTitleBarInert(boolean)` call. State is
 * mirrored locally rather than asked-for; main does NOT cache the
 * flag, matching how panel-changed / theme-changed already work.
 */
const isInert = ref(false)
/**
 * Install-less host window flag (Phase 3 step 2c). When true, the center
 * install pill labels itself "Choose an install" (set by the initial
 * title push from main) and renders without a caret — there's no
 * install backing the window so the install-scoped menu has no items
 * to expose. The File menu (New Window, App Settings) is the
 * only menu in install-less mode.
 */
const isInstallLess = ref((bridge?.getInstallationId() ?? '') === '')
/** Install identity (e.g. "MyInstall — Standalone") — main pushes this on ready. */
const installLabel = ref('ComfyUI')
const themeBg = ref<string | null>(null)
const themeText = ref<string | null>(null)

/**
 * Phase 3 §18 — title-bar status pills.
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
 *
 * Both pills become `:disabled` during a Tier 3 takeover via `isInert`,
 * matching the file menu / install pill / nav arrows so the takeover
 * can't be dismissed via title-bar affordances.
 */
const appUpdateState = ref<{
  kind: 'available' | 'ready' | null
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
  if (s.kind === 'ready') {
    // Track B item 2 — auto-updates ON downloads silently in the
    // background, so the user's first sign of the update is a "ready
    // to apply on restart" pill. Auto-updates OFF means the user
    // explicitly asked to download, so the existing "Restart to
    // update" copy still reads correctly.
    return s.autoUpdate ? 'Update will apply on restart' : 'Restart to update'
  }
  // 'available' — only fires with auto-updates OFF (main suppresses
  // it when ON and triggers the download itself).
  return s.version ? `Update ${s.version} available` : 'Update available'
})

/** Track B item 1 — install-update pill copy. Mirrors the app-update
 *  pill's "Update {version}" format when main carries a target version
 *  through the install's status tag, falling back to the generic
 *  "Update available" label when no version is known (e.g. legacy
 *  payloads or sources that don't surface one). */
const installUpdatePillLabel = computed<string>(() => {
  const v = installUpdateState.value.version
  return v ? `Update ${v}` : 'Update available'
})

const showAppUpdatePill = computed(() => appUpdateState.value.kind !== null)
const showInstallUpdatePill = computed(
  () => !isInstallLess.value && installUpdateState.value.available,
)

function handleAppUpdatePill(): void {
  if (isInert.value) return
  bridge?.clickAppUpdatePill()
}
function handleInstallUpdatePill(): void {
  if (isInert.value) return
  bridge?.clickInstallUpdatePill()
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
const pillBtnRef = useTemplateRef<HTMLButtonElement>('pillBtn')

/** Per-menu suppression window. When a native menu closes, we stamp
 *  `Date.now()` against its kind. The next click on the same menu
 *  button within `MENU_REOPEN_GUARD_MS` is treated as "the same click
 *  that just dismissed the menu" and is dropped, preventing the menu
 *  from flickering open immediately after the user clicked the open
 *  button to dismiss it. The OS dismisses the menu first, then the
 *  click event reaches our renderer button — without this guard the
 *  click handler would ask main to pop the menu again. */
const MENU_REOPEN_GUARD_MS = 100
const menuClosedAt = { file: 0, install: 0 }

/** Anchor a native menu just below `el`'s bottom-left corner.
 *  Coordinates are in title-bar-local pixels (y is rounded down so the
 *  popup always sits flush with — never above — the button). */
function anchorBelow(el: HTMLElement | null | undefined): MenuAnchor {
  if (!el) return { x: 0, y: 0 }
  const rect = el.getBoundingClientRect()
  return { x: Math.round(rect.left), y: Math.round(rect.bottom) }
}

function handleFileMenu(): void {
  // The Tier 3 inert flag intentionally does NOT disable the file /
  // waffle menu — the user must always be able to escape a takeover
  // via "Return to Dashboard" / "Close Window" / "Close All Windows"
  // / open a fresh chooser via "New Window". Without this hatch the
  // menu would be a dead button while a takeover is mounted (and the
  // user has no other reachable nav surface, since the install pill
  // and back/forward arrows DO stay disabled per `isInert`).
  // Suppress click-to-toggle-close: if the file menu just closed, this
  // click is the same one that dismissed it (OS dismissed first, then
  // event propagates to the button). Don't reopen.
  if (Date.now() - menuClosedAt.file < MENU_REOPEN_GUARD_MS) return
  bridge?.openFileMenu(anchorBelow(fileBtnRef.value))
}
function handleBack(): void {
  if (isInert.value) return
  if (!canBack.value) return
  bridge?.goBack()
}
function handleForward(): void {
  if (isInert.value) return
  if (!canForward.value) return
  bridge?.goForward()
}
/** Single click target for the install pill. On install-backed windows
 *  the whole pill opens the native install menu (Phase 3 §7 — the pill
 *  body and caret are no longer separate hit targets). Install-less
 *  host windows render a disabled pill, so this handler is unreachable
 *  there. Tier 3 takeover also disables the pill so the user can't
 *  pop the install menu over a takeover. */
function handleInstallPillClick(): void {
  if (isInert.value) return
  if (isInstallLess.value) return
  if (Date.now() - menuClosedAt.install < MENU_REOPEN_GUARD_MS) return
  bridge?.openInstallMenu(anchorBelow(pillBtnRef.value))
}

let unsubPanel: (() => void) | undefined
let unsubNavState: (() => void) | undefined
let unsubTitle: (() => void) | undefined
let unsubTheme: (() => void) | undefined
let unsubFullscreen: (() => void) | undefined
let unsubMenuClosed: (() => void) | undefined
let unsubInert: (() => void) | undefined
let unsubAppUpdate: (() => void) | undefined
let unsubInstallUpdate: (() => void) | undefined

/** Drop the hover gate immediately when input leaves the title-bar
 *  webContents — covers the case where a native menu (Menu.popup) or
 *  another view receives focus. */
const handleWindowBlur = (): void => {
  isHoverActive.value = false
}
/** Re-enable the hover gate only on a fresh `pointermove`. We do NOT
 *  re-enable on `window.focus` alone, because focus can return without
 *  any cursor movement (clicking back into the title bar to dismiss
 *  the menu refocuses the renderer with a stale cursor position). */
const handlePointerMove = (): void => {
  if (!isHoverActive.value) isHoverActive.value = true
}
/** Belt-and-braces: if the cursor leaves the title-bar's bounds, drop
 *  the gate. The renderer should normally see a `mouseleave` here, but
 *  on some platforms / WebContentsView setups the leave doesn't fire
 *  reliably, so we mirror the blur path. */
const handlePointerLeave = (): void => {
  isHoverActive.value = false
}

onMounted(() => {
  if (!bridge) return
  unsubPanel = bridge.onPanelChanged((panel) => {
    activePanel.value = panel
  })
  unsubNavState = bridge.onNavStateChanged(({ canBack: cb, canForward: cf }) => {
    canBack.value = cb
    canForward.value = cf
  })
  unsubTitle = bridge.onTitleChanged((title) => {
    installLabel.value = title || 'ComfyUI'
  })
  unsubTheme = bridge.onThemeChanged(({ bg, text }) => {
    themeBg.value = bg
    themeText.value = text
  })
  unsubFullscreen = bridge.onFullscreenChanged((fullscreen) => {
    isFullscreen.value = fullscreen
  })
  unsubMenuClosed = bridge.onMenuClosed(({ menu }) => {
    menuClosedAt[menu] = Date.now()
  })
  unsubInert = bridge.onInertChanged((inert) => {
    isInert.value = inert
  })
  unsubAppUpdate = bridge.onAppUpdateStateChanged((next) => {
    appUpdateState.value = next
  })
  unsubInstallUpdate = bridge.onInstallUpdateAvailable((next) => {
    installUpdateState.value = next
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
  unsubNavState?.()
  unsubTitle?.()
  unsubTheme?.()
  unsubFullscreen?.()
  unsubMenuClosed?.()
  unsubInert?.()
  unsubAppUpdate?.()
  unsubInstallUpdate?.()
  window.removeEventListener('blur', handleWindowBlur)
  window.removeEventListener('pointermove', handlePointerMove)
  document.documentElement.removeEventListener('pointerleave', handlePointerLeave)
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
      'is-inert': isInert,
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
    <div class="title-left">
      <!-- File / waffle menu button is exempt from the `isInert` disable
           gate so the user can always reach Return-to-Dashboard /
           Close-Window from inside a Tier 3 takeover. The install pill,
           back/forward arrows, and update pills remain disabled — only
           the menu stays live. -->
      <button
        ref="fileBtn"
        type="button"
        class="title-menu-button title-menu-button--icon"
        aria-haspopup="menu"
        title="Menu"
        aria-label="Menu"
        @click="handleFileMenu"
      >
        <MenuIcon :size="18" />
      </button>
      <!-- Phase 3 §18 — app-update pill. Sits right of the hamburger
           and disappears entirely in the steady state (no update). The
           same surface (`useAppUpdateState` via the popover) is reached
           via the in-banner buttons; the pill is the persistent re-entry
           after the banner has been dismissed. -->
      <button
        v-if="showAppUpdatePill"
        type="button"
        class="title-update-pill is-app-update"
        :class="{ 'is-ready': appUpdateState.kind === 'ready' }"
        :disabled="isInert"
        :title="appUpdatePillLabel ?? ''"
        :aria-label="appUpdatePillLabel ?? ''"
        @click="handleAppUpdatePill"
      >
        <Download v-if="appUpdateState.kind === 'available'" :size="14" />
        <RefreshCw v-else-if="appUpdateState.kind === 'ready'" :size="14" />
        <span class="title-update-pill-label">{{ appUpdatePillLabel }}</span>
      </button>
    </div>

    <!-- Center: browser-style Back / Forward arrows immediately left of
         the install pill. The pill is a single click target — clicking
         anywhere on it opens the native install menu. The caret inside
         is decoration, not a separate button. Install-less host windows
         render the pill as a disabled identity label (no menu, no caret). -->
    <div class="title-center">
      <button
        type="button"
        class="title-nav-button"
        :disabled="!canBack || isInert"
        aria-label="Back"
        title="Back"
        @click="handleBack"
      >
        <ChevronLeft :size="16" />
      </button>
      <button
        type="button"
        class="title-nav-button"
        :disabled="!canForward || isInert"
        aria-label="Forward"
        title="Forward"
        @click="handleForward"
      >
        <ChevronRight :size="16" />
      </button>
      <button
        ref="pillBtn"
        type="button"
        class="title-install-pill"
        :class="{ 'is-install-less': isInstallLess }"
        :disabled="isInstallLess || isInert"
        :aria-haspopup="isInstallLess || isInert ? undefined : 'menu'"
        @click="handleInstallPillClick"
      >
        <span class="title-install-name">{{ installLabel }}</span>
        <ChevronDown
          v-if="!isInstallLess"
          :size="14"
          class="title-install-caret"
        />
      </button>
      <!-- Phase 3 §18 — install-update pill. Suppressed in install-less
           mode (no install backing the host) and in the steady state
           (status tag isn't `update`). Click sends a panel-trigger to
           open the manage overlay on the update tab — same surface the
           chooser kebab "Update…" entry lands on. -->
      <button
        v-if="showInstallUpdatePill"
        type="button"
        class="title-update-pill is-install-update"
        :disabled="isInert"
        :title="installUpdatePillLabel"
        :aria-label="installUpdatePillLabel"
        @click="handleInstallUpdatePill"
      >
        <Download :size="14" />
        <span class="title-update-pill-label">{{ installUpdatePillLabel }}</span>
      </button>
    </div>

    <div class="drag-spacer"></div>
  </header>
</template>

<style scoped>
.title-bar {
  display: flex;
  align-items: center;
  /* Title bar uses three columns: left (File), center (install pill,
     centred via grid spacer), right (drag spacer / native controls). */
  height: 100vh;
  width: 100vw;
  padding-left: 12px;
  padding-right: 140px; /* Reserve space for native window controls (Win/Linux) */
  box-sizing: border-box;
  background: var(--surface);
  color: var(--text-muted);
  border-bottom: 1px solid var(--border);
  font: 12px/1 var(--font-sans, 'Inter', system-ui, sans-serif);
  user-select: none;
  -webkit-app-region: drag;
  gap: 8px;
}
.title-bar.is-mac {
  padding-left: 78px;
  padding-right: 12px;
}
/* Traffic lights vanish in macOS fullscreen — reclaim the 78px padding. */
.title-bar.is-mac.is-fullscreen {
  padding-left: 12px;
}

/* The container DIVs stay drag-region so empty space around the buttons
   is still draggable — only the actual interactive elements opt out via
   `-webkit-app-region: no-drag` (set on each <button> below). Marking
   the containers no-drag would consume the entire title bar width and
   leave only the small left/right padding zones draggable. */
.title-left {
  position: relative;
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
}

.title-center {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  /* Back / Forward arrows + install pill cluster, centred in the bar.
     The cluster shrink-wraps so the empty space on either side stays
     draggable. */
  gap: 4px;
  flex: 1 1 auto;
  min-width: 0;
}

.drag-spacer {
  flex: 0 0 0;
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

/* Icon-only variant — square padding so the hamburger sits centred
   with the same outer height as the back/forward arrows. */
.title-menu-button--icon {
  padding: 4px 6px;
  gap: 0;
}

/* --- Back / Forward arrows (browser-style nav) --- */
.title-nav-button {
  -webkit-app-region: no-drag;
  background: transparent;
  color: inherit;
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 2px 6px;
  cursor: pointer;
  opacity: 0.85;
  display: inline-flex;
  align-items: center;
  transition: background-color 0.12s, opacity 0.12s, border-color 0.12s;
}
.title-bar.is-hover-active .title-nav-button:not(:disabled):hover {
  opacity: 1;
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.18);
}
.title-bar.is-light.is-hover-active .title-nav-button:not(:disabled):hover {
  background: rgba(0, 0, 0, 0.06);
  border-color: rgba(0, 0, 0, 0.18);
}
.title-nav-button:disabled {
  opacity: 0.3;
  cursor: default;
}

/* --- Install pill (center) — single click target. The whole pill
       opens the native install menu on install-backed windows and
       renders disabled (identity-only) on install-less host windows.
       Always looks like a pill: solid surface fill, rounded ends,
       visible border at rest, brighter hover. --- */
.title-install-pill {
  -webkit-app-region: no-drag;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  /* Pill shape — pill-radius (999px) + horizontal padding for breathing
     room around the install name. */
  padding: 4px 12px;
  border-radius: 999px;
  /* Solid surface fill so the pill always reads as a chip, not as
     bare text. Subtle border for definition on light themes; hover
     state lifts both. */
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.14);
  color: inherit;
  font: inherit;
  font-weight: 500;
  cursor: pointer;
  max-width: 480px;
  transition: background-color 0.12s, border-color 0.12s, opacity 0.12s;
}
.title-bar.is-hover-active .title-install-pill:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.14);
  border-color: rgba(255, 255, 255, 0.28);
}
.title-install-pill:focus-visible {
  outline: 2px solid var(--accent, #60a5fa);
  outline-offset: 2px;
}
.title-bar.is-light .title-install-pill {
  background: rgba(0, 0, 0, 0.04);
  border-color: rgba(0, 0, 0, 0.14);
}
.title-bar.is-light.is-hover-active .title-install-pill:hover:not(:disabled) {
  background: rgba(0, 0, 0, 0.09);
  border-color: rgba(0, 0, 0, 0.24);
}
/* Install-less host windows: pill is an identity-only label. Disabled
   buttons skip the hover lift; the cursor stays default. */
.title-install-pill.is-install-less {
  cursor: default;
  opacity: 0.85;
}

.title-install-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.title-install-caret {
  flex-shrink: 0;
  opacity: 0.7;
}

/* Tier 3 takeover (§17) — interactive controls are :disabled while a
   takeover is mounted, but install-less mode also disables the pill,
   and we want the takeover state to read more "inert" than just
   "no-install-here". The is-inert class adds a uniform dimming pass
   so File / Back / Forward / pill all read as paused at the same
   visual weight. Window controls (× / □) live outside this view and
   stay live. */
.title-bar.is-inert .title-menu-button:disabled,
.title-bar.is-inert .title-nav-button:disabled,
.title-bar.is-inert .title-install-pill:disabled,
.title-bar.is-inert .title-update-pill:disabled {
  cursor: default;
  opacity: 0.5;
}

/* --- Phase 3 §18 — Status pills (app-update + install-update) ---
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
.title-update-pill:focus-visible {
  outline: 2px solid var(--accent, #60a5fa);
  outline-offset: 2px;
}
.title-update-pill-label {
  white-space: nowrap;
}

/* Dropdown popups are now native OS menus rendered via Menu.popup() in
   main — no HTML popup styles needed here. */
</style>
