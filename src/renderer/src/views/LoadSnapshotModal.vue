<script setup lang="ts">
import { ref, computed, watch, toRaw, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useModal } from '../composables/useModal'
import { useModalOverlay } from '../composables/useModalOverlay'
import type { SnapshotFilePreview, FieldOption, GPUInfo } from '../types/ipc'
import { getVariantGpuLabel, sortedCardOptions, findBestVariant } from '../lib/variants'
import VariantCardGrid from '../components/VariantCardGrid.vue'
import { emitTelemetryAction, toVariantBucket } from '../lib/telemetry'
import SnapshotFilePreviewContent from '../components/SnapshotFilePreviewContent.vue'

const emit = defineEmits<{
  close: []
  'show-progress': [
    opts: {
      installationId: string
      title: string
      apiCall: () => Promise<unknown>
      cancellable?: boolean
    }
  ]
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

const { handleOverlayMouseDown, handleOverlayClick } = useModalOverlay(
  () => true,
  () => emit('close'),
)

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
  emitTelemetryAction('launcher.install.variant.selected', {
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
  <div
    class="view-modal active"
    @mousedown="handleOverlayMouseDown"
    @click="handleOverlayClick"
  >
    <div
      ref="contentRef"
      class="view-modal-content"
      @dragover="!preview && handleDragOver($event)"
      @dragleave="!preview && handleDragLeave($event)"
      @drop="!preview && handleDrop($event)"
    >
      <div class="view-modal-header">
        <div class="view-modal-title">{{ $t('list.loadSnapshot') }}</div>
        <button class="view-modal-close" @click="emit('close')">✕</button>
      </div>
      <div class="view-modal-body">
        <div class="view-scroll">
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
                <button class="ls-browse-btn" @click="handleBrowse">{{ $t('common.browse') }}</button>
              </template>
            </div>
          </div>

          <!-- Preview content -->
          <template v-if="preview">
            <!-- Install name -->
            <div class="ls-section">
              <div class="ls-field">
                <span class="ls-label">{{ $t('common.name') }}</span>
                <input
                  v-model="installName"
                  class="ls-name-input"
                  type="text"
                  :placeholder="$t('common.namePlaceholder')"
                >
                <span v-if="nameHasInvalidChars" class="ls-name-hint">{{ $t('list.snapshotNameHint') }}</span>
              </div>
            </div>

            <!-- Release selection -->
            <div class="ls-section">
              <div class="ls-field">
                <span class="ls-label">{{ $t('list.snapshotRelease') }}</span>
                <select
                  v-if="!releaseLoading && releaseOptions.length > 0"
                  class="ls-select"
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
                <span v-else-if="releaseLoading" class="ls-value ls-value-loading with-spinner">{{ $t('newInstall.loading') }}</span>
                <span v-else class="ls-value">{{ $t('newInstall.noOptions') }}</span>
                <span v-if="preview.newestSnapshot.comfyui.releaseTag" class="ls-release-hint">
                  {{ $t('list.snapshotOriginalRelease', { tag: preview.newestSnapshot.comfyui.releaseTag }) }}
                </span>
              </div>
            </div>

            <!-- Device / variant selection -->
            <div class="ls-section">
              <div class="ls-field">
                <span class="ls-label">{{ $t('list.snapshotDevice') }}</span>
                <div v-if="variantLoading" class="ls-value ls-value-loading with-spinner">{{ $t('newInstall.loading') }}</div>
                <VariantCardGrid
                  v-else-if="variantOptions.length > 0"
                  :options="sortedVariants"
                  :selected-value="selectedVariant?.value"
                  @select="selectVariant"
                />
                <span v-else class="ls-value">{{ $t('newInstall.noOptions') }}</span>
              </div>

              <!-- Hardware mismatch warning -->
              <div v-if="hardwareMismatch" class="ls-hw-warning">
                {{ $t('list.snapshotHardwareMismatch', { snapshotDevice: snapshotGpuLabel, detectedDevice: detectedGpuLabel }) }}
              </div>
            </div>

            <SnapshotFilePreviewContent :preview="preview" />
          </template>
        </div>

        <!-- Bottom actions -->
        <div class="view-bottom">
          <button v-if="preview" @click="handleClearPreview">{{ $t('common.back') }}</button>
          <button
            class="primary"
            :disabled="!preview || creating || !selectedVariant"
            @click="handleCreate"
          >
            {{ creating ? $t('newInstall.loading') : $t('list.snapshotCreateInstall') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Ensure view-scroll stretches the drop zone when no preview is loaded */
.view-scroll:has(.ls-drop-zone-wrap) {
  display: flex;
  flex-direction: column;
}

/* Drop zone */
.ls-drop-zone-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
}

.ls-drop-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: 100%;
  height: 100%;
  border: 2px dashed var(--border);
  border-radius: 8px;
  padding: 32px;
  transition: border-color 0.15s, background 0.15s;
}
.ls-drop-zone-active {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}
.ls-drop-zone-loading {
  opacity: 0.6;
  pointer-events: none;
}

.ls-drop-loading {
  flex-direction: column;
  justify-content: center;
  font-size: 14px;
  color: var(--text-muted);
}

.ls-drop-text {
  font-size: 14px;
  color: var(--text-muted);
  text-align: center;
}
.ls-drop-or {
  font-size: 13px;
  color: var(--text-muted);
}
.ls-browse-btn {
  padding: 6px 20px;
  font-size: 14px;
  border-radius: 6px;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  cursor: pointer;
}
.ls-browse-btn:hover {
  border-color: var(--border-hover);
}

.ls-name-input {
  font-size: 14px;
  padding: 6px 10px;
  border-radius: 5px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text);
  box-sizing: border-box;
  width: 100%;
}
.ls-name-input:focus {
  outline: none;
  border-color: var(--accent);
}

.ls-name-hint {
  font-size: 11px;
  color: var(--warning);
  margin-top: 2px;
}

.ls-release-hint {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 2px;
}

/* Release select */
.ls-select {
  font-size: 14px;
  padding: 6px 10px;
  border-radius: 5px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text);
  box-sizing: border-box;
  width: 100%;
}
.ls-select:focus {
  outline: none;
  border-color: var(--accent);
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
