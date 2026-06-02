<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowDownToLine,
  CheckCircle2,
  FolderOpen,
  PauseCircle,
  PlayCircle,
  RotateCcw,
  X,
  XCircle,
} from 'lucide-vue-next'
import { BaseModal } from './ui'
import { useDownloadStore } from '../stores/downloadStore'
import { isTerminalModelDownloadStatus } from '../lib/telemetry'
import {
  fileLabel,
  statusKindClass,
  statusLine as formatStatusLine,
} from '../lib/downloadFormatters'
import { revealInFolderLabel } from '../composables/usePlatform'
import type { ModelDownloadProgress, ModelDownloadStatus } from '../types/ipc'

const { t } = useI18n()
const revealLabel = computed(() => revealInFolderLabel(window.api?.platform))

/**
 * "View All Downloads" — the brand-redesigned, full surface that the
 * title-bar popup's footer link opens. Mirrors the Settings tab's data
 * model and actions (status filter, full status line, save path,
 * pause/resume/cancel/show-in-folder/dismiss, clear-finished) but
 * presents them on the reusable `BaseModal` primitive with brand chrome.
 *
 * Sized for huge files (~40 GB checkpoints): every active row shows
 * `received / total · % · speed · ETA` continuously so the user has no
 * reason to leave the desktop app for a browser download tray.
 *
 * Backed by the same `useDownloadStore` the popup + Settings tab read
 * from — dismissals and clear-finished round-trip through main so all
 * three surfaces stay in lockstep.
 */

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

type StatusFilter = 'all' | 'active' | 'completed' | 'error'

const store = useDownloadStore()
const filter = ref<StatusFilter>('all')

onMounted(() => {
  store.init()
})

const ordered = computed<ModelDownloadProgress[]>(() =>
  // Newest-first by `createdAt` so the most recently kicked-off
  // download surfaces at the top and finished ones drift down. A row
  // that transitions active → cancelled / completed keeps its slot
  // rather than jumping buckets (`createdAt` is stamped by main on
  // first sight and preserved across status updates).
  [...store.downloads.values()].sort(
    (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
  ),
)

const activeCount = computed(() => store.activeDownloads.length)
const completedCount = computed(
  () => store.finishedDownloads.filter((d) => d.status === 'completed').length,
)
const errorCount = computed(
  () =>
    store.finishedDownloads.filter(
      (d) => d.status === 'error' || d.status === 'cancelled',
    ).length,
)

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

/** Append total size to `'completed'` rows (the long-form variant the
 *  Settings tab also opts into) — opt into the shared formatter rather
 *  than re-implementing the switch. */
function statusLine(d: ModelDownloadProgress): string {
  return formatStatusLine(d, { completedShowsSize: true })
}

/** Every IPC call wrapped — rejections from main shouldn't escape into
 *  unhandled-promise warnings. The store doesn't block on success, so
 *  logging is the right failure mode here. */
async function safe(call: Promise<unknown>): Promise<void> {
  try {
    await call
  } catch (err) {
    console.warn('downloads:', err)
  }
}

function pause(url: string): void {
  void safe(window.api.pauseModelDownload(url))
}
function resume(url: string): void {
  void safe(window.api.resumeModelDownload(url))
}
function cancel(url: string): void {
  void safe(window.api.cancelModelDownload(url))
}
function retry(url: string): void {
  void safe(window.api.retryModelDownload(url))
}
function showInFolder(savePath: string | undefined): void {
  if (!savePath) return
  void safe(window.api.showDownloadInFolder(savePath))
}
function dismissOne(url: string): void {
  store.dismiss(url)
}
/**
 * Smart filter visibility: only render pills for buckets that have data,
 * and only render the bar at all when ≥ 2 buckets are non-empty (a lone
 * bucket *is* the list — no filtering needed).
 */
const visibleFilters = computed<{ key: StatusFilter; label: string }[]>(() => {
  const present: { key: StatusFilter; label: string }[] = []
  if (activeCount.value > 0) {
    present.push({ key: 'active', label: t('downloadsTab.filterActive') })
  }
  if (completedCount.value > 0) {
    present.push({ key: 'completed', label: t('downloadsTab.filterCompleted') })
  }
  if (errorCount.value > 0) {
    present.push({ key: 'error', label: t('downloadsTab.filterErrored') })
  }
  if (present.length < 2) return []
  return [{ key: 'all', label: t('downloadsTab.filterAll') }, ...present]
})

watch(visibleFilters, (next) => {
  if (filter.value === 'all') return
  if (!next.some((f) => f.key === filter.value)) {
    filter.value = 'all'
  }
})

function isTerminal(status: ModelDownloadStatus): boolean {
  return isTerminalModelDownloadStatus(status)
}
</script>

<template>
  <BaseModal
    :open="props.open"
    size="lg"
    blur-overlay
    :aria-label="t('downloadsTab.title')"
    @close="emit('close')"
  >
    <template #header>
      <div class="dlm-header">
        <h2 class="dlm-title">{{ t('downloadsTab.title') }}</h2>
      </div>
    </template>

    <div
      v-if="visibleFilters.length > 0"
      class="dlm-filterbar filter-pill-group"
      role="tablist"
      :aria-label="t('downloadsTab.filterAriaLabel')"
    >
      <button
        v-for="f in visibleFilters"
        :key="f.key"
        type="button"
        class="filter-pill dlm-filter-chip"
        :class="{ active: filter === f.key }"
        role="tab"
        :aria-selected="filter === f.key"
        @click="filter = f.key"
      >
        {{ f.label }}
      </button>
    </div>

    <div v-if="filtered.length === 0" class="dlm-empty">
      <ArrowDownToLine :size="18" />
      <span>{{ t('downloadsTab.empty') }}</span>
    </div>

    <ul v-else class="dlm-list">
      <li
        v-for="d in filtered"
        :key="d.url"
        class="dlm-item"
        :class="statusKindClass(d)"
      >
        <div class="dlm-item-row">
          <CheckCircle2
            v-if="d.status === 'completed'"
            :size="14"
            class="dlm-icon ok"
          />
          <XCircle
            v-else-if="d.status === 'error' || d.status === 'cancelled'"
            :size="14"
            class="dlm-icon bad"
          />
          <ArrowDownToLine v-else :size="14" class="dlm-icon" />
          <span class="dlm-name" :title="fileLabel(d)">{{ fileLabel(d) }}</span>
          <button
            v-if="isTerminal(d.status)"
            type="button"
            class="dlm-dismiss"
            :title="t('downloadsPopup.remove')"
            :aria-label="t('downloadsPopup.remove')"
            @click="dismissOne(d.url)"
          >
            <X :size="14" />
          </button>
        </div>
        <div class="dlm-status">{{ statusLine(d) }}</div>
        <div v-if="d.savePath" class="dlm-path" :title="d.savePath">
          {{ d.savePath }}
        </div>
        <div
          v-if="d.status === 'downloading' || d.status === 'paused' || d.status === 'pending'"
          class="dlm-bar"
        >
          <div
            class="dlm-bar-fill"
            :class="{ indeterminate: d.status === 'pending' }"
            :style="
              d.status === 'pending'
                ? { width: '100%' }
                : { width: `${Math.round(d.progress * 100)}%` }
            "
          />
        </div>
        <div class="dlm-item-actions">
          <button
            v-if="d.status === 'error' || d.status === 'cancelled'"
            type="button"
            @click="retry(d.url)"
          >
            <RotateCcw :size="13" />
            {{ t('downloadsTab.retry') }}
          </button>
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
            {{ revealLabel }}
          </button>
        </div>
      </li>
    </ul>
  </BaseModal>
</template>

<style scoped>
.dlm-header {
  display: flex;
  align-items: center;
  gap: 12px;
}

.dlm-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: var(--takeover-fs-h3, 18px);
  font-weight: 700;
  color: var(--neutral-100);
}

/* `.filter-pill` / `.filter-pill-group` are global (assets/main.css)
 * and shared with ChooserView + the Settings tab. The local
 * `.dlm-filter-chip` class is a test-selector hook only. */
.dlm-filterbar {
  position: sticky;
  top: 0;
  z-index: 1;
  margin: -16px -24px 12px;
  padding: 12px 24px;
  background: var(--modal-surface-bg);
  border-bottom: 1px solid color-mix(in oklab, var(--neutral-100) 8%, transparent);
}

.dlm-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 48px 0;
  color: var(--text-muted, #9ca0a8);
  font-size: 13px;
}

.dlm-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dlm-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  border: 1px solid color-mix(in oklab, var(--neutral-100) 8%, transparent);
  border-radius: 10px;
  background: color-mix(in oklab, var(--neutral-100) 3%, transparent);
}

.dlm-item-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dlm-icon {
  flex: 0 0 auto;
  color: var(--neutral-100);
}
.dlm-icon.ok {
  color: #22c55e;
}
.dlm-icon.bad {
  color: #ef4444;
}

.dlm-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
  font-size: 13px;
  color: var(--neutral-100);
}

.dlm-dismiss {
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
.dlm-dismiss:hover {
  opacity: 1;
  background: color-mix(in oklab, var(--neutral-100) 10%, transparent);
  color: inherit;
}

.dlm-status {
  font-size: 12px;
  color: var(--text-muted, #9ca0a8);
  font-variant-numeric: tabular-nums;
}

.dlm-path {
  font-size: 11px;
  color: var(--text-muted, #9ca0a8);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dlm-bar {
  height: 4px;
  background: color-mix(in oklab, var(--neutral-100) 10%, transparent);
  border-radius: 2px;
  overflow: hidden;
}
.dlm-bar-fill {
  height: 100%;
  background: var(--accent, #60a5fa);
  transition: width 0.3s ease;
}
.dlm-bar-fill.indeterminate {
  /* Subtle barber-pole until main reports a real progress tick. Same
   * device the Settings tab uses so the empty-bar moment doesn't read
   * as "stuck". */
  background: repeating-linear-gradient(
    90deg,
    var(--accent, #60a5fa),
    var(--accent, #60a5fa) 8px,
    color-mix(in oklab, var(--accent, #60a5fa) 65%, transparent) 8px,
    color-mix(in oklab, var(--accent, #60a5fa) 65%, transparent) 16px
  );
}
.dlm-item.is-paused .dlm-bar-fill {
  background: #f59e0b;
}

.dlm-item-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 2px;
}
/* Terminal rows with no per-row action collapse silently — the title-row
 * X handled the Remove affordance. */
.dlm-item-actions:empty {
  display: none;
}
.dlm-item-actions button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: color-mix(in oklab, var(--neutral-100) 6%, transparent);
  color: inherit;
  border: 1px solid color-mix(in oklab, var(--neutral-100) 18%, transparent);
  border-radius: 5px;
  padding: 4px 8px;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.dlm-item-actions button.primary {
  background: var(--accent, #3b82f6);
  color: #fff;
  border-color: transparent;
}
.dlm-item-actions button.danger {
  border-color: rgba(239, 68, 68, 0.45);
  color: #ef4444;
}
.dlm-item-actions button:hover {
  filter: brightness(1.1);
}
</style>

<!-- Non-scoped: while the host is in overlay-panel mode the page behind
     the modal is the live ComfyUI canvas (PanelApp toggles
     `body.panel-overlay-mode` with a transparent background). The
     default BaseModal scrim (70% neutral-800) crushes that canvas
     visually; soften it to a light tint and lean on the blur prop. -->
<style>
body.panel-overlay-mode .base-modal-overlay {
  background: color-mix(in oklab, var(--neutral-900) 28%, transparent);
}
</style>
