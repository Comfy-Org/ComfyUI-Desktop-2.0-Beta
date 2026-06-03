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
  /** Absent (or `'tooltip'`) for the plain hover bubble; `'coachmark'`
   *  for the sticky onboarding card with a beak + accent + dismiss. */
  variant?: 'tooltip' | 'coachmark'
  /** Hover-bubble body (tooltip variant). */
  text?: string
  /** Coachmark title + body + dismiss label (coachmark variant). */
  title?: string
  body?: string
  dismissLabel?: string
  theme: { bg: string; text: string; border: string; accent?: string }
  configToken: string
}

interface Bridge {
  ready(): void
  notifyRendered(payload: { width: number; height: number; configToken: string }): void
  onConfig(cb: (config: TooltipConfig) => void): () => void
  /** Coachmark dismiss button — tells main to hide + persist the
   *  once-ever flag. No-op for the tooltip variant. */
  dismissCoachmark?(): void
}

const bridge = (window as unknown as { __comfyTitleTooltip?: Bridge }).__comfyTitleTooltip

const variant = ref<'tooltip' | 'coachmark'>('tooltip')
const text = ref<string>('')
const cmTitle = ref<string>('')
const cmBody = ref<string>('')
const cmDismissLabel = ref<string>('Got it')
const themeBg = ref<string>('#211927')
const themeText = ref<string>('#ffffff')
const themeBorder = ref<string>('#38303d')
const themeAccent = ref<string>('#e3ff3c')
/** Whitish, semi-transparent hairline for the coachmark card + beak.
 *  Brighter than the neutral tooltip border (`themeBorder`) so the card
 *  reads as a distinct floating surface separated from the ComfyUI
 *  content behind it, not a flush extension of the dark chrome. */
const coachmarkBorder = 'rgba(255, 255, 255, 0.22)'
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
    variant.value = cfg.variant === 'coachmark' ? 'coachmark' : 'tooltip'
    text.value = cfg.text ?? ''
    cmTitle.value = cfg.title ?? ''
    cmBody.value = cfg.body ?? ''
    cmDismissLabel.value = cfg.dismissLabel ?? cmDismissLabel.value
    themeBg.value = cfg.theme.bg
    themeText.value = cfg.theme.text
    themeBorder.value = cfg.theme.border
    if (cfg.theme.accent) themeAccent.value = cfg.theme.accent
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
watch([text, cmTitle, cmBody], () => { void measureAndAck() })

function onDismiss(): void {
  bridge?.dismissCoachmark?.()
}

onUnmounted(() => {
  unsubConfig?.()
})
</script>

<template>
  <!-- Coachmark variant: sticky onboarding card with an upward beak,
       brand-accent title, body copy, and a dismiss button. -->
  <div
    v-if="variant === 'coachmark'"
    ref="bubble"
    class="coachmark"
    role="dialog"
    aria-modal="false"
    :aria-label="cmTitle"
    :style="{
      background: themeBg,
      color: themeText,
      borderColor: coachmarkBorder,
    }"
  >
    <span class="coachmark-beak" :style="{ background: themeBg, borderColor: coachmarkBorder }" />
    <div class="coachmark-body">
      <div class="coachmark-title" :style="{ color: themeAccent }">{{ cmTitle }}</div>
      <p class="coachmark-text">{{ cmBody }}</p>
      <button type="button" class="coachmark-dismiss" :style="{ color: themeAccent }" @click="onDismiss">
        {{ cmDismissLabel }}
      </button>
    </div>
  </div>
  <!-- Hover-tooltip variant: the plain content-sized bubble. -->
  <span
    v-else
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

/* Coachmark card — sticky onboarding hint. Wider than the tooltip,
   interactive (dismiss button), with an upward beak that visually ties
   it to the pill above. The view bounds are sized from this element's
   measured rect (render-ack), so it shrink-wraps its content. */
.coachmark {
  position: relative;
  display: block;
  width: max-content;
  max-width: 280px;
  margin-top: 7px; /* room for the beak above the card */
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid;
  /* Whitish hairline (set inline) + a soft inner highlight + a drop
     shadow, so the card floats clearly above the ComfyUI content behind
     it rather than blending into the dark canvas. */
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.04),
    0 8px 24px rgba(0, 0, 0, 0.5);
  font: 13px/1.45 var(--font-sans, 'Inter', system-ui, sans-serif);
  user-select: none;
  box-sizing: border-box;
}

/* Upward-pointing beak centered on the card's top edge. A rotated square
   sharing the card's bg + border so only the top two edges show. */
.coachmark-beak {
  position: absolute;
  top: -6px;
  left: 50%;
  width: 12px;
  height: 12px;
  transform: translateX(-50%) rotate(45deg);
  border-top: 1px solid;
  border-left: 1px solid;
  border-top-left-radius: 3px;
}

.coachmark-title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.coachmark-text {
  margin: 4px 0 10px;
  font-size: 12px;
  line-height: 1.5;
  opacity: 0.88;
}

.coachmark-dismiss {
  appearance: none;
  background: transparent;
  border: none;
  padding: 2px 0;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.coachmark-dismiss:hover {
  text-decoration: underline;
}
</style>
