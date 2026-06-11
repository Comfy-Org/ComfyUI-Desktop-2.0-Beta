<script setup lang="ts">
import { computed } from 'vue'
import { Check, LoaderCircle } from 'lucide-vue-next'
import type { ProgressStepVM } from '../lib/progressViewModel'

/**
 * Focus stepper — replaces the caption for stepped ops. Fixed viewport, track
 * translates so the active row sits on the centre line; done steps fade up,
 * pending steps wait below.
 */
const props = defineProps<{ steps: ProgressStepVM[] }>()

const ROW_H = 46
const VISIBLE_ROWS = 3

const activeIndex = computed(() => {
  const i = props.steps.findIndex((s) => s.status === 'active')
  if (i >= 0) return i
  // No active step yet (brief gap, or all done). Anchor to the FIRST step, not
  // the last — otherwise the stepper centres on the final phase then jerks
  // back to the top when the first real phase fires.
  if (props.steps.every((s) => s.status === 'done')) return props.steps.length - 1
  return 0
})

const trackStyle = computed(() => ({
  transform: `translateY(${(Math.floor(VISIBLE_ROWS / 2) - activeIndex.value) * ROW_H}px)`,
}))

const viewportStyle = computed(() => ({ height: `${VISIBLE_ROWS * ROW_H}px` }))

function rowOpacity(index: number): number {
  const dist = Math.abs(index - activeIndex.value)
  if (dist === 0) return 1
  if (dist === 1) return 0.38
  return Math.max(0.08, 0.22 - (dist - 2) * 0.1)
}
</script>

<template>
  <div v-if="steps.length" class="bpv" :style="viewportStyle" aria-live="polite">
    <ul class="bpv__track" :style="trackStyle">
      <li
        v-for="(step, i) in steps"
        :key="step.phase"
        class="bpv__row"
        :class="[
          `is-${step.status}`,
          {
            'is-focused': i === activeIndex,
          },
        ]"
        :style="{ opacity: rowOpacity(i) }"
        :aria-current="i === activeIndex ? 'step' : undefined"
      >
        <span class="bpv__row-inner">
          <span class="bpv__text">
            <span class="bpv__line">
              <span class="bpv__icon" aria-hidden="true">
                <Check v-if="step.status === 'done'" :size="12" stroke-width="2.5" />
                <LoaderCircle v-else-if="step.status === 'active'" :size="14" class="bpv__spin" />
                <span v-else class="bpv__dot" />
              </span>
              <span class="bpv__label">{{ step.label }}</span>
            </span>
            <span v-if="i === activeIndex && step.detail" class="bpv__detail">{{
              step.detail
            }}</span>
          </span>
        </span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.bpv {
  --bpv-row-h: 46px;
  position: relative;
  width: 100%;
  max-width: 38rem;
  margin-inline: auto;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent 0%,
    #000 18%,
    #000 82%,
    transparent 100%
  );
  mask-image: linear-gradient(to bottom, transparent 0%, #000 18%, #000 82%, transparent 100%);
}
.bpv__track {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
  transition: transform 420ms cubic-bezier(0.22, 1, 0.36, 1);
  will-change: transform;
}
.bpv__row {
  height: var(--bpv-row-h);
  display: flex;
  align-items: center;
  justify-content: center;
  padding-inline: 0.25rem;
  transition: opacity 300ms ease;
}
.bpv__row-inner {
  display: flex;
  justify-content: center;
  max-width: 100%;
}
.bpv__line {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  max-width: 100%;
}
.bpv__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex: 0 0 16px;
  color: var(--neutral-500);
}
.bpv__row.is-done .bpv__icon {
  color: var(--brand-success, #3ecf8e);
}
.bpv__row.is-focused .bpv__icon {
  color: var(--comfy-yellow);
}
.bpv__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  border: 1.5px solid var(--neutral-500);
}
.bpv__text {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  min-width: 0;
  /* Wide enough for the full download detail line (bytes · speed · ETA) so it
     isn't ellipsized; clamped to the viewport on narrow windows. */
  max-width: min(34rem, 88vw);
  text-align: center;
}
.bpv__label {
  font-size: 0.8125rem;
  font-weight: 400;
  line-height: 1.25;
  color: var(--neutral-300);
  letter-spacing: 0.005em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-shadow:
    0 1px 2px rgba(0, 0, 0, 0.7),
    0 0 18px rgba(25, 19, 29, 0.9);
}
.bpv__row.is-focused .bpv__label {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--neutral-100);
  text-shadow:
    0 1px 3px rgba(0, 0, 0, 0.75),
    0 0 24px rgba(25, 19, 29, 0.95);
}
.bpv__detail {
  font-size: 0.6875rem;
  line-height: 1.3;
  color: var(--neutral-400);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
  text-shadow:
    0 1px 2px rgba(0, 0, 0, 0.65),
    0 0 16px rgba(25, 19, 29, 0.85);
}
.bpv__spin {
  animation: bpv-spin 0.9s linear infinite;
}
@keyframes bpv-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .bpv__track {
    transition: none;
  }
  .bpv__spin {
    animation: none;
  }
}
</style>
