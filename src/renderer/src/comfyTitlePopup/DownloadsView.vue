<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowDownToLine,
  CheckCircle2,
  Eraser,
  PauseCircle,
  PlayCircle,
  X,
  XCircle,
} from 'lucide-vue-next'
import { fileLabel, statusKindClass, statusLine } from '../lib/downloadFormatters'

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
  | { action: 'clear-finished' }

type PopupSettingsTab = 'comfy' | 'directories' | 'downloads' | 'global'

interface PopupBridge {
  downloadsAction(action: DownloadAction): void
  openSettingsTab(tab: PopupSettingsTab): void
}

const bridge = (window as unknown as { __comfyTitlePopup?: PopupBridge }).__comfyTitlePopup

const props = defineProps<{ state: DownloadsState }>()

const TERMINAL_STATUSES = new Set<DownloadEntry['status']>([
  'completed',
  'error',
  'cancelled',
])

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
    (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
  ),
)

const finishedCount = computed(
  () => props.state.recent.length,
)

function pause(url: string): void {
  bridge?.downloadsAction({ action: 'pause', url })
}
function resume(url: string): void {
  bridge?.downloadsAction({ action: 'resume', url })
}
function cancel(url: string): void {
  bridge?.downloadsAction({ action: 'cancel', url })
}
function showInFolder(url: string, savePath: string): void {
  bridge?.downloadsAction({ action: 'show-in-folder', url, savePath })
}
function dismiss(url: string): void {
  bridge?.downloadsAction({ action: 'dismiss', url })
}
function clearFinished(): void {
  bridge?.downloadsAction({ action: 'clear-finished' })
}
function viewAllInSettings(): void {
  bridge?.openSettingsTab('downloads')
}
</script>

<template>
  <div class="downloads">
    <!-- The popup is self-explanatory (it's anchored under the title-bar
         downloads icon), so no header title — that left only the
         "Clear finished" affordance, which now sits alone at the
         right edge of the head row when there's anything to clear. -->
    <header
      v-if="finishedCount > 0"
      class="downloads-head"
    >
      <button
        type="button"
        class="downloads-clear"
        :title="t('downloadsPopup.clearFinishedTooltip')"
        @click="clearFinished"
      >
        <Eraser :size="12" />
        {{ t('downloadsPopup.clearFinished') }}
      </button>
    </header>

    <div
      v-if="orderedEntries.length === 0"
      class="downloads-empty"
    >
      {{ t('downloadsPopup.empty') }}
    </div>

    <ul v-else class="downloads-list">
      <li
        v-for="d in orderedEntries"
        :key="d.url"
        class="downloads-item"
        :class="[statusKindClass(d), { 'is-finished': isTerminal(d) }]"
      >
        <div class="downloads-item-row">
          <CheckCircle2
            v-if="d.status === 'completed'"
            :size="14"
            class="downloads-item-icon ok"
          />
          <XCircle
            v-else-if="d.status === 'error' || d.status === 'cancelled'"
            :size="14"
            class="downloads-item-icon bad"
          />
          <ArrowDownToLine v-else :size="14" class="downloads-item-icon" />
          <span class="downloads-item-name" :title="fileLabel(d)">
            {{ fileLabel(d) }}
          </span>
          <!-- Per-row dismiss — only offered for terminal entries.
               Lives in the title row (not the actions row) so the
               affordance reads as "remove from this list" rather
               than a destructive delete; the trashcan was confusing
               because it implied the downloaded file would be
               deleted from disk. -->
          <button
            v-if="isTerminal(d)"
            type="button"
            class="downloads-item-dismiss"
            :title="t('downloadsPopup.remove')"
            :aria-label="t('downloadsPopup.remove')"
            @click="dismiss(d.url)"
          >
            <X :size="12" />
          </button>
        </div>
        <div class="downloads-item-status">{{ statusLine(d) }}</div>
        <div
          v-if="!isTerminal(d)"
          class="downloads-bar"
        >
          <div
            class="downloads-bar-fill"
            :class="{ indeterminate: d.status === 'pending' }"
            :style="
              d.status === 'pending'
                ? { width: '100%' }
                : { width: `${Math.round(d.progress * 100)}%` }
            "
          />
        </div>
        <div class="downloads-item-actions">
          <button
            v-if="d.status === 'downloading'"
            type="button"
            :title="t('downloadsPopup.pause')"
            :aria-label="t('downloadsPopup.pause')"
            @click="pause(d.url)"
          >
            <PauseCircle :size="14" />
            {{ t('downloadsPopup.pause') }}
          </button>
          <button
            v-if="d.status === 'paused'"
            type="button"
            class="primary"
            :title="t('downloadsPopup.resume')"
            :aria-label="t('downloadsPopup.resume')"
            @click="resume(d.url)"
          >
            <PlayCircle :size="14" />
            {{ t('downloadsPopup.resume') }}
          </button>
          <button
            v-if="!isTerminal(d)"
            type="button"
            class="danger"
            :title="t('downloadsPopup.cancel')"
            :aria-label="t('downloadsPopup.cancel')"
            @click="cancel(d.url)"
          >
            <XCircle :size="14" />
            {{ t('downloadsPopup.cancel') }}
          </button>
          <button
            v-if="d.status === 'completed' && d.savePath"
            type="button"
            @click="showInFolder(d.url, d.savePath)"
          >
            {{ t('downloadsPopup.showInFolder') }}
          </button>
        </div>
      </li>
    </ul>

    <footer class="downloads-foot">
      <button type="button" class="downloads-link" @click="viewAllInSettings">
        {{ t('downloadsPopup.viewAllInSettings') }}
      </button>
    </footer>
  </div>
</template>

<style scoped>
.downloads {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  box-sizing: border-box;
  font: 12px/1.4 var(--font-sans, 'Inter', system-ui, sans-serif);
}

/* The header now only carries the optional "Clear finished" button —
 * right-align so it sits flush with the right edge of the popup card. */
.downloads-head {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 8px 10px 6px;
  border-bottom: 1px solid var(--border, #494a50);
  flex: 0 0 auto;
}

.downloads-clear {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: 1px solid var(--border, rgba(127, 127, 127, 0.3));
  border-radius: 4px;
  padding: 2px 8px;
  font: inherit;
  font-size: 11px;
  color: inherit;
  cursor: pointer;
  opacity: 0.85;
}
.downloads-clear:hover {
  opacity: 1;
  background: rgba(127, 127, 127, 0.12);
}

.downloads-empty {
  padding: 20px 14px;
  color: var(--text-muted, #9ca0a8);
  text-align: center;
  font-size: 12px;
}

/* The popup view's outer height is bounded by main (DOWNLOADS_POPUP_MAX_HEIGHT_PX);
   the list itself flexes to fill what's left after the head + footer
   and scrolls internally so a long history doesn't stretch the popup. */
.downloads-list {
  list-style: none;
  margin: 0;
  padding: 4px 0;
  overflow-y: auto;
  flex: 1 1 auto;
  min-height: 0;
}

.downloads-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border, #494a50);
}
.downloads-item:last-child {
  border-bottom: none;
}

.downloads-item-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.downloads-item-icon {
  flex: 0 0 auto;
  color: var(--accent, #60a5fa);
}
.downloads-item-icon.ok {
  color: #22c55e;
}
.downloads-item-icon.bad {
  color: #ef4444;
}

.downloads-item-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 500;
}

/* Per-row dismiss "X" — small, low-contrast affordance pinned to the
 * end of the title row. Reads as "remove from this list" rather than
 * a destructive trashcan. */
.downloads-item-dismiss {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted, #9ca0a8);
  cursor: pointer;
  opacity: 0.6;
}
.downloads-item-dismiss:hover {
  opacity: 1;
  background: rgba(127, 127, 127, 0.18);
  color: inherit;
}

.downloads-item-status {
  font-size: 11px;
  color: var(--text-muted, #9ca0a8);
}

.downloads-bar {
  height: 3px;
  background: rgba(127, 127, 127, 0.18);
  border-radius: 2px;
  overflow: hidden;
}
.downloads-bar-fill {
  height: 100%;
  background: var(--accent, #60a5fa);
  transition: width 0.3s ease;
}
.downloads-item.is-paused .downloads-bar-fill {
  background: #f59e0b;
}
.downloads-item.is-error .downloads-bar-fill {
  background: #ef4444;
}

.downloads-item-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
/* Terminal entries with no save-path (errored / cancelled) have no
 * actions at all once Remove was lifted to the title-row X. Collapse
 * the row so the card doesn't carry a phantom margin. */
.downloads-item-actions:empty {
  display: none;
}
.downloads-item-actions button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--surface-2, rgba(127, 127, 127, 0.1));
  color: inherit;
  border: 1px solid var(--border, #494a50);
  border-radius: 4px;
  padding: 3px 8px;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.downloads-item-actions button.primary {
  background: var(--accent, #3b82f6);
  color: #fff;
  border-color: transparent;
}
.downloads-item-actions button.danger {
  border-color: rgba(239, 68, 68, 0.45);
  color: #ef4444;
}
.downloads-item-actions button.muted {
  opacity: 0.75;
}
.downloads-item-actions button:hover {
  filter: brightness(1.1);
}

.downloads-foot {
  display: flex;
  justify-content: center;
  padding: 8px 12px;
  border-top: 1px solid var(--border, #494a50);
  flex: 0 0 auto;
}
.downloads-link {
  background: transparent;
  border: none;
  color: var(--accent, #60a5fa);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  padding: 2px 6px;
}
.downloads-link:hover {
  text-decoration: underline;
}
</style>
