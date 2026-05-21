<script setup lang="ts">
import { ref, watch } from 'vue'
import { ChevronRight } from 'lucide-vue-next'
import BaseAccordion from '../../components/ui/BaseAccordion.vue'

/**
 * Single-use accordion wrapper for the Global Settings panel.
 *
 * Combines the Instance Picker's accordion header chrome
 * (`picker-detail-nav-item` button + 12px ChevronRight + 90° rotate on
 * open) with the shared `BaseAccordion` body. Keeps the panel template
 * readable when stacked five times without duplicating the
 * button + chevron + accordion triplet at every callsite.
 *
 * Visuals match `InstancePickerView.vue` lines 841-870 exactly so the
 * accordions read as the picker's right-pane Settings/Snapshots
 * accordions do.
 */

interface Props {
  title: string
  /** Initial open state. The wrapper owns its own toggle once mounted —
   *  parent prop changes after mount are ignored. */
  defaultOpen?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  defaultOpen: false,
})

const open = ref(props.defaultOpen)

// Re-sync only when the value flips to true after mount (e.g. parent
// drives an "open this section" deep-link). Doesn't auto-close.
watch(
  () => props.defaultOpen,
  (next) => {
    if (next) open.value = true
  },
)

function toggle(): void {
  open.value = !open.value
}
</script>

<template>
  <div class="global-settings-accordion">
    <button
      type="button"
      class="global-settings-accordion-header"
      :aria-expanded="open"
      @click="toggle"
    >
      <ChevronRight
        :size="12"
        aria-hidden="true"
        class="global-settings-accordion-chevron"
        :class="{ 'is-open': open }"
      />
      <span>{{ title }}</span>
    </button>
    <BaseAccordion :open="open">
      <div class="global-settings-accordion-body">
        <slot />
      </div>
    </BaseAccordion>
  </div>
</template>

<style scoped>
.global-settings-accordion {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* Matches `picker-detail-nav-item` in InstancePickerView.vue:841-858. */
.global-settings-accordion-header {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--neutral-100);
  font-size: 14px;
  line-height: normal;
  cursor: pointer;
  text-align: left;
  align-self: flex-start;
}

.global-settings-accordion-header:hover,
.global-settings-accordion-header:focus-visible {
  opacity: 0.85;
  outline: none;
}

/* Matches `picker-detail-nav-chevron` in InstancePickerView.vue:859-864. */
.global-settings-accordion-chevron {
  transition: transform 180ms cubic-bezier(0.32, 0.72, 0, 1);
}

.global-settings-accordion-chevron.is-open {
  transform: rotate(90deg);
}

/* Body sits flush against the header — the outer `.global-settings-body`
 * already supplies horizontal gutter, so re-padding here just doubled
 * up the visual mass. */
.global-settings-accordion-body {
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>
