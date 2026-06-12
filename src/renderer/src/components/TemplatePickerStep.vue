<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, TriangleAlert, ImageOff } from 'lucide-vue-next'
import type { FieldOption } from '../types/ipc'
import { formatBytes } from '../lib/formatting'

/**
 * Dedicated starter-template picker — a modality grid of showcase templates plus
 * a "blank canvas" option. Renders the same `bundledTemplate` FieldOptions the
 * wizard already loads (so selecting here drives `selections.bundledTemplate`).
 * Warns — never blocks — when the detected GPU has less VRAM than the selected
 * template recommends. Purely presentational: all decisions (gating, save) live
 * in the host wizard.
 */
const props = defineProps<{
  /** `bundledTemplate` options incl. the "None" sentinel (value === noneValue). */
  options: FieldOption[]
  noneValue: string
  selectedValue: string | null
  /** Whether to pre-download the selected template's models. */
  consent: boolean
  /** Detected GPU VRAM in bytes, or undefined when unknown (never warns then). */
  detectedVramBytes?: number
  /** Show the "Don't show this again" checkbox (only when ≥1 local install). */
  showDontShowAgain: boolean
  dontShowAgain: boolean
}>()

const emit = defineEmits<{
  select: [option: FieldOption]
  'update:consent': [value: boolean]
  'update:dontShowAgain': [value: boolean]
}>()

const { t } = useI18n()

/** Real template cards (everything but the "None" sentinel), in index order. */
const templateCards = computed(() => props.options.filter((o) => o.value !== props.noneValue))
const noneOption = computed(() => props.options.find((o) => o.value === props.noneValue) ?? null)

const selectedOption = computed(() =>
  props.options.find((o) => o.value === props.selectedValue) ?? null,
)
const selectedHasModels = computed(() => sizeBytesOf(selectedOption.value) > 0)

function sizeBytesOf(option: FieldOption | null): number {
  const size = option?.data?.sizeBytes
  return typeof size === 'number' ? size : 0
}
function vramOf(option: FieldOption | null): number {
  const vram = option?.data?.recommendedVramBytes
  return typeof vram === 'number' ? vram : 0
}
function modalityOf(option: FieldOption): string {
  const modality = option.data?.modality
  return typeof modality === 'string' ? t(`standalone.modality.${modality}`) : ''
}
function thumbnailOf(option: FieldOption): string | null {
  const url = option.data?.thumbnailUrl
  return typeof url === 'string' && url ? url : null
}
function sizeLabelOf(option: FieldOption): string {
  const bytes = sizeBytesOf(option)
  return bytes > 0 ? `~${formatBytes(bytes)}` : ''
}

/** Warn only when we have a real VRAM figure below the selected template's
 *  recommendation (mirrors main's `shouldWarnVram`). */
const vramWarning = computed<string | null>(() => {
  const recommended = vramOf(selectedOption.value)
  if (!recommended || props.detectedVramBytes === undefined) return null
  if (props.detectedVramBytes >= recommended) return null
  return t('standalone.templateVramWarning', {
    recommended: formatBytes(recommended),
    detected: formatBytes(props.detectedVramBytes),
  })
})
</script>

<template>
  <div class="tps">
    <h1 class="brand-title">{{ t('standalone.templatePickerTitle') }}</h1>
    <p class="brand-lead">{{ t('standalone.templatePickerLead') }}</p>

    <div class="tps__grid" role="radiogroup" :aria-label="t('standalone.templatePickerTitle')">
      <button
        v-for="opt in templateCards"
        :key="opt.value"
        type="button"
        role="radio"
        :aria-checked="selectedValue === opt.value"
        :class="['tps__card', { 'tps__card--selected': selectedValue === opt.value }]"
        @click="emit('select', opt)"
      >
        <span class="tps__thumb" aria-hidden="true">
          <img
            v-if="thumbnailOf(opt)"
            :src="thumbnailOf(opt)!"
            :alt="opt.label"
            loading="lazy"
            draggable="false"
          />
          <ImageOff v-else :size="20" class="tps__thumb-fallback" />
          <span v-if="modalityOf(opt)" class="tps__modality">{{ modalityOf(opt) }}</span>
          <Check v-if="selectedValue === opt.value" class="tps__check" :size="14" :stroke-width="2.5" />
        </span>
        <span class="tps__body">
          <span class="tps__name">{{ opt.label }}</span>
          <span v-if="opt.description" class="tps__desc">{{ opt.description }}</span>
          <span v-if="sizeLabelOf(opt)" class="tps__size">{{ sizeLabelOf(opt) }}</span>
        </span>
      </button>
    </div>

    <button
      v-if="noneOption"
      type="button"
      role="radio"
      :aria-checked="selectedValue === noneValue"
      :class="['tps__none', { 'tps__none--selected': selectedValue === noneValue }]"
      @click="emit('select', noneOption!)"
    >
      <span class="tps__none-text">
        <span class="tps__name">{{ noneOption.label }}</span>
        <span v-if="noneOption.description" class="tps__desc">{{ noneOption.description }}</span>
      </span>
      <Check v-if="selectedValue === noneValue" :size="16" :stroke-width="2" aria-hidden="true" />
    </button>

    <div v-if="vramWarning" class="tps__warning" role="status">
      <TriangleAlert :size="15" aria-hidden="true" />
      <span>{{ vramWarning }}</span>
    </div>

    <label v-if="selectedHasModels" class="tps__consent">
      <input
        type="checkbox"
        :checked="consent"
        @change="emit('update:consent', ($event.target as HTMLInputElement).checked)"
      />
      <span>{{ t('standalone.downloadTemplateModels', { size: sizeLabelOf(selectedOption!) }) }}</span>
    </label>

    <label v-if="showDontShowAgain" class="tps__dont-show">
      <input
        type="checkbox"
        :checked="dontShowAgain"
        @change="emit('update:dontShowAgain', ($event.target as HTMLInputElement).checked)"
      />
      <span>{{ t('standalone.templateDontShowAgain') }}</span>
    </label>
  </div>
</template>

<style scoped>
.tps {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  max-width: 720px;
  margin-inline: auto;
}
.tps__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
  width: 100%;
  margin-top: 8px;
}
.tps__card {
  display: flex;
  flex-direction: column;
  text-align: left;
  padding: 0;
  border: 1px solid var(--brand-surface-border);
  border-radius: 10px;
  background: var(--brand-surface-bg);
  color: var(--neutral-200);
  font: inherit;
  cursor: pointer;
  overflow: hidden;
  transition:
    border-color 120ms ease,
    background 120ms ease,
    box-shadow 120ms ease;
}
.tps__card:hover {
  background: var(--brand-surface-bg-hover);
  border-color: var(--brand-surface-border-hover);
}
.tps__card:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}
.tps__card--selected {
  border-color: var(--comfy-yellow);
  box-shadow: 0 0 0 1px var(--comfy-yellow) inset;
}
.tps__thumb {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 16 / 10;
  background: var(--chooser-surface-bg);
  overflow: hidden;
}
.tps__thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.tps__thumb-fallback {
  color: var(--neutral-500);
}
.tps__modality {
  position: absolute;
  top: 8px;
  left: 8px;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--neutral-100);
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
}
.tps__check {
  position: absolute;
  top: 8px;
  right: 8px;
  padding: 3px;
  border-radius: 999px;
  color: var(--neutral-950, #000);
  background: var(--comfy-yellow);
}
.tps__body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 12px 12px;
}
.tps__name {
  font-size: var(--takeover-fs-body);
  font-weight: 600;
  color: var(--neutral-100);
}
.tps__desc {
  font-size: var(--takeover-fs-caption);
  line-height: 1.35;
  color: var(--neutral-300);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.tps__size {
  font-size: var(--takeover-fs-caption);
  color: var(--neutral-400);
  font-variant-numeric: tabular-nums;
}
.tps__none {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  margin-top: 12px;
  padding: 12px 14px;
  border: 1px solid var(--brand-surface-border);
  border-radius: 8px;
  background: var(--brand-surface-bg);
  color: var(--neutral-200);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 120ms ease, background 120ms ease;
}
.tps__none:hover {
  background: var(--brand-surface-bg-hover);
  border-color: var(--brand-surface-border-hover);
}
.tps__none:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}
.tps__none--selected {
  border-color: var(--comfy-yellow);
  box-shadow: 0 0 0 1px var(--comfy-yellow) inset;
}
.tps__none-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.tps__warning {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  font-size: var(--takeover-fs-caption);
  line-height: 1.4;
  color: var(--warning, #e0a458);
  background: color-mix(in srgb, var(--warning, #e0a458) 12%, transparent);
}
.tps__warning svg {
  flex: 0 0 auto;
  margin-top: 1px;
}
.tps__consent,
.tps__dont-show {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  margin-top: 12px;
  font-size: var(--takeover-fs-caption);
  color: var(--neutral-300);
  cursor: pointer;
}
.tps__consent input,
.tps__dont-show input {
  flex: 0 0 auto;
  accent-color: var(--comfy-yellow);
}
</style>
