<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AppUpdateState, AppUpdateDownloadProgress } from '../types/ipc'

/**
 * "Desktop Updates" settings section. State-driven panel that mirrors
 * the title-bar app-update pill:
 *
 *   - kind === null            → "Up to date" + Check for Updates
 *   - kind === 'available'     → "Update {v} available" + Download
 *                                (transitions to a progress bar +
 *                                 "Downloading…" while the download
 *                                 is in flight)
 *   - kind === 'ready'         → "Update {v} ready"     + Restart & Update
 *
 * Owns its own update-state, download-progress, and user-action-failed
 * subscriptions so it stays in sync without the parent SettingsView
 * having to plumb the data through.
 *
 * Renders as a full `.settings-section` so it sits in the same
 * vertical stack as the SettingsSections-rendered sections (General,
 * Telemetry, Cache, …) without any layout asymmetry.
 *
 * The renderer-side `downloading` flag is local — main does not push a
 * dedicated downloading-state event. We flip it true when the user
 * clicks Download and false when:
 *   - the cached state transitions to `'ready'` (download finished)
 *     or back to `null`
 *   - main broadcasts `app-update:user-action-failed` (download or
 *     install failed)
 *
 * Without the failure subscription the button would stay stuck on
 * "Downloading…" forever after a network error, since the IPC
 * `downloadUpdate()` resolves immediately after kicking off the
 * background download.
 */

const { t } = useI18n()

const emit = defineEmits<{
  /** Bubble main's "no update available" / "error" alert up to
   *  SettingsView so the parent (which already owns useModal +
   *  knows whether the install is system-managed) can surface it
   *  via the unified alert chrome with the right copy. */
  upToDate: []
  checkError: [message: string]
}>()

const updateState = ref<AppUpdateState>({ kind: null, version: null, autoUpdate: true })
const checking = ref(false)
/** Local "in-flight" flag flipped true the instant the user clicks
 *  Download — bridges the gap between click and the first
 *  `download-progress` tick (which transitions cached
 *  state.kind → `'downloading'`). Cleared by `onStateChanged` when
 *  the kind moves away from `'available'` / `'downloading'`. */
const downloadStarting = ref(false)
const progress = ref<AppUpdateDownloadProgress | null>(null)

/** Single source of truth: either main has flipped state to
 *  `'downloading'`, or the user just clicked Download and we're
 *  waiting on the first tick. */
const isDownloading = computed(
  () => downloadStarting.value || updateState.value.kind === 'downloading',
)

let unsubState: (() => void) | null = null
let unsubProgress: (() => void) | null = null
let unsubFailed: (() => void) | null = null

async function loadInitialState(): Promise<void> {
  try {
    updateState.value = await window.api.getAppUpdateState()
  } catch {
    // Defensive — leave default null state in place.
  }
}

function onStateChanged(next: AppUpdateState): void {
  // Once the cached state moves out of the available/downloading
  // window (i.e. download finished → 'ready', or someone reset to
  // null) the local "starting" flag and any progress payload must
  // clear so the panel renders the new CTA fresh.
  if (next.kind !== 'available' && next.kind !== 'downloading') {
    downloadStarting.value = false
    progress.value = null
  }
  updateState.value = next
}

function onDownloadProgress(next: AppUpdateDownloadProgress): void {
  progress.value = next
}

function onUserActionFailed(): void {
  // Clear local flag + progress so the user can retry. The cached
  // state is rolled back to 'available' by main's error handler.
  // Error alert itself surfaces via PanelApp's existing listener —
  // we don't double-pop a modal here.
  downloadStarting.value = false
  progress.value = null
}

onMounted(() => {
  void loadInitialState()
  unsubState = window.api.onAppUpdateStateChanged(onStateChanged)
  unsubProgress = window.api.onAppUpdateDownloadProgress(onDownloadProgress)
  unsubFailed = window.api.onAppUpdateUserActionFailed(onUserActionFailed)
})

onUnmounted(() => {
  unsubState?.()
  unsubProgress?.()
  unsubFailed?.()
})

const versionLabel = computed(() =>
  updateState.value.version
    ? `v${updateState.value.version}`
    : t('appUpdate.fallbackVersion'),
)

const statusText = computed(() => {
  if (isDownloading.value) {
    return t('appUpdate.panelDownloadingTitle', { version: versionLabel.value })
  }
  switch (updateState.value.kind) {
    case 'ready':
      return t('appUpdate.panelReadyTitle', { version: versionLabel.value })
    case 'available':
      return t('appUpdate.panelAvailableTitle', { version: versionLabel.value })
    default:
      return t('appUpdate.panelIdleTitle')
  }
})

const buttonLabel = computed(() => {
  if (checking.value) return t('settings.checkingForUpdates')
  if (isDownloading.value) return t('appUpdate.downloading')
  switch (updateState.value.kind) {
    case 'ready':
      return t('appUpdate.restartNow')
    case 'available':
      return t('appUpdate.download')
    default:
      return t('settings.checkForUpdates')
  }
})

const buttonDisabled = computed(() => checking.value || isDownloading.value)

/** Clamped 0..100 percent for the bar fill. Null when no progress
 *  tick has arrived yet (the bar still renders in indeterminate mode
 *  so the user has feedback before the first byte). */
const percent = computed<number | null>(() => {
  const p = progress.value?.percent
  if (typeof p !== 'number') return null
  return Math.max(0, Math.min(100, Math.round(p)))
})

/** Tiny "12.4 MB / 30.1 MB · 1.5 MB/s" caption under the bar; only
 *  rendered when main has sent at least one tick. */
const progressDetail = computed<string | null>(() => {
  const p = progress.value
  if (!p) return null
  const parts: string[] = []
  if (p.transferred !== null && p.total !== null) {
    parts.push(`${formatBytes(p.transferred)} / ${formatBytes(p.total)}`)
  }
  if (p.bytesPerSecond !== null && p.bytesPerSecond > 0) {
    parts.push(`${formatBytes(p.bytesPerSecond)}/s`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
})

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

async function handleClick(): Promise<void> {
  if (buttonDisabled.value) return
  const kind = updateState.value.kind
  if (kind === 'ready') {
    await window.api.installUpdate()
    return
  }
  if (kind === 'available') {
    downloadStarting.value = true
    progress.value = null
    try {
      await window.api.downloadUpdate()
    } catch {
      // Failure surfaces via onAppUpdateUserActionFailed; the IPC
      // promise itself rarely rejects, so this catch is defensive.
      downloadStarting.value = false
      progress.value = null
    }
    return
  }
  checking.value = true
  try {
    const result = await window.api.checkForUpdate()
    if (result.error) {
      emit('checkError', result.error)
    } else if (!result.available) {
      // No newer version than what's installed AND no cached
      // available/ready state arrived during the check — surface the
      // "you're on the latest" alert. If a state push DID arrive (the
      // check found something), the panel rerenders with the new
      // status + CTA and we skip the alert.
      if (updateState.value.kind === null) {
        emit('upToDate')
      }
    }
  } finally {
    checking.value = false
  }
}
</script>

<template>
  <div class="settings-section">
    <div class="detail-section-title">{{ $t('appUpdate.sectionTitle') }}</div>
    <div class="detail-fields app-update-fields">
      <div class="app-update-row">
        <div class="app-update-status">{{ statusText }}</div>
        <button
          type="button"
          class="app-update-button"
          :disabled="buttonDisabled"
          @click="handleClick"
        >
          {{ buttonLabel }}
        </button>
      </div>
      <div v-if="isDownloading" class="app-update-progress">
        <div
          class="progress-bar-track"
          :class="{ indeterminate: percent === null }"
        >
          <div
            v-if="percent !== null"
            class="progress-bar-fill"
            :style="{ width: percent + '%' }"
          ></div>
        </div>
        <div class="app-update-progress-detail">
          <span v-if="percent !== null">{{ percent }}%</span>
          <span v-if="progressDetail">{{ progressDetail }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app-update-fields {
  flex-direction: column;
  align-items: stretch;
  gap: 10px;
}
.app-update-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.app-update-status {
  flex: 1;
  font-size: 14px;
}
.app-update-button {
  flex-shrink: 0;
}
.app-update-progress {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.app-update-progress .progress-bar-track {
  margin-bottom: 0;
}
.app-update-progress-detail {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-muted);
}
</style>
