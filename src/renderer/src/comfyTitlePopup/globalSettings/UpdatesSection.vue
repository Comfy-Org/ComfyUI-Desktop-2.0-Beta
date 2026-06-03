<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import SettingsSectionList from '../../views/comfyUISettings/SettingsSectionList.vue'
import { formatRelativeFromMs } from '../../lib/datetime'
import { formatBytes, formatSpeed } from '../../lib/downloadFormatters'
import type {
  AppUpdateDownloadProgress,
  AppUpdateState,
  DetailField,
  DetailSection
} from '../../types/ipc'

/**
 * Desktop-only Updates tab. Presents human-readable status first,
 * version/build as secondary detail, and a single inset card that
 * groups status + metadata + actions.
 */

interface Props {
  state: AppUpdateState
  progress: AppUpdateDownloadProgress | null
  isDownloading: boolean
  checking: boolean
  lastCheckedAt: number | null
  installedVersion: string
  systemManaged?: boolean
  preferenceFields?: DetailField[]
}

const props = withDefaults(defineProps<Props>(), {
  systemManaged: false,
  preferenceFields: () => []
})

const emit = defineEmits<{
  'update-now': []
  'check-for-update': []
  'update-field': [field: DetailField, value: unknown]
}>()

const { t, d } = useI18n()

function formatVersionLabel(raw: string | undefined | null): string {
  if (!raw) return '—'
  const trimmed = raw.trim()
  if (trimmed.startsWith('v') || trimmed.startsWith('V')) return trimmed
  return `v${trimmed}`
}

function normalizeVersion(raw: string | undefined | null): string {
  if (!raw) return ''
  return raw.trim().replace(/^[vV]/, '').toLowerCase()
}

const targetVersionLabel = computed(() => {
  if (props.state.version) return formatVersionLabel(props.state.version)
  return t('appUpdate.fallbackVersion', 'this update')
})

const statusSentence = computed(() => {
  if (props.isDownloading || props.state.kind === 'downloading') {
    return t(
      'appUpdate.panelDownloadingTitle',
      {
        version: targetVersionLabel.value
      },
      'Downloading update…'
    )
  }
  switch (props.state.kind) {
    case 'ready':
      return t(
        'appUpdate.panelReadyTitle',
        {
          version: targetVersionLabel.value
        },
        'Update ready to install'
      )
    case 'available':
      return t(
        'appUpdate.panelAvailableTitle',
        {
          version: targetVersionLabel.value
        },
        'Update available'
      )
    default:
      return t('appUpdate.panelIdleTitle', 'ComfyUI Desktop is up to date')
  }
})

const statusTone = computed(() => {
  if (props.isDownloading || props.state.kind === 'downloading') return 'downloading'
  if (props.state.kind === 'available' || props.state.kind === 'ready') return 'update'
  return 'current'
})

const installedDetail = computed(() => {
  if (!props.installedVersion) return null
  return t(
    'appUpdate.installedLabel',
    { version: formatVersionLabel(props.installedVersion) },
    `Installed ${formatVersionLabel(props.installedVersion)}`
  )
})

const lastCheckedDetail = computed(() => {
  if (!props.lastCheckedAt) return null
  let title: string | undefined
  try {
    title = d(new Date(props.lastCheckedAt), 'long')
  } catch {
    title = new Date(props.lastCheckedAt).toLocaleString()
  }
  const time = formatRelativeFromMs(props.lastCheckedAt, t)
  return {
    text: t('appUpdate.lastCheckedLabel', { time }, `Last checked ${time}`),
    title
  }
})

const latestDetail = computed(() => {
  if (!props.state.version) return null
  const installed = normalizeVersion(props.installedVersion)
  const latest = normalizeVersion(props.state.version)
  if (!latest || installed === latest) return null
  return t(
    'appUpdate.latestLabel',
    { version: formatVersionLabel(props.state.version) },
    `Latest ${formatVersionLabel(props.state.version)}`
  )
})

const preferenceSections = computed<DetailSection[]>(() =>
  props.preferenceFields.length > 0 ? [{ fields: props.preferenceFields }] : []
)

const primaryActionLabel = computed(() => {
  if (props.checking) return t('settings.checkingForUpdates', 'Checking…')
  if (props.isDownloading) return t('appUpdate.downloading', 'Downloading…')
  switch (props.state.kind) {
    case 'ready':
      return t('appUpdate.restartNow', 'Restart & update')
    case 'available':
      return t('appUpdate.download', 'Download')
    default:
      return t('settings.checkForUpdates', 'Check for updates')
  }
})

const showSecondaryCheck = computed(
  () => props.state.kind === 'available' || props.state.kind === 'ready'
)

const actionsDisabled = computed(() => props.checking || props.isDownloading)

const percent = computed<number | null>(() => {
  const p = props.progress?.percent
  if (typeof p !== 'number') return null
  return Math.max(0, Math.min(100, Math.round(p)))
})

const progressDetail = computed<string | null>(() => {
  const p = props.progress
  if (!p) return null
  const parts: string[] = []
  if (p.transferred !== null && p.total !== null) {
    parts.push(`${formatBytes(p.transferred)} / ${formatBytes(p.total)}`)
  }
  if (p.bytesPerSecond !== null && p.bytesPerSecond > 0) {
    parts.push(formatSpeed(p.bytesPerSecond))
  }
  return parts.length > 0 ? parts.join(' · ') : null
})
</script>

<template>
  <div class="updates-section">
    <div class="updates-card">
      <div class="updates-card-body">
        <p class="updates-status" :class="statusTone">
          {{ statusSentence }}
        </p>

        <div v-if="installedDetail || lastCheckedDetail || latestDetail" class="updates-details">
          <span v-if="installedDetail" class="updates-detail">{{ installedDetail }}</span>
          <span v-if="lastCheckedDetail" class="updates-detail" :title="lastCheckedDetail.title">{{
            lastCheckedDetail.text
          }}</span>
          <span v-if="latestDetail" class="updates-detail is-highlight">{{ latestDetail }}</span>
        </div>

        <p v-if="systemManaged" class="updates-note">
          {{
            t(
              'appUpdate.systemManagedNote',
              'Updates for this install are delivered through your system package manager.'
            )
          }}
        </p>

        <div v-if="isDownloading" class="updates-progress">
          <div class="progress-bar-track" :class="{ indeterminate: percent === null }">
            <div
              v-if="percent !== null"
              class="progress-bar-fill"
              :style="{ width: percent + '%' }"
            ></div>
          </div>
          <div class="updates-progress-detail">
            <span v-if="percent !== null">{{ percent }}%</span>
            <span v-if="progressDetail">{{ progressDetail }}</span>
          </div>
        </div>
      </div>

      <div class="updates-card-footer">
        <button
          v-if="showSecondaryCheck"
          type="button"
          class="updates-action"
          :disabled="actionsDisabled"
          @click="emit('check-for-update')"
        >
          {{ t('settings.checkForUpdates', 'Check for updates') }}
        </button>
        <button
          type="button"
          class="updates-action accent"
          :disabled="actionsDisabled"
          @click="emit('update-now')"
        >
          {{ primaryActionLabel }}
        </button>
      </div>
    </div>

    <SettingsSectionList
      v-if="preferenceSections.length > 0"
      :sections="preferenceSections"
      @update-field="(field, value) => emit('update-field', field, value)"
    />
  </div>
</template>

<style scoped>
.updates-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.updates-card {
  border: 1px solid var(--chooser-surface-border);
  border-radius: 8px;
  background: var(--brand-surface-bg);
  overflow: hidden;
}

.updates-card-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 14px 12px;
}

.updates-status {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
  color: var(--neutral-100);
}

.updates-status.update {
  color: var(--accent);
}

.updates-status.downloading {
  color: var(--accent-primary, #0b8ce9);
}

.updates-details {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.updates-detail {
  font-size: 12px;
  line-height: 17px;
  color: var(--text-muted);
}

.updates-detail.is-highlight {
  color: var(--accent);
  font-weight: 500;
}

.updates-note {
  margin: 0;
  font-size: 11px;
  line-height: 16px;
  color: var(--text-muted);
  opacity: 0.85;
}

.updates-card-footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  padding: 10px 14px 12px;
  border-top: 1px solid var(--border-hover);
}

.updates-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  height: 32px;
  min-height: 32px;
  padding: 0 16px;
  border-radius: 8px;
  border: 1px solid var(--chooser-surface-border);
  background: var(--brand-surface-bg);
  color: var(--neutral-100);
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  box-sizing: border-box;
  transition: background-color 100ms ease;
}

.updates-action:hover:not(:disabled),
.updates-action:focus-visible:not(:disabled) {
  background: var(--brand-surface-bg-hover);
  outline: none;
}

.updates-action.accent {
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}

.updates-action:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.updates-action.accent:disabled:hover {
  background: var(--brand-surface-bg-hover);
}
.updates-progress {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 4px;
}

.progress-bar-track {
  position: relative;
  height: 4px;
  border-radius: 9999px;
  background: color-mix(in oklab, var(--neutral-100) 6%, transparent);
  overflow: hidden;
}

.progress-bar-fill {
  position: absolute;
  inset: 0 auto 0 0;
  background: var(--accent-primary, #0b8ce9);
  transition: width 120ms ease;
}

.progress-bar-track.indeterminate {
  background: linear-gradient(
    90deg,
    color-mix(in oklab, var(--neutral-100) 6%, transparent) 0%,
    var(--accent-primary, #0b8ce9) 50%,
    color-mix(in oklab, var(--neutral-100) 6%, transparent) 100%
  );
  background-size: 200% 100%;
  animation: progress-indeterminate 1.4s linear infinite;
}

@keyframes progress-indeterminate {
  0% {
    background-position: 200% 0;
  }
  100% {
    background-position: -200% 0;
  }
}

.updates-progress-detail {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--text-muted);
}
</style>
