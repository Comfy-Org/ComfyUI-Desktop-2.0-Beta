<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import MenuView from './MenuView.vue'
import DownloadsView from './DownloadsView.vue'

/**
 * Title-bar dropdown popup shell.
 *
 * Hosts every title-bar dropdown (waffle menu, downloads tray, …)
 * inside one transparent `WebContentsView` attached to the host window
 * so we get theme-matched chrome and no clipping by the title-bar
 * view's bounds.
 *
 * The view is reused across opens (created once per parent window,
 * hidden between uses) so opening feels instant after the first paint.
 * Each open arrives as a `comfy-titlepopup:set-config` IPC carrying
 * kind + theme (+ items for the menu kind); the renderer re-renders
 * before main shows the view.
 */

interface MenuItem {
  id?: string
  label?: string
  checked?: boolean
  kind?: 'separator'
}

type PopupConfig =
  | {
      kind: 'menu'
      items: MenuItem[]
      theme: { bg: string; text: string }
    }
  | {
      kind: 'downloads'
      theme: { bg: string; text: string }
    }

interface Bridge {
  activate(id: string): void
  close(): void
  ready(): void
  notifyRendered(): void
  onConfig(cb: (config: PopupConfig) => void): () => void
}

const bridge = (window as unknown as { __comfyTitlePopup?: Bridge }).__comfyTitlePopup

const kind = ref<'menu' | 'downloads'>('menu')
const items = ref<MenuItem[]>([])
const themeBg = ref<string>('#262729')
const themeText = ref<string>('#dddddd')

/** Body-luminance test — drives is-light styling (lighter hover state),
 *  matching the convention in TitleBarApp.vue. */
const isLight = computed(() => {
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return false
  ctx.fillStyle = themeBg.value
  const hex = ctx.fillStyle as string
  if (!hex.startsWith('#') || hex.length < 7) return false
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return (r * 299 + g * 587 + b * 114) / 1000 >= 128
})

function handleActivate(id: string): void {
  bridge?.activate(id)
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    bridge?.close()
  }
}

let unsubConfig: (() => void) | undefined

onMounted(() => {
  unsubConfig = bridge?.onConfig((cfg) => {
    kind.value = cfg.kind
    items.value = cfg.kind === 'menu' ? cfg.items : []
    themeBg.value = cfg.theme.bg
    themeText.value = cfg.theme.text
    // Ack after Vue has flushed the DOM update *and* the browser has
    // had a chance to paint it. Main keeps the popup view hidden until
    // this ack arrives so the user never sees a frame of the previous
    // open's content on a new open.
    void nextTick(() => {
      requestAnimationFrame(() => {
        bridge?.notifyRendered()
      })
    })
  })
  window.addEventListener('keydown', handleKeydown)
  // Tell main the renderer is mounted and listening — main flushes any
  // config that was queued before this point.
  bridge?.ready()
})
onUnmounted(() => {
  unsubConfig?.()
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <div
    class="popup"
    :class="{ 'is-light': isLight }"
    :style="{ background: themeBg, color: themeText }"
  >
    <MenuView v-if="kind === 'menu'" :items="items" @activate="handleActivate" />
    <DownloadsView v-else />
  </div>
</template>

<style scoped>
:global(html),
:global(body),
:global(#app) {
  margin: 0;
  width: 100%;
  height: 100%;
  background: transparent !important;
}

/* The popup view's background is transparent (set on <html>/<body>/#app
   via the :global rules above plus `setBackgroundColor('#00000000')` on
   the WebContentsView in main). The .popup div is the visible card —
   solid surface fill, rounded corners, subtle border so it reads as a
   card not as floating text. */
.popup {
  margin: 0;
  border: 1px solid var(--border, #494a50);
  border-radius: 6px;
  font: 12px/1 var(--font-sans, 'Inter', system-ui, sans-serif);
  user-select: none;
  overflow: hidden;
  height: 100%;
  width: 100%;
  box-sizing: border-box;
}
</style>
