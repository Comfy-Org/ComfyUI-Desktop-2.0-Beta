<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick, toRaw } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight, HardDrive } from 'lucide-vue-next'
import { useModal } from '../composables/useModal'

import type {
  Source,
  SourceField,
  FieldOption,
  HardwareValidation,
  ShowProgressOpts
} from '../types/ipc'
import { stripVariantPrefix, sortedCardOptions } from '../lib/variants'
import { emitTelemetryAction, toVariantBucket } from '../lib/telemetry'
import {
  trackGuardrailBlocked,
  createDiskSpaceChecker,
  showPathIssueAlerts,
  checkNvidiaDriverOrWarn,
  checkDiskSpaceOrWarn
} from '../lib/installHelpers'
import TakeoverBack from '../components/TakeoverBack.vue'
import BrandTakeoverLayout from '../components/BrandTakeoverLayout.vue'
import BrandVariantList from '../components/BrandVariantList.vue'
import PathDiskInfo from '../components/PathDiskInfo.vue'
import TooltipWrap from '../components/TooltipWrap.vue'
import { BaseSelect, type BaseSelectOption } from '../components/ui'

const emit = defineEmits<{
  close: []
  'show-progress': [opts: ShowProgressOpts]
  'navigate-list': []
  /** Configure footer's Back link when opened by the first-use chain; host returns to the FirstUseTakeover localBranch step. */
  'back-to-local-branch': []
}>()

const props = withDefaults(
  defineProps<{
    /** Hide the "Back to Dashboard" chevron when chained from the first-use takeover. */
    hideBackToDashboard?: boolean
  }>(),
  { hideBackToDashboard: false }
)

const { t } = useI18n()
const modal = useModal()

const sources = ref<Source[]>([])
const currentSource = ref<Source | null>(null)
const selections = ref<Record<string, FieldOption>>({})
const instName = ref('')
/** Placeholder's suggested default (`ComfyUI` → `ComfyUI (2)` if taken). `handleSave`'s blank-field fallback produces the same value, so it's truthful. */
const suggestedName = ref('')
const instPath = ref('')
const defaultInstPath = ref('')
const detectedGpu = ref('')
const saveDisabled = ref(true)
const sourcesLoading = ref(false)
const initializing = ref(false)
const sourceError = ref('')

// Per-field state
const fieldOptions = ref(new Map<string, FieldOption[]>())
const fieldLoading = ref(new Map<string, boolean>())
const fieldErrors = ref(new Map<string, string>())
const textFieldValues = ref(new Map<string, string>())

// Disk space and path validation
const {
  diskSpace,
  diskSpaceLoading,
  pathIssues,
  fetchDiskSpace,
  reset: resetDiskSpace
} = createDiskSpaceChecker()
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

const advancedOpen = ref(false)
const advancedRef = ref<HTMLElement | null>(null)

// Scroll Advanced into view on open. `block: 'nearest'` no-ops when already visible so the view doesn't yank on tall screens.
watch(advancedOpen, async (open) => {
  if (!open) return
  await nextTick()
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  advancedRef.value?.scrollIntoView({
    behavior: reduced ? 'auto' : 'smooth',
    block: 'nearest'
  })
})

watch(instPath, (newPath) => {
  diskSpace.value = null
  pathIssues.value = []
  fetchDiskSpace(newPath)
})

/** Bumped on each open/source change to discard stale responses. */
let loadGeneration = 0

// Reject whitespace-only names; a truly-blank field is allowed (falls back to the suggested default).
const nameError = computed(() =>
  instName.value.length > 0 && instName.value.trim().length === 0
    ? t('newInstall.nameWhitespace')
    : ''
)

// Mirrors main's `parseUrl`: a scheme-less value is tried as `http://<value>` and must yield a hostname.
function isValidConnectionUrl(raw: string): boolean {
  const trimmed = raw.trim()
  if (!trimmed) return false
  try {
    const parsed = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`)
    return parsed.hostname.length > 0
  } catch {
    return false
  }
}

// Inline error for the `url` field on Remote Connection / Cloud sources; scoped to `id === 'url'` so other text fields keep their own flow.
const urlFieldError = computed(() => {
  const source = currentSource.value
  if (!source) return ''
  const urlField = source.fields.find((f) => f.id === 'url' && f.type === 'text')
  if (!urlField) return ''
  const value = textFieldValues.value.get('url') ?? ''
  return isValidConnectionUrl(value) ? '' : t('newInstall.urlInvalid')
})

// Continue gate. `skipInstall` sources (Remote Connection) have no install path, so the path-issue guard is skipped for them.
const canContinue = computed(() => {
  if (!currentSource.value) return false
  if (nameError.value || urlFieldError.value) return false
  if (currentSource.value.skipInstall) return !saveDisabled.value
  return !saveDisabled.value && pathIssues.value.length === 0
})

/** Deep-strip Vue reactive proxies for safe IPC serialization. */
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

const brandShellRef = ref<HTMLElement | null>(null)
let returnFocusTo: HTMLElement | null = null

onMounted(() => {
  if (props.hideBackToDashboard) {
    returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
    void nextTick(() => {
      const target = brandShellRef.value?.querySelector<HTMLElement>(
        'input, button, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
      target?.focus()
    })
  }

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

onBeforeUnmount(() => {
  if (returnFocusTo && document.contains(returnFocusTo)) {
    returnFocusTo.focus()
  }
  returnFocusTo = null
})

interface OpenOpts {
  /** Set when opened via the first-use localBranch → Start Fresh path; surfaces a Back link that returns to localBranch instead of closing. */
  cameFromLocalBranch?: boolean
}

const cameFromLocalBranch = ref(false)

async function open(opts: OpenOpts = {}): Promise<void> {
  loadGeneration++
  instName.value = ''
  cameFromLocalBranch.value = opts.cameFromLocalBranch === true
  suggestedName.value = ''
  void window.api
    .getUniqueName('ComfyUI')
    .then((name) => {
      suggestedName.value = name
    })
    .catch(() => {})
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

    // Pre-select Standalone (the recommended method); other sources are reachable via the Advanced method-picker chips.
    hardwareValidation = await window.api.validateHardware()
    const standalone = sources.value.find((s) => s.id === 'standalone')
    if (standalone && hardwareValidation.supported) {
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
      message: hardwareValidation.error || ''
    })
    return
  }

  await selectSource(source)
  emitTelemetryAction('comfy.desktop.install.method.selected', {
    source_id: source.id,
    source_category: source.category || source.id,
    flow: 'wizard'
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
    fieldOptions.value.set(field.id, options)

    if (options.length > 0) {
      let defaultIndex = options.findIndex((opt) => opt.recommended)
      if (defaultIndex < 0) defaultIndex = 0
      const defaultOption = options[defaultIndex]
      if (defaultOption) selections.value[field.id] = defaultOption
    } else {
      // Conditional fields (e.g. `comfyVersion` on the 'latest' channel) return
      // [] when not applicable. Drop any stale selection so a value from a
      // prior channel toggle doesn't leak into `buildInstallation`.
      delete selections.value[field.id]
    }

    // Load next select field. An empty-options field still hands off downstream
    // so a conditional field can't strand the chain (would leave Continue disabled).
    const nextSelect = source.fields.findIndex((f, i) => i > fieldIndex && f.type !== 'text')
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

  const nextSelect = source.fields.findIndex((f, i) => i > fieldIndex && f.type !== 'text')
  if (nextSelect >= 0) {
    loadFieldOptions(nextSelect)
  } else {
    saveDisabled.value = false
  }
}

function selectCardOption(field: SourceField, fieldIndex: number, option: FieldOption): void {
  selections.value[field.id] = option
  if (field.id === 'variant') {
    emitTelemetryAction('comfy.desktop.install.variant.selected', {
      variant_bucket: toVariantBucket(
        (option.data?.variantId as string | undefined) || option.value
      ),
      recommended: !!option.recommended,
      flow: 'wizard'
    })
  }

  const source = currentSource.value
  if (!source) return
  const nextSelect = source.fields.findIndex((f, i) => i > fieldIndex && f.type !== 'text')
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
  const nextLoadable = source.fields.findIndex((f, i) => i > fieldIndex && f.type !== 'text')
  if (nextLoadable >= 0) {
    loadFieldOptions(nextLoadable)
  }
}

async function handleBrowse(): Promise<void> {
  const chosen = await window.api.browseFolder(instPath.value)
  if (chosen) instPath.value = chosen
}

async function handleSave(): Promise<void> {
  const source = currentSource.value
  if (!source) return

  // Warn if NVIDIA driver is too old for the bundled PyTorch
  if (source.id === 'standalone') {
    const variantId = selections.value.variant?.data?.variantId as string | undefined
    if (variantId && stripVariantPrefix(variantId).startsWith('nvidia')) {
      if (!(await checkNvidiaDriverOrWarn('wizard', 'save', modal.confirm, t))) {
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
  const baseName =
    instName.value.trim() || (source.id === 'standalone' ? 'ComfyUI' : `ComfyUI (${source.label})`)
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
      if (!(await showPathIssueAlerts(issues, 'wizard', 'save', modal.alert, t))) {
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
        | Array<{ size: number }>
        | undefined
      const downloadBytes = downloadFiles ? downloadFiles.reduce((sum, f) => sum + f.size, 0) : 0
      const estimatedRequired = downloadBytes > 0 ? Math.ceil(downloadBytes * 2.25) : 0

      if (
        !(await checkDiskSpaceOrWarn({
          path: instPath.value,
          estimatedRequired,
          flow: 'wizard',
          confirm: modal.confirm,
          t
        }))
      ) {
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
  if (result.entry) {
    // Hand off WITHOUT emitting `close` first: the host swaps the overlay in place; closing first would flash the dashboard underneath.
    emit('show-progress', {
      installationId: result.entry.id,
      title: `${t('newInstall.installing')} — ${name}`,
      apiCall: () => window.api.installInstance(result.entry!.id),
      autoLaunchOnFinish: true,
      opKind: 'install'
    })
    return
  }
  // Defensive: addInstallation reported ok but produced no entry.
  // Dismiss the wizard so the user isn't stuck on it.
  emit('close')
}

function getSelectOptions(field: SourceField): BaseSelectOption[] {
  const options = fieldOptions.value.get(field.id)
  if (!options) return []
  return options.map((opt) => ({
    value: opt.value,
    label: opt.recommended ? `${opt.label} (${t('newInstall.recommended')})` : opt.label,
    description: opt.description
  }))
}

function getSelectPlaceholder(field: SourceField): string {
  if (fieldLoading.value.get(field.id)) return t('newInstall.loading')
  const err = fieldErrors.value.get(field.id)
  if (err) return `Error: ${err}`
  if (fieldOptions.value.has(field.id)) return t('newInstall.noOptions')
  return '—'
}

function onSelectFieldChange(field: SourceField, fieldIndex: number, value: string): void {
  const options = fieldOptions.value.get(field.id)
  if (!options) return
  const idx = options.findIndex((o) => o.value === value)
  if (idx < 0) return
  handleFieldSelectChange(field, fieldIndex, String(idx))
}

/** Conditional fields like `comfyVersion` (only meaningful on the stable
 *  channel) return an empty options array when not applicable. Hide them
 *  outright so the wizard doesn't render a "No options" dropdown. */
function isHiddenWhenEmpty(field: SourceField): boolean {
  if (field.type === 'text' || field.renderAs === 'cards') return false
  const options = fieldOptions.value.get(field.id)
  if (options === undefined) return false
  return options.length === 0 && !fieldLoading.value.get(field.id)
}

defineExpose({ open })
</script>

<template>
  <BrandTakeoverLayout>
    <div ref="brandShellRef" class="config-shell">
      <h1 class="brand-title">{{ $t('newInstall.configureTitle') }}</h1>
      <p class="brand-lead">{{ $t('newInstall.configureLead') }}</p>
      <div class="config-card">
        <div class="config-card__body">
          <div class="config-field">
            <label class="config-label" for="inst-name-standalone">{{ $t('common.name') }}</label>
            <div class="brand-input" :class="{ 'brand-input--invalid': nameError }">
              <input
                id="inst-name-standalone"
                :value="instName"
                type="text"
                :placeholder="suggestedName || $t('common.namePlaceholder')"
                :aria-invalid="!!nameError"
                :aria-describedby="nameError ? 'inst-name-error' : undefined"
                @input="instName = ($event.target as HTMLInputElement).value"
              />
            </div>
            <div v-if="nameError" id="inst-name-error" class="field-error" role="alert">
              {{ nameError }}
            </div>
          </div>

          <!-- GPU + Install Location stay visible but are disabled in Remote Connection mode (no local hardware / path). -->
          <TooltipWrap
            class="config-field-wrap"
            side="bottom"
            :text="currentSource?.skipInstall ? $t('newInstall.notAvailableRemote') : ''"
          >
            <div
              class="config-field"
              :class="{ 'config-field--disabled': currentSource?.skipInstall }"
            >
              <label class="config-label">{{ $t('newInstall.detectedGpuLabel') }}</label>
              <div
                class="brand-input config-select config-select--readonly"
                role="textbox"
                aria-readonly="true"
              >
                <span class="config-select__value">{{ detectedGpu }}</span>
              </div>
            </div>
          </TooltipWrap>

          <TooltipWrap
            class="config-field-wrap"
            side="bottom"
            :text="currentSource?.skipInstall ? $t('newInstall.notAvailableRemote') : ''"
          >
            <div
              class="config-field"
              :class="{ 'config-field--disabled': currentSource?.skipInstall }"
            >
              <label class="config-label" for="inst-path">{{
                $t('newInstall.installLocation')
              }}</label>
              <div class="config-path-row">
                <div class="brand-input config-path-input">
                  <HardDrive :size="14" aria-hidden="true" />
                  <input
                    id="inst-path"
                    :value="instPath"
                    type="text"
                    readonly
                    :disabled="!!currentSource?.skipInstall"
                  />
                </div>
                <button
                  class="brand-tertiary"
                  type="button"
                  :disabled="!!currentSource?.skipInstall"
                  @click="handleBrowse"
                >
                  {{ $t('common.browse') }}
                </button>
              </div>
              <PathDiskInfo
                v-if="!currentSource?.skipInstall"
                :path-issues="pathIssues"
                :disk-space-loading="diskSpaceLoading"
                :disk-space="diskSpace"
                :estimated-size="estimatedInstallSize"
              />
            </div>
          </TooltipWrap>

          <div ref="advancedRef" class="config-advanced" :class="{ 'is-open': advancedOpen }">
            <button
              type="button"
              class="config-advanced__summary"
              :aria-expanded="advancedOpen"
              @click="advancedOpen = !advancedOpen"
            >
              <ChevronRight :size="14" class="config-advanced__chevron" aria-hidden="true" />
              <span>{{ $t('common.advanced') }}</span>
            </button>
            <div class="config-advanced__wrap">
              <div class="config-advanced__body">
                <div
                  v-if="sources.length > 1"
                  class="config-method-row"
                  role="radiogroup"
                  :aria-label="$t('newInstall.chooseMethod')"
                >
                  <button
                    v-for="s in sources"
                    :key="s.id"
                    type="button"
                    role="radio"
                    :aria-checked="currentSource?.id === s.id"
                    :class="[
                      'config-method',
                      { 'config-method--selected': currentSource?.id === s.id }
                    ]"
                    @click="selectSourceCard(s)"
                  >
                    <span class="config-method__label">{{ s.label }}</span>
                    <span v-if="s.id === 'standalone'" class="brand-tag-recommended">
                      {{ $t('newInstall.recommended') }}
                    </span>
                  </button>
                </div>
                <div v-if="sourceError" class="wizard-error">{{ sourceError }}</div>
                <div v-if="currentSource" id="source-fields">
                  <div
                    v-for="(field, fieldIndex) in currentSource.fields"
                    v-show="!isHiddenWhenEmpty(field)"
                    :key="field.id"
                    class="field"
                  >
                    <label :for="`sf-${field.id}`">{{ field.label }}</label>

                    <template v-if="field.type === 'text'">
                      <div class="path-input">
                        <div
                          class="brand-input config-source-text"
                          :class="{
                            'brand-input--invalid': field.id === 'url' && urlFieldError
                          }"
                        >
                          <input
                            :id="`sf-${field.id}`"
                            type="text"
                            :value="textFieldValues.get(field.id) ?? ''"
                            :placeholder="field.defaultValue || ''"
                            :aria-invalid="field.id === 'url' && !!urlFieldError"
                            :aria-describedby="
                              field.id === 'url' && urlFieldError
                                ? `sf-${field.id}-error`
                                : undefined
                            "
                            @input="
                              textFieldValues.set(
                                field.id,
                                ($event.target as HTMLInputElement).value
                              )
                            "
                          />
                        </div>
                        <button
                          v-if="field.action"
                          :id="`sf-${field.id}-action`"
                          type="button"
                          class="brand-tertiary"
                          @click="handleTextAction(field)"
                        >
                          {{ field.action.label }}
                        </button>
                      </div>
                      <div v-if="fieldErrors.get(field.id)" class="field-error">
                        {{ fieldErrors.get(field.id) }}
                      </div>
                      <div
                        v-else-if="field.id === 'url' && urlFieldError"
                        :id="`sf-${field.id}-error`"
                        class="field-error"
                        role="alert"
                      >
                        {{ urlFieldError }}
                      </div>
                    </template>

                    <template v-else-if="field.renderAs === 'cards'">
                      <div v-if="fieldLoading.get(field.id)" class="wizard-loading with-spinner">
                        {{ $t('newInstall.loading') }}
                      </div>
                      <BrandVariantList
                        v-else-if="
                          fieldOptions.has(field.id) &&
                          (fieldOptions.get(field.id)?.length ?? 0) > 0
                        "
                        :options="sortedCardOptions(fieldOptions.get(field.id)!)"
                        :selected-value="selections[field.id]?.value ?? null"
                        :aria-label="field.label"
                        @select="(opt) => selectCardOption(field, fieldIndex, opt)"
                      />
                      <div v-else-if="fieldOptions.has(field.id)" class="wizard-loading">
                        {{
                          fieldErrors.get(field.id)
                            ? `Error: ${fieldErrors.get(field.id)}`
                            : $t('newInstall.noOptions')
                        }}
                      </div>
                    </template>

                    <template v-else>
                      <BaseSelect
                        :model-value="selections[field.id]?.value ?? ''"
                        :options="getSelectOptions(field)"
                        :placeholder="getSelectPlaceholder(field)"
                        :disabled="
                          fieldLoading.get(field.id) ||
                          !fieldOptions.has(field.id) ||
                          (fieldOptions.get(field.id)?.length ?? 0) === 0
                        "
                        :aria-label="field.label"
                        @update:model-value="onSelectFieldChange(field, fieldIndex, $event)"
                      />
                    </template>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="config-card__footer">
          <button
            v-if="cameFromLocalBranch"
            type="button"
            class="brand-ghost config-back"
            data-testid="config-back-to-local-branch"
            @click="emit('back-to-local-branch')"
          >
            {{ $t('common.back') }}
          </button>
          <button
            class="brand-primary config-continue"
            :disabled="!canContinue"
            @click="handleSave"
          >
            {{ $t('common.continue') }}
          </button>
        </div>
      </div>
    </div>
    <template #footer-left>
      <TakeoverBack
        v-if="!hideBackToDashboard"
        class="config-back-to-dashboard"
        :label="$t('common.backToDashboard')"
        @back="emit('close')"
      />
    </template>
  </BrandTakeoverLayout>
</template>

<style scoped>
.config-shell {
  align-self: stretch;
  height: 100%;
  max-height: 100%;
  width: 100%;
  max-width: 640px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding-block: clamp(1.5rem, 4vh, 3rem);
  min-height: 0;
}

.config-card {
  width: 100%;
  /* Capped at shell height so the card doesn't overflow the viewport when Advanced expands; body scrolls instead. */
  max-height: 100%;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--brand-surface-border);
  border-radius: 8px;
  background: var(--brand-surface-bg);
  backdrop-filter: blur(var(--brand-surface-blur));
  overflow: hidden;
  text-align: left;
}

.config-card__body {
  /* `flex: 1 1 auto` lets this body absorb leftover space and scroll internally once the card hits the shell cap, keeping the title centered. */
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  /* Hide scrollbar to prevent layout shift when content overflows. */
  scrollbar-width: none;
}
.config-card__body::-webkit-scrollbar {
  display: none;
}

.config-card__footer {
  flex: 0 0 auto;
  padding: 14px 20px;
  border-top: 1px solid var(--brand-surface-border);
  background: var(--brand-surface-bg);
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 12px;
}
.config-back {
  margin-right: auto;
}

.config-back-to-dashboard {
  position: absolute;
  left: clamp(1.25rem, 2vw, 2rem);
  bottom: clamp(1.25rem, 2vw, 2rem);
  z-index: 2;
}

.config-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.config-field--disabled {
  opacity: 0.5;
}
/* Keep the wrap hoverable for TooltipWrap; block interaction on controls only. */
.config-field--disabled input,
.config-field--disabled button,
.config-field--disabled .brand-input {
  pointer-events: none;
}
/* TooltipWrap defaults to `display: inline-flex`; promote to block-level
 * so the wrapped .config-field still fills the card width. */
.config-field-wrap {
  display: flex;
  flex-direction: column;
  width: 100%;
}
.config-field-wrap > .config-field--disabled {
  cursor: not-allowed;
}
.config-label {
  font-size: 13px;
  color: var(--neutral-200);
}

/* Takes the row's flex 1 so the input and any sibling action button line up. */
.config-source-text {
  flex: 1 1 auto;
  min-width: 0;
}

.config-select {
  padding: 8px 12px;
  cursor: default;
}
/* Detected GPU is read-only; strip the hover affordance that would imply it's editable. */
.config-select--readonly:hover {
  border-color: var(--brand-surface-border);
  background: var(--brand-surface-bg);
}
.config-select--readonly .config-select__value {
  color: var(--text-muted);
}
.config-select__value {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--neutral-100);
  font-size: 14px;
}

.config-path-row {
  display: flex;
  gap: 8px;
  align-items: stretch;
}
.config-path-row > .config-path-input,
.config-path-row > button.brand-tertiary {
  height: 40px;
  padding-block: 0;
  display: flex;
  align-items: center;
}
.config-path-input {
  flex: 1 1 auto;
  min-width: 0;
  padding-inline: 12px;
}
.config-path-row > button.brand-tertiary {
  padding-inline: 14px;
  font-size: 13px;
}

.config-advanced {
  border-top: 1px solid var(--brand-surface-border);
  padding-top: var(--takeover-gap-md);
}
.config-advanced__summary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  cursor: pointer;
  background: transparent;
  border: none;
  color: var(--neutral-200);
  font: inherit;
  font-size: var(--takeover-fs-body);
}
.config-advanced__summary:hover {
  color: var(--text);
  transition: color 120ms ease;
}
.config-advanced__summary:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
  border-radius: 4px;
}
.config-advanced__chevron {
  transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
}
.config-advanced.is-open .config-advanced__chevron {
  transform: rotate(90deg);
}

.config-advanced__wrap {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 280ms cubic-bezier(0.22, 1, 0.36, 1);
}
.config-advanced.is-open .config-advanced__wrap {
  grid-template-rows: 1fr;
}
.config-advanced__body {
  min-height: 0;
  overflow: hidden;
  padding-inline: 3px;
  margin-inline: -3px;
  opacity: 0;
  transform: translateY(-4px);
  transition:
    opacity 220ms ease 60ms,
    transform 260ms cubic-bezier(0.22, 1, 0.36, 1) 40ms;
}
.config-advanced.is-open .config-advanced__body {
  margin-top: var(--takeover-gap-md);
  opacity: 1;
  transform: translateY(0);
}

/* Install-method chips: pill picker inside Advanced for swapping source without leaving the brand chrome. */
.config-method-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}
.config-method {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border: 1px solid var(--brand-surface-border);
  border-radius: 6px;
  background: var(--brand-surface-bg);
  color: var(--neutral-200);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition:
    border-color 160ms ease,
    background 160ms ease,
    color 160ms ease;
}
.config-method:hover {
  border-color: var(--brand-surface-border-hover);
  background: var(--brand-surface-bg-hover);
}
.config-method:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}
.config-method--selected {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--neutral-100);
}

.config-continue {
  min-width: 120px;
}
</style>
