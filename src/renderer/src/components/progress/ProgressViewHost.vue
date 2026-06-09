<script setup lang="ts">
import { computed } from 'vue'
import type { Component } from 'vue'
import BrandProgressView from './views/BrandProgressView.vue'
import MinimalProgressView from './views/MinimalProgressView.vue'
import type { ProgressStepVM } from './progressViewModel'

/**
 * Swaps the launch/op progress presentation by a single `variant` prop.
 * Every view consumes the same normalized model, so changing the variant is
 * guaranteed to alter pixels only — the CTO-demo seam. Add a third look by
 * adding one line to `REGISTRY`.
 */
export type ProgressVariant = 'brand' | 'minimal'

const REGISTRY: Record<ProgressVariant, Component> = {
  brand: BrandProgressView,
  minimal: MinimalProgressView
}

const props = withDefaults(
  defineProps<{
    steps: ProgressStepVM[]
    variant?: ProgressVariant
  }>(),
  { variant: 'brand' }
)

const view = computed<Component>(() => REGISTRY[props.variant] ?? BrandProgressView)
</script>

<template>
  <component :is="view" :steps="steps" />
</template>
