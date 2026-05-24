<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { useTooltip, type TooltipAlign, type TooltipSide } from '../../composables/useTooltip'

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
const bubbleId = `tooltip-${useId()}`

const { visible, show, hide, bubbleStyle, resolvedSide, arrowStyle } = useTooltip(
  triggerRef,
  bubbleRef,
  {
    side: () => props.side,
    align: () => props.align,
    canShow: () => !props.disabled && !!props.text,
  },
)

const describedBy = computed(() => (visible.value ? bubbleId : undefined))

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

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && visible.value) {
    e.stopPropagation()
    hide()
  }
}
</script>

<template>
  <span
    ref="triggerRef"
    class="tooltip-wrap"
    :aria-describedby="describedBy"
    @mouseenter="onEnter"
    @mouseleave="onLeave"
    @focusin="onEnter"
    @focusout="onLeave"
    @keydown="onKeydown"
  >
    <slot />
    <Teleport to="body">
      <span
        v-if="visible"
        :id="bubbleId"
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
  z-index: var(--z-tooltip);
  padding: 8px 16px;
  border-radius: var(--primitive-border-radius-rounded-lg, 8px);
  border: 1px solid var(--tooltip-border);
  background: var(--tooltip-bg);
  color: var(--tooltip-fg);
  font-size: 12px;
  line-height: 1.4;
  font-weight: 400;
  max-width: 260px;
  pointer-events: none;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
  white-space: normal;
  text-align: left;
}

.tooltip-arrow {
  position: absolute;
  width: 12px;
  height: 6px;
  transform: translateX(-50%);
  pointer-events: none;
}
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
  background: var(--tooltip-border);
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
  background: var(--tooltip-bg);
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
