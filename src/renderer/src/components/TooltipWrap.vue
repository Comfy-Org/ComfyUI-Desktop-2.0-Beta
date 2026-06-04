<script setup lang="ts">
import Tooltip from './ui/Tooltip.vue'
import type { TooltipAlign, TooltipSide } from '../composables/useTooltip'

// Backwards-compat shim forwarding to the `Tooltip` primitive in `/ui`.
// TODO(tooltip-cleanup): migrate call sites to `ui/Tooltip.vue`, then delete this shim.

withDefaults(
  defineProps<{
    text?: string
    side?: TooltipSide
    align?: TooltipAlign
  }>(),
  { text: undefined, side: 'top', align: 'center' },
)
</script>

<template>
  <Tooltip :text="text" :side="side" :align="align">
    <slot />
  </Tooltip>
</template>
