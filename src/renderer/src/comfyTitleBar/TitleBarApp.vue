<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, useTemplateRef } from 'vue'
import { ChevronDown, ChevronLeft, ChevronRight, Menu as MenuIcon } from 'lucide-vue-next'

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
  checkForUpdates: () => void
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
 * Install-less host window flag (Phase 3 step 2c). When true, the center
 * install pill labels itself "Choose an install" (set by the initial
 * title push from main) and renders without a caret — there's no
 * install backing the window so the install-scoped menu has no items
 * to expose. The File menu (New Window, Desktop 2 Settings) is the
 * only menu in install-less mode.
 */
const isInstallLess = ref((bridge?.getInstallationId() ?? '') === '')
/** Install identity (e.g. "MyInstall — Standalone") — main pushes this on ready. */
const installLabel = ref('ComfyUI')
const themeBg = ref<string | null>(null)
const themeText = ref<string | null>(null)

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
  // Suppress click-to-toggle-close: if the file menu just closed, this
  // click is the same one that dismissed it (OS dismissed first, then
  // event propagates to the button). Don't reopen.
  if (Date.now() - menuClosedAt.file < MENU_REOPEN_GUARD_MS) return
  bridge?.openFileMenu(anchorBelow(fileBtnRef.value))
}
function handleBack(): void {
  if (!canBack.value) return
  bridge?.goBack()
}
function handleForward(): void {
  if (!canForward.value) return
  bridge?.goForward()
}
/** Single click target for the install pill. On install-backed windows
 *  the whole pill opens the native install menu (Phase 3 §7 — the pill
 *  body and caret are no longer separate hit targets). Install-less
 *  host windows render a disabled pill, so this handler is unreachable
 *  there. */
function handleInstallPillClick(): void {
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
        :disabled="!canBack"
        aria-label="Back"
        title="Back"
        @click="handleBack"
      >
        <ChevronLeft :size="16" />
      </button>
      <button
        type="button"
        class="title-nav-button"
        :disabled="!canForward"
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
        :disabled="isInstallLess"
        :aria-haspopup="isInstallLess ? undefined : 'menu'"
        @click="handleInstallPillClick"
      >
        <span class="title-install-name">{{ installLabel }}</span>
        <ChevronDown
          v-if="!isInstallLess"
          :size="14"
          class="title-install-caret"
        />
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

/* Dropdown popups are now native OS menus rendered via Menu.popup() in
   main — no HTML popup styles needed here. */
</style>
