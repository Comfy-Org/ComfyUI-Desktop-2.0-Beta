<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, useTemplateRef, watch } from 'vue'

/**
 * Title-tooltip popup renderer. Renders the hover bubble (and onboarding
 * coachmark) and reports its rendered size to main on each config update so
 * main resizes the popup view before showing it. Used because macOS doesn't
 * reliably surface native `title` tooltips for unfocused sibling chrome views.
 */

interface TooltipConfig {
  /** `'tooltip'` (default) for the hover bubble; `'coachmark'` for the
   *  onboarding card. */
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
const coachmarkBorder = 'rgba(255, 255, 255, 0.22)'
/** Token of the latest config, echoed in every render-ack so main can discard
 *  stale acks. */
let currentConfigToken = ''

const bubbleRef = useTemplateRef<HTMLElement>('bubble')

let unsubConfig: (() => void) | undefined

/** Wait for the Inter web font before measuring, else the first show measures in
 *  the fallback font and reports a wrong size, making the bubble visibly
 *  re-size when the real font paints. */
async function measureAndAck(): Promise<void> {
  // Capture the token now; a config change mid-await produces a stale ack that
  // main ignores because the token won't match.
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
    void measureAndAck()
  })
  bridge?.ready()
  // Re-measure if Inter loads mid-session (after the initial ack) so main can
  // resize to the new metrics.
  if (document.fonts && typeof document.fonts.addEventListener === 'function') {
    document.fonts.addEventListener('loadingdone', () => {
      if (text.value) void measureAndAck()
    })
  }
})

// Defensive re-measure if rendered text changes outside the config push (HMR,
// future mutations that bypass `onConfig`).
watch([text, cmTitle, cmBody], () => { void measureAndAck() })

function onDismiss(): void {
  bridge?.dismissCoachmark?.()
}

onUnmounted(() => {
  unsubConfig?.()
})
</script>

<template>
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

/* Center the bubble horizontally; anchor it to the top (asymmetric gutter). */
:global(body) {
  display: flex;
  align-items: flex-start;
  justify-content: center;
}

/* Shrink-wraps its text so main can measure and resize the view. Chrome matches
   the panel-side `.info-tooltip-bubble` so the popup looks identical. */
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

/* Coachmark card — sticky onboarding hint, sized from its measured rect. */
.coachmark {
  position: relative;
  display: block;
  width: max-content;
  max-width: 280px;
  margin-top: 7px; /* room for the beak above the card */
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid;
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.04),
    0 8px 24px rgba(0, 0, 0, 0.5);
  font: 13px/1.45 var(--font-sans, 'Inter', system-ui, sans-serif);
  user-select: none;
  box-sizing: border-box;
}

/* Upward beak: a rotated square sharing the card's bg + border. */
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
