<script setup lang="ts">
import type { FieldOption } from '../types/ipc'
import { getVariantImage } from '../lib/variants'

defineProps<{
  options: FieldOption[]
  selectedValue?: string | null
}>()

defineEmits<{
  select: [option: FieldOption]
}>()
</script>

<template>
  <div class="variant-cards">
    <div
      v-for="opt in options"
      :key="opt.value"
      role="button"
      tabindex="0"
      :class="['variant-card', {
        selected: selectedValue === opt.value,
        recommended: opt.recommended,
      }]"
      @click="$emit('select', opt)"
      @keydown.enter.prevent="$emit('select', opt)"
      @keydown.space.prevent="$emit('select', opt)"
    >
      <div class="variant-card-icon">
        <img
          v-if="getVariantImage(opt)"
          :src="getVariantImage(opt)!"
          :alt="opt.label"
          draggable="false"
        />
        <span v-else class="variant-card-icon-text">{{ opt.label }}</span>
      </div>
      <div class="variant-card-label">{{ opt.label }}</div>
      <div v-if="opt.recommended" class="variant-card-badge">
        {{ $t('newInstall.recommended') }}
      </div>
      <div v-if="opt.description" class="variant-card-desc">
        {{ opt.description }}
      </div>
    </div>
  </div>
</template>
