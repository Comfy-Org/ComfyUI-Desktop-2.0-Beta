<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, useTemplateRef } from 'vue'

/**
 * Title-tooltip popup renderer.
 *
 * Renders the single tooltip bubble shown on hover over title-bar
 * controls. Sized to fit content; reports its rendered dimensions back
 * to main on every config update so main can resize the popup
 * `WebContentsView` to match before flipping it visible.
 *
 * Issue #514 — macOS Chromium does not reliably surface native HTML
 * `title` tooltips for sibling chrome `WebContentsView` instances that
 * aren't the focused view, so we render this popup instead.
 */

interface TooltipConfig {
  text: string
  theme: { bg: string; text: string; border: string }
}

interface Bridge {
  ready(): void
  notifyRendered(payload: { width: number; height: number }): void
  onConfig(cb: (config: TooltipConfig) => void): () => void
}

const bridge = (window as unknown as { __comfyTitleTooltip?: Bridge }).__comfyTitleTooltip

const text = ref<string>('')
const themeBg = ref<string>('#262729')
const themeText = ref<string>('#dddddd')
const themeBorder = ref<string>('#494a50')

const bubbleRef = useTemplateRef<HTMLElement>('bubble')

let unsubConfig: (() => void) | undefined

onMounted(() => {
  unsubConfig = bridge?.onConfig((cfg) => {
    text.value = cfg.text
    themeBg.value = cfg.theme.bg
    themeText.value = cfg.theme.text
    themeBorder.value = cfg.theme.border
    // Ack after Vue has flushed the DOM update *and* the browser has
    // had a chance to paint it. Main keeps the popup view hidden until
    // this ack arrives so the user never sees the previous tooltip's
    // text on a new hover.
    void nextTick(() => {
      requestAnimationFrame(() => {
        const el = bubbleRef.value
        if (!el) {
          bridge?.notifyRendered({ width: 0, height: 0 })
          return
        }
        const rect = el.getBoundingClientRect()
        bridge?.notifyRendered({
          width: Math.ceil(rect.width),
          height: Math.ceil(rect.height),
        })
      })
    })
  })
  // Tell main the renderer is mounted and listening — main flushes any
  // config that was queued before this point.
  bridge?.ready()
})

onUnmounted(() => {
  unsubConfig?.()
})
</script>

<template>
  <span
    ref="bubble"
    class="bubble"
    :style="{
      background: themeBg,
      color: themeText,
      borderColor: themeBorder,
    }"
  >{{ text }}</span>
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

/* The bubble shrink-wraps its text so we can measure it and resize the
   popup view accordingly. Visual chrome matches the in-renderer
   `.info-tooltip-bubble` style used elsewhere (InfoTooltip / TooltipWrap)
   so this popup looks identical to the panel-side tooltips. */
.bubble {
  display: inline-block;
  width: max-content;
  max-width: 260px;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid;
  font: 12px/1.4 var(--font-sans, 'Inter', system-ui, sans-serif);
  font-weight: 400;
  letter-spacing: 0;
  white-space: normal;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
  pointer-events: none;
  user-select: none;
  box-sizing: border-box;
}
</style>
