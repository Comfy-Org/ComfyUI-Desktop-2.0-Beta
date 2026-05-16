<script setup lang="ts">
import { ref, computed, toRaw } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, HardDrive } from 'lucide-vue-next'
import { useModal } from '../composables/useModal'
import TakeoverBack from '../components/TakeoverBack.vue'
import BrandTakeoverLayout from '../components/BrandTakeoverLayout.vue'

import type { ProbeResult } from '../types/ipc'
import { emitTelemetryAction, toCountBucket } from '../lib/telemetry'

const emit = defineEmits<{
  close: []
  'navigate-list': []
}>()

const { t } = useI18n()
const modal = useModal()

const trackPath = ref('')
const trackName = ref('')
const probeResults = ref<ProbeResult[]>([])
const selectedProbe = ref<ProbeResult | null>(null)
const venvOverride = ref<string | null>(null)
const probing = ref(false)


const saveDisabled = computed(() => !trackPath.value || !selectedProbe.value)

function open(): void {
  trackPath.value = ''
  trackName.value = ''
  probeResults.value = []
  selectedProbe.value = null
  venvOverride.value = null
}

async function handleBrowse(): Promise<void> {
  const dir = await window.api.browseFolder(trackPath.value || undefined)
  if (dir) {
    trackPath.value = dir
    await probe(dir)
  }
}

async function probe(dirPath: string): Promise<void> {
  probing.value = true
  selectedProbe.value = null
  probeResults.value = []

  try {
    probeResults.value = await window.api.probeInstallation(dirPath)
  } finally {
    probing.value = false
  }

  if (probeResults.value.length > 0) {
    selectedProbe.value = probeResults.value[0] ?? null
  }
}

function handleSourceChange(event: Event): void {
  const idx = parseInt((event.target as HTMLSelectElement).value, 10)
  selectedProbe.value = probeResults.value[idx] ?? null
  venvOverride.value = null
}

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

const detectedTriggerLabel = computed(() => {
  if (probing.value) return t('track.detecting')
  if (probeResults.value.length === 0) {
    return trackPath.value ? t('track.noDetected') : t('track.browseDirFirst')
  }
  return selectedProbe.value?.sourceLabel || ''
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

  const name =
    trackName.value.trim() ||
    `ComfyUI (${selectedProbe.value.sourceLabel})`

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
  emitTelemetryAction('desktop2.track_existing.saved', {
    detected_source_label: selectedProbe.value.sourceLabel || 'unknown',
    probe_count_bucket: toCountBucket(probeResults.value.length),
    custom_name_used: trackName.value.trim().length > 0,
  })
  emit('close')
  emit('navigate-list')
}

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
      <h1 class="brand-title">{{ $t('track.grandTitle') }}</h1>
      <p class="brand-lead">{{ $t('track.grandSubtitle') }}</p>
      <div class="config-card">
        <div class="config-card__body">
          <!-- Track path -->
          <div class="config-field">
            <label class="config-label" for="track-path">{{ $t('track.installDir') }}</label>
            <div class="config-path-row">
              <div class="brand-input config-path-input">
                <HardDrive :size="14" aria-hidden="true" />
                <input
                  id="track-path"
                  v-model="trackPath"
                  type="text"
                  :placeholder="$t('track.selectDir')"
                />
              </div>
              <button class="brand-secondary" type="button" @click="handleBrowse">
                {{ $t('common.browse') }}
              </button>
            </div>
          </div>

          <!-- Installation name -->
          <div class="config-field">
            <label class="config-label" for="track-name">{{ $t('common.name') }}</label>
            <div class="brand-input">
              <input
                id="track-name"
                v-model="trackName"
                type="text"
                :placeholder="$t('common.namePlaceholder')"
              />
            </div>
          </div>

          <!-- Detected type -->
          <div class="config-field">
            <label class="config-label" for="track-source">{{ $t('track.detectedType') }}</label>
            <div
              v-if="probing"
              class="brand-input config-select brand-input--readonly with-spinner"
              role="textbox"
              aria-readonly="true"
            >
              <span class="config-select__value">{{ $t('track.detecting') }}</span>
            </div>
            <div v-else class="brand-input brand-select">
              <span class="brand-select__trigger" aria-hidden="true">
                <span class="brand-select__trigger-value">{{ detectedTriggerLabel }}</span>
                <ChevronDown :size="14" class="brand-select__trigger-chevron" />
              </span>
              <select
                id="track-source"
                :disabled="probeResults.length <= 1"
                @change="handleSourceChange"
              >
                <option v-if="probeResults.length === 0">
                  {{ detectedTriggerLabel }}
                </option>
                <template v-else>
                  <option
                    v-for="(r, i) in probeResults"
                    :key="i"
                    :value="i"
                  >
                    {{ r.sourceLabel }}
                  </option>
                </template>
              </select>
            </div>
          </div>

          <!-- Probe detail fields -->
          <div v-if="detailFields.length > 0" class="detail-fields">
            <div v-for="field in detailFields" :key="field.label">
              <div class="detail-field-label">{{ field.label }}</div>
              <div class="detail-field-value">{{ field.value }}</div>
            </div>
          </div>

          <!-- Virtual environment selector (git source) -->
          <div v-if="showVenvField" class="config-field">
            <label class="config-label">{{ $t('git.venv') }}</label>
            <div class="config-path-row">
              <div
                class="brand-input config-path-input config-select brand-input--readonly"
                role="textbox"
                aria-readonly="true"
              >
                <HardDrive :size="14" aria-hidden="true" />
                <span class="config-select__value">{{ effectiveVenvName || $t('git.venvNotFound') }}</span>
              </div>
              <button class="brand-secondary" type="button" @click="handleBrowseVenv">
                {{ $t('common.browse') }}
              </button>
            </div>
          </div>
        </div>

        <div class="config-card__footer">
          <button
            class="primary config-continue"
            :disabled="saveDisabled"
            @click="handleSave"
          >
            {{ $t('track.trackInstallation') }}
          </button>
        </div>
      </div>
    </div>
  </BrandTakeoverLayout>
</template>

<style scoped>
/* Probe detail rows — compact label/value pairs surfaced after a
 * successful probe. Tokens align with the brand-card copy palette. */
.detail-fields {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--brand-surface-border);
  border-radius: 6px;
  background: var(--brand-surface-bg);
}
.detail-field-label {
  font-size: 12px;
  color: var(--neutral-300);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.detail-field-value {
  font-size: 13px;
  color: var(--neutral-100);
  word-break: break-all;
  margin-top: 2px;
}
</style>
