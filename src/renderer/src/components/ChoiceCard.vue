<script setup lang="ts">
import { ArrowRight } from 'lucide-vue-next'
import InlineRichText from './InlineRichText.vue'

withDefaults(
  defineProps<{
    label: string
    description: string
    tagline?: string
    disabled?: boolean
    /** Adds a soft plum glow behind the card content. Opt-in for the
     *  Cloud option on the first-use pick step — Local stays plain. */
    glow?: boolean
  }>(),
  {
    tagline: '',
    disabled: false,
    glow: false
  }
)

defineEmits<{ click: [] }>()
</script>

<template>
  <button
    type="button"
    :class="['choice-card', { 'choice-card--glow': glow }]"
    :disabled="disabled"
    @click="$emit('click')"
  >
    <div v-if="tagline" class="choice-card__tagline">{{ tagline }}</div>
    <div class="choice-card__body">
      <div class="choice-card__text">
        <div class="choice-card__label">{{ label }}</div>
        <div class="choice-card__desc">
          <InlineRichText :text="description" />
        </div>
      </div>
      <ArrowRight :size="18" class="choice-card__arrow" aria-hidden="true" />
    </div>
  </button>
</template>

<style scoped>
.choice-card {
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  align-items: stretch;
  gap: 0;
  padding: 0;
  border: 1px solid var(--brand-surface-border);
  border-radius: 10px;
  /* Resting bg lifted from `--brand-surface-bg` (5% gray) to the
   * hover token so the cards visibly separate from the takeover
   * surface even at rest. Hover then steps to a brighter `border`
   * tone (~18% white) instead of a barely-different bg — keeps the
   * resting state legible AND gives hover a real lift. */
  background: var(--brand-surface-bg-hover);
  backdrop-filter: blur(var(--brand-surface-blur));
  color: var(--neutral-100);
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  transition:
    border-color 120ms ease,
    background 120ms ease;
  font: inherit;
}
.choice-card:hover:not(:disabled) {
  /* Border steps up to give the hover a clear edge cue; bg stays in
   * the same gray family as resting and lifts by ~3% so the surface
   * doesn't flash white-bright on hover. */
  border-color: var(--brand-surface-border-hover);
  background: rgba(137, 137, 137, 0.13);
}
.choice-card:hover:not(:disabled) .choice-card__label {
  color: var(--text);
}
.choice-card:hover:not(:disabled) .choice-card__arrow {
  opacity: 1;
  transform: translateX(0);
}
.choice-card:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}
.choice-card:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.choice-card__tagline {
  position: relative;
  z-index: 1;
  padding: 10px 20px;
  font-size: var(--takeover-fs-body);
  font-weight: 500;
  line-height: normal;
  color: var(--neutral-100);
  /* Stronger gradient + thin bottom rule so the tagline reads as a
   * distinct header band, not a watermark on the card surface. The
   * previous 7% white left edge was so close to the card bg that the
   * band visually disappeared. */
  background: linear-gradient(90deg, rgba(255, 255, 255, 0.12) 0%, rgba(255, 255, 255, 0.02) 100%);
  border-bottom: 1px solid var(--brand-surface-border);
}
.choice-card__body {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 16px;
  padding: 18px 20px 20px 20px;
}
.choice-card__text {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.choice-card__label {
  font-family: var(--font-sans);
  font-size: var(--takeover-fs-lead);
  font-weight: 700;
  line-height: normal;
  color: var(--neutral-100);
  transition: color 120ms ease;
}
.choice-card__desc {
  font-family: var(--font-sans);
  font-size: var(--takeover-fs-body);
  font-weight: 400;
  line-height: normal;
  color: var(--neutral-300);
}
.choice-card__desc :deep(strong) {
  color: var(--neutral-100);
  font-weight: 400;
}
/* Trailing arrow — the card IS the trigger (single-action button, no
 * confirm step), so the arrow signals "this commits" the way a row
 * affordance does in Linear / Arc. Resting state is muted + nudged
 * left so the reveal-on-hover reads as a slide-in, not a recolour. */
.choice-card__arrow {
  flex: 0 0 auto;
  color: var(--neutral-100);
  opacity: 0;
  transform: translateX(-4px);
  transition:
    opacity 140ms ease,
    transform 140ms cubic-bezier(0.32, 0.72, 0, 1);
}
@media (prefers-reduced-motion: reduce) {
  .choice-card__arrow {
    transition: opacity 100ms ease;
    transform: none;
  }
}
</style>
