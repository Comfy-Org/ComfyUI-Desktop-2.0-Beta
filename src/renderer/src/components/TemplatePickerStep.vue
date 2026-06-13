<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Check,
  CircleAlert,
  TriangleAlert,
  Image as ImageIcon,
  Video,
  AudioLines,
  Box
} from 'lucide-vue-next'
import type { DiskSpaceInfo, FieldOption } from '../types/ipc'
import { formatBytesCoarse } from '../lib/formatting'
import { templateDiskRequiredBytes, isTemplateDiskBlocked } from '../lib/installHelpers'

/**
 * Starter-template picker — compact rows; description expands inside the
 * selected row. Alerts below; footer actions live in the host wizard.
 */
const props = defineProps<{
  options: FieldOption[]
  noneValue: string
  selectedValue: string | null
  detectedVramBytes?: number
  diskSpace: DiskSpaceInfo | null
  diskSpaceLoading: boolean
}>()

const emit = defineEmits<{
  select: [option: FieldOption]
}>()

const { t } = useI18n()

const listRef = ref<HTMLElement | null>(null)
const alertsRef = ref<HTMLElement | null>(null)

const templateCards = computed(() => props.options.filter((o) => o.value !== props.noneValue))

const selectedOption = computed(
  () => props.options.find((o) => o.value === props.selectedValue) ?? null,
)
const recommendedValue = computed(() => templateCards.value[0]?.value ?? null)

const thumbFailed = reactive<Record<string, boolean>>({})

const MODALITY_GLYPH: Record<string, Component> = {
  image: ImageIcon,
  video: Video,
  audio: AudioLines,
  '3d': Box
}

function sizeBytesOf(option: FieldOption | null): number {
  const size = option?.data?.sizeBytes
  return typeof size === 'number' ? size : 0
}
function vramOf(option: FieldOption | null): number {
  const vram = option?.data?.recommendedVramBytes
  return typeof vram === 'number' ? vram : 0
}
function modalityKey(option: FieldOption): string {
  const modality = option.data?.modality
  return typeof modality === 'string' ? modality : ''
}
function modalityLabel(option: FieldOption): string {
  const key = modalityKey(option)
  return key ? t(`standalone.modality.${key}`) : ''
}
function modalityGlyph(option: FieldOption): Component | null {
  return MODALITY_GLYPH[modalityKey(option)] ?? null
}
function thumbnailOf(option: FieldOption): string | null {
  const url = option.data?.thumbnailUrl
  return typeof url === 'string' && url ? url : null
}
function sizeLabelOf(option: FieldOption): string {
  const bytes = sizeBytesOf(option)
  return bytes > 0 ? `~${formatBytesCoarse(bytes)}` : ''
}
function metaLabelOf(option: FieldOption): string {
  const parts: string[] = [modalityLabel(option), sizeLabelOf(option)].filter(Boolean)
  const vram = vramOf(option)
  if (vram > 0) {
    parts.push(t('standalone.templatePickerSpecVram', { size: formatBytesCoarse(vram) }))
  }
  return parts.join(' · ')
}

const vramWarning = computed<string | null>(() => {
  const recommended = vramOf(selectedOption.value)
  if (!recommended || props.detectedVramBytes === undefined) return null
  if (props.detectedVramBytes >= recommended) return null
  return t('standalone.templateVramWarning', {
    recommended: formatBytesCoarse(recommended),
    detected: formatBytesCoarse(props.detectedVramBytes)
  })
})

const diskBlocked = computed(() =>
  !props.diskSpaceLoading &&
  isTemplateDiskBlocked(props.diskSpace, sizeBytesOf(selectedOption.value)),
)

const diskErrorMessage = computed<string | null>(() => {
  if (!diskBlocked.value || !props.diskSpace) return null
  const required = templateDiskRequiredBytes(sizeBytesOf(selectedOption.value))
  return t('diskSpace.templateBlockMessage', {
    required: formatBytesCoarse(required),
    free: formatBytesCoarse(props.diskSpace.free)
  })
})

const hasAlerts = computed(() => !!(diskErrorMessage.value || vramWarning.value))

function focusRow(index: number): void {
  nextTick(() => {
    listRef.value?.querySelectorAll<HTMLButtonElement>('button[role="radio"]')[index]?.focus()
  })
}

function onRowKeydown(e: KeyboardEvent, index: number): void {
  const last = templateCards.value.length - 1
  let nextIndex: number
  if (e.key === 'ArrowDown') nextIndex = Math.min(index + 1, last)
  else if (e.key === 'ArrowUp') nextIndex = Math.max(index - 1, 0)
  else if (e.key === 'Home') nextIndex = 0
  else if (e.key === 'End') nextIndex = last
  else return

  e.preventDefault()
  if (nextIndex === index) return
  const next = templateCards.value[nextIndex]
  if (!next) return
  emit('select', next)
  focusRow(nextIndex)
}

watch(diskBlocked, (blocked) => {
  if (!blocked) return
  nextTick(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    alertsRef.value?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'nearest' })
  })
})

/** Shake the disk-error alert so a blocked Install click is impossible to miss
 *  (mirrors the consent-row nudge on the first-use screen). No-op when not
 *  blocked. Exposed so the host wizard — which owns the Install button — can
 *  trigger it. Auto-resets so it can replay on the next click. */
const diskErrorNudge = ref(false)
let diskNudgeTimer: ReturnType<typeof setTimeout> | undefined
function nudgeDiskError(): void {
  if (!diskBlocked.value) return
  diskErrorNudge.value = true
  clearTimeout(diskNudgeTimer)
  diskNudgeTimer = setTimeout(() => {
    diskErrorNudge.value = false
  }, 600)
}
defineExpose({ nudgeDiskError })
</script>

<template>
  <div class="tps">
    <div
      ref="listRef"
      class="brand-variant-list"
      role="radiogroup"
      :aria-label="t('standalone.templatePickerTitle')"
    >
      <button
        v-for="(opt, index) in templateCards"
        :key="opt.value"
        type="button"
        role="radio"
        :aria-checked="selectedValue === opt.value"
        :class="[
          'brand-variant-row',
          { 'brand-variant-row--selected': selectedValue === opt.value },
        ]"
        @click="emit('select', opt)"
        @keydown="onRowKeydown($event, index)"
      >
        <span class="brand-variant-row__icon" aria-hidden="true">
          <img
            v-if="thumbnailOf(opt) && !thumbFailed[opt.value]"
            :src="thumbnailOf(opt)!"
            :alt="opt.label"
            draggable="false"
            @error="thumbFailed[opt.value] = true"
          />
          <component :is="modalityGlyph(opt)" v-else-if="modalityGlyph(opt)" :size="20" />
        </span>
        <span class="brand-variant-row__body">
          <span class="brand-variant-row__head">
            <span class="brand-variant-row__text">
              <span class="brand-variant-row__label">
                {{ opt.label }}
                <span v-if="opt.value === recommendedValue" class="tps__recommended">
                  {{ t('newInstall.recommended') }}
                </span>
              </span>
              <span v-if="metaLabelOf(opt)" class="brand-variant-row__meta">
                {{ metaLabelOf(opt) }}
              </span>
            </span>
            <Check
              v-if="selectedValue === opt.value"
              class="brand-variant-row__check"
              :size="16"
              :stroke-width="2"
              aria-hidden="true"
            />
          </span>
          <span
            v-if="opt.description"
            class="tps__row-detail"
            :class="{ 'tps__row-detail--open': selectedValue === opt.value }"
          >
            <span class="tps__row-detail-inner">{{ opt.description }}</span>
          </span>
        </span>
      </button>
    </div>

    <div
      v-if="hasAlerts"
      id="tps-alerts"
      ref="alertsRef"
      class="tps__alerts"
    >
      <div
        v-if="diskErrorMessage"
        class="tps__alert tps__alert--error"
        :class="{ 'tps__alert--nudge': diskErrorNudge }"
        role="alert"
      >
        <CircleAlert :size="15" aria-hidden="true" />
        <span>{{ diskErrorMessage }}</span>
      </div>
      <div v-if="vramWarning" class="tps__alert tps__alert--warn" role="status">
        <TriangleAlert :size="15" aria-hidden="true" />
        <span>{{ vramWarning }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tps {
  width: 100%;
  text-align: left;
}

.brand-variant-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.brand-variant-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  width: 100%;
  padding: 10px 12px;
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
  margin-top: 1px;
  border-radius: 6px;
  background: var(--chooser-surface-bg);
  overflow: hidden;
  color: var(--neutral-500);
}
.brand-variant-row__icon img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.brand-variant-row__body {
  display: flex;
  flex-direction: column;
  gap: 0;
  min-width: 0;
  flex: 1 1 auto;
}
.brand-variant-row__head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
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
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
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

.tps__recommended {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--neutral-100);
  background: color-mix(in oklab, var(--neutral-100) 14%, transparent);
  border: 1px solid color-mix(in oklab, var(--neutral-100) 22%, transparent);
  box-shadow:
    0 1px 0 color-mix(in oklab, var(--neutral-100) 12%, transparent) inset,
    0 1px 8px color-mix(in oklab, var(--neutral-900) 25%, transparent);
  backdrop-filter: blur(8px);
}

.tps__row-detail {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 220ms ease;
}
.tps__row-detail--open {
  grid-template-rows: 1fr;
}
.tps__row-detail-inner {
  overflow: hidden;
  padding-top: 0;
  font-size: var(--takeover-fs-caption);
  line-height: 1.45;
  color: var(--neutral-300);
  transition:
    padding-top 220ms ease,
    color 220ms ease;
}
.tps__row-detail--open .tps__row-detail-inner {
  padding-top: 6px;
  color: var(--neutral-200);
}

.tps__alerts {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--brand-surface-border);
}
.tps__alert {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: var(--takeover-fs-caption);
  line-height: 1.4;
  text-align: left;
}
.tps__alert svg {
  flex: 0 0 auto;
  margin-top: 1px;
}
.tps__alert--error {
  color: var(--danger);
}
.tps__alert--warn {
  color: var(--warning);
}

/* Shake when a blocked Install is clicked (mirrors the consent-row nudge). */
.tps__alert--nudge {
  animation: tps-alert-shake 400ms cubic-bezier(0.36, 0.07, 0.19, 0.97) both;
}
@keyframes tps-alert-shake {
  10%,
  90% {
    transform: translateX(-1px);
  }
  20%,
  80% {
    transform: translateX(2px);
  }
  30%,
  50%,
  70% {
    transform: translateX(-3px);
  }
  40%,
  60% {
    transform: translateX(3px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .brand-variant-row,
  .tps__row-detail,
  .tps__row-detail-inner {
    transition: none;
  }
  .tps__row-detail:not(.tps__row-detail--open) {
    display: none;
  }
  .tps__alert--nudge {
    animation: none;
  }
}
</style>
