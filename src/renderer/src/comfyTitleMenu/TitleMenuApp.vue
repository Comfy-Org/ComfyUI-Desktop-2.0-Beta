<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { Check } from 'lucide-vue-next'

/**
 * Title-menu popup.
 *
 * Hosts the File / Install dropdowns rendered as HTML inside a
 * transparent `WebContentsView` attached to the host window — replaces
 * the previous native `Menu.popup()` flow so we get theme-matched
 * chrome and no clipping by the title-bar WebContentsView's bounds.
 *
 * The popup view is reused across opens (created once per parent
 * window, hidden between uses) so opening feels instant after the first
 * paint. Each open arrives as a `comfy-titlemenu:set-config` IPC carrying
 * kind / items / theme — the renderer re-renders before main shows the
 * view.
 */

interface MenuItem {
  /** Item id — main routes by this. */
  id?: string
  /** Visible label. */
  label?: string
  /** Renders a checkmark glyph on the left when true. */
  checked?: boolean
  /** Marks a separator row instead of an interactive item. */
  kind?: 'separator'
}

interface MenuConfig {
  kind: 'file' | 'install'
  items: MenuItem[]
  theme: { bg: string; text: string }
}

interface Bridge {
  activate(id: string): void
  close(): void
  ready(): void
  notifyRendered(): void
  onConfig(cb: (config: MenuConfig) => void): () => void
}

const bridge = (window as unknown as { __comfyTitleMenu?: Bridge }).__comfyTitleMenu

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

function handleClick(item: MenuItem): void {
  if (item.kind === 'separator') return
  if (!item.id) return
  bridge?.activate(item.id)
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
    items.value = cfg.items
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
    <ul class="menu">
      <template v-for="(item, idx) in items" :key="idx">
        <li v-if="item.kind === 'separator'" class="separator" role="separator" />
        <li
          v-else
          class="item"
          role="menuitem"
          tabindex="-1"
          @click="handleClick(item)"
        >
          <span class="check">
            <Check v-if="item.checked" :size="14" />
          </span>
          <span class="label">{{ item.label }}</span>
        </li>
      </template>
    </ul>
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

.menu {
  list-style: none;
  margin: 0;
  padding: 4px 0;
}

.item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  height: 28px;
  box-sizing: border-box;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 0.08s;
}
.item:hover {
  background: rgba(255, 255, 255, 0.1);
}
.popup.is-light .item:hover {
  background: rgba(0, 0, 0, 0.07);
}

.check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  opacity: 0.85;
}

.label {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
}

.separator {
  height: 1px;
  margin: 4px 8px;
  background: var(--border, #494a50);
  opacity: 0.6;
}
</style>
