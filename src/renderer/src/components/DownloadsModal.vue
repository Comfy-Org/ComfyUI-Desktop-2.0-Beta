<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowDownToLine,
  Ban,
  CheckCircle2,
  CircleAlert,
  FolderOpen,
  LoaderCircle,
  PauseCircle,
  PlayCircle,
  RotateCcw,
  Trash2,
  X,
  XCircle
} from 'lucide-vue-next'
import { BaseModal } from './ui'
import DownloadThumbnail from './DownloadThumbnail.vue'
import { useDownloadStore } from '../stores/downloadStore'
import { isTerminalModelDownloadStatus } from '../lib/telemetry'
import { fileLabel, modalSubtitle, statusKindClass } from '../lib/downloadFormatters'
import { revealInFolderLabel } from '../composables/usePlatform'
import type { ModelDownloadProgress, ModelDownloadStatus } from '../types/ipc'

const { t } = useI18n()
const revealLabel = computed(() => revealInFolderLabel(window.api?.platform))

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

type StatusFilter = 'all' | 'active' | 'completed' | 'error'

const store = useDownloadStore()
const filter = ref<StatusFilter>('all')

onMounted(() => {
  store.init()
})

// Ticking clock so relative timestamps ("5m ago") stay fresh. Runs only while
// the modal is open to avoid a background timer when it's closed.
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined
function stopClock(): void {
  if (clock) {
    clearInterval(clock)
    clock = undefined
  }
}
watch(
  () => props.open,
  (open) => {
    stopClock()
    if (open) {
      now.value = Date.now()
      clock = setInterval(() => (now.value = Date.now()), 30_000)
    }
  },
  { immediate: true }
)
onUnmounted(stopClock)

const ordered = computed<ModelDownloadProgress[]>(() =>
  [...store.downloads.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
)

const activeCount = computed(() => store.activeDownloads.length)
const completedCount = computed(
  () => store.finishedDownloads.filter((d) => d.status === 'completed').length
)
const errorCount = computed(
  () =>
    store.finishedDownloads.filter((d) => d.status === 'error' || d.status === 'cancelled').length
)
const finishedCount = computed(() => store.finishedDownloads.length)

const filtered = computed<ModelDownloadProgress[]>(() => {
  switch (filter.value) {
    case 'active':
      return store.activeDownloads
    case 'completed':
      return store.finishedDownloads.filter((d) => d.status === 'completed')
    case 'error':
      return store.finishedDownloads.filter((d) => d.status === 'error' || d.status === 'cancelled')
    default:
      return ordered.value
  }
})

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

const fetchThumbnail = (savePath: string): Promise<string | null> =>
  window.api.getDownloadThumbnail(savePath)

function isCompletedImage(download: ModelDownloadProgress): boolean {
  return download.isImage === true && download.status === 'completed'
}

function progressPercent(d: ModelDownloadProgress): number {
  return Math.round(d.progress * 100)
}

function statusBadge(d: ModelDownloadProgress): { label: string; cls: string } | null {
  switch (d.status) {
    case 'error':
      return { label: t('downloadsTab.badgeFailed'), cls: 'dlm-badge-error' }
    case 'cancelled':
      return { label: t('downloadsTab.badgeCancelled'), cls: 'dlm-badge-muted' }
    default:
      return null
  }
}
</script>

<template>
  <BaseModal
    :open="props.open"
    size="lg"
    blur-overlay
    content-class="dlm-panel"
    :aria-label="t('downloadsTab.title')"
    @close="emit('close')"
  >
    <template #header>
      <div class="dlm-header">
        <h2 class="dlm-title">{{ t('downloadsTab.title') }}</h2>
      </div>
    </template>

    <div class="dlm-body">
      <div
        v-if="visibleFilters.length > 0"
        class="dlm-filterbar"
        role="tablist"
        :aria-label="t('downloadsTab.filterAriaLabel')"
      >
        <button
          v-for="f in visibleFilters"
          :key="f.key"
          type="button"
          class="dlm-filter-chip"
          :class="{ active: filter === f.key }"
          role="tab"
          :aria-selected="filter === f.key"
          @click="filter = f.key"
        >
          {{ f.label }}
        </button>
      </div>

      <div v-if="filtered.length === 0" class="dlm-empty">
        <div class="dlm-empty-icon">
          <ArrowDownToLine :size="28" />
        </div>
        <span class="dlm-empty-title">{{ t('downloadsTab.empty') }}</span>
        <span class="dlm-empty-hint">{{ t('downloadsTab.emptyHint') }}</span>
      </div>

      <ul v-else :key="filter" class="dlm-list">
        <li
          v-for="(d, i) in filtered"
          :key="d.url"
          class="dlm-row"
          :class="statusKindClass(d)"
          :style="{ '--i': i }"
        >
          <!-- Left: icon / thumbnail -->
          <span :class="['dlm-leading', { 'dlm-thumb': isCompletedImage(d) }]">
            <DownloadThumbnail :entry="d" :fetcher="fetchThumbnail">
              <template #fallback>
                <span v-if="d.status === 'completed'" class="dlm-icon-circle ok">
                  <CheckCircle2 :size="16" />
                </span>
                <span v-else-if="d.status === 'error'" class="dlm-icon-circle error">
                  <CircleAlert :size="16" />
                </span>
                <span v-else-if="d.status === 'cancelled'" class="dlm-icon-circle muted">
                  <Ban :size="16" />
                </span>
                <span v-else-if="d.status === 'paused'" class="dlm-icon-circle warn">
                  <PauseCircle :size="16" />
                </span>
                <span v-else class="dlm-icon-circle active">
                  <LoaderCircle :size="16" class="dlm-spin" />
                </span>
              </template>
            </DownloadThumbnail>
          </span>

          <!-- Center: name + subtitle -->
          <div class="dlm-content">
            <span class="dlm-name" :title="fileLabel(d)">{{ fileLabel(d) }}</span>
            <span class="dlm-sub" :title="d.savePath">{{ modalSubtitle(d, now) }}</span>
            <!-- Inline progress bar for active downloads -->
            <div
              v-if="d.status === 'downloading' || d.status === 'paused' || d.status === 'pending'"
              class="dlm-bar"
            >
              <div
                class="dlm-bar-fill"
                :class="{
                  indeterminate: d.status === 'pending',
                  paused: d.status === 'paused'
                }"
                :style="
                  d.status === 'pending' ? { width: '100%' } : { width: `${progressPercent(d)}%` }
                "
              />
            </div>
          </div>

          <!-- Right: badge + primary action + dismiss -->
          <div class="dlm-actions">
            <span v-if="statusBadge(d)" class="dlm-badge" :class="statusBadge(d)!.cls">
              {{ statusBadge(d)!.label }}
            </span>

            <span v-if="d.status === 'downloading'" class="dlm-pct">{{ progressPercent(d) }}%</span>
            <button
              v-if="d.status === 'downloading'"
              type="button"
              class="dlm-btn"
              :title="t('downloadsPopup.pause')"
              :aria-label="t('downloadsPopup.pause')"
              @click="pause(d.url)"
            >
              <PauseCircle :size="14" />
            </button>
            <button
              v-if="d.status === 'paused'"
              type="button"
              class="dlm-btn dlm-btn-primary"
              :title="t('downloadsPopup.resume')"
              :aria-label="t('downloadsPopup.resume')"
              @click="resume(d.url)"
            >
              <PlayCircle :size="14" />
              {{ t('downloadsPopup.resume') }}
            </button>
            <button
              v-if="d.status === 'error' || d.status === 'cancelled'"
              type="button"
              class="dlm-btn"
              :title="t('downloadsTab.retry')"
              :aria-label="t('downloadsTab.retry')"
              @click="retry(d.url)"
            >
              <RotateCcw :size="14" />
              {{ t('downloadsTab.retry') }}
            </button>
            <button
              v-if="d.status === 'completed' && d.savePath"
              type="button"
              class="dlm-btn"
              @click="showInFolder(d.savePath)"
            >
              <FolderOpen :size="14" />
              {{ revealLabel }}
            </button>

            <!-- Cancel (active) or dismiss (terminal) -->
            <button
              v-if="!isTerminal(d.status)"
              type="button"
              class="dlm-x"
              :title="t('downloadsPopup.cancel')"
              :aria-label="t('downloadsPopup.cancel')"
              @click="cancel(d.url)"
            >
              <XCircle :size="14" />
            </button>
            <button
              v-if="isTerminal(d.status)"
              type="button"
              class="dlm-x"
              :title="t('downloadsPopup.remove')"
              :aria-label="t('downloadsPopup.remove')"
              @click="dismissOne(d.url)"
            >
              <X :size="14" />
            </button>
          </div>
        </li>
      </ul>
    </div>

    <!-- Footer summary bar -->
    <template v-if="ordered.length > 0" #footer>
      <div class="dlm-footer">
        <span class="dlm-footer-stats">
          <span v-if="activeCount > 0" class="dlm-footer-stat">
            {{ t('downloadsTab.footerActive', { n: activeCount }) }}
          </span>
          <span v-if="activeCount > 0 && completedCount > 0" class="dlm-footer-sep">&middot;</span>
          <span v-if="completedCount > 0" class="dlm-footer-stat">
            {{ t('downloadsTab.footerCompleted', { n: completedCount }) }}
          </span>
        </span>
        <button
          v-if="finishedCount > 0"
          type="button"
          class="dlm-clear-btn"
          @click="store.clearFinished()"
        >
          <Trash2 :size="13" />
          {{ t('downloadsTab.clearFinished') }}
        </button>
      </div>
    </template>
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

.dlm-body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 100%;
}

.dlm-filterbar {
  position: sticky;
  top: -16px;
  z-index: 2;
  display: flex;
  gap: 6px;
  margin: -16px -24px 8px;
  padding: 12px 24px 10px;
  background: var(--modal-surface-bg, #27202d);
  border-bottom: 1px solid color-mix(in oklab, var(--neutral-100) 8%, transparent);
}
.dlm-filter-chip {
  flex: 1 1 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 5px 8px;
  font: inherit;
  font-size: 12px;
  color: inherit;
  background: transparent;
  border: 1px solid color-mix(in oklab, var(--neutral-100) 12%, transparent);
  border-radius: 6px;
  cursor: pointer;
  opacity: 0.65;
  transition:
    opacity 150ms ease,
    background 150ms ease,
    border-color 150ms ease;
}
.dlm-filter-chip:hover {
  opacity: 1;
}
.dlm-filter-chip.active {
  background: color-mix(in oklab, var(--neutral-100) 8%, transparent);
  border-color: color-mix(in oklab, var(--neutral-100) 22%, transparent);
  opacity: 1;
}

/* ── Empty state ── */
.dlm-empty {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
}
.dlm-empty-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: 16px;
  background: color-mix(in oklab, var(--neutral-100) 5%, transparent);
  color: var(--text-muted, #9ca0a8);
  margin-bottom: 4px;
}
.dlm-empty-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--neutral-100);
}
.dlm-empty-hint {
  font-size: 13px;
  color: var(--text-muted, #9ca0a8);
}

/* ── List ── */
.dlm-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* ── Row: horizontal layout + stagger entrance ── */
.dlm-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  transition: background 120ms ease;
  animation: dlm-row-in 220ms cubic-bezier(0.2, 0, 0, 1) both;
  animation-delay: calc(var(--i, 0) * 40ms);
}
@media (prefers-reduced-motion: reduce) {
  .dlm-row {
    animation: none;
  }
}
@keyframes dlm-row-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}
.dlm-row:hover {
  background: color-mix(in oklab, var(--neutral-100) 4%, transparent);
}

/* ── Leading icon / thumbnail ── */
.dlm-leading {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
}
.dlm-thumb {
  width: 40px;
  height: 40px;
  border-radius: 8px;
  overflow: hidden;
  background: color-mix(in oklab, var(--neutral-100) 6%, transparent);
}

.dlm-icon-circle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
}
.dlm-icon-circle.ok {
  background: color-mix(in oklab, #22c55e 15%, transparent);
  color: #22c55e;
}
.dlm-icon-circle.error {
  background: color-mix(in oklab, #ef4444 15%, transparent);
  color: #ef4444;
}
.dlm-icon-circle.muted {
  background: color-mix(in oklab, var(--neutral-100) 8%, transparent);
  color: var(--text-muted, #9ca0a8);
}
.dlm-icon-circle.warn {
  background: color-mix(in oklab, #f59e0b 15%, transparent);
  color: #f59e0b;
}
.dlm-icon-circle.active {
  background: color-mix(in oklab, var(--accent, #60a5fa) 15%, transparent);
  color: var(--accent, #60a5fa);
}

.dlm-spin {
  animation: dlm-spin 0.9s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .dlm-spin {
    animation: none;
  }
}
@keyframes dlm-spin {
  to {
    transform: rotate(360deg);
  }
}

/* ── Center content ── */
.dlm-content {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.dlm-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
  font-size: 13px;
  color: var(--neutral-100);
}

/* ── Status badge ── */
.dlm-badge {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  padding: 3px 7px;
  border-radius: 4px;
  white-space: nowrap;
}
.dlm-badge-error {
  background: color-mix(in oklab, #ef4444 15%, transparent);
  color: #ef4444;
}
.dlm-badge-muted {
  background: color-mix(in oklab, var(--neutral-100) 8%, transparent);
  color: var(--text-muted, #9ca0a8);
}

.dlm-sub {
  font-size: 12px;
  color: var(--text-muted, #9ca0a8);
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── Inline progress bar ── */
.dlm-bar {
  height: 3px;
  margin-top: 2px;
  background: color-mix(in oklab, var(--neutral-100) 10%, transparent);
  border-radius: 2px;
  overflow: hidden;
}
.dlm-bar-fill {
  height: 100%;
  background: var(--accent, #60a5fa);
  border-radius: 2px;
  transition: width 0.3s ease;
}
.dlm-bar-fill.indeterminate {
  background: repeating-linear-gradient(
    90deg,
    var(--accent, #60a5fa),
    var(--accent, #60a5fa) 8px,
    color-mix(in oklab, var(--accent, #60a5fa) 50%, transparent) 8px,
    color-mix(in oklab, var(--accent, #60a5fa) 50%, transparent) 16px
  );
  animation: dlm-shimmer 1.2s linear infinite;
}
.dlm-bar-fill.paused {
  background: #f59e0b;
}
@keyframes dlm-shimmer {
  to {
    background-position: 32px 0;
  }
}

/* ── Right: actions ── */
.dlm-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
}

.dlm-pct {
  font-size: 13px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--accent, #60a5fa);
  min-width: 36px;
  text-align: right;
}

.dlm-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: color-mix(in oklab, var(--neutral-100) 6%, transparent);
  color: inherit;
  border: 1px solid color-mix(in oklab, var(--neutral-100) 12%, transparent);
  border-radius: 6px;
  padding: 4px 10px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  transition:
    background 120ms ease,
    border-color 120ms ease;
}
.dlm-btn:hover {
  background: color-mix(in oklab, var(--neutral-100) 10%, transparent);
  border-color: color-mix(in oklab, var(--neutral-100) 20%, transparent);
}
.dlm-btn-primary {
  background: var(--accent, #3b82f6);
  color: #fff;
  border-color: transparent;
}
.dlm-btn-primary:hover {
  background: var(--accent-hover, #2563eb);
  border-color: transparent;
}

.dlm-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted, #9ca0a8);
  cursor: pointer;
  opacity: 0.5;
  transition:
    opacity 120ms ease,
    background 120ms ease,
    color 120ms ease;
}
/* Active rows: hide X until hover */
.dlm-row.is-active .dlm-x {
  opacity: 0;
}
.dlm-row.is-active:hover .dlm-x {
  opacity: 0.5;
}
.dlm-x:hover {
  opacity: 1 !important;
  background: color-mix(in oklab, var(--neutral-100) 10%, transparent);
  color: var(--neutral-100);
}

/* ── Footer ── */
.dlm-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}
.dlm-footer-stats {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-muted, #9ca0a8);
}
.dlm-footer-stat {
  font-variant-numeric: tabular-nums;
}
.dlm-footer-sep {
  opacity: 0.4;
}
.dlm-clear-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  color: var(--text-muted, #9ca0a8);
  border: 1px solid color-mix(in oklab, var(--neutral-100) 10%, transparent);
  border-radius: 6px;
  padding: 5px 10px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition:
    background 120ms ease,
    color 120ms ease;
}
.dlm-clear-btn:hover {
  background: color-mix(in oklab, var(--neutral-100) 6%, transparent);
  color: var(--neutral-100);
}
</style>

<!-- Non-scoped: contentClass and overlay-mode styles live outside scoped. -->
<style>
body.panel-overlay-mode .base-modal-overlay {
  background: color-mix(in oklab, var(--neutral-900) 28%, transparent);
}
.dlm-panel {
  height: clamp(420px, 70vh, 720px);
}
.dlm-panel .base-modal-body {
  display: flex;
  flex-direction: column;
}
</style>
