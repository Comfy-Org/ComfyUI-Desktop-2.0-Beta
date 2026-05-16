<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowDownToLine,
  CheckCircle2,
  Eraser,
  FolderOpen,
  PauseCircle,
  PlayCircle,
  X,
  XCircle,
} from 'lucide-vue-next'
import { useDownloadStore } from '../stores/downloadStore'
import { isTerminalModelDownloadStatus } from '../lib/telemetry'
import {
  fileLabel,
  statusKindClass,
  statusLine as formatStatusLine,
} from '../lib/downloadFormatters'
import type { ModelDownloadProgress, ModelDownloadStatus } from '../types/ipc'

const { t } = useI18n()

/**
 * Settings → Downloads tab. Long-form companion to the title-bar
 * popup's compact `DownloadsView`. Backed by `useDownloadStore`
 * (same source the popup reads from over its preload bridge), so
 * everything stays in sync across surfaces.
 *
 * Adds, on top of the popup view: a status filter, clear-completed,
 * full save-path display, and a Show-in-folder action for any
 * terminal entry that wrote to disk.
 */

type StatusFilter = 'all' | 'active' | 'completed' | 'error'

const store = useDownloadStore()
const filter = ref<StatusFilter>('all')

onMounted(() => {
  store.init()
})

const ordered = computed<ModelDownloadProgress[]>(() => {
  // Single list ordered newest-first by `createdAt` so the most
  // recently kicked-off download surfaces at the top and finished
  // ones drift down as new ones come in. A download that transitions
  // active → cancelled / completed keeps its slot rather than jumping
  // between buckets. `createdAt` is stamped by main on first sight
  // and preserved across status updates.
  return [...store.downloads.values()].sort(
    (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
  )
})

const filtered = computed<ModelDownloadProgress[]>(() => {
  switch (filter.value) {
    case 'active':
      return store.activeDownloads
    case 'completed':
      return store.finishedDownloads.filter((d) => d.status === 'completed')
    case 'error':
      return store.finishedDownloads.filter(
        (d) => d.status === 'error' || d.status === 'cancelled',
      )
    default:
      return ordered.value
  }
})

const finishedCount = computed(() => store.finishedDownloads.length)

/** The Settings tab adds the total size to the `'completed'` status
 *  line — opt into the variant in the shared formatter rather than
 *  re-implementing the switch. */
function statusLine(d: ModelDownloadProgress): string {
  return formatStatusLine(d, { completedShowsSize: true })
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
function showInFolder(savePath: string | undefined): void {
  if (!savePath) return
  void window.api.showDownloadInFolder(savePath)
}
function clearOne(url: string): void {
  store.dismiss(url)
}
function clearCompleted(): void {
  store.clearFinished()
}

/** Filter chips. Labels resolve through i18n at render time so they
 *  re-render if the locale ever changes; the underlying `key` is the
 *  stable identifier that drives `filter` state. */
const filters = computed<{ key: StatusFilter; label: string }[]>(() => [
  { key: 'all', label: t('downloadsTab.filterAll') },
  { key: 'active', label: t('downloadsTab.filterActive') },
  { key: 'completed', label: t('downloadsTab.filterCompleted') },
  { key: 'error', label: t('downloadsTab.filterErrored') },
])

function isTerminal(status: ModelDownloadStatus): boolean {
  return isTerminalModelDownloadStatus(status)
}
</script>

<template>
  <div class="downloads-tab">
    <header class="downloads-tab-head">
      <h2 class="downloads-tab-title">{{ t('downloadsTab.title') }}</h2>
      <div class="downloads-tab-actions">
        <div
          class="filter-pill-group"
          role="tablist"
          :aria-label="t('downloadsTab.filterAriaLabel')"
        >
          <button
            v-for="f in filters"
            :key="f.key"
            type="button"
            class="filter-pill downloads-filter-chip"
            :class="{ active: filter === f.key }"
            role="tab"
            :aria-selected="filter === f.key"
            @click="filter = f.key"
          >
            {{ f.label }}
          </button>
        </div>
        <button
          type="button"
          class="downloads-clear"
          :disabled="finishedCount === 0"
          :title="t('downloadsPopup.clearFinishedTooltip')"
          @click="clearCompleted"
        >
          <Eraser :size="13" />
          {{ t('downloadsPopup.clearFinished') }}
        </button>
      </div>
    </header>

    <div v-if="filtered.length === 0" class="downloads-tab-empty">
      <ArrowDownToLine :size="18" />
      <span>{{ t('downloadsTab.empty') }}</span>
    </div>

    <ul v-else class="downloads-tab-list">
      <li
        v-for="d in filtered"
        :key="d.url"
        class="downloads-tab-item"
        :class="statusKindClass(d)"
      >
        <div class="downloads-tab-item-row">
          <CheckCircle2
            v-if="d.status === 'completed'"
            :size="14"
            class="downloads-tab-icon ok"
          />
          <XCircle
            v-else-if="d.status === 'error' || d.status === 'cancelled'"
            :size="14"
            class="downloads-tab-icon bad"
          />
          <ArrowDownToLine v-else :size="14" class="downloads-tab-icon" />
          <span class="downloads-tab-name" :title="fileLabel(d)">{{ fileLabel(d) }}</span>
          <!-- Per-row dismiss — only offered for terminal entries.
               A small X in the title row reads as "remove from this
               list" rather than the destructive trashcan that was
               there before (which implied the file would be deleted
               from disk). -->
          <button
            v-if="isTerminal(d.status)"
            type="button"
            class="downloads-tab-dismiss"
            :title="t('downloadsPopup.remove')"
            :aria-label="t('downloadsPopup.remove')"
            @click="clearOne(d.url)"
          >
            <X :size="14" />
          </button>
        </div>
        <div class="downloads-tab-status">{{ statusLine(d) }}</div>
        <div v-if="d.savePath" class="downloads-tab-path" :title="d.savePath">
          {{ d.savePath }}
        </div>
        <div
          v-if="d.status === 'downloading' || d.status === 'paused' || d.status === 'pending'"
          class="downloads-tab-bar"
        >
          <div
            class="downloads-tab-bar-fill"
            :class="{ indeterminate: d.status === 'pending' }"
            :style="
              d.status === 'pending'
                ? { width: '100%' }
                : { width: `${Math.round(d.progress * 100)}%` }
            "
          />
        </div>
        <div class="downloads-tab-item-actions">
          <button
            v-if="d.status === 'downloading'"
            type="button"
            @click="pause(d.url)"
          >
            <PauseCircle :size="13" />
            {{ t('downloadsPopup.pause') }}
          </button>
          <button
            v-if="d.status === 'paused'"
            type="button"
            class="primary"
            @click="resume(d.url)"
          >
            <PlayCircle :size="13" />
            {{ t('downloadsPopup.resume') }}
          </button>
          <button
            v-if="d.status === 'downloading' || d.status === 'paused' || d.status === 'pending'"
            type="button"
            class="danger"
            @click="cancel(d.url)"
          >
            <XCircle :size="13" />
            {{ t('downloadsPopup.cancel') }}
          </button>
          <button
            v-if="d.status === 'completed' && d.savePath"
            type="button"
            @click="showInFolder(d.savePath)"
          >
            <FolderOpen :size="13" />
            {{ t('downloadsPopup.showInFolder') }}
          </button>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.downloads-tab {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.downloads-tab-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.downloads-tab-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.downloads-tab-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

/* Status-filter chip styling lives in `assets/main.css` under the
 * shared `.filter-pill` / `.filter-pill-group` classes (also used by
 * ChooserView). The local `.downloads-filter-chip` class is kept only
 * as a test selector hook. */

.downloads-clear {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: 1px solid var(--border, rgba(127, 127, 127, 0.3));
  border-radius: 6px;
  padding: 4px 10px;
  font: inherit;
  font-size: 12px;
  color: inherit;
  cursor: pointer;
}
.downloads-clear:hover:not(:disabled) {
  background: var(--bg-elev-2, rgba(127, 127, 127, 0.12));
}
.downloads-clear:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.downloads-tab-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 32px 0;
  color: var(--text-muted, #9ca0a8);
  font-size: 13px;
}

.downloads-tab-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.downloads-tab-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--border, rgba(127, 127, 127, 0.25));
  border-radius: 8px;
  background: var(--bg-elev-1, rgba(127, 127, 127, 0.04));
}

.downloads-tab-item-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.downloads-tab-icon {
  flex: 0 0 auto;
  color: var(--accent, #60a5fa);
}
.downloads-tab-icon.ok {
  color: #22c55e;
}
.downloads-tab-icon.bad {
  color: #ef4444;
}

.downloads-tab-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
  font-size: 13px;
}

/* Per-row dismiss "X" — pinned to the end of the title row. Same
 * affordance as the popup so the per-row remove reads identically
 * across surfaces. */
.downloads-tab-dismiss {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted, #9ca0a8);
  cursor: pointer;
  opacity: 0.6;
}
.downloads-tab-dismiss:hover {
  opacity: 1;
  background: rgba(127, 127, 127, 0.18);
  color: inherit;
}

.downloads-tab-status {
  font-size: 12px;
  color: var(--text-muted, #9ca0a8);
}

.downloads-tab-path {
  font-size: 11px;
  color: var(--text-muted, #9ca0a8);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.downloads-tab-bar {
  height: 4px;
  background: rgba(127, 127, 127, 0.18);
  border-radius: 2px;
  overflow: hidden;
}
.downloads-tab-bar-fill {
  height: 100%;
  background: var(--accent, #60a5fa);
  transition: width 0.3s ease;
}
.downloads-tab-item.is-paused .downloads-tab-bar-fill {
  background: #f59e0b;
}

.downloads-tab-item-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 2px;
}
/* Terminal entries with no save-path (errored / cancelled) have no
 * actions at all once Remove was lifted to the title-row X. Collapse
 * the row so the card doesn't carry a phantom margin. */
.downloads-tab-item-actions:empty {
  display: none;
}
.downloads-tab-item-actions button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--surface-2, rgba(127, 127, 127, 0.1));
  color: inherit;
  border: 1px solid var(--border, rgba(127, 127, 127, 0.3));
  border-radius: 5px;
  padding: 4px 8px;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.downloads-tab-item-actions button.primary {
  background: var(--accent, #3b82f6);
  color: #fff;
  border-color: transparent;
}
.downloads-tab-item-actions button.danger {
  border-color: rgba(239, 68, 68, 0.45);
  color: #ef4444;
}
.downloads-tab-item-actions button.muted {
  opacity: 0.75;
}
.downloads-tab-item-actions button:hover {
  filter: brightness(1.1);
}
</style>
