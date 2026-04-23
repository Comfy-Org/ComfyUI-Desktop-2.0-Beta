<script setup lang="ts">
import { ref, computed, watch, onMounted, toRaw } from 'vue'
import { useI18n } from 'vue-i18n'
import { useModal } from '../composables/useModal'
import { useModalOverlay } from '../composables/useModalOverlay'
import type { Source, SourceField, FieldOption, HardwareValidation } from '../types/ipc'
import { stripVariantPrefix, sortedCardOptions } from '../lib/variants'
import VariantCardGrid from '../components/VariantCardGrid.vue'
import { emitTelemetryAction, toVariantBucket } from '../lib/telemetry'
import { trackGuardrailBlocked, createDiskSpaceChecker, showPathIssueAlerts, checkNvidiaDriverOrWarn, checkDiskSpaceOrWarn } from '../lib/installHelpers'
import PathDiskInfo from '../components/PathDiskInfo.vue'

const emit = defineEmits<{
  close: []
  'show-progress': [
    opts: {
      installationId: string
      title: string
      apiCall: () => Promise<unknown>
      cancellable?: boolean
      returnTo?: string
    }
  ]
  'navigate-list': []
}>()

const { t } = useI18n()
const modal = useModal()

const sources = ref<Source[]>([])
const currentSource = ref<Source | null>(null)
const selections = ref<Record<string, FieldOption>>({})
const instName = ref('')
const instPath = ref('')
const defaultInstPath = ref('')
const detectedGpu = ref('')
const saveDisabled = ref(true)
const sourcesLoading = ref(false)
const initializing = ref(false)
const sourceError = ref('')
const currentStep = ref(1)

// Per-field state
const fieldOptions = ref(new Map<string, FieldOption[]>())
const fieldLoading = ref(new Map<string, boolean>())
const fieldErrors = ref(new Map<string, string>())
const textFieldValues = ref(new Map<string, string>())

// Disk space and path validation
const { diskSpace, diskSpaceLoading, pathIssues, fetchDiskSpace, reset: resetDiskSpace } = createDiskSpaceChecker()
let hardwareValidation: HardwareValidation | null = null

const estimatedInstallSize = computed(() => {
  let downloadBytes = 0
  for (const selected of Object.values(selections.value)) {
    const files = selected?.data?.downloadFiles as Array<{ size: number }> | undefined
    if (files) {
      downloadBytes += files.reduce((sum, f) => sum + f.size, 0)
    }
  }
  return downloadBytes > 0 ? Math.ceil(downloadBytes * 2.25) : 0
})

watch(instPath, (newPath) => {
  diskSpace.value = null
  pathIssues.value = []
  if (currentStep.value >= 3 || currentSource.value?.skipInstall) {
    fetchDiskSpace(newPath)
  }
})



/** Generation counter — incremented on each open/source change to discard stale responses */
let loadGeneration = 0

const totalSteps = computed(() => {
  if (!currentSource.value) return 3
  return currentSource.value.skipInstall ? 2 : 3
})

const heroSources = computed(() => sources.value.filter((s) => s.id === 'standalone'))
const otherSources = computed(() => sources.value.filter((s) => s.id !== 'standalone'))

const stepTitle = computed(() => {
  if (currentStep.value === 1) return t('newInstall.chooseMethod')
  if (currentStep.value === 2) {
    return currentSource.value?.skipInstall
      ? t('newInstall.nameLocation')
      : t('newInstall.configuration')
  }
  return t('newInstall.nameLocation')
})

const canProceed = computed(() => {
  if (currentStep.value === 1) return currentSource.value !== null
  if (currentStep.value === 2) {
    if (currentSource.value?.skipInstall) return true
    return !saveDisabled.value
  }
  if (currentStep.value === 3) return pathIssues.value.length === 0
  return true
})

/** Deep-strip Vue reactive proxies for safe IPC serialization */
function rawSelections(): Record<string, FieldOption> {
  const raw = toRaw(selections.value)
  const result: Record<string, FieldOption> = {}
  for (const [key, val] of Object.entries(raw)) {
    result[key] = JSON.parse(JSON.stringify(toRaw(val))) as FieldOption
  }
  return result
}

let installDirPromise: Promise<string> | null = null
let sourcesPromise: Promise<Source[]> | null = null

onMounted(() => {
  window.api
    .detectGPU()
    .then((gpu) => {
      if (gpu) {
        detectedGpu.value = t('newInstall.detectedGpu', { label: gpu.label })
      } else {
        detectedGpu.value = t('newInstall.noGpuDetected')
      }
    })
    .catch(() => {
      detectedGpu.value = t('newInstall.noGpuDetected')
    })

  installDirPromise = window.api.getDefaultInstallDir().catch(() => '')
  sourcesPromise = window.api.getSources()
})

async function open(): Promise<void> {
  loadGeneration++
  currentStep.value = 1
  instName.value = ''
  instPath.value = ''
  selections.value = {}
  currentSource.value = null
  saveDisabled.value = true
  fieldOptions.value.clear()
  fieldLoading.value.clear()
  fieldErrors.value.clear()
  textFieldValues.value.clear()

  detectedGpu.value = t('newInstall.detectingGpu')
  resetDiskSpace()
  sourceError.value = ''
  initializing.value = true

  try {
    const [, installDir] = await Promise.all([loadSources(), installDirPromise])

    defaultInstPath.value = installDir ?? ''
    instPath.value = defaultInstPath.value

    // Auto-select standalone and skip to device selection (step 2)
    hardwareValidation = await window.api.validateHardware()
    const standalone = sources.value.find((s) => s.id === 'standalone')
    if (standalone && hardwareValidation.supported) {
      currentStep.value = 2
      await selectSourceCard(standalone)
    } else if (standalone) {
      detectedGpu.value = hardwareValidation.error || t('newInstall.noGpuDetected')
    }
  } finally {
    initializing.value = false
  }
}

async function loadSources(): Promise<void> {
  if (sources.value.length > 0) return
  sourcesLoading.value = true
  try {
    sources.value = sourcesPromise ? await sourcesPromise : await window.api.getSources()
  } finally {
    sourcesLoading.value = false
  }
}

async function selectSourceCard(source: Source): Promise<void> {
  if (currentSource.value?.id === source.id) return

  if (source.id === 'standalone' && hardwareValidation && !hardwareValidation.supported) {
    trackGuardrailBlocked('unsupported_hw', 'wizard', 'source_select')
    await modal.alert({
      title: t('newInstall.unsupportedHardwareTitle'),
      message: hardwareValidation.error || '',
    })
    return
  }

  await selectSource(source)
  emitTelemetryAction('launcher.install.method.selected', {
    source_id: source.id,
    source_category: source.category || source.id,
    flow: 'wizard',
  })
}

async function selectSource(source: Source): Promise<void> {
  loadGeneration++
  currentSource.value = source
  selections.value = {}
  fieldOptions.value.clear()
  fieldLoading.value.clear()
  fieldErrors.value.clear()
  textFieldValues.value.clear()
  saveDisabled.value = true
  sourceError.value = ''

  // Initialize text fields with defaults
  for (const f of source.fields) {
    if (f.type === 'text') {
      const defaultVal = f.defaultValue ?? ''
      textFieldValues.value.set(f.id, defaultVal)
      if (f.defaultValue !== undefined) {
        selections.value[f.id] = { value: f.defaultValue, label: f.defaultValue }
      }
    }
  }

  // Start loading from the first loadable (non-text) field
  const firstLoadable = source.fields.findIndex((f) => f.type !== 'text')
  if (firstLoadable >= 0) {
    await loadFieldOptions(firstLoadable)
  }

  // Sources with only text fields and skipInstall can be saved immediately
  if (source.skipInstall && source.fields.every((f) => f.type === 'text')) {
    saveDisabled.value = false
  }
}

async function loadFieldOptions(fieldIndex: number): Promise<void> {
  const source = currentSource.value
  if (!source) return
  const field = source.fields[fieldIndex]
  if (!field) return

  const gen = loadGeneration

  fieldLoading.value.set(field.id, true)
  fieldOptions.value.delete(field.id)
  saveDisabled.value = true

  // Clear downstream select fields
  for (let i = fieldIndex + 1; i < source.fields.length; i++) {
    const df = source.fields[i]
    if (!df || df.type === 'text') continue
    fieldOptions.value.delete(df.id)
    fieldLoading.value.set(df.id, false)
    delete selections.value[df.id]
  }

  // Clear any previous error on the error target field
  const clearTarget =
    field.errorTarget ||
    (() => {
      for (let i = fieldIndex - 1; i >= 0; i--) {
        const sf = source.fields[i]
        if (sf?.type === 'text') return sf.id
      }
      return null
    })()
  if (clearTarget) {
    fieldErrors.value.delete(clearTarget)
  }

  try {
    const options = await window.api.getFieldOptions(
      source.id,
      field.id,
      rawSelections(),
      field.id === 'release' ? { includeLatestStable: true } : undefined
    )

    // Discard stale response if source/modal changed during the await
    if (gen !== loadGeneration) return

    fieldLoading.value.set(field.id, false)

    if (options.length === 0) {
      fieldOptions.value.set(field.id, [])
      return
    }

    fieldOptions.value.set(field.id, options)

    let defaultIndex = options.findIndex((opt) => opt.recommended)
    if (defaultIndex < 0) defaultIndex = 0
    const defaultOption = options[defaultIndex]
    if (defaultOption) selections.value[field.id] = defaultOption

    // Load next select field
    const nextSelect = source.fields.findIndex(
      (f, i) => i > fieldIndex && f.type !== 'text'
    )
    if (nextSelect >= 0) {
      await loadFieldOptions(nextSelect)
    } else {
      saveDisabled.value = false
    }
  } catch (err: unknown) {
    if (gen !== loadGeneration) return
    fieldLoading.value.set(field.id, false)
    const errMsg = (err as Error).message || String(err)

    // Show error on the declared errorTarget, or fall back to preceding text field
    let errorFieldId = field.errorTarget
    if (!errorFieldId) {
      for (let i = fieldIndex - 1; i >= 0; i--) {
        const sf = source.fields[i]
        if (sf?.type === 'text') {
          errorFieldId = sf.id
          break
        }
      }
    }
    if (errorFieldId) {
      fieldErrors.value.set(errorFieldId, errMsg)
    } else if (field.renderAs === 'cards' || field.type === 'select') {
      sourceError.value = errMsg
    } else {
      fieldErrors.value.set(field.id, errMsg)
    }
  }
}

function handleFieldSelectChange(field: SourceField, fieldIndex: number, value: string): void {
  const source = currentSource.value
  if (!source) return
  const options = fieldOptions.value.get(field.id)
  if (!options) return

  const idx = parseInt(value, 10)
  const selected = options[idx]
  if (selected) selections.value[field.id] = selected

  const nextSelect = source.fields.findIndex(
    (f, i) => i > fieldIndex && f.type !== 'text'
  )
  if (nextSelect >= 0) {
    loadFieldOptions(nextSelect)
  } else {
    saveDisabled.value = false
  }
}

function selectCardOption(field: SourceField, fieldIndex: number, option: FieldOption): void {
  selections.value[field.id] = option
  if (field.id === 'variant') {
    emitTelemetryAction('launcher.install.variant.selected', {
      variant_bucket: toVariantBucket((option.data?.variantId as string | undefined) || option.value),
      recommended: !!option.recommended,
      flow: 'wizard',
    })
  }

  const source = currentSource.value
  if (!source) return
  const nextSelect = source.fields.findIndex(
    (f, i) => i > fieldIndex && f.type !== 'text'
  )
  if (nextSelect >= 0) {
    loadFieldOptions(nextSelect)
  } else {
    saveDisabled.value = false
  }
}

function handleTextAction(field: SourceField): void {
  const source = currentSource.value
  if (!source) return
  const value = textFieldValues.value.get(field.id) ?? ''

  fieldErrors.value.delete(field.id)
  selections.value[field.id] = { value, label: value }

  const fieldIndex = source.fields.findIndex((f) => f.id === field.id)
  const nextLoadable = source.fields.findIndex(
    (f, i) => i > fieldIndex && f.type !== 'text'
  )
  if (nextLoadable >= 0) {
    loadFieldOptions(nextLoadable)
  }
}

async function handleBrowse(): Promise<void> {
  const chosen = await window.api.browseFolder(instPath.value)
  if (chosen) instPath.value = chosen
}

function resetInstPath(): void {
  instPath.value = defaultInstPath.value
}

function nextStep(): void {
  if (currentStep.value < totalSteps.value && canProceed.value) {
    currentStep.value++
    if (instPath.value) fetchDiskSpace(instPath.value)
  }
}

function prevStep(): void {
  if (currentStep.value > 1) {
    currentStep.value--
  }
}

async function handleSave(): Promise<void> {
  const source = currentSource.value
  if (!source) return

  // Warn if NVIDIA driver is too old for the bundled PyTorch
  if (source.id === 'standalone') {
    const variantId = selections.value.variant?.data?.variantId as string | undefined
    if (variantId && stripVariantPrefix(variantId).startsWith('nvidia')) {
      if (!await checkNvidiaDriverOrWarn('wizard', 'save', modal.confirm, t)) {
        return
      }
    }
  }

  // Sync text field values into selections before building
  for (const f of source.fields) {
    if (f.type === 'text') {
      const value = textFieldValues.value.get(f.id) ?? ''
      selections.value[f.id] = { value, label: value }
    }
  }

  const instData = await window.api.buildInstallation(source.id, rawSelections())
  const baseName = instName.value.trim() ||
    (source.id === 'standalone' ? 'ComfyUI' : `ComfyUI (${source.label})`)
  const name = await window.api.getUniqueName(baseName)

  if (source.skipInstall) {
    const result = await window.api.addInstallation({
      name,
      installPath: '',
      status: 'installed',
      ...instData
    })
    if (!result.ok) {
      await modal.alert({
        title: t('errors.cannotAdd'),
        message: result.message || ''
      })
      return
    }
    emit('close')
    emit('navigate-list')
    return
  }

  // Validate install path against restricted locations
  if (instPath.value) {
    try {
      const issues = await window.api.validateInstallPath(instPath.value)
      if (!await showPathIssueAlerts(issues, 'wizard', 'save', modal.alert, t)) {
        return
      }
    } catch {
      // If validation fails, proceed anyway
    }
  }

  // Check disk space before proceeding
  if (instPath.value) {
    try {
      const downloadFiles = selections.value.variant?.data?.downloadFiles as
        Array<{ size: number }> | undefined
      const downloadBytes = downloadFiles
        ? downloadFiles.reduce((sum, f) => sum + f.size, 0)
        : 0
      const estimatedRequired = downloadBytes > 0 ? Math.ceil(downloadBytes * 2.25) : 0

      if (!await checkDiskSpaceOrWarn({
        path: instPath.value,
        estimatedRequired,
        flow: 'wizard',
        confirm: modal.confirm,
        t,
      })) {
        return
      }
    } catch {
      // If disk space check fails, proceed anyway
    }
  }

  const result = await window.api.addInstallation({
    name,
    installPath: instPath.value,
    ...instData
  })
  if (!result.ok) {
    await modal.alert({
      title: t('errors.cannotAdd'),
      message: result.message || ''
    })
    return
  }
  emit('close')
  if (result.entry) {
    emit('show-progress', {
      installationId: result.entry.id,
      title: `${t('newInstall.installing')} — ${name}`,
      apiCall: () => window.api.installInstance(result.entry!.id)
    })
  }
}

function getSelectedIndex(field: SourceField): number {
  const options = fieldOptions.value.get(field.id)
  if (!options) return 0
  const sel = selections.value[field.id]
  if (!sel) return 0
  const idx = options.findIndex((o) => o.value === sel.value)
  return idx >= 0 ? idx : 0
}

const { handleOverlayMouseDown, handleOverlayClick } = useModalOverlay(
  () => true,
  () => emit('close'),
)

defineExpose({ open })
</script>

<template>
  <div
    class="view-modal active"
    @mousedown="handleOverlayMouseDown"
    @click="handleOverlayClick"
  >
    <div class="view-modal-content">
      <div class="view-modal-header">
        <div class="view-modal-title">{{ stepTitle }}</div>
        <button class="view-modal-close" @click="emit('close')">✕</button>
      </div>
      <div class="view-modal-body">
        <div class="view-scroll">
          <!-- Step 1: Source Selection -->
          <div v-if="currentStep === 1" class="wizard-step">
            <div v-if="sourcesLoading || initializing" class="wizard-loading with-spinner">
              {{ $t('newInstall.loading') }}
            </div>
            <template v-else>
              <!-- Hero card (Standalone) -->
              <div
                v-for="s in heroSources"
                :key="s.id"
                :class="['source-card', 'source-card-hero', { selected: currentSource?.id === s.id }]"
                @click="selectSourceCard(s)"
              >
                <div class="source-card-header">
                  <div class="source-card-label">{{ s.label }}</div>
                  <div class="source-card-badge">{{ $t('newInstall.recommended') }}</div>
                </div>
                <div v-if="s.description" class="source-card-desc">{{ s.description }}</div>
              </div>

              <!-- Other source cards -->
              <div class="source-cards-row">
                <div
                  v-for="s in otherSources"
                  :key="s.id"
                  :class="['source-card', { selected: currentSource?.id === s.id }]"
                  @click="selectSourceCard(s)"
                >
                  <div class="source-card-label">{{ s.label }}</div>
                  <div v-if="s.description" class="source-card-desc">{{ s.description }}</div>
                </div>
              </div>
            </template>
          </div>

          <!-- Step 2: Configuration (or combined step for skipInstall) -->
          <div v-else-if="currentStep === 2" class="wizard-step">
            <!-- For skipInstall sources: combined config + name -->
            <template v-if="currentSource?.skipInstall">
              <div v-if="currentSource" id="source-fields">
                <div
                  v-for="field in currentSource.fields"
                  :key="field.id"
                  class="field"
                >
                  <label :for="`sf-${field.id}`">{{ field.label }}</label>
                  <template v-if="field.type === 'text'">
                    <div class="path-input">
                      <input
                        :id="`sf-${field.id}`"
                        type="text"
                        :value="textFieldValues.get(field.id) ?? ''"
                        :placeholder="field.defaultValue || ''"
                        @input="textFieldValues.set(field.id, ($event.target as HTMLInputElement).value)"
                      />
                      <button
                        v-if="field.action"
                        :id="`sf-${field.id}-action`"
                        type="button"
                        @click="handleTextAction(field)"
                      >
                        {{ field.action.label }}
                      </button>
                    </div>
                    <div v-if="fieldErrors.get(field.id)" class="field-error">
                      {{ fieldErrors.get(field.id) }}
                    </div>
                  </template>
                </div>
              </div>

              <!-- Name field for skipInstall -->
              <div class="field">
                <label for="inst-name">{{ $t('common.name') }}</label>
                <input
                  id="inst-name"
                  v-model="instName"
                  type="text"
                  :placeholder="$t('common.namePlaceholder')"
                />
              </div>
            </template>

            <!-- For local sources: configuration fields -->
            <template v-else>
              <div class="detected-hardware">{{ detectedGpu }}</div>

              <div v-if="sourceError" class="wizard-error">
                {{ sourceError }}
              </div>

              <div v-if="currentSource" id="source-fields">
                <div
                  v-for="(field, fieldIndex) in currentSource.fields"
                  :key="field.id"
                  class="field"
                >
                  <label :for="`sf-${field.id}`">{{ field.label }}</label>

                  <!-- Text field -->
                  <template v-if="field.type === 'text'">
                    <div class="path-input">
                      <input
                        :id="`sf-${field.id}`"
                        type="text"
                        :value="textFieldValues.get(field.id) ?? ''"
                        :placeholder="field.defaultValue || ''"
                        @input="textFieldValues.set(field.id, ($event.target as HTMLInputElement).value)"
                      />
                      <button
                        v-if="field.action"
                        :id="`sf-${field.id}-action`"
                        type="button"
                        @click="handleTextAction(field)"
                      >
                        {{ field.action.label }}
                      </button>
                    </div>
                    <div v-if="fieldErrors.get(field.id)" class="field-error">
                      {{ fieldErrors.get(field.id) }}
                    </div>
                  </template>

                  <!-- Card-rendered select field -->
                  <template v-else-if="field.renderAs === 'cards'">
                    <div v-if="fieldLoading.get(field.id)" class="wizard-loading with-spinner">
                      {{ $t('newInstall.loading') }}
                    </div>
                    <VariantCardGrid
                      v-else-if="fieldOptions.has(field.id) && (fieldOptions.get(field.id)?.length ?? 0) > 0"
                      :options="sortedCardOptions(fieldOptions.get(field.id)!)"
                      :selected-value="selections[field.id]?.value"
                      @select="(opt) => selectCardOption(field, fieldIndex, opt)"
                    />
                    <div
                      v-else-if="fieldOptions.has(field.id)"
                      class="wizard-loading"
                    >
                      {{ fieldErrors.get(field.id)
                        ? `Error: ${fieldErrors.get(field.id)}`
                        : $t('newInstall.noOptions') }}
                    </div>
                  </template>

                  <!-- Regular select field -->
                  <template v-else>
                    <select
                      :id="`sf-${field.id}`"
                      :disabled="
                        fieldLoading.get(field.id) ||
                        !fieldOptions.has(field.id) ||
                        fieldOptions.get(field.id)?.length === 0
                      "
                      :value="getSelectedIndex(field)"
                      @change="
                        handleFieldSelectChange(
                          field,
                          fieldIndex,
                          ($event.target as HTMLSelectElement).value
                        )
                      "
                    >
                      <option v-if="fieldLoading.get(field.id)">
                        {{ $t('newInstall.loading') }}
                      </option>
                      <option
                        v-else-if="
                          !fieldOptions.has(field.id) ||
                          fieldOptions.get(field.id)?.length === 0
                        "
                      >
                        {{
                          fieldErrors.get(field.id)
                            ? `Error: ${fieldErrors.get(field.id)}`
                            : fieldOptions.has(field.id)
                              ? $t('newInstall.noOptions')
                              : '—'
                        }}
                      </option>
                      <template v-else>
                        <option
                          v-for="(opt, i) in fieldOptions.get(field.id)"
                          :key="opt.value"
                          :value="i"
                        >
                          {{ opt.description ? `${opt.label}  —  ${opt.description}` : opt.label }}{{ opt.recommended ? ` (${$t('newInstall.recommended')})` : '' }}
                        </option>
                      </template>
                    </select>
                  </template>
                </div>
              </div>
            </template>
          </div>

          <!-- Step 3: Name & Location (local sources only) -->
          <div v-else-if="currentStep === 3" class="wizard-step">
            <div class="field">
              <label for="inst-name">{{ $t('common.name') }}</label>
              <input
                id="inst-name"
                v-model="instName"
                type="text"
                :placeholder="$t('common.namePlaceholder')"
              />
            </div>

            <div
              v-if="!currentSource?.hideInstallPath"
              class="field"
            >
              <label for="inst-path">{{ $t('newInstall.installLocation') }}</label>
              <div class="path-input">
                <input
                  id="inst-path"
                  v-model="instPath"
                  type="text"
                />
                <button @click="handleBrowse">{{ $t('common.browse') }}</button>
                <button
                  v-if="instPath !== defaultInstPath"
                  @click="resetInstPath"
                >{{ $t('common.resetDefault') }}</button>
              </div>
              <PathDiskInfo
                :path-issues="pathIssues"
                :disk-space-loading="diskSpaceLoading"
                :disk-space="diskSpace"
                :estimated-size="estimatedInstallSize"
              />
            </div>
          </div>
        </div>

        <!-- Wizard footer -->
        <div class="wizard-footer">
          <button
            v-if="currentStep > 1"
            class="wizard-back"
            @click="prevStep"
          >
            ← {{ currentStep === 2 ? $t('newInstall.changeInstallType') : $t('common.back') }}
          </button>
          <div v-else class="wizard-back-placeholder"></div>

          <div class="wizard-dots">
            <div
              v-for="s in totalSteps"
              :key="s"
              :class="['wizard-dot', { active: s === currentStep, completed: s < currentStep }]"
            />
          </div>

          <button
            class="primary"
            :disabled="!canProceed"
            @click="currentStep < totalSteps ? nextStep() : handleSave()"
          >
            {{ currentStep < totalSteps ? $t('newInstall.next') : $t('newInstall.addInstallation') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
