<script setup lang="ts">
import { ref, computed, watch, toRaw, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown } from 'lucide-vue-next'
import { useModal } from '../composables/useModal'

import type { SnapshotFilePreview, FieldOption, GPUInfo, ShowProgressOpts } from '../types/ipc'
import { getVariantGpuLabel, sortedCardOptions, findBestVariant } from '../lib/variants'
import VariantCardGrid from '../components/VariantCardGrid.vue'
import { emitTelemetryAction, toVariantBucket } from '../lib/telemetry'
import SnapshotFilePreviewContent from '../components/SnapshotFilePreviewContent.vue'
import TakeoverBack from '../components/TakeoverBack.vue'
import BrandTakeoverLayout from '../components/BrandTakeoverLayout.vue'

const emit = defineEmits<{
  close: []
  'show-progress': [opts: ShowProgressOpts]
}>()

const { t } = useI18n()
const modal = useModal()

const preview = ref<SnapshotFilePreview | null>(null)
const installName = ref('')
const loading = ref(false)
const creating = ref(false)
const dragging = ref(false)

// Release & variant selection
const releaseOptions = ref<FieldOption[]>([])
const selectedRelease = ref<FieldOption | null>(null)
const releaseLoading = ref(false)
const variantOptions = ref<FieldOption[]>([])
const selectedVariant = ref<FieldOption | null>(null)
const variantLoading = ref(false)
const detectedGpu = ref<GPUInfo | null>(null)
let optionsGeneration = 0

const sortedVariants = computed(() => sortedCardOptions(variantOptions.value))

const snapshotGpuLabel = computed(() => {
  if (!preview.value) return null
  return getVariantGpuLabel(preview.value.newestSnapshot.comfyui.variant || '')
})

const detectedGpuLabel = computed(() => detectedGpu.value?.label || null)

const hardwareMismatch = computed(() => {
  if (!snapshotGpuLabel.value || !detectedGpuLabel.value) return false
  return snapshotGpuLabel.value !== detectedGpuLabel.value
})

const INVALID_NAME_CHARS = /[<>:"/\\|?*]/
const nameHasInvalidChars = computed(() => INVALID_NAME_CHARS.test(installName.value))

const releaseTriggerLabel = computed(() => {
  if (releaseLoading.value) return t('newInstall.loading')
  if (releaseOptions.value.length === 0) return t('newInstall.noOptions')
  const opt = selectedRelease.value
  if (!opt) return ''
  return opt.recommended ? `${opt.label} (${t('newInstall.recommended')})` : opt.label
})


function open(): void {
  preview.value = null
  installName.value = ''
  loading.value = false
  creating.value = false
  dragging.value = false
  releaseOptions.value = []
  selectedRelease.value = null
  variantOptions.value = []
  selectedVariant.value = null
  releaseLoading.value = false
  variantLoading.value = false
  optionsGeneration++
}

async function loadReleaseOptions(): Promise<void> {
  const gen = ++optionsGeneration
  releaseLoading.value = true
  releaseOptions.value = []
  selectedRelease.value = null
  variantOptions.value = []
  selectedVariant.value = null
  try {
    const gpu = await window.api.detectGPU()
    if (gen !== optionsGeneration) return
    detectedGpu.value = gpu

    const options = await window.api.getFieldOptions('standalone', 'release', {})
    if (gen !== optionsGeneration) return
    releaseOptions.value = options

    // Preselect the release matching the snapshot's releaseTag, or fall back to latest
    const snapshotTag = preview.value?.newestSnapshot.comfyui.releaseTag
    const match = snapshotTag ? options.find((o) => o.value === snapshotTag) : null
    selectedRelease.value = match || options[0] || null
  } finally {
    if (gen === optionsGeneration) releaseLoading.value = false
  }
}

async function loadVariantOptions(): Promise<void> {
  if (!selectedRelease.value) {
    variantOptions.value = []
    selectedVariant.value = null
    return
  }
  const gen = ++optionsGeneration
  variantLoading.value = true
  variantOptions.value = []
  selectedVariant.value = null
  try {
    const rawRelease = JSON.parse(JSON.stringify(toRaw(selectedRelease.value))) as FieldOption
    const options = await window.api.getFieldOptions('standalone', 'variant', { release: rawRelease })
    if (gen !== optionsGeneration) return
    variantOptions.value = options

    // Default to the variant matching the snapshot's device, then recommended (detected GPU), then first
    const snapshotVariantId = preview.value?.newestSnapshot.comfyui.variant || ''
    selectedVariant.value = findBestVariant(options, snapshotVariantId)
  } finally {
    if (gen === optionsGeneration) variantLoading.value = false
  }
}

watch(selectedRelease, () => {
  loadVariantOptions()
})

async function loadFromPath(filePath: string): Promise<void> {
  loading.value = true
  try {
    const result = await window.api.previewSnapshotPath(filePath)
    if (!result.ok) {
      if (result.message) {
        await modal.alert({ title: t('list.loadSnapshot'), message: result.message })
      }
      return
    }
    if (result.preview) {
      preview.value = result.preview
      installName.value = result.preview.installationName || ''
      await loadReleaseOptions()
    }
  } finally {
    loading.value = false
  }
}

async function handleBrowse(): Promise<void> {
  const result = await window.api.previewSnapshotFile()
  if (!result.ok) {
    if (result.message) {
      await modal.alert({ title: t('list.loadSnapshot'), message: result.message })
    }
    return
  }
  if (result.preview) {
    preview.value = result.preview
    installName.value = result.preview.installationName || ''
    await loadReleaseOptions()
  }
}

const contentRef = ref<HTMLElement | null>(null)

function handleDragOver(event: DragEvent): void {
  event.preventDefault()
  dragging.value = true
}

function handleDragLeave(event: DragEvent): void {
  if (contentRef.value && !contentRef.value.contains(event.relatedTarget as Node)) {
    dragging.value = false
  }
}

async function handleDrop(event: DragEvent): Promise<void> {
  event.preventDefault()
  dragging.value = false
  const file = event.dataTransfer?.files[0]
  if (!file) return
  if (!file.name.endsWith('.json')) {
    await modal.alert({ title: t('list.loadSnapshot'), message: t('snapshots.importInvalidFile') })
    return
  }
  const filePath = window.api.getPathForFile(file)
  if (!filePath) return
  await loadFromPath(filePath)
}

function handleClearPreview(): void {
  preview.value = null
  releaseOptions.value = []
  selectedRelease.value = null
  variantOptions.value = []
  selectedVariant.value = null
  optionsGeneration++
}

function selectVariant(option: FieldOption): void {
  selectedVariant.value = option
  emitTelemetryAction('desktop2.install.variant.selected', {
    variant_bucket: toVariantBucket((option.data?.variantId as string | undefined) || option.value),
    recommended: !!option.recommended,
    flow: 'snapshot',
  })
}

async function handleCreate(): Promise<void> {
  if (!preview.value || creating.value) return
  creating.value = true
  const filePath = preview.value.filePath
  const releaseTag = selectedRelease.value?.value
  const variantId = (selectedVariant.value?.data?.variantId as string) || selectedVariant.value?.value || undefined

  try {
    const result = await window.api.createFromSnapshot(filePath, installName.value || undefined, releaseTag, variantId)
    if (!result.ok) {
      if (result.message) {
        await modal.alert({ title: t('list.loadSnapshot'), message: result.message })
      }
      return
    }
    if (result.entry) {
      creating.value = false
      emit('close')
      emit('show-progress', {
        installationId: result.entry.id,
        title: `${t('newInstall.installing')} — ${result.entry.name}`,
        apiCall: () => window.api.installInstance(result.entry!.id),
        cancellable: true,
      })
      return
    }
  } finally {
    creating.value = false
  }
}

// Prevent Electron from navigating to dropped files
function preventNav(event: Event): void {
  event.preventDefault()
}

onMounted(() => {
  document.addEventListener('dragover', preventNav)
  document.addEventListener('drop', preventNav)
})
onUnmounted(() => {
  document.removeEventListener('dragover', preventNav)
  document.removeEventListener('drop', preventNav)
})

defineExpose({ open })
</script>

<template>
  <BrandTakeoverLayout>
    <template #back>
      <TakeoverBack
        :label="$t('common.backToDashboard')"
        @back="emit('close')"
      />
    </template>
    <div class="config-shell">
      <h1 class="brand-title">{{ $t('loadSnapshot.grandTitle') }}</h1>
      <p class="brand-lead">{{ $t('loadSnapshot.grandSubtitle') }}</p>
      <div class="config-card">
        <div
          ref="contentRef"
          class="config-card__body ls-drop-target"
          @dragover="!preview && handleDragOver($event)"
          @dragleave="!preview && handleDragLeave($event)"
          @drop="!preview && handleDrop($event)"
        >
          <!-- Drop zone / file picker (shown when no preview loaded) -->
          <div v-if="!preview" class="ls-drop-zone-wrap">
            <div
              class="ls-drop-zone"
              :class="{ 'ls-drop-zone-active': dragging, 'ls-drop-zone-loading': loading }"
            >
              <div v-if="loading" class="ls-drop-loading with-spinner">{{ $t('newInstall.loading') }}</div>
              <template v-else>
                <div class="ls-drop-text">{{ $t('list.snapshotDropHint') }}</div>
                <div class="ls-drop-or">{{ $t('common.or') }}</div>
                <button class="brand-secondary" type="button" @click="handleBrowse">
                  {{ $t('common.browse') }}
                </button>
              </template>
            </div>
          </div>

          <!-- Preview content -->
          <template v-if="preview">
            <!-- Install name -->
            <div class="config-field">
              <label class="config-label" for="ls-name">{{ $t('common.name') }}</label>
              <div class="brand-input">
                <input
                  id="ls-name"
                  v-model="installName"
                  type="text"
                  :placeholder="$t('common.namePlaceholder')"
                />
              </div>
              <span v-if="nameHasInvalidChars" class="ls-name-hint">
                {{ $t('list.snapshotNameHint') }}
              </span>
            </div>

            <!-- Release selection -->
            <div class="config-field">
              <label class="config-label" for="ls-release">{{ $t('list.snapshotRelease') }}</label>
              <div
                v-if="releaseLoading || releaseOptions.length === 0"
                class="brand-input config-select brand-input--readonly"
                :class="{ 'with-spinner': releaseLoading }"
                role="textbox"
                aria-readonly="true"
              >
                <span class="config-select__value">{{ releaseTriggerLabel }}</span>
              </div>
              <div v-else class="brand-input brand-select">
                <span class="brand-select__trigger" aria-hidden="true">
                  <span class="brand-select__trigger-value">{{ releaseTriggerLabel }}</span>
                  <ChevronDown :size="14" class="brand-select__trigger-chevron" />
                </span>
                <select
                  id="ls-release"
                  :value="releaseOptions.indexOf(selectedRelease!)"
                  @change="selectedRelease = releaseOptions[Number(($event.target as HTMLSelectElement).value)] ?? null"
                >
                  <option
                    v-for="(opt, i) in releaseOptions"
                    :key="opt.value"
                    :value="i"
                  >
                    {{ opt.label }}{{ opt.recommended ? ` (${$t('newInstall.recommended')})` : '' }}
                  </option>
                </select>
              </div>
              <span v-if="preview.newestSnapshot.comfyui.releaseTag" class="ls-release-hint">
                {{ $t('list.snapshotOriginalRelease', { tag: preview.newestSnapshot.comfyui.releaseTag }) }}
              </span>
            </div>

            <!-- Device / variant selection -->
            <div class="config-field">
              <label class="config-label">{{ $t('list.snapshotDevice') }}</label>
              <div v-if="variantLoading" class="ls-loading with-spinner">
                {{ $t('newInstall.loading') }}
              </div>
              <VariantCardGrid
                v-else-if="variantOptions.length > 0"
                :options="sortedVariants"
                :selected-value="selectedVariant?.value"
                @select="selectVariant"
              />
              <span v-else class="ls-loading">{{ $t('newInstall.noOptions') }}</span>

              <div v-if="hardwareMismatch" class="ls-hw-warning">
                {{ $t('list.snapshotHardwareMismatch', { snapshotDevice: snapshotGpuLabel, detectedDevice: detectedGpuLabel }) }}
              </div>
            </div>

            <SnapshotFilePreviewContent :preview="preview" />
          </template>
        </div>

        <div class="config-card__footer">
          <button
            v-if="preview"
            class="brand-secondary"
            type="button"
            @click="handleClearPreview"
          >
            {{ $t('common.back') }}
          </button>
          <button
            class="primary config-continue"
            :class="{ loading: creating }"
            :disabled="!preview || creating || !selectedVariant"
            @click="handleCreate"
          >
            {{ creating ? $t('newInstall.loading') : $t('list.snapshotCreateInstall') }}
          </button>
        </div>
      </div>
    </div>
  </BrandTakeoverLayout>
</template>

<style scoped>
.ls-drop-target {
  /* Stretch the body so the drop zone can grow into it. */
  display: flex;
  flex-direction: column;
}

/* Drop zone */
.ls-drop-zone-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1 1 auto;
  min-height: 220px;
}

.ls-drop-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  width: 100%;
  height: 100%;
  border: 2px dashed var(--brand-surface-border);
  border-radius: 8px;
  padding: 32px;
  transition: border-color 0.15s, background 0.15s;
  background: var(--brand-surface-bg);
}
.ls-drop-zone-active {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, var(--brand-surface-bg));
}
.ls-drop-zone-loading {
  opacity: 0.6;
  pointer-events: none;
}

.ls-drop-loading,
.ls-loading {
  flex-direction: column;
  justify-content: center;
  font-size: 14px;
  color: var(--neutral-300);
}

.ls-drop-text {
  font-size: 14px;
  color: var(--neutral-200);
  text-align: center;
}
.ls-drop-or {
  font-size: 13px;
  color: var(--neutral-300);
}

.ls-name-hint {
  font-size: 11px;
  color: var(--warning);
}

.ls-release-hint {
  font-size: 12px;
  color: var(--neutral-300);
}

/* Hardware mismatch warning */
.ls-hw-warning {
  font-size: 13px;
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--warning) 30%, transparent);
  border-radius: 6px;
  padding: 8px 12px;
  margin-top: 8px;
}
</style>
