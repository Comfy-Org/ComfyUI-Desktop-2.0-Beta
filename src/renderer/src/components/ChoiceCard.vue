<script setup lang="ts">
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
      <div class="choice-card__indicator" aria-hidden="true">
        <slot name="icon">
          <span class="choice-card__radio" />
        </slot>
      </div>
      <div class="choice-card__text">
        <div class="choice-card__label">{{ label }}</div>
        <div class="choice-card__desc">
          <InlineRichText :text="description" />
        </div>
      </div>
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
  border-radius: 6px;
  background: var(--brand-surface-bg);
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
  background: var(--brand-surface-bg-hover);
}
.choice-card:hover:not(:disabled) .choice-card__label {
  color: var(--text);
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
  padding: 4px 12px;
  margin: 4px 4px 0 4px;
  font-size: var(--takeover-fs-lead);
  line-height: normal;
  color: var(--neutral-100);
  border-radius: 4px 4px 0 0;
  background: linear-gradient(90deg, rgba(255, 255, 255, 0.07) 0%, rgba(255, 255, 255, 0) 100%);
}
.choice-card__body {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: 12px;
  padding: 20px 16px 24px 32px;
}
.choice-card__indicator {
  margin-top: 1.25px;
}
.choice-card__radio {
  display: inline-block;
  width: 16px;
  height: 16px;
  border-radius: 16px;
  border: 1px solid var(--text-faint);
  background: transparent;
}
.choice-card__text {
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
</style>
