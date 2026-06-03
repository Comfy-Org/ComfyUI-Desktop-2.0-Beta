<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, useTemplateRef, watch } from 'vue'

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
  configToken: string
}

interface Bridge {
  ready(): void
  notifyRendered(payload: { width: number; height: number; configToken: string }): void
  onConfig(cb: (config: TooltipConfig) => void): () => void
}

const bridge = (window as unknown as { __comfyTitleTooltip?: Bridge }).__comfyTitleTooltip

const text = ref<string>('')
const themeBg = ref<string>('#211927')
const themeText = ref<string>('#ffffff')
const themeBorder = ref<string>('#38303d')
/** Token from the most recently applied config — echoed back to main
 *  in every render-ack so main can discard stale acks. */
let currentConfigToken = ''

const bubbleRef = useTemplateRef<HTMLElement>('bubble')

let unsubConfig: (() => void) | undefined

/** Wait for the Inter web font to finish loading before reporting
 *  bubble dimensions. Without this gate the very first show measures
 *  the bubble in the system fallback font (different glyph widths) and
 *  reports a slightly-wrong size; main resizes the view to fit, but
 *  the next paint with the real font then either clips the bubble
 *  (if the real font is wider) or leaves dead space (if it's narrower)
 *  — both surface to users as "the tooltip text size keeps changing".
 *  `document.fonts.ready` resolves once every face used so far has
 *  loaded. */
async function measureAndAck(): Promise<void> {
  // Capture the token at call time. If the config changes mid-await
  // (a new `onConfig` arrives), the stale ack is still safe to ignore
  // on the main side because the token won't match.
  const token = currentConfigToken
  if (document.fonts && typeof document.fonts.ready?.then === 'function') {
    try {
      await document.fonts.ready
    } catch {
      // Best-effort — fall through to measuring with whatever's loaded.
    }
  }
  await nextTick()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  const el = bubbleRef.value
  if (!el) {
    bridge?.notifyRendered({ width: 0, height: 0, configToken: token })
    return
  }
  const rect = el.getBoundingClientRect()
  bridge?.notifyRendered({
    width: Math.ceil(rect.width),
    height: Math.ceil(rect.height),
    configToken: token,
  })
}

onMounted(() => {
  unsubConfig = bridge?.onConfig((cfg) => {
    currentConfigToken = cfg.configToken
    text.value = cfg.text
    themeBg.value = cfg.theme.bg
    themeText.value = cfg.theme.text
    themeBorder.value = cfg.theme.border
    // Ack after Vue has flushed the DOM update *and* the browser has
    // painted with the actual web font. Main keeps the popup view
    // hidden until this ack arrives so the user never sees the
    // previous tooltip's text on a new hover.
    void measureAndAck()
  })
  // Tell main the renderer is mounted and listening — main flushes any
  // config that was queued before this point.
  bridge?.ready()
  // If a font swap happens *after* the initial ack (e.g. Inter loads
  // mid-session), re-measure once it lands so main can resize the view
  // to match the new metrics.
  if (document.fonts && typeof document.fonts.addEventListener === 'function') {
    document.fonts.addEventListener('loadingdone', () => {
      if (text.value) void measureAndAck()
    })
  }
})

// Re-measure any time the rendered text changes for any reason other
// than a config push (defensive; the config-push path already calls
// measureAndAck). Keeping the watch here makes the renderer robust to
// hot-module reload during dev and to future code that might mutate
// `text` without going through `onConfig`.
watch(text, () => { void measureAndAck() })

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
  overflow: hidden;
}

/* Center the bubble inside the popup view's bounds. Main sizes the
   view to `bubbleSize + 2 * SHADOW_GUTTER` (horizontal) and centers
   the view on the trigger, so flex-centering the bubble aligns its
   visual center with the trigger center. The bottom gutter is
   asymmetric (only top has gap, bottom is shadow-only) so the bubble
   is anchored to the top of the view. */
:global(body) {
  display: flex;
  align-items: flex-start;
  justify-content: center;
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
