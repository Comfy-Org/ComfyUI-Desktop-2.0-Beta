<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { ChevronDown } from 'lucide-vue-next'

// Inlined to keep the title-bar renderer self-contained — the preload TS
// file isn't visible to tsconfig.web (only its .d.ts would be). Kept in
// sync with the literal union in src/preload/comfyTitleBarPreload.ts and
// the ComfyPanelKey export in src/main/index.ts.
type ComfyPanelKey = 'comfy' | 'install-settings' | 'launcher-settings'

interface Bridge {
  getInstallationId: () => string | null
  isMac: () => boolean
  setPanel: (panel: ComfyPanelKey) => void
  openNewWindow: () => void
  checkForUpdates: () => void
  onPanelChanged: (cb: (panel: ComfyPanelKey) => void) => () => void
  onTitleChanged: (cb: (title: string) => void) => () => void
  onThemeChanged: (cb: (theme: { bg: string; text: string }) => void) => () => void
  onFullscreenChanged: (cb: (fullscreen: boolean) => void) => () => void
  ready: () => void
}

const bridge = (window as unknown as { __comfyTitleBar?: Bridge }).__comfyTitleBar

const isMac = ref(bridge?.isMac() ?? false)
const isFullscreen = ref(false)
/** Active body-mode pill, mirrored from main. Used for highlighting the
 *  install-pill (Comfy) and the dropdown menu's Install Settings entry. */
const activePanel = ref<ComfyPanelKey>('comfy')
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

// --- Dropdown menu state ---
//
// The title bar carries two menus:
//   - File menu (left): New Window / Desktop 2 Settings
//   - Install menu (center, install-backed only): Install Settings,
//     Check for Updates
//
// At most one menu can be open at a time. Click-outside collapses it,
// and selecting any item closes the menu before invoking the action.
type OpenMenu = 'file' | 'install' | null
const openMenu = ref<OpenMenu>(null)

function toggleFileMenu(): void {
  openMenu.value = openMenu.value === 'file' ? null : 'file'
}
function toggleInstallMenu(): void {
  if (isInstallLess.value) return
  openMenu.value = openMenu.value === 'install' ? null : 'install'
}
function closeMenu(): void {
  openMenu.value = null
}

function handleNewWindow(): void {
  closeMenu()
  bridge?.openNewWindow()
}
function handleDesktopSettings(): void {
  closeMenu()
  bridge?.setPanel('launcher-settings')
}
function handleInstallSettings(): void {
  closeMenu()
  bridge?.setPanel('install-settings')
}
function handleCheckForUpdates(): void {
  closeMenu()
  bridge?.checkForUpdates()
}
function handleInstallPillClick(): void {
  // Center pill click sets the body to the Comfy view (the install's
  // ComfyUI / chooser body). The caret is a separate area for the
  // dropdown menu — clicking it doesn't switch panels, only toggles
  // the menu.
  bridge?.setPanel('comfy')
}

// Click-outside / Escape handling — runs while a menu is open.
function onDocumentClick(event: MouseEvent): void {
  if (!openMenu.value) return
  // If the click was inside any .menu-anchor / .menu-popup, leave it alone.
  const target = event.target as Node | null
  const menuRoots = document.querySelectorAll('.title-menu-root')
  for (const root of Array.from(menuRoots)) {
    if (target && root.contains(target)) return
  }
  closeMenu()
}
function onDocumentKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeMenu()
}

let unsubPanel: (() => void) | undefined
let unsubTitle: (() => void) | undefined
let unsubTheme: (() => void) | undefined
let unsubFullscreen: (() => void) | undefined

onMounted(() => {
  document.addEventListener('click', onDocumentClick, true)
  document.addEventListener('keydown', onDocumentKey)
  if (!bridge) return
  unsubPanel = bridge.onPanelChanged((panel) => {
    activePanel.value = panel
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
  bridge.ready()
})

onUnmounted(() => {
  document.removeEventListener('click', onDocumentClick, true)
  document.removeEventListener('keydown', onDocumentKey)
  unsubPanel?.()
  unsubTitle?.()
  unsubTheme?.()
  unsubFullscreen?.()
})
</script>

<template>
  <header
    class="title-bar"
    :class="{ 'is-mac': isMac, 'is-light': isLight, 'is-fullscreen': isFullscreen }"
    :style="{
      background: themeBg ?? undefined,
      color: themeText ?? undefined,
    }"
  >
    <!-- Left: File menu -->
    <div class="title-left title-menu-root">
      <button
        type="button"
        class="title-menu-button"
        :class="{ active: openMenu === 'file' }"
        aria-haspopup="menu"
        :aria-expanded="openMenu === 'file'"
        @click="toggleFileMenu"
      >
        File
        <ChevronDown :size="12" class="title-menu-caret" />
      </button>
      <div v-if="openMenu === 'file'" class="title-menu-popup" role="menu">
        <button
          type="button"
          class="title-menu-item"
          role="menuitem"
          @click="handleNewWindow"
        >
          New Window
        </button>
        <button
          type="button"
          class="title-menu-item"
          role="menuitem"
          @click="handleDesktopSettings"
        >
          Desktop 2 Settings
        </button>
      </div>
    </div>

    <!-- Center: install pill (with caret + dropdown for install-backed
         windows; no caret for install-less host windows). -->
    <div class="title-center title-menu-root">
      <div class="title-install-pill" :class="{ active: activePanel === 'comfy' }">
        <button
          type="button"
          class="title-install-name"
          @click="handleInstallPillClick"
        >
          {{ installLabel }}
        </button>
        <button
          v-if="!isInstallLess"
          type="button"
          class="title-install-caret"
          aria-haspopup="menu"
          :aria-expanded="openMenu === 'install'"
          @click="toggleInstallMenu"
        >
          <ChevronDown :size="14" />
        </button>
      </div>
      <div v-if="openMenu === 'install'" class="title-menu-popup title-menu-popup-center" role="menu">
        <button
          type="button"
          class="title-menu-item"
          role="menuitem"
          :class="{ active: activePanel === 'install-settings' }"
          @click="handleInstallSettings"
        >
          Install Settings
        </button>
        <button
          type="button"
          class="title-menu-item"
          role="menuitem"
          @click="handleCheckForUpdates"
        >
          Check for Updates
        </button>
      </div>
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

.title-left {
  position: relative;
  display: flex;
  align-items: center;
  -webkit-app-region: no-drag;
  flex: 0 0 auto;
}

.title-center {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  -webkit-app-region: no-drag;
  /* Spread the center along the available drag area while keeping the
     pill itself shrink-wrapped. */
  flex: 1 1 auto;
  min-width: 0;
}

.drag-spacer {
  flex: 0 0 0;
  -webkit-app-region: drag;
}

/* --- File menu button --- */
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
.title-menu-button:hover,
.title-menu-button.active {
  opacity: 1;
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.18);
}
.title-bar.is-light .title-menu-button:hover,
.title-bar.is-light .title-menu-button.active {
  background: rgba(0, 0, 0, 0.06);
  border-color: rgba(0, 0, 0, 0.18);
}

.title-menu-caret {
  opacity: 0.7;
}

/* --- Install pill (center) --- */
.title-install-pill {
  -webkit-app-region: no-drag;
  display: inline-flex;
  align-items: center;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  overflow: hidden;
  max-width: 480px;
  opacity: 0.85;
  transition: background-color 0.12s, opacity 0.12s, border-color 0.12s;
}
.title-install-pill:hover,
.title-install-pill.active {
  opacity: 1;
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.18);
}
.title-bar.is-light .title-install-pill:hover,
.title-bar.is-light .title-install-pill.active {
  background: rgba(0, 0, 0, 0.06);
  border-color: rgba(0, 0, 0, 0.18);
}

.title-install-name {
  -webkit-app-region: no-drag;
  background: transparent;
  color: inherit;
  border: none;
  padding: 4px 10px;
  font: inherit;
  font-weight: 500;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.title-install-caret {
  -webkit-app-region: no-drag;
  background: transparent;
  color: inherit;
  border: none;
  border-left: 1px solid currentColor;
  padding: 4px 6px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  opacity: 0.6;
}
.title-install-caret:hover {
  opacity: 1;
}

/* --- Dropdown popup --- */
.title-menu-popup {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  min-width: 200px;
  z-index: 1000;
  background: var(--surface, #2a2a2a);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.18));
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  -webkit-app-region: no-drag;
}
/* Center menu pops down centred under the pill. */
.title-menu-popup-center {
  left: 50%;
  transform: translateX(-50%);
}

.title-menu-item {
  -webkit-app-region: no-drag;
  background: transparent;
  color: inherit;
  border: none;
  padding: 6px 10px;
  font: inherit;
  text-align: left;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 0.1s;
}
.title-menu-item:hover,
.title-menu-item.active {
  background: rgba(255, 255, 255, 0.1);
}
.title-bar.is-light .title-menu-item:hover,
.title-bar.is-light .title-menu-item.active {
  background: rgba(0, 0, 0, 0.08);
}
</style>
