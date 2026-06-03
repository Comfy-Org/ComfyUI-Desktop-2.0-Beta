<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  CircleAlert,
  CircleCheck,
  LoaderCircle,
  PauseCircle,
  // TODO(brand-cleanup): PlayCircle was the Resume action icon — redesign skips it; restore if Pause/Resume comes back.
  // PlayCircle,
  RotateCcw,
  X
} from 'lucide-vue-next'
import { fileLabel, statusKindClass, statusLine } from '../lib/downloadFormatters'
import { revealInFolderLabel } from '../composables/usePlatform'

const { t } = useI18n()

/**
 * Live downloads tray view.
 *
 * Stateless — receives the latest `DownloadsState` snapshot as a prop
 * from `TitlePopupApp` (which owns the long-lived
 * `comfy-titlepopup:downloads-changed` subscription so the initial
 * push on a fresh `'downloads'` open lands even before this component
 * mounts). Per-entry actions are dispatched back via
 * `comfy-titlepopup:downloads-action`.
 *
 * Active and terminal entries are rendered in a single
 * insertion-ordered list (sorted by `createdAt`) so a download that
 * transitions active → cancelled / completed stays in its original
 * slot rather than jumping to the bottom of a separate "recent"
 * bucket.
 *
 * The popup webContents is a transient view with its own preload — no
 * Pinia store and no `vue-i18n` here. The tsconfig.web slice can't see
 * the preload's TypeScript directly, so the entry / state / action
 * shapes are mirrored inline (kept in sync with
 * `comfyTitlePopupPreload.ts`).
 */

interface DownloadEntry {
  url: string
  filename: string
  directory?: string
  savePath?: string
  progress: number
  receivedBytes?: number
  totalBytes?: number
  speedBytesPerSec?: number
  etaSeconds?: number
  status: 'pending' | 'downloading' | 'paused' | 'completed' | 'error' | 'cancelled'
  error?: string
  createdAt?: number
}

interface DownloadsState {
  active: DownloadEntry[]
  recent: DownloadEntry[]
}

type DownloadAction =
  | { action: 'pause'; url: string }
  | { action: 'resume'; url: string }
  | { action: 'cancel'; url: string }
  | { action: 'show-in-folder'; url: string; savePath: string }
  | { action: 'dismiss'; url: string }
  | { action: 'retry'; url: string }
  | { action: 'clear-finished' }

type PopupSettingsTab = 'comfy' | 'directories' | 'downloads' | 'global'

interface PopupBridge {
  platform?: string
  downloadsAction(action: DownloadAction): void
  openSettingsTab(tab: PopupSettingsTab): void
  openDownloadsModal(): void
}

const bridge = (window as unknown as { __comfyTitlePopup?: PopupBridge }).__comfyTitlePopup
const revealLabel = computed(() => revealInFolderLabel(bridge?.platform))

const props = defineProps<{ state: DownloadsState }>()

const TERMINAL_STATUSES = new Set<DownloadEntry['status']>(['completed', 'error', 'cancelled'])

function isTerminal(d: DownloadEntry): boolean {
  return TERMINAL_STATUSES.has(d.status)
}

/** Combined list ordered newest-first by `createdAt` — both active
 *  and terminal entries share one slot so a download that transitions
 *  active → cancelled / completed stays in place rather than jumping
 *  between buckets. The active/recent split survives only because
 *  that's the shape main pushes over the IPC; on screen the most
 *  recently kicked-off download surfaces at the top of the list. */
const orderedEntries = computed<DownloadEntry[]>(() =>
  [...props.state.active, ...props.state.recent].sort(
    (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)
  )
)

function cancel(url: string): void {
  bridge?.downloadsAction({ action: 'cancel', url })
}
// TODO(brand-cleanup): redesign skips pause/resume — keep handlers wired for an easy restore.
// function pause(url: string): void {
//   bridge?.downloadsAction({ action: 'pause', url })
// }
// function resume(url: string): void {
//   bridge?.downloadsAction({ action: 'resume', url })
// }
function showInFolder(url: string, savePath: string): void {
  bridge?.downloadsAction({ action: 'show-in-folder', url, savePath })
}
function dismiss(url: string): void {
  bridge?.downloadsAction({ action: 'dismiss', url })
}
function retry(url: string): void {
  bridge?.downloadsAction({ action: 'retry', url })
}
function viewAllDownloads(): void {
  // Opens the brand-redesigned `DownloadsModal` on the host's panel
  // view instead of deep-linking to the Settings → Downloads tab.
  // Browser-style surface designed for monitoring multi-GB checkpoint
  // downloads.
  bridge?.openDownloadsModal()
}

/** Right-edge X dispatches the contextually correct action: for an
 *  in-flight entry it cancels the download (replacing the old explicit
 *  Cancel button), for a terminal entry it removes the row from the
 *  list. Functions identical to the prior actions row — only the
 *  affordance moved into the title row per the redesign. */
function handleClose(d: DownloadEntry): void {
  if (isTerminal(d)) dismiss(d.url)
  else cancel(d.url)
}

function closeLabel(d: DownloadEntry): string {
  return isTerminal(d) ? t('downloadsPopup.remove') : t('downloadsPopup.cancel')
}

/** Subtitle under the filename. Surfaces the full bytes/speed/ETA
 *  breakdown (`statusLine`) for active rows so users tracking large
 *  model downloads (10–40 GB checkpoints) see the same information a
 *  browser tray would — without leaving the app. Terminal rows still
 *  collapse to "Show in Finder" when a save path is known so the row
 *  reads as a single click affordance. */
function subtitle(d: DownloadEntry): string {
  if (d.status === 'downloading' || d.status === 'pending') {
    return statusLine(d)
  }
  if (d.status === 'paused') {
    return `${t('downloadsPopup.pause')} · ${statusLine(d)}`
  }
  if (d.status === 'completed' && d.savePath) {
    return revealLabel.value
  }
  if ((d.status === 'error' || d.status === 'cancelled') && d.savePath) {
    return revealLabel.value
  }
  return statusLine(d)
}

/** Whole-row click — completed entries with a save path open the file
 *  location, matching the design's removal of the explicit
 *  "Show in folder" button. Other statuses are not clickable. */
function handleRowClick(d: DownloadEntry, event: MouseEvent): void {
  if ((event.target as HTMLElement).closest('.downloads-item-close, .downloads-item-retry')) return
  if (d.status === 'completed' && d.savePath) showInFolder(d.url, d.savePath)
}

function isRowClickable(d: DownloadEntry): boolean {
  return d.status === 'completed' && !!d.savePath
}

/** Inline progress-fill background — only meaningful for active
 *  downloads. The card itself reads as the progress bar (gradient stop
 *  at the progress%); pending/idle states fall back to the solid card
 *  background via CSS class. */
function progressStyle(d: DownloadEntry): Record<string, string> | undefined {
  if (d.status !== 'downloading' && d.status !== 'pending') return undefined
  const pct = d.status === 'pending' ? 0 : Math.max(0, Math.min(1, d.progress)) * 100
  // Two-stop gradient with a ~1% transition so the leading edge reads
  // as a crisp line — matches the Figma spec `0% / 54% / 54.91%`.
  // At 100% the gradient collapses to a solid card, so a completed
  // row keeps its filled appearance with no special-case.
  const next = Math.min(100, pct + 0.91)
  return {
    background: `linear-gradient(90deg, var(--downloads-card) 0%, var(--downloads-card) ${pct}%, var(--downloads-bar-rest) ${next}%)`
  }
}

// TODO(brand-cleanup): redesign skips Pause/Resume in the popover. The
// bridge handlers + i18n strings remain so re-introducing them is just
// reinstating the buttons below.
</script>

<template>
  <div class="downloads">
    <header class="downloads-head">
      <h2 class="downloads-title">{{ t('downloadsPopup.title') }}</h2>
    </header>

    <div v-if="orderedEntries.length === 0" class="downloads-empty">
      {{ t('downloadsPopup.empty') }}
    </div>

    <ul v-else class="downloads-list">
      <li
        v-for="d in orderedEntries"
        :key="d.url"
        class="downloads-item"
        :class="[
          statusKindClass(d),
          {
            'is-finished': isTerminal(d),
            'is-clickable': isRowClickable(d)
          }
        ]"
        :style="progressStyle(d)"
        @click="(e) => handleRowClick(d, e)"
      >
        <span class="downloads-item-icon">
          <CircleCheck v-if="d.status === 'completed'" :size="16" class="ok" />
          <CircleAlert
            v-else-if="d.status === 'error' || d.status === 'cancelled'"
            :size="16"
            class="bad"
          />
          <PauseCircle v-else-if="d.status === 'paused'" :size="16" />
          <LoaderCircle v-else :size="16" class="spin" />
        </span>
        <div class="downloads-item-text">
          <span class="downloads-item-name" :title="fileLabel(d)">{{ fileLabel(d) }}</span>
          <span class="downloads-item-sub">{{ subtitle(d) }}</span>
        </div>
        <!-- TODO(brand-cleanup): redesign skips Pause/Resume — restore here if needed.
        <button
          v-if="d.status === 'downloading'"
          type="button"
          :aria-label="t('downloadsPopup.pause')"
          @click.stop="pause(d.url)"
        ><PauseCircle :size="14" /></button>
        <button
          v-if="d.status === 'paused'"
          type="button"
          :aria-label="t('downloadsPopup.resume')"
          @click.stop="resume(d.url)"
        ><PlayCircle :size="14" /></button>
        -->
        <button
          v-if="d.status === 'error' || d.status === 'cancelled'"
          type="button"
          class="downloads-item-retry"
          :title="t('downloadsPopup.retry')"
          :aria-label="t('downloadsPopup.retry')"
          @click.stop="retry(d.url)"
        >
          <RotateCcw :size="16" />
        </button>
        <button
          type="button"
          class="downloads-item-close"
          :title="closeLabel(d)"
          :aria-label="closeLabel(d)"
          @click.stop="handleClose(d)"
        >
          <X :size="16" />
        </button>
      </li>
    </ul>

    <footer class="downloads-foot">
      <button type="button" class="downloads-link" @click="viewAllDownloads">
        {{ t('downloadsPopup.viewAllInSettings') }}
      </button>
    </footer>
  </div>
</template>

<style scoped>
.downloads {
  /* Local design tokens — kept here (not in main.css) because they're
   * only consumed by this view. Sourced from the Figma spec; gradient
   * rest stop is the one non-ramp value (sits between --neutral-700
   * and --neutral-800). */
  --downloads-card: #322c3d;
  --downloads-bar-rest: #2a2332;
  --downloads-border: rgba(255, 255, 255, 0.1);
  --downloads-text: var(--neutral-100);
  --downloads-text-muted: var(--text-muted);
  --downloads-danger: #ff5454;

  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  background: var(--neutral-800);
}

.downloads-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--downloads-border);
  flex: 0 0 auto;
}

.downloads-title {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  color: var(--neutral-100);
}

.downloads-empty {
  padding: 24px 16px;
  color: var(--downloads-text-muted);
  text-align: center;
  font-size: 12px;
}

/* The popup view's outer height is bounded by main (DOWNLOADS_POPUP_MAX_HEIGHT_PX);
   the list itself flexes to fill what's left after the head + footer
   and scrolls internally so a long history doesn't stretch the popup. */
.downloads-list {
  list-style: none;
  margin: 0;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  flex: 1 1 auto;
  min-height: 0;
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.downloads-list::-webkit-scrollbar {
  display: none;
}

.downloads-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-radius: 8px;
  background: var(--downloads-card);
  transition: background 220ms ease;
}
.downloads-item.is-finished {
  background: var(--downloads-card);
}
.downloads-item.is-error,
.downloads-item.is-cancelled {
  background: color-mix(in srgb, var(--downloads-card) 50%, transparent);
}
.downloads-item.is-clickable {
  cursor: pointer;
}
.downloads-item.is-clickable:hover {
  background: color-mix(in srgb, var(--downloads-card) 85%, var(--neutral-500));
}

.downloads-item-icon {
  flex: 0 0 16px;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--downloads-text);
  margin-top: 2px;
  align-self: flex-start;
}
.downloads-item-icon .ok {
  color: var(--downloads-text);
}
.downloads-item-icon .bad {
  color: var(--downloads-danger);
}
.downloads-item-icon .spin {
  animation: downloads-spin 0.9s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .downloads-item-icon .spin {
    animation: none;
  }
}
@keyframes downloads-spin {
  to {
    transform: rotate(360deg);
  }
}

.downloads-item-text {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
}

.downloads-item-name {
  font-size: 14px;
  line-height: 20px;
  color: var(--downloads-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.downloads-item-sub {
  font-size: 12px;
  line-height: 1.2;
  color: var(--downloads-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.downloads-item-close,
.downloads-item-retry {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  margin-left: 4px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--downloads-text-muted);
  cursor: pointer;
  transition:
    background-color 120ms ease,
    color 120ms ease;
}
.downloads-item-close:hover,
.downloads-item-retry:hover {
  background: color-mix(in srgb, var(--neutral-500) 35%, transparent);
  color: var(--downloads-text);
}
.downloads-item-close:focus-visible,
.downloads-item-retry:focus-visible {
  outline: 2px solid var(--neutral-50);
  outline-offset: 1px;
}

.downloads-foot {
  display: flex;
  align-items: center;
  padding: 8px;
  border-top: 1px solid var(--downloads-border);
  flex: 0 0 auto;
}
.downloads-link {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  background: transparent;
  border: none;
  color: var(--neutral-100);
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  padding: 8px;
  border-radius: 6px;
  transition: background-color 120ms ease;
}
.downloads-link:hover {
  background: color-mix(in srgb, var(--neutral-500) 25%, transparent);
}
.downloads-link:focus-visible {
  outline: 2px solid var(--neutral-50);
  outline-offset: 1px;
}
</style>
