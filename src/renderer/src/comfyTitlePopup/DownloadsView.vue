<script setup lang="ts">
import {
  ArrowDownToLine,
  CheckCircle2,
  PauseCircle,
  PlayCircle,
  XCircle,
} from 'lucide-vue-next'
import { fileLabel, statusKindClass, statusLine } from '../lib/downloadFormatters'

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

type PopupSettingsTab = 'comfy' | 'directories' | 'downloads' | 'global'

interface PopupBridge {
  downloadsAction(action: DownloadAction): void
  openSettingsTab(tab: PopupSettingsTab): void
}

const bridge = (window as unknown as { __comfyTitlePopup?: PopupBridge }).__comfyTitlePopup

defineProps<{ state: DownloadsState }>()

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
function viewAllInSettings(): void {
  bridge?.openSettingsTab('downloads')
}
</script>

<template>
  <div class="downloads">
    <header class="downloads-head">
      <h2 class="downloads-title">Downloads</h2>
    </header>

    <div
      v-if="state.active.length === 0 && state.recent.length === 0"
      class="downloads-empty"
    >
      No downloads yet
    </div>

    <ul v-else class="downloads-list">
      <li
        v-for="d in state.active"
        :key="d.url"
        class="downloads-item"
        :class="statusKindClass(d)"
      >
        <div class="downloads-item-row">
          <ArrowDownToLine :size="14" class="downloads-item-icon" />
          <span class="downloads-item-name" :title="fileLabel(d)">
            {{ fileLabel(d) }}
          </span>
        </div>
        <div class="downloads-item-status">{{ statusLine(d) }}</div>
        <div class="downloads-bar">
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
            title="Pause"
            aria-label="Pause"
            @click="pause(d.url)"
          >
            <PauseCircle :size="14" />
            Pause
          </button>
          <button
            v-if="d.status === 'paused'"
            type="button"
            class="primary"
            title="Resume"
            aria-label="Resume"
            @click="resume(d.url)"
          >
            <PlayCircle :size="14" />
            Resume
          </button>
          <button
            type="button"
            class="danger"
            title="Cancel"
            aria-label="Cancel"
            @click="cancel(d.url)"
          >
            <XCircle :size="14" />
            Cancel
          </button>
        </div>
      </li>

      <li
        v-for="d in state.recent"
        :key="`recent-${d.url}`"
        class="downloads-item is-finished"
        :class="statusKindClass(d)"
      >
        <div class="downloads-item-row">
          <CheckCircle2
            v-if="d.status === 'completed'"
            :size="14"
            class="downloads-item-icon ok"
          />
          <XCircle v-else :size="14" class="downloads-item-icon bad" />
          <span class="downloads-item-name" :title="fileLabel(d)">
            {{ fileLabel(d) }}
          </span>
        </div>
        <div class="downloads-item-status">{{ statusLine(d) }}</div>
        <div class="downloads-item-actions">
          <button
            v-if="d.status === 'completed' && d.savePath"
            type="button"
            @click="showInFolder(d.url, d.savePath)"
          >
            Show in folder
          </button>
        </div>
      </li>
    </ul>

    <footer class="downloads-foot">
      <button type="button" class="downloads-link" @click="viewAllInSettings">
        View all in Settings…
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

.downloads-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px 6px 14px;
  border-bottom: 1px solid var(--border, #494a50);
}

.downloads-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.downloads-empty {
  padding: 20px 14px;
  color: var(--text-muted, #9ca0a8);
  text-align: center;
  font-size: 12px;
}

.downloads-list {
  list-style: none;
  margin: 0;
  padding: 4px 0;
  overflow-y: auto;
  flex: 1 1 auto;
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
