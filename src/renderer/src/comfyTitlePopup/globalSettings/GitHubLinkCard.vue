<script setup lang="ts">
// Intentionally NOT a variant of `components/ChoiceCard.vue`:
// ChoiceCard is an onboarding takeover primitive (tagline band, large
// type, optional radio + glow + arrow). This is a compact list-row
// link with a trailing star badge — overlapping a `variant="link"` on
// ChoiceCard would null out half its surface and fork typography.
import { computed } from 'vue'
import { ExternalLink, Github, Star } from 'lucide-vue-next'

const props = withDefaults(
  defineProps<{
    url: string
    stars: number | null
    label?: string
  }>(),
  {
    label: 'Comfy Desktop',
  },
)

const emit = defineEmits<{
  open: [url: string]
}>()

const starCountLabel = computed(() => {
  if (props.stars == null) return ''
  return new Intl.NumberFormat(undefined, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(props.stars)
})
</script>

<template>
  <button type="button" class="github-link-card" @click="emit('open', url)">
    <span class="github-link-main">
      <Github :size="16" aria-hidden="true" />
      <span class="github-link-label">{{ label }}</span>
      <ExternalLink :size="12" class="github-link-external" aria-hidden="true" />
    </span>
    <span v-if="stars != null" class="github-link-stars" :aria-label="`${stars} GitHub stars`">
      <Star :size="12" class="github-link-stars-icon" aria-hidden="true" />
      <span>{{ starCountLabel }}</span>
    </span>
  </button>
</template>

<style scoped>
.github-link-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--chooser-surface-border);
  border-radius: 8px;
  background: var(--brand-surface-bg);
  color: var(--neutral-100);
  cursor: pointer;
  text-align: left;
  transition: background-color 100ms ease;
}

.github-link-card:hover,
.github-link-card:focus-visible {
  background: var(--brand-surface-bg-hover);
  outline: none;
}

.github-link-main {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.github-link-label {
  font-size: 13px;
  font-weight: 500;
  line-height: 19px;
}

.github-link-external {
  flex-shrink: 0;
  opacity: 0.5;
}

.github-link-stars {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  padding: 2px 8px;
  border: 1px solid color-mix(in oklab, var(--neutral-100) 14%, transparent);
  border-radius: 999px;
  background: color-mix(in oklab, var(--neutral-100) 4%, transparent);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 16px;
}

.github-link-stars-icon {
  color: var(--warning);
  fill: currentColor;
}
</style>
