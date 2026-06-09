<script setup lang="ts">
import { computed } from 'vue'
import type { ProgressStepVM } from '../progressViewModel'

/**
 * Minimal alternate presentation of the SAME `ProgressViewModel.steps`.
 * Shows only the active phase's label + live detail and a compact "step N of
 * M" counter — no full row list. Exists as the swappable second look for the
 * leadership A/B demo; reads identical state to `BrandProgressView`.
 */
const props = defineProps<{ steps: ProgressStepVM[] }>()

const total = computed(() => props.steps.length)
const activeIndex = computed(() => props.steps.findIndex((s) => s.status === 'active'))
const active = computed(() => props.steps[activeIndex.value] ?? null)
const doneCount = computed(() => props.steps.filter((s) => s.status === 'done').length)
</script>

<template>
  <div v-if="total" class="mpv" aria-live="polite">
    <div class="mpv__counter">
      {{ Math.min(activeIndex >= 0 ? activeIndex + 1 : doneCount, total) }} / {{ total }}
    </div>
    <div v-if="active" class="mpv__line">
      <span class="mpv__label">{{ active.label }}</span>
      <span v-if="active.detail" class="mpv__detail"> · {{ active.detail }}</span>
    </div>
  </div>
</template>

<style scoped>
.mpv {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  font-size: 0.8125rem;
  line-height: 1.25rem;
}
.mpv__counter {
  font-variant-numeric: tabular-nums;
  opacity: 0.6;
  flex: 0 0 auto;
}
.mpv__line {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mpv__label {
  font-weight: 500;
}
.mpv__detail {
  opacity: 0.7;
}
</style>
