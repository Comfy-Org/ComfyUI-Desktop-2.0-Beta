<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Check } from 'lucide-vue-next'
import type { FieldOption } from '../types/ipc'
import { getVariantImage } from '../lib/variants'

defineProps<{
  options: FieldOption[]
  selectedValue?: string | null
  ariaLabel?: string
}>()

defineEmits<{
  select: [option: FieldOption]
}>()

const { t } = useI18n()
</script>

<template>
  <div
    class="brand-variant-list"
    role="radiogroup"
    :aria-label="ariaLabel"
  >
    <button
      v-for="opt in options"
      :key="opt.value"
      type="button"
      role="radio"
      :aria-checked="selectedValue === opt.value"
      :class="[
        'brand-variant-row',
        { 'brand-variant-row--selected': selectedValue === opt.value }
      ]"
      @click="$emit('select', opt)"
    >
      <span class="brand-variant-row__icon" aria-hidden="true">
        <img
          v-if="getVariantImage(opt)"
          :src="getVariantImage(opt)!"
          :alt="opt.label"
          draggable="false"
        />
      </span>
      <span class="brand-variant-row__text">
        <span class="brand-variant-row__label">
          {{ opt.label }}
          <span v-if="opt.recommended" class="brand-tag-recommended">
            {{ t('newInstall.recommended') }}
          </span>
        </span>
        <span v-if="opt.description" class="brand-variant-row__meta">
          {{ opt.description }}
        </span>
      </span>
      <Check
        v-if="selectedValue === opt.value"
        class="brand-variant-row__check"
        :size="16"
        :stroke-width="2"
        aria-hidden="true"
      />
    </button>
  </div>
</template>

<style scoped>
.brand-variant-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
}
.brand-variant-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 12px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: var(--brand-surface-bg);
  color: var(--neutral-200);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    background 120ms ease,
    border-color 120ms ease,
    color 120ms ease;
}
.brand-variant-row:hover {
  background: var(--brand-surface-bg-hover);
  border-color: var(--brand-surface-border);
  color: var(--neutral-100);
}
.brand-variant-row:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}
.brand-variant-row--selected {
  background: var(--brand-surface-bg-hover);
  border-color: var(--brand-surface-border-hover);
  box-shadow: 0 1px 0 0 rgba(255, 255, 255, 0.08) inset;
  color: var(--neutral-100);
}
.brand-variant-row__icon {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.04);
  overflow: hidden;
}
.brand-variant-row__icon img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.brand-variant-row__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1 1 auto;
}
.brand-variant-row__label {
  display: inline-flex;
  align-items: center;
  font-size: var(--takeover-fs-body);
  font-weight: 600;
  color: var(--neutral-100);
}
.brand-variant-row__meta {
  font-size: var(--takeover-fs-caption);
  color: var(--neutral-300);
}
.brand-variant-row__check {
  flex: 0 0 auto;
  color: var(--neutral-100);
}
</style>
