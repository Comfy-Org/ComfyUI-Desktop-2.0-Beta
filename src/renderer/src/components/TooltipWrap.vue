<script setup lang="ts">
import Tooltip from './ui/Tooltip.vue'
import type { TooltipAlign, TooltipSide } from '../composables/useTooltip'

/**
 * Backwards-compat shim that forwards to the position-aware `Tooltip`
 * primitive in `/ui`. Pre-existing call sites (DetailSection,
 * InstallWizardModal, SettingsSectionList, DetailModal) keep importing
 * `TooltipWrap` so the migration didn't have to mass-rename in the
 * same PR as the primitive landing.
 *
 * TODO(tooltip-cleanup): replace `import TooltipWrap from
 * '@/components/TooltipWrap.vue'` at call sites with `import Tooltip
 * from '@/components/ui/Tooltip.vue'`, then delete this shim.
 */

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
