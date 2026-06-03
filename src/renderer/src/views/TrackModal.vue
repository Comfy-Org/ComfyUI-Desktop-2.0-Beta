<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount, nextTick, toRaw } from 'vue'
import { useI18n } from 'vue-i18n'
import { HardDrive } from 'lucide-vue-next'
import { useModal } from '../composables/useModal'
import BrandTakeoverLayout from '../components/BrandTakeoverLayout.vue'
import TakeoverBack from '../components/TakeoverBack.vue'
import { BaseSelect, type BaseSelectOption } from '../components/ui'

import type { ProbeResult } from '../types/ipc'
import { emitTelemetryAction, toCountBucket } from '../lib/telemetry'

const emit = defineEmits<{
  close: []
  'navigate-list': []
}>()

const { t } = useI18n()
const modal = useModal()

const isOpen = ref(false)
const trackPath = ref('')
const trackName = ref('')
const suggestedName = ref('')
const probeResults = ref<ProbeResult[]>([])
const selectedProbe = ref<ProbeResult | null>(null)
const venvOverride = ref<string | null>(null)
const probing = ref(false)

const cardRef = ref<HTMLElement | null>(null)
let returnFocusTo: HTMLElement | null = null

const saveDisabled = computed(() => !trackPath.value || !selectedProbe.value)

/** Path most recently probed — guards the input watcher from re-probing
 *  a value that `handleBrowse` (or a prior debounce) already handled. */
let lastProbedPath = ''
/** Generation counter — bumped on every probe so stale async responses
 *  from an earlier path are discarded once the field changes again. */
let probeGeneration = 0
let probeDebounce: ReturnType<typeof setTimeout> | null = null

/** Re-probe whenever the path field changes, not just via Browse. Typing
 *  or pasting a directory now triggers detection so a valid existing
 *  install enables the "Track install" button. Debounced to avoid
 *  probing on every keystroke; trimmed so trailing whitespace from a
 *  paste doesn't read as a distinct path. */
watch(trackPath, (newPath) => {
  const trimmed = newPath.trim()
  if (trimmed === lastProbedPath) return
  if (probeDebounce) clearTimeout(probeDebounce)
  if (!trimmed) {
    lastProbedPath = ''
    probeResults.value = []
    selectedProbe.value = null
    return
  }
  probeDebounce = setTimeout(() => {
    void probe(trimmed)
  }, 300)
})

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && isOpen.value) emit('close')
}

watch(isOpen, async (open) => {
  if (open) {
    document.addEventListener('keydown', onKeydown)
    returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
    await nextTick()
    const target = cardRef.value?.querySelector<HTMLElement>(
      'input, button, select, [tabindex]:not([tabindex="-1"])'
    )
    target?.focus()
  } else {
    document.removeEventListener('keydown', onKeydown)
    returnFocusTo?.focus()
    returnFocusTo = null
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
  if (probeDebounce) clearTimeout(probeDebounce)
  if (returnFocusTo && document.contains(returnFocusTo)) returnFocusTo.focus()
  returnFocusTo = null
})

function open(): void {
  if (probeDebounce) clearTimeout(probeDebounce)
  probeDebounce = null
  lastProbedPath = ''
  trackPath.value = ''
  trackName.value = ''
  probeResults.value = []
  selectedProbe.value = null
  venvOverride.value = null
  suggestedName.value = ''
  isOpen.value = true
  void window.api
    .getUniqueName('ComfyUI')
    .then((name) => {
      suggestedName.value = name
    })
    .catch(() => {})
}

async function handleBrowse(): Promise<void> {
  const dir = await window.api.browseFolder(trackPath.value || undefined)
  if (dir) {
    trackPath.value = dir
    await probe(dir)
  }
}

async function probe(dirPath: string): Promise<void> {
  const generation = ++probeGeneration
  lastProbedPath = dirPath.trim()
  probing.value = true
  selectedProbe.value = null
  probeResults.value = []

  let results: ProbeResult[]
  try {
    results = await window.api.probeInstallation(dirPath)
  } finally {
    // Discard if the field moved on while this probe was in flight.
    if (generation === probeGeneration) probing.value = false
  }

  // Stale response from an earlier path — drop it.
  if (generation !== probeGeneration) return
  probeResults.value = results
  if (results.length > 0) {
    selectedProbe.value = results[0] ?? null
  }
}

function onProbeSelect(value: string): void {
  const idx = parseInt(value, 10)
  selectedProbe.value = probeResults.value[idx] ?? null
  venvOverride.value = null
}

const probeOptions = computed<BaseSelectOption[]>(() =>
  probeResults.value.map((r, i) => ({ value: String(i), label: r.sourceLabel }))
)

const selectedProbeValue = computed(() => {
  if (!selectedProbe.value) return ''
  const idx = probeResults.value.indexOf(selectedProbe.value)
  return idx >= 0 ? String(idx) : ''
})

const selectPlaceholder = computed(() => {
  if (probing.value) return t('track.detecting')
  if (probeResults.value.length > 0) return ''
  return trackPath.value ? t('track.noDetected') : t('track.browseDirFirst')
})

interface DetailFieldEntry {
  label: string
  value: string
}

const detailFields = computed<DetailFieldEntry[]>(() => {
  if (!selectedProbe.value) return []
  const p = selectedProbe.value
  const fields: DetailFieldEntry[] = []
  if (p.version && p.version !== 'unknown') {
    fields.push({ label: t('track.version'), value: p.version })
  }
  if (p.repo) {
    fields.push({ label: t('track.repository'), value: p.repo })
  }
  if (p.branch) {
    fields.push({ label: t('track.branch'), value: p.branch })
  }
  return fields
})

const showVenvField = computed(() => {
  if (!selectedProbe.value) return false
  return selectedProbe.value.sourceId === 'git'
})

const effectiveVenvPath = computed(() => {
  if (venvOverride.value !== null) return venvOverride.value
  return (selectedProbe.value?.venvPath as string | undefined) || ''
})

const effectiveVenvName = computed(() => {
  const p = effectiveVenvPath.value
  if (!p) return ''
  const sep = p.includes('\\') ? '\\' : '/'
  return p.split(sep).pop() || ''
})

async function handleBrowseVenv(): Promise<void> {
  const defaultPath = effectiveVenvPath.value || trackPath.value || undefined
  const dir = await window.api.browseFolder(defaultPath)
  if (dir) {
    venvOverride.value = dir
  }
}

async function handleSave(): Promise<void> {
  if (!selectedProbe.value) return

  const name = trackName.value.trim() || `ComfyUI (${selectedProbe.value.sourceLabel})`

  const rawProbe = JSON.parse(JSON.stringify(toRaw(selectedProbe.value))) as Record<string, unknown>
  if (venvOverride.value !== null) {
    rawProbe.venvPath = venvOverride.value
  }
  const data: Record<string, unknown> = {
    name,
    installPath: trackPath.value,
    ...rawProbe
  }

  const result = await window.api.trackInstallation(data)
  if (!result.ok) {
    await modal.alert({
      title: t('track.cannotTrack'),
      message: result.message || ''
    })
    return
  }
  emitTelemetryAction('comfy.desktop.track_existing.saved', {
    detected_source_label: selectedProbe.value.sourceLabel || 'unknown',
    probe_count_bucket: toCountBucket(probeResults.value.length),
    custom_name_used: trackName.value.trim().length > 0
  })
  isOpen.value = false
  emit('close')
  emit('navigate-list')
}

defineExpose({ open })
</script>

<template>
  <BrandTakeoverLayout v-if="isOpen">
    <div class="track-shell" data-testid="track-modal">
      <h1 class="brand-title">{{ $t('track.grandTitle') }}</h1>
      <p class="brand-lead">{{ $t('track.grandSubtitle') }}</p>
      <div
        ref="cardRef"
        class="brand-card"
        role="dialog"
        aria-modal="true"
        :aria-label="$t('track.grandTitle')"
      >
        <div class="brand-card__body">
          <div class="track-field">
            <label class="track-label" for="track-path">{{ $t('track.installDir') }}</label>
            <div class="track-path-row">
              <div class="brand-input track-path-input">
                <HardDrive :size="14" aria-hidden="true" />
                <input
                  id="track-path"
                  v-model="trackPath"
                  type="text"
                  :placeholder="$t('track.selectDir')"
                />
              </div>
              <button class="brand-tertiary" type="button" @click="handleBrowse">
                {{ $t('common.browse') }}
              </button>
            </div>
          </div>

          <div class="track-field">
            <label class="track-label" for="track-name">{{ $t('common.name') }}</label>
            <div class="brand-input">
              <input
                id="track-name"
                v-model="trackName"
                type="text"
                :placeholder="suggestedName || $t('common.namePlaceholder')"
              />
            </div>
          </div>

          <div class="track-field">
            <label class="track-label">{{ $t('track.detectedType') }}</label>
            <BaseSelect
              :model-value="selectedProbeValue"
              :options="probeOptions"
              :placeholder="selectPlaceholder"
              :disabled="probing || probeResults.length <= 1"
              :aria-label="$t('track.detectedType')"
              @update:model-value="onProbeSelect"
            />
          </div>

          <div v-if="detailFields.length > 0" class="brand-summary">
            <div v-for="field in detailFields" :key="field.label" class="brand-summary__row">
              <span class="brand-summary__label">{{ field.label }}</span>
              <span class="brand-summary__value">{{ field.value }}</span>
            </div>
          </div>

          <div v-if="showVenvField" class="track-field">
            <label class="track-label">{{ $t('git.venv') }}</label>
            <div class="track-path-row">
              <div class="brand-input track-path-input">
                <HardDrive :size="14" aria-hidden="true" />
                <input type="text" :value="effectiveVenvName || $t('git.venvNotFound')" disabled />
              </div>
              <button class="brand-tertiary" type="button" @click="handleBrowseVenv">
                {{ $t('common.browse') }}
              </button>
            </div>
          </div>
        </div>

        <div class="brand-card__footer">
          <button class="brand-primary track-save" :disabled="saveDisabled" @click="handleSave">
            {{ $t('track.trackInstallation') }}
          </button>
        </div>
      </div>
    </div>
    <template #footer-left>
      <TakeoverBack
        class="track-back-to-dashboard"
        :label="$t('common.backToDashboard')"
        @back="emit('close')"
      />
    </template>
  </BrandTakeoverLayout>
</template>

<style scoped>
.track-shell {
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

.track-back-to-dashboard {
  position: absolute;
  left: clamp(1.25rem, 2vw, 2rem);
  bottom: clamp(1.25rem, 2vw, 2rem);
  z-index: 2;
}

.track-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.track-label {
  font-size: 13px;
  color: var(--neutral-200);
}

.track-path-row {
  display: flex;
  gap: 8px;
  align-items: stretch;
}
.track-path-row > .track-path-input,
.track-path-row > button.brand-tertiary {
  height: 40px;
  padding-block: 0;
  display: flex;
  align-items: center;
}
.track-path-input {
  flex: 1 1 auto;
  min-width: 0;
  padding-inline: 12px;
}
.track-path-row > button.brand-tertiary {
  padding-inline: 14px;
  font-size: 13px;
}

.track-save {
  min-width: 120px;
}
</style>
