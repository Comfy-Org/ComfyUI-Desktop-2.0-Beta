<script setup lang="ts">
import { CircleHelp } from 'lucide-vue-next'
import Tooltip from './ui/Tooltip.vue'
import type { TooltipSide } from '../composables/useTooltip'

/**
 * Inline help-icon trigger that composes the shared `Tooltip` primitive.
 * Owns the icon + hover affordance; defers placement, teleport, arrow,
 * and viewport collision handling to the primitive in `/ui`.
 */
const props = withDefaults(
  defineProps<{
    text: string
    side?: TooltipSide
    delayMs?: number
  }>(),
  { side: 'top', delayMs: 100 }
)
</script>

<template>
  <Tooltip :text="props.text" :side="props.side" :delay-ms="props.delayMs">
    <span class="info-tooltip-trigger" tabindex="0" role="button" :aria-label="props.text">
      <CircleHelp :size="14" class="info-tooltip-icon" />
    </span>
  </Tooltip>
</template>

<style scoped>
.info-tooltip-trigger {
  display: inline-flex;
  align-items: center;
  margin-left: 4px;
  vertical-align: middle;
  cursor: help;
}

.info-tooltip-icon {
  color: var(--text-muted);
  opacity: 0.85;
  transition:
    opacity 0.15s,
    color 0.15s;
  flex-shrink: 0;
}

.info-tooltip-trigger:hover .info-tooltip-icon,
.info-tooltip-trigger:focus-visible .info-tooltip-icon {
  opacity: 1;
  color: var(--accent);
}
</style>
