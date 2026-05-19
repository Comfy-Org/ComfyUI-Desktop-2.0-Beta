<script setup lang="ts">
import { computed, ref, toRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronRight, Plus, Search } from 'lucide-vue-next'
import BaseInput from '../components/ui/BaseInput.vue'
import { FILTER_CHIPS, useInstallList } from '../composables/useInstallList'
import { installTypeMetaFor } from '../lib/installTypeIcon'
import InstanceRow from './instancePicker/InstanceRow.vue'
import type { Installation } from '../types/ipc'

/**
 * Instance-picker popover view.
 *
 * Renders the title-bar centre pill's dropdown. The popup webContents
 * shell (`TitlePopupApp.vue`) hands us a static snapshot per open;
 * subsequent install-registry changes arrive via the
 * `onInstancePickerSnapshot` bridge subscription so the list stays
 * fresh while the popover is open.
 *
 * Pure-prop component — no IPC handshake here, just `__comfyTitlePopup`
 * bridge calls on user actions. The popup shell owns the `set-config` →
 * `notifyRendered` handshake and the natural-height `requestSize` push.
 *
 * Search / filter / recency / cloud-split logic comes from the shared
 * `useInstallList` composable, so the picker and `ChooserView` cannot
 * diverge.
 */

interface PickerInstall {
  id: string
  name: string
  sourceLabel: string
  sourceCategory: string
  version?: string
  lastLaunchedAt?: number
  installPath?: string
  status?: string
  statusTag?: { style: string; label: string }
}

interface PickerSnapshot {
  installs: PickerInstall[]
  activeInstallationId: string | null
  runningInstallationIds: string[]
}

const props = defineProps<{
  snapshot: PickerSnapshot
}>()

const { t } = useI18n()

// Bridge surface — only the methods the picker dispatches on user
// actions. `onInstancePickerSnapshot` subscription is owned by the
// shell (TitlePopupApp.vue), so we don't subscribe here too — that
// would race with the shell's incoming-snapshot handling.
interface PickerBridge {
  pickInstall: (installationId: string) => void
  openNewInstall: () => void
}
const bridge = (window as unknown as { __comfyTitlePopup?: PickerBridge }).__comfyTitlePopup

// --- shared list logic ---
//
// `useInstallList` takes a reactive installs ref; we re-coerce the
// snapshot prop into the renderer-side `Installation` shape (a
// superset of `PickerInstall` — every field the picker uses already
// exists in `Installation`).
const installations = computed<Installation[]>(
  () => props.snapshot.installs as unknown as Installation[]
)
const installationsRef = toRef(() => installations.value)
const {
  searchQuery,
  activeFilter,
  cloudInstall,
  visibleInstalls,
  showCloudCard,
  showEmptyHint,
  lastLaunchedLabel
} = useInstallList({ installations: installationsRef })

// Chips come from the shared `FILTER_CHIPS` constant in
// `useInstallList`, so ChooserView (when its hidden chip row comes
// back) and the picker can't drift in chip order or labels.

// --- selection state ---
//
// Pre-select the host's active install on open. Watch the prop so a
// fresh `set-config` (popover re-opens against a different host)
// re-syncs the selection.
const selectedId = ref<string | null>(props.snapshot.activeInstallationId)
watch(
  () => props.snapshot.activeInstallationId,
  (next) => {
    selectedId.value = next
  }
)

// Fall back to the first visible install when the active one isn't in
// the visible list (e.g. the user typed a query that filtered the
// active row out). Empty visible list → empty detail pane.
const selectedInstall = computed<Installation | null>(() => {
  const id = selectedId.value
  if (id) {
    const found = installations.value.find((i) => i.id === id)
    if (found) return found
  }
  return null
})

const selectedTypeMeta = computed(() =>
  selectedInstall.value ? installTypeMetaFor(selectedInstall.value.sourceCategory) : null
)

const runningSet = computed(() => new Set(props.snapshot.runningInstallationIds))

function isRowRunning(inst: Installation): boolean {
  return runningSet.value.has(inst.id)
}

// --- action dispatch ---
//
// The picker is a switcher: clicking a row UPDATES the right detail
// pane only, it does NOT launch. The Open button (and only the Open
// button) fires the actual `pickInstall` IPC. This matches the
// switcher pattern in the Figma — the popup stays open while the user
// browses installs and previews their details, then dismisses once
// they commit to one via Open.
function handleSelect(inst: Installation): void {
  selectedId.value = inst.id
}

function handleOpenButton(): void {
  if (!selectedInstall.value) return
  // Even when the user clicked Open on the host's own install (a
  // visual no-op because main just refocuses the existing window),
  // the picker still dismisses — that's the canonical "I committed"
  // signal back to the user.
  bridge?.pickInstall(selectedInstall.value.id)
}

function handleNewInstall(): void {
  bridge?.openNewInstall()
}

function handleCloudClick(): void {
  // Cloud row body click = select-only (same switcher contract as the
  // regular install rows). The Open button commits.
  if (cloudInstall.value) {
    selectedId.value = cloudInstall.value.id
  } else {
    // Empty Cloud CTA — no install to select, the click commits
    // directly into the new-install flow.
    bridge?.openNewInstall()
  }
}

const isCloudRowActive = computed(
  () => cloudInstall.value != null && selectedId.value === cloudInstall.value.id
)
</script>

<template>
  <div class="picker">
    <div class="picker-search">
      <BaseInput
        v-model="searchQuery"
        :placeholder="t('chooser.searchPlaceholder')"
        :aria-label="t('chooser.searchPlaceholder')"
      >
        <template #leading><Search :size="14" class="picker-search-icon" /></template>
      </BaseInput>
    </div>

    <div class="picker-chips" role="tablist" aria-label="Source filter">
      <button
        v-for="chip in FILTER_CHIPS"
        :key="chip.key"
        type="button"
        role="tab"
        class="picker-chip"
        :class="{ 'is-active': activeFilter === chip.key }"
        :aria-selected="activeFilter === chip.key"
        @click="activeFilter = chip.key"
      >
        {{ t(chip.labelKey) }}
      </button>
    </div>

    <div class="picker-body">
      <div class="picker-left">
        <div class="picker-list-section">
          <div class="picker-list-section-title">{{ t('instancePicker.instances') }}</div>

          <div class="picker-list" role="listbox">
            <div v-if="showCloudCard" class="picker-row-wrap">
              <button
                type="button"
                class="picker-row picker-row-cloud"
                :class="{ 'is-active': isCloudRowActive }"
                @click="handleCloudClick"
              >
                <div class="picker-row-icon">
                  <component :is="installTypeMetaFor('cloud').icon" :size="20" />
                </div>
                <div class="picker-row-body picker-row-body-single">
                  <div class="picker-row-name">
                    {{ cloudInstall ? cloudInstall.name : t('cloud.label') }}
                  </div>
                </div>
              </button>
            </div>

            <InstanceRow
              v-for="inst in visibleInstalls"
              :key="inst.id"
              :installation="inst"
              :active="selectedId === inst.id"
              :running="isRowRunning(inst)"
              :last-launched-label="lastLaunchedLabel(inst)"
              @select="handleSelect"
            />

            <div v-if="showEmptyHint" class="picker-list-empty">
              {{ t('chooser.noMatches') }}
            </div>
          </div>
        </div>

        <button type="button" class="picker-new-install" @click="handleNewInstall">
          <Plus :size="16" />
          <span>{{ t('instancePicker.newInstance') }}</span>
        </button>
      </div>

      <div class="picker-detail-wrap">
        <div class="picker-detail">
          <template v-if="selectedInstall">
            <div class="picker-detail-main">
              <component
                :is="selectedTypeMeta.icon"
                v-if="selectedTypeMeta"
                :size="32"
                class="picker-detail-type-icon"
                :title="t(selectedTypeMeta.labelKey)"
              />
              <div class="picker-detail-text">
                <div class="picker-detail-name">{{ selectedInstall.name }}</div>
                <div class="picker-detail-pills">
                  <span class="picker-detail-pill">{{ t('instancePicker.latestOnGithub') }}</span>
                  <span
                    v-if="selectedInstall.version"
                    class="picker-detail-pill picker-detail-pill-version"
                  >
                    v{{ selectedInstall.version }}
                  </span>
                  <span class="picker-detail-pill">
                    {{ lastLaunchedLabel(selectedInstall) }}
                  </span>
                </div>
              </div>
            </div>

            <div class="picker-detail-nav">
              <div class="picker-detail-nav-item">
                <ChevronRight :size="12" aria-hidden="true" />
                <span>{{ t('instancePicker.settings') }}</span>
              </div>
              <div class="picker-detail-nav-item">
                <ChevronRight :size="12" aria-hidden="true" />
                <span>{{ t('instancePicker.snapshots') }}</span>
              </div>
            </div>

            <div class="picker-detail-cta">
              <button type="button" class="picker-detail-open" @click="handleOpenButton">
                {{ t('instancePicker.open') }}
              </button>
              <button type="button" class="picker-detail-more">
                <span>{{ t('instancePicker.more') }}</span>
                <ChevronDown :size="16" aria-hidden="true" />
              </button>
            </div>
          </template>
          <div v-else class="picker-detail-empty">
            {{ t('instancePicker.empty') }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.picker {
  --pick-bg: rgba(255, 255, 255, 0.04);
  --pick-bg-active: rgba(255, 255, 255, 0.1);
  --pick-bg-hover: rgba(255, 255, 255, 0.08);
  --pick-stroke: rgba(255, 255, 255, 0.1);
  --pick-stroke-active: rgba(255, 255, 255, 0.3);

  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  box-sizing: border-box;
}

.picker-search {
  padding: 8px;
  border-bottom: 1px solid var(--pick-stroke);
}
.picker-search :deep(.ui-input) {
  background: transparent;
  border: none;
  border-radius: 0;
  padding: 0;
  gap: 8px;
}
.picker-search :deep(.ui-input):focus-within {
  border-color: transparent;
}
.picker-search :deep(.ui-input-leading) {
  color: var(--neutral-100);
}
.picker-search :deep(.ui-input-control) {
  padding: 0;
  font-size: 14px;
  color: var(--text);
}
.picker-search :deep(.ui-input-control::placeholder) {
  color: var(--neutral-100);
  opacity: 0.67;
}

.picker-search-icon {
  color: var(--neutral-100);
  opacity: 0.67;
  margin-top: 6px;
}
.picker-chips {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 16px;
  border-bottom: 1px solid var(--pick-stroke);
}
.picker-chip {
  height: 24px;
  padding: 3px 11px;
  border-radius: 9999px;
  border: 1px solid var(--pick-stroke);
  background: var(--pick-bg);
  font-size: 12px;
  line-height: 16px;
  color: var(--neutral-100);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  transition:
    background-color 100ms ease,
    border-color 100ms ease;
}
.picker-chip:hover,
.picker-chip:focus-visible {
  outline: none;
}
.picker-chip.is-active {
  background: var(--pick-bg-active);
  border-color: var(--pick-stroke-active);
}

.picker-body {
  flex: 1 1 0;
  min-height: 0;
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
}

.picker-left {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-bottom: 24px;
  border-right: 1px solid var(--pick-stroke);
}
.picker-list-section {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 8px 0;
  overflow: hidden;
}
.picker-list-section-title {
  flex: 0 0 auto;
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
  color: var(--neutral-100);
  opacity: 0.75;
  padding: 8px 18px 0;
}
.picker-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.picker-list-empty {
  padding: 12px 18px;
  font-size: 12px;
  color: var(--neutral-100);
  opacity: 0.7;
}

.picker-new-install {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  margin: 0 18px;
  padding: 8px 16px 8px 8px;
  border-radius: 8px;
  width: fit-content;
  border: none;
  background: var(--pick-bg-active);
  color: var(--neutral-100);
  font-size: 12px;
  font-weight: 500;
  line-height: 16px;
  cursor: pointer;
  transition: background-color 120ms ease;
}
.picker-new-install:hover,
.picker-new-install:focus-visible {
  background: var(--pick-bg-hover);
  outline: none;
}

/* Cloud row — mirrors InstanceRow inner chrome. */
.picker-row-wrap {
  padding: 2px 8px;
  width: 100%;
  box-sizing: border-box;
}
.picker-row {
  display: grid;
  grid-template-columns: 24px 1fr;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 8px 8px 10px;
  border-radius: 8px;
  border: none;
  cursor: pointer;
  color: inherit;
  font: inherit;
  text-align: left;
  background: transparent;
  transition: background-color 120ms ease;
}
.picker-row:hover,
.picker-row:focus-visible {
  background: var(--pick-bg);
  outline: none;
}
.picker-row.is-active {
  background: var(--pick-bg-active);
}
.picker-row-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  color: var(--neutral-100);
}
.picker-row-body {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
  overflow: hidden;
}
.picker-row-body-single {
  align-items: center;
}
.picker-row-name {
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
  color: var(--neutral-100);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picker-detail-wrap {
  min-width: 0;
  min-height: 0;
  padding: 24px 20px;
  display: flex;
}
.picker-detail {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.picker-detail-main {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}
.picker-detail-type-icon {
  color: var(--neutral-100);
  flex: 0 0 auto;
}
.picker-detail-text {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.picker-detail-name {
  font-size: 16px;
  font-weight: 600;
  line-height: 24px;
  color: var(--neutral-100);
}
.picker-detail-pills {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.picker-detail-pill {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 3px 11px;
  border-radius: 9999px;
  background: var(--pick-bg);
  border: 1px solid var(--pick-stroke);
  font-size: 12px;
  line-height: 16px;
  color: var(--neutral-100);
  white-space: nowrap;
}
.picker-detail-pill-version {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.picker-detail-nav {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--pick-stroke);
}
.picker-detail-nav-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--neutral-100);
  font-size: 14px;
  line-height: normal;
  cursor: pointer;
  text-align: left;
}
.picker-detail-nav-item:hover,
.picker-detail-nav-item:focus-visible {
  opacity: 0.85;
  outline: none;
}
.picker-detail-cta {
  margin-top: auto;
  display: flex;
  align-items: flex-end;
  gap: 8px;
  min-height: 40px;
}
.picker-detail-open {
  flex: 1 1 auto;
  min-height: 32px;
  padding: 8px 16px;
  border-radius: 8px;
  border: 1px solid var(--accent-primary, #0b8ce9);
  background: var(--accent-primary, #0b8ce9);
  color: var(--text);
  font-size: 12px;
  font-weight: 500;
  line-height: normal;
  cursor: pointer;
  transition: filter 100ms ease;
}
.picker-detail-open:hover,
.picker-detail-open:focus-visible {
  filter: brightness(1.08);
  outline: none;
}
.picker-detail-more {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 8px 8px 8px 16px;
  border-radius: 8px;
  border: none;
  background: var(--pick-bg-active);
  color: var(--neutral-100);
  font-size: 12px;
  font-weight: 500;
  line-height: 16px;
  cursor: pointer;
  transition: background-color 120ms ease;
}
.picker-detail-more:hover,
.picker-detail-more:focus-visible {
  background: var(--pick-bg-hover);
  outline: none;
}
.picker-detail-empty {
  margin: auto;
  font-size: 14px;
  color: var(--neutral-100);
  opacity: 0.7;
}
</style>
