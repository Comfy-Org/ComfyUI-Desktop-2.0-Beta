<script setup lang="ts">
import { ArrowRight } from 'lucide-vue-next'
import InlineRichText from './InlineRichText.vue'

withDefaults(
  defineProps<{
    label: string
    description: string
    tagline?: string
    disabled?: boolean
    glow?: boolean
    /** Renders as a radio option (left indicator, no arrow); click selects
     *  rather than commits, leaving the commit to a parent Continue button. */
    selectable?: boolean
    selected?: boolean
  }>(),
  {
    tagline: '',
    disabled: false,
    glow: false,
    selectable: false,
    selected: false
  }
)

defineEmits<{ click: [] }>()
</script>

<template>
  <button
    type="button"
    :class="[
      'choice-card',
      { 'choice-card--glow': glow, 'choice-card--selected': selectable && selected }
    ]"
    :role="selectable ? 'radio' : undefined"
    :aria-checked="selectable ? selected : undefined"
    :tabindex="selectable ? (selected ? 0 : -1) : undefined"
    :disabled="disabled"
    @click="$emit('click')"
  >
    <div v-if="tagline" class="choice-card__tagline">{{ tagline }}</div>
    <div class="choice-card__body">
      <span v-if="selectable" class="choice-card__radio" aria-hidden="true">
        <span v-if="selected" class="choice-card__radio-dot" />
      </span>
      <div class="choice-card__text">
        <div class="choice-card__label">
          <span class="choice-card__label-text">{{ label }}</span>
          <span v-if="$slots['label-trailing']" class="choice-card__label-trailing">
            <slot name="label-trailing" />
          </span>
        </div>
        <div class="choice-card__desc">
          <InlineRichText :text="description" />
          <div v-if="$slots['desc-trailing']" class="choice-card__desc-trailing">
            <slot name="desc-trailing" />
          </div>
        </div>
      </div>
      <ArrowRight v-if="!selectable" :size="18" class="choice-card__arrow" aria-hidden="true" />
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
  /* Resting bg uses the hover token so cards separate from the takeover
   * surface even at rest. */
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
/* Selected uses brand blue, not yellow, so the radio doesn't compete with
 * the yellow Continue CTA for attention. */
.choice-card--selected {
  border-color: color-mix(in oklab, var(--accent-primary) 60%, transparent);
  background: color-mix(in oklab, var(--accent-primary) 6%, var(--brand-surface-bg-hover));
  box-shadow: 0 0 0 1px color-mix(in oklab, var(--accent-primary) 40%, transparent) inset;
}
.choice-card--selected:hover:not(:disabled) {
  border-color: color-mix(in oklab, var(--accent-primary) 75%, transparent);
  background: color-mix(in oklab, var(--accent-primary) 9%, rgba(137, 137, 137, 0.13));
}
.choice-card__radio {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 999px;
  border: 1.5px solid var(--brand-surface-border-hover);
  background: rgba(0, 0, 0, 0.1);
  transition:
    border-color 120ms ease,
    background 120ms ease;
}
.choice-card--selected .choice-card__radio {
  border-color: var(--accent-primary);
  background: transparent;
}
.choice-card__radio-dot {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  background: var(--accent-primary);
}

.choice-card__tagline {
  position: relative;
  z-index: 1;
  padding: 10px 20px;
  font-size: var(--takeover-fs-body);
  font-weight: 500;
  line-height: normal;
  color: var(--neutral-100);
  /* Gradient + bottom rule so the tagline reads as a header band, not a
   * watermark on the card surface. */
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
  gap: 8px;
  min-width: 0;
}
.choice-card__label {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  flex-wrap: wrap;
  gap: 8px;
  width: 100%;
  font-family: var(--font-sans);
  font-size: var(--takeover-fs-lead);
  font-weight: 700;
  line-height: normal;
  color: var(--neutral-100);
  transition: color 120ms ease;
}
.choice-card__label-text {
  flex: 0 0 auto;
}
.choice-card__label-trailing {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
}
.choice-card__desc-trailing {
  margin-top: 6px;
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
/* Resting state is muted + nudged left so hover reads as a slide-in. */
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
