<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'

// Inlined to keep the title-bar renderer self-contained — the preload TS
// file isn't visible to tsconfig.web (only its .d.ts would be). Kept in
// sync with the literal union in src/preload/comfyTitleBarPreload.ts and
// the ComfyPanelKey export in src/main/index.ts.
type ComfyPanelKey = 'comfy' | 'install-settings' | 'launcher-settings'

interface Bridge {
  getInstallationId: () => string | null
  isMac: () => boolean
  setPanel: (panel: ComfyPanelKey) => void
  onPanelChanged: (cb: (panel: ComfyPanelKey) => void) => () => void
  onTitleChanged: (cb: (title: string) => void) => () => void
  onThemeChanged: (cb: (theme: { bg: string; text: string }) => void) => () => void
  onFullscreenChanged: (cb: (fullscreen: boolean) => void) => () => void
  ready: () => void
}

const bridge = (window as unknown as { __comfyTitleBar?: Bridge }).__comfyTitleBar

const isMac = ref(bridge?.isMac() ?? false)
const isFullscreen = ref(false)
const activePanel = ref<ComfyPanelKey>('comfy')
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

const tabs: { key: ComfyPanelKey; staticLabel?: string }[] = [
  { key: 'comfy' },
  { key: 'install-settings', staticLabel: 'Install Settings' },
  { key: 'launcher-settings', staticLabel: 'Launcher Settings' },
]

function labelFor(key: ComfyPanelKey, staticLabel?: string): string {
  // The comfy tab is the install identity; everything else is a fixed string
  // (title bar isn't localized yet — it lives in its own WebContents).
  if (key === 'comfy') return installLabel.value || 'ComfyUI'
  return staticLabel || key
}

function handleClick(key: ComfyPanelKey): void {
  bridge?.setPanel(key)
}

let unsubPanel: (() => void) | undefined
let unsubTitle: (() => void) | undefined
let unsubTheme: (() => void) | undefined
let unsubFullscreen: (() => void) | undefined

onMounted(() => {
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
    <nav class="panel-tabs">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        type="button"
        :class="{ active: activePanel === tab.key, 'is-comfy': tab.key === 'comfy' }"
        @click="handleClick(tab.key)"
      >
        {{ labelFor(tab.key, tab.staticLabel) }}
      </button>
    </nav>
    <div class="drag-spacer"></div>
  </header>
</template>

<style scoped>
.title-bar {
  display: flex;
  align-items: center;
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
}
.title-bar.is-mac {
  padding-left: 78px;
  padding-right: 12px;
}
/* Traffic lights vanish in macOS fullscreen — reclaim the 78px padding. */
.title-bar.is-mac.is-fullscreen {
  padding-left: 12px;
}

.panel-tabs {
  display: flex;
  align-items: center;
  -webkit-app-region: no-drag;
  flex: 0 1 auto;
  min-width: 0;
  gap: 4px;
}

.panel-tabs button {
  -webkit-app-region: no-drag;
  background: transparent;
  color: inherit;
  border: 1px solid transparent;
  padding: 4px 10px;
  font: inherit;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0.75;
  display: inline-flex;
  align-items: center;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: background-color 0.12s, opacity 0.12s, border-color 0.12s;
}
.panel-tabs button:hover {
  opacity: 1;
  background: rgba(255, 255, 255, 0.06);
}
.panel-tabs button.active {
  opacity: 1;
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.18);
}
.panel-tabs button.is-comfy {
  font-weight: 500;
}

/* Light-theme overrides — applied when ComfyUI reports a light --comfy-menu-bg. */
.title-bar.is-light .panel-tabs button:hover {
  background: rgba(0, 0, 0, 0.06);
}
.title-bar.is-light .panel-tabs button.active {
  background: rgba(0, 0, 0, 0.08);
  border-color: rgba(0, 0, 0, 0.18);
}

.drag-spacer {
  flex: 1 1 auto;
  min-width: 0;
  -webkit-app-region: drag;
}
</style>
