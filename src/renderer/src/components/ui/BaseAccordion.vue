<script setup lang="ts">
/**
 * BaseAccordion — smooth height-animated disclosure primitive.
 *
 * Mirrors shadcn's Radix-based Accordion behavior using a CSS-only
 * `grid-template-rows: 0fr → 1fr` transition. No JS height measurement,
 * no layout thrash, no fixed `max-height` cap — content of any size
 * expands from 0 to its natural height and back, smoothly.
 *
 * Consumers control state via the `open` prop. The component renders no
 * trigger / header chrome — pair it with whatever expansion button the
 * surrounding UI already has (chevron, row click target, etc.).
 *
 * Why grid-template-rows over max-height: max-height needs a guessed
 * cap (too low = clip, too high = laggy late-stage easing). The grid
 * trick transitions between two intrinsic states (0fr and 1fr) so the
 * animation always covers the exact content height at the exact pace.
 */

interface Props {
  /** When true, content is revealed at its natural height. */
  open: boolean
  /** Transition duration in ms. Defaults to 220ms — matches the rest
   *  of the drawer's motion rhythm. */
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

/* The inner wrapper needs `min-height: 0` so the grid track can
 * actually collapse to 0fr (Firefox quirk). `overflow: hidden` clips
 * content during the transition so partially-collapsed text doesn't
 * leak below the row. */
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
