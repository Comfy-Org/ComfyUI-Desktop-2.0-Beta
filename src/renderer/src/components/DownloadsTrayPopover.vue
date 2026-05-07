<script setup lang="ts">
/**
 * Track F — Tier 1 popover surfaced by the title-bar downloads tray.
 * `PanelApp.vue` mounts this when `currentOverlay.kind === 'downloads'`.
 *
 * The popover is the new home of the downloads UI that used to be
 * injected into the ComfyUI page surface by `comfyContentScript.ts`
 * — pulling the affordance out of ComfyUI's namespace and into the
 * Launcher chrome where it belongs. Reads the same `downloadStore`
 * the `DownloadsPanel` consumes so the in-launcher list and the
 * tray popover never disagree about what's in flight.
 *
 * Pinned to the top-right corner via `position: fixed` so it overlays
 * whatever panel is mounted underneath. Emits `close` for the host to
 * route through `dismissTakeoverDirect` (the popover doesn't need the
 * cancel-prompt that Tier 2/3 ops do — closing the popover only
 * dismisses the overlay; the underlying downloads keep running and
 * the next broadcast repaints).
 */
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowDownToLine,
  CheckCircle2,
  PauseCircle,
  PlayCircle,
  XCircle,
} from 'lucide-vue-next'
import { useDownloadStore } from '../stores/downloadStore'
import { formatBytes } from '../lib/formatting'
import type { ModelDownloadProgress } from '../types/ipc'

const { t } = useI18n()
const downloadStore = useDownloadStore()

defineEmits<{ close: [] }>()

onMounted(() => {
  // Idempotent — the store no-ops the second init() call. We init
  // here defensively in case the popover opens before the panel
  // renderer has called `init()` on its own (e.g. on a fresh
  // chooser-host window where DownloadsPanel was never mounted).
  downloadStore.init()
})

function fmtSpeed(bytesPerSec: number): string {
  if (bytesPerSec < 1048576) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`
  return `${(bytesPerSec / 1048576).toFixed(1)} MB/s`
}

function fmtEta(seconds: number): string {
  if (seconds < 60) return `${Math.ceil(seconds)}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s`
  const h = Math.floor(seconds / 3600)
  const m = Math.ceil((seconds % 3600) / 60)
  return `${h}h ${m}m`
}

function statusLine(d: ModelDownloadProgress): string {
  const pct = Math.round(d.progress * 100)
  switch (d.status) {
    case 'pending':
      return t('downloads.pending')
    case 'downloading': {
      const parts: string[] = []
      if (d.totalBytes && d.totalBytes > 0 && d.receivedBytes != null) {
        parts.push(`${formatBytes(d.receivedBytes)} / ${formatBytes(d.totalBytes)}`)
      }
      parts.push(`${pct}%`)
      if (d.speedBytesPerSec && d.speedBytesPerSec > 0) {
        parts.push(fmtSpeed(d.speedBytesPerSec))
      }
      if (d.etaSeconds != null && d.etaSeconds > 0 && isFinite(d.etaSeconds)) {
        parts.push(fmtEta(d.etaSeconds))
      }
      return parts.join(' · ')
    }
    case 'paused':
      return t('downloads.paused', { percent: pct })
    case 'completed':
      return t('downloads.completed')
    case 'error':
      return d.error || t('downloads.error')
    case 'cancelled':
      return t('downloads.cancelled')
    default:
      return ''
  }
}

function statusKindClass(d: ModelDownloadProgress): string {
  switch (d.status) {
    case 'completed':
      return 'is-completed'
    case 'error':
      return 'is-error'
    case 'cancelled':
      return 'is-cancelled'
    case 'paused':
      return 'is-paused'
    default:
      return 'is-active'
  }
}

const hasAny = computed(
  () => downloadStore.activeDownloads.length > 0 || downloadStore.finishedDownloads.length > 0,
)

function fileLabel(d: ModelDownloadProgress): string {
  return d.directory ? `${d.directory} / ${d.filename}` : d.filename
}

function pause(url: string): void {
  void window.api.pauseModelDownload(url)
}
function resume(url: string): void {
  void window.api.resumeModelDownload(url)
}
function cancel(url: string): void {
  void window.api.cancelModelDownload(url)
}
function showInFolder(savePath: string): void {
  window.api.showDownloadInFolder(savePath)
}
function dismiss(url: string): void {
  downloadStore.dismiss(url)
}
</script>

<template>
  <div
    class="downloads-tray-popover"
    role="dialog"
    aria-labelledby="downloads-tray-popover-title"
  >
    <header class="downloads-tray-popover-head">
      <h2 id="downloads-tray-popover-title" class="downloads-tray-popover-title">
        {{ t('downloads.title') }}
      </h2>
      <button
        type="button"
        class="downloads-tray-popover-close"
        :aria-label="t('downloads.dismiss')"
        :title="t('downloads.dismiss')"
        @click="$emit('close')"
      >
        <XCircle :size="16" />
      </button>
    </header>

    <div v-if="!hasAny" class="downloads-tray-popover-empty">
      {{ t('downloads.empty') }}
    </div>

    <ul v-else class="downloads-tray-popover-list">
      <li
        v-for="d in downloadStore.activeDownloads"
        :key="d.url"
        class="downloads-tray-popover-item"
        :class="statusKindClass(d)"
      >
        <div class="downloads-tray-popover-item-row">
          <ArrowDownToLine :size="14" class="downloads-tray-popover-item-icon" />
          <span class="downloads-tray-popover-item-name" :title="fileLabel(d)">
            {{ fileLabel(d) }}
          </span>
        </div>
        <div class="downloads-tray-popover-item-status">{{ statusLine(d) }}</div>
        <div class="downloads-tray-popover-bar">
          <div
            class="downloads-tray-popover-bar-fill"
            :class="{ indeterminate: d.status === 'pending' }"
            :style="
              d.status === 'pending'
                ? { width: '100%' }
                : { width: `${Math.round(d.progress * 100)}%` }
            "
          />
        </div>
        <div class="downloads-tray-popover-item-actions">
          <button
            v-if="d.status === 'downloading'"
            type="button"
            :title="t('downloads.pause')"
            :aria-label="t('downloads.pause')"
            @click="pause(d.url)"
          >
            <PauseCircle :size="14" />
            {{ t('downloads.pause') }}
          </button>
          <button
            v-if="d.status === 'paused'"
            type="button"
            class="primary"
            :title="t('downloads.resume')"
            :aria-label="t('downloads.resume')"
            @click="resume(d.url)"
          >
            <PlayCircle :size="14" />
            {{ t('downloads.resume') }}
          </button>
          <button
            type="button"
            class="danger"
            :title="t('downloads.cancel')"
            :aria-label="t('downloads.cancel')"
            @click="cancel(d.url)"
          >
            <XCircle :size="14" />
            {{ t('downloads.cancel') }}
          </button>
        </div>
      </li>

      <li
        v-for="d in downloadStore.finishedDownloads"
        :key="d.url"
        class="downloads-tray-popover-item is-finished"
        :class="statusKindClass(d)"
      >
        <div class="downloads-tray-popover-item-row">
          <CheckCircle2 v-if="d.status === 'completed'" :size="14" class="downloads-tray-popover-item-icon ok" />
          <XCircle v-else :size="14" class="downloads-tray-popover-item-icon bad" />
          <span class="downloads-tray-popover-item-name" :title="fileLabel(d)">
            {{ fileLabel(d) }}
          </span>
        </div>
        <div class="downloads-tray-popover-item-status">{{ statusLine(d) }}</div>
        <div class="downloads-tray-popover-item-actions">
          <button
            v-if="d.status === 'completed' && d.savePath"
            type="button"
            @click="showInFolder(d.savePath)"
          >
            {{ t('downloads.view') }}
          </button>
          <button type="button" @click="dismiss(d.url)">
            {{ t('downloads.dismiss') }}
          </button>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.downloads-tray-popover {
  position: fixed;
  top: 12px;
  /* Anchored to the LEFT edge — the tray button sits in the
     `.title-left` cluster, so the popover hangs below it on the same
     side. (The legacy app-update popover anchored right; the modal
     flow that replaced it for issue #488 no longer collides here.) */
  left: 12px;
  z-index: 1000;
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
  min-width: 320px;
  max-width: 420px;
  max-height: calc(100vh - 24px);
  display: flex;
  flex-direction: column;
  font: 13px/1.4 var(--font-sans, 'Inter', system-ui, sans-serif);
}

.downloads-tray-popover-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px 6px 14px;
  border-bottom: 1px solid var(--border);
}

.downloads-tray-popover-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.downloads-tray-popover-close {
  background: none;
  border: none;
  color: var(--text-muted, var(--text));
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  padding: 4px;
  border-radius: 4px;
}
.downloads-tray-popover-close:hover {
  background: rgba(127, 127, 127, 0.15);
  color: var(--text);
}

.downloads-tray-popover-empty {
  padding: 14px;
  color: var(--text-muted, var(--text));
  font-size: 12px;
  text-align: center;
}

.downloads-tray-popover-list {
  list-style: none;
  margin: 0;
  padding: 4px 0;
  overflow-y: auto;
  max-height: 60vh;
}

.downloads-tray-popover-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
}
.downloads-tray-popover-item:last-child {
  border-bottom: none;
}

.downloads-tray-popover-item-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.downloads-tray-popover-item-icon {
  flex: 0 0 auto;
  color: var(--accent, #60a5fa);
}
.downloads-tray-popover-item-icon.ok {
  color: #22c55e;
}
.downloads-tray-popover-item-icon.bad {
  color: #ef4444;
}

.downloads-tray-popover-item-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 500;
}

.downloads-tray-popover-item-status {
  font-size: 11px;
  color: var(--text-muted, var(--text));
}

.downloads-tray-popover-bar {
  height: 3px;
  background: rgba(127, 127, 127, 0.18);
  border-radius: 2px;
  overflow: hidden;
}
.downloads-tray-popover-bar-fill {
  height: 100%;
  background: var(--accent, #60a5fa);
  transition: width 0.3s ease;
}
.downloads-tray-popover-item.is-paused .downloads-tray-popover-bar-fill {
  background: #f59e0b;
}
.downloads-tray-popover-item.is-error .downloads-tray-popover-bar-fill {
  background: #ef4444;
}

.downloads-tray-popover-item-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.downloads-tray-popover-item-actions button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--surface-2, rgba(127, 127, 127, 0.1));
  color: inherit;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 3px 8px;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.downloads-tray-popover-item-actions button.primary {
  background: var(--accent, #3b82f6);
  color: #fff;
  border-color: transparent;
}
.downloads-tray-popover-item-actions button.danger {
  border-color: rgba(239, 68, 68, 0.45);
  color: #ef4444;
}
.downloads-tray-popover-item-actions button:hover {
  filter: brightness(1.1);
}
</style>
