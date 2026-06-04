<script setup lang="ts">
// Height-animated disclosure via a CSS `grid-template-rows: 0fr → 1fr`
// transition, which covers the exact content height without a max-height cap.

interface Props {
  open: boolean
  duration?: number
}

withDefaults(defineProps<Props>(), { duration: 220 })
</script>

<template>
  <div
    class="ui-accordion"
    :class="{ 'is-open': open }"
    :style="{ '--ui-accordion-duration': `${duration}ms` }"
    :data-state="open ? 'open' : 'closed'"
  >
    <!-- `inert` removes the collapsed content from the focus order and
         the a11y tree, so Tab doesn't land on hidden buttons. -->
    <div class="ui-accordion-inner" :aria-hidden="!open" :inert="!open || undefined">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.ui-accordion {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--ui-accordion-duration)
    cubic-bezier(0.32, 0.72, 0, 1);
}

.ui-accordion.is-open {
  grid-template-rows: 1fr;
}

/* `min-height: 0` lets the grid track collapse to 0fr (Firefox quirk). */
.ui-accordion-inner {
  min-height: 0;
  overflow: hidden;
  opacity: 0;
  transition: opacity var(--ui-accordion-duration) ease;
}

.ui-accordion.is-open .ui-accordion-inner {
  opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
  .ui-accordion,
  .ui-accordion-inner {
    transition-duration: 0ms;
  }
}
</style>
