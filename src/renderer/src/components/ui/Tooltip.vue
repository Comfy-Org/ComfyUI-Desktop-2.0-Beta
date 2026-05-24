<script setup lang="ts">
import { ref } from 'vue'
import { useTooltip, type TooltipAlign, type TooltipSide } from '../../composables/useTooltip'

/**
 * Position-aware tooltip primitive (shadcn-style).
 *
 * Wraps a trigger slot, teleports the bubble to body, and lets
 * `useTooltip` own placement: requested side honoured when there's
 * room, flipped to the opposite side on collision, `left`/`top`
 * clamped inside a viewport edge band so the bubble never sits flush
 * against the screen edge. The arrow is offset back toward the trigger
 * regardless of how clamping shifts the bubble.
 *
 * The trigger slot must accept hover + focus events on its root — the
 * wrapper is a contents-only `<span>` so it doesn't introduce a stacking
 * box, but bubbles `mouseenter` / `focusin` upward from whatever the
 * consumer renders inside.
 *
 * TODO(tooltip-tokens): tooltip surface colours hard-coded per spec
 * (#211927 fill, #38303D border); promote to `--tooltip-*` tokens in
 * main.css and reference them here once the design system PR lands.
 */

interface Props {
  text?: string
  side?: TooltipSide
  align?: TooltipAlign
  delayMs?: number
  disabled?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  text: undefined,
  side: 'top',
  align: 'center',
  delayMs: 100,
  disabled: false,
})

const triggerRef = ref<HTMLElement | null>(null)
const bubbleRef = ref<HTMLElement | null>(null)

const { visible, show, hide, bubbleStyle, resolvedSide, arrowStyle } = useTooltip(
  triggerRef,
  bubbleRef,
  {
    side: () => props.side,
    align: () => props.align,
    canShow: () => !props.disabled && !!props.text,
  },
)

let openTimer: ReturnType<typeof setTimeout> | null = null

function onEnter(): void {
  if (openTimer) clearTimeout(openTimer)
  if (props.delayMs <= 0) {
    show()
    return
  }
  openTimer = setTimeout(() => {
    show()
    openTimer = null
  }, props.delayMs)
}

function onLeave(): void {
  if (openTimer) {
    clearTimeout(openTimer)
    openTimer = null
  }
  hide()
}
</script>

<template>
  <span
    ref="triggerRef"
    class="tooltip-wrap"
    @mouseenter="onEnter"
    @mouseleave="onLeave"
    @focusin="onEnter"
    @focusout="onLeave"
  >
    <slot />
    <Teleport to="body">
      <span
        v-if="visible"
        ref="bubbleRef"
        class="tooltip-bubble"
        :data-side="resolvedSide"
        :style="bubbleStyle"
        role="tooltip"
      >
        {{ text }}
        <span class="tooltip-arrow" :style="arrowStyle" aria-hidden="true">
          <span class="tooltip-arrow__fill" />
        </span>
      </span>
    </Teleport>
  </span>
</template>

<style scoped>
.tooltip-wrap {
  display: inline-flex;
}
</style>

<style>
.tooltip-bubble {
  position: fixed;
  z-index: 10001;
  padding: 8px 16px;
  border-radius: var(--primitive-border-radius-rounded-lg, 8px);
  border: 1px solid #38303d;
  background: #211927;
  color: #ffffff;
  font-size: 12px;
  line-height: 1.4;
  font-weight: 400;
  max-width: 260px;
  pointer-events: none;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
  white-space: normal;
  text-align: left;
}

/* Arrow is a CSS triangle stacked over a same-shape fill so the bubble
 * border reads continuously through the arrow's outer edge. */
.tooltip-arrow {
  position: absolute;
  width: 12px;
  height: 6px;
  /* Inline `left` / `top` from `arrowStyle` positions the arrow back at
   * the trigger center even when clamping pushed the bubble off-axis. */
  transform: translateX(-50%);
  pointer-events: none;
}
/* Pull the arrow 1px back into the bubble so the fill triangle overlaps
 * the bubble's 1px border at the join and the arrow reads as one
 * continuous shape with the bubble — no seam, no visible border line
 * across the top of the triangle. */
.tooltip-bubble[data-side='top'] .tooltip-arrow {
  bottom: -5px;
}
.tooltip-bubble[data-side='bottom'] .tooltip-arrow {
  top: -5px;
}
.tooltip-bubble[data-side='left'] .tooltip-arrow,
.tooltip-bubble[data-side='right'] .tooltip-arrow {
  width: 6px;
  height: 12px;
  transform: translateY(-50%);
}
.tooltip-bubble[data-side='left'] .tooltip-arrow {
  right: -5px;
}
.tooltip-bubble[data-side='right'] .tooltip-arrow {
  left: -5px;
}

.tooltip-arrow::before,
.tooltip-arrow__fill {
  content: '';
  position: absolute;
  inset: 0;
}
.tooltip-arrow::before {
  /* Border-coloured triangle painted under the fill — its tip + sides
   * become the arrow's outline. The fill overlaps the bubble border so
   * the only visible #38303d edge is the two sloped sides of the
   * triangle, not the flat top. */
  background: #38303d;
  clip-path: polygon(50% 100%, 0 0, 100% 0);
}
.tooltip-bubble[data-side='bottom'] .tooltip-arrow::before {
  clip-path: polygon(50% 0, 0 100%, 100% 100%);
}
.tooltip-bubble[data-side='left'] .tooltip-arrow::before {
  clip-path: polygon(100% 50%, 0 0, 0 100%);
}
.tooltip-bubble[data-side='right'] .tooltip-arrow::before {
  clip-path: polygon(0 50%, 100% 0, 100% 100%);
}

.tooltip-arrow__fill {
  background: #211927;
  /* Pull the fill 1px upward so it covers the bubble's bottom border
   * where the triangle meets the bubble — the only visible border is
   * the two sloped sides. */
  inset: -1px 0 0 0;
  clip-path: polygon(50% 100%, 0 0, 100% 0);
}
.tooltip-bubble[data-side='bottom'] .tooltip-arrow__fill {
  inset: 0 0 -1px 0;
  clip-path: polygon(50% 0, 0 100%, 100% 100%);
}
.tooltip-bubble[data-side='left'] .tooltip-arrow__fill {
  inset: 0 0 0 -1px;
  clip-path: polygon(100% 50%, 0 0, 0 100%);
}
.tooltip-bubble[data-side='right'] .tooltip-arrow__fill {
  inset: 0 -1px 0 0;
  clip-path: polygon(0 50%, 100% 0, 100% 100%);
}
</style>
