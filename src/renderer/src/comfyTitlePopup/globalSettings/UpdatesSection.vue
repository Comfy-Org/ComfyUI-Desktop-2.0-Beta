<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import ChannelPicker from '../../views/comfyUISettings/ChannelPicker.vue'
import { formatBytes, formatSpeed } from '../../lib/downloadFormatters'
import type {
  ActionDef,
  AppUpdateDownloadProgress,
  AppUpdateState,
  DetailField,
} from '../../types/ipc'

/**
 * Updates accordion body for the Global Settings panel.
 *
 * Bespoke renderer — the Updates section is not field-shaped. It's a
 * launcher-update status grid (Installed / Latest / Platform / Last
 * Checked / Status) plus a tri-button row (Update Now / Check For
 * Update) plus, when the host has an active install, the existing
 * `ChannelPicker.vue` (drives Update Channel + Copy & Update + Switch
 * Channel actions via main's payload-embedded `option.data.actions`).
 *
 * All state + handlers come from props — the parent (`useGlobalSettings`
 * composable) owns IPC subscriptions and the runAction dispatcher.
 */

interface Props {
  state: AppUpdateState
  progress: AppUpdateDownloadProgress | null
  isDownloading: boolean
  checking: boolean
  lastCheckedAt: number | null
  installedVersion: string
  platformLabel: string
  /** From the active install's Update tab, when one exists. Null on
   *  chooser hosts or cloud installs — the picker (and Copy & Update
   *  action bundled inside it) is hidden in those cases. */
  channelPickerField: DetailField | null
}

const props = defineProps<Props>()

const emit = defineEmits<{
  'update-now': []
  'check-for-update': []
  'install-action': [action: ActionDef]
}>()

const { t, d } = useI18n()

const versionLabel = computed(() =>
  props.state.version ? `v${props.state.version}` : t('appUpdate.fallbackVersion'),
)

const statusText = computed(() => {
  if (props.isDownloading) {
    return t('appUpdate.panelDownloadingTitle', { version: versionLabel.value })
  }
  switch (props.state.kind) {
    case 'ready':
      return t('appUpdate.panelReadyTitle', { version: versionLabel.value })
    case 'available':
      return t('appUpdate.panelAvailableTitle', { version: versionLabel.value })
    default:
      return t('appUpdate.panelIdleTitle')
  }
})

const updateNowLabel = computed(() => {
  if (props.checking) return t('settings.checkingForUpdates')
  if (props.isDownloading) return t('appUpdate.downloading')
  switch (props.state.kind) {
    case 'ready':
      return t('appUpdate.restartNow')
    case 'available':
      return t('appUpdate.download')
    default:
      return t('settings.checkForUpdates')
  }
})

const updateNowDisabled = computed(() => props.checking || props.isDownloading)

const latestVersionLabel = computed(() =>
  props.state.version ? `v${props.state.version}` : '—',
)

const lastCheckedLabel = computed(() => {
  if (!props.lastCheckedAt) return '—'
  try {
    return d(new Date(props.lastCheckedAt), 'long')
  } catch {
    return new Date(props.lastCheckedAt).toLocaleString()
  }
})

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
    <!-- Status grid (read-only rows). -->
    <dl class="updates-status">
      <div class="updates-status-row">
        <dt>{{ t('channelCards.installedVersion', 'Installed Version') }}</dt>
        <dd>{{ installedVersion ? `v${installedVersion}` : '—' }}</dd>
      </div>
      <div class="updates-status-row">
        <dt>{{ t('channelCards.latestVersion', 'Latest Version') }}</dt>
        <dd>{{ latestVersionLabel }}</dd>
      </div>
      <div class="updates-status-row">
        <dt>{{ t('settings.platform', 'Platform') }}</dt>
        <dd>{{ platformLabel }}</dd>
      </div>
      <div class="updates-status-row">
        <dt>{{ t('channelCards.lastChecked', 'Last Checked') }}</dt>
        <dd>{{ lastCheckedLabel }}</dd>
      </div>
      <div class="updates-status-row">
        <dt>{{ t('channelCards.status', 'Status') }}</dt>
        <dd>{{ statusText }}</dd>
      </div>
    </dl>

    <!-- Install-scoped Update Channel + bundled actions (Update Now /
         Copy & Update / Switch Channel). Hidden when the host has no
         active install — the launcher-level Update Now / Check For
         Update buttons below still render. -->
    <ChannelPicker
      v-if="channelPickerField"
      :field="channelPickerField"
      @action="(a) => emit('install-action', a)"
    />

    <!-- Launcher-level action buttons. Rendered only when no channel
         picker is present (i.e. install-less host) — the picker already
         surfaces an Update Now button bundled into its own action row,
         so showing two would be confusing. -->
    <div v-if="!channelPickerField" class="updates-actions">
      <button
        type="button"
        class="updates-action primary"
        :disabled="updateNowDisabled"
        @click="emit('update-now')"
      >
        {{ updateNowLabel }}
      </button>
      <button
        type="button"
        class="updates-action"
        :disabled="updateNowDisabled"
        @click="emit('check-for-update')"
      >
        {{ t('settings.checkForUpdates') }}
      </button>
    </div>

    <!-- Download progress bar — shown whenever a launcher download is
         in flight regardless of which surface kicked it off. -->
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
</template>

<style scoped>
.updates-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* Status grid — label/value pairs separated by hairline dividers.
   Mirrors ChannelPicker's preview-card row chrome so the two read as
   one design language. */
.updates-status {
  margin: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--chooser-surface-border);
  border-radius: 8px;
  padding: 4px 12px;
}

.updates-status-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 0;
  border-top: 1px solid var(--border-hover);
}

.updates-status-row:first-child {
  padding-top: 8px;
  border-top: none;
}

.updates-status-row:last-child {
  padding-bottom: 8px;
}

.updates-status dt {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 16px;
}

.updates-status dd {
  margin: 0;
  font-size: 14px;
  line-height: 21px;
  color: var(--neutral-100);
}

.updates-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.updates-action {
  flex: 1 1 0;
  min-height: 32px;
  padding: 8px 16px;
  border-radius: 8px;
  border: 1px solid var(--chooser-surface-border);
  background: var(--brand-surface-bg);
  color: var(--neutral-100);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 100ms ease, filter 100ms ease;
}

.updates-action:hover:not(:disabled),
.updates-action:focus-visible:not(:disabled) {
  background: var(--brand-surface-bg-hover);
  outline: none;
}

.updates-action.primary {
  border-color: var(--accent-primary, #0b8ce9);
  background: var(--accent-primary, #0b8ce9);
  color: var(--text);
}

.updates-action.primary:hover:not(:disabled),
.updates-action.primary:focus-visible:not(:disabled) {
  filter: brightness(1.08);
  background: var(--accent-primary, #0b8ce9);
}

.updates-action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Progress bar — visual match with AppUpdateAction.vue's existing
   rules so the download UX reads identically. */
.updates-progress {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.progress-bar-track {
  position: relative;
  height: 4px;
  border-radius: 9999px;
  background: var(--brand-surface-bg);
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
    var(--brand-surface-bg) 0%,
    var(--accent-primary, #0b8ce9) 50%,
    var(--brand-surface-bg) 100%
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
  font-size: 12px;
  color: var(--text-muted);
}
</style>
