<script setup lang="ts">
import { computed, onMounted, ref, toRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, Search } from 'lucide-vue-next'
import BaseInput from '../components/ui/BaseInput.vue'
import { FILTER_CHIPS, useInstallList } from '../composables/useInstallList'
import { useSessionStore } from '../stores/sessionStore'
import ComfyUISettingsContent from '../components/settings/ComfyUISettingsContent.vue'
import InstanceRow from './instancePicker/InstanceRow.vue'
import { resolvePickerTab, type PickerTab } from '../lib/pickerTabs'
import { mergePanelLocaleIntoPopup } from './pickerSettingsApiShim'
import type {
  DetailSection,
  Installation,
  RunningInstance,
  ShowProgressOpts,
  SnapshotListData
} from '../types/ipc'

/**
 * Instance-picker popover view — persistent master–detail split.
 *
 * Left pane: searchable instance list. Right pane: per-install settings.
 * Row click selects an install and updates the detail pane; Open/Restart
 * lives in the settings footer only.
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
  selectedInstallationId: string | null
  selectedSettings: DetailSection[] | null
  selectedSnapshots: SnapshotListData | null
  initialTab?: string | null
  autoAction?: string | null
}

const props = defineProps<{
  snapshot: PickerSnapshot
}>()

const { mergeLocaleMessage } = useI18n()

const sessionStore = useSessionStore()
function hydrateSessionStoreFromSnapshot(): void {
  const next = new Set(props.snapshot.runningInstallationIds)
  for (const id of Array.from(sessionStore.runningInstances.keys())) {
    if (!next.has(id)) sessionStore.runningInstances.delete(id)
  }
  for (const id of next) {
    if (!sessionStore.runningInstances.has(id)) {
      const placeholder: RunningInstance = {
        installationId: id,
        installationName: '',
        mode: ''
      }
      sessionStore.runningInstances.set(id, placeholder)
    }
  }
}

let panelLocaleMerge: Promise<void> | null = null
function ensurePanelLocaleMerged(): Promise<void> {
  panelLocaleMerge ??= mergePanelLocaleIntoPopup(mergeLocaleMessage)
  return panelLocaleMerge
}

interface PickerBridge {
  platform?: string
  pickInstall: (installationId: string) => void
  openNewInstall: () => void
  restartInstall: (installationId: string) => void
  setPickerSelectedInstall: (installationId: string | null) => void
  pickerUpdateField: (
    installationId: string,
    fieldId: string,
    value: unknown
  ) => Promise<{ ok: boolean; message?: string }>
  pickerRunAction: (
    installationId: string,
    actionId: 'snapshot-save' | 'snapshot-restore' | 'snapshot-delete',
    actionData?: Record<string, unknown>
  ) => Promise<{ ok: boolean; message?: string }>
  openInstallAction: (installationId: string, actionId: string) => void
  pickerForwardShowProgress: (payload: {
    installationId: string
    actionId: string
    actionData?: Record<string, unknown>
    title: string
    cancellable?: boolean
    triggersInstanceStart?: boolean
    opKind?: 'launch' | 'install' | 'update' | 'destructive' | 'snapshot' | 'generic'
    isRestart?: boolean
  }) => void
}
const bridge = (window as unknown as { __comfyTitlePopup?: PickerBridge }).__comfyTitlePopup

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
  lastLaunchedShortLabel
} = useInstallList({ installations: installationsRef })

const visibleChips = computed(() => {
  return FILTER_CHIPS.filter((chip) => {
    if (chip.key === 'all') return true
    const count = installations.value.filter((i) => {
      if (chip.key === 'local') {
        return i.sourceCategory === 'local' || i.sourceCategory === 'desktop'
      }
      return i.sourceCategory === chip.key
    }).length
    return count > 0
  })
})

function resolveInitialSelection(snapshot: PickerSnapshot): string | null {
  const explicit = snapshot.selectedInstallationId ?? snapshot.activeInstallationId
  if (explicit) return explicit
  return snapshot.installs[0]?.id ?? null
}
const selectedId = ref<string | null>(resolveInitialSelection(props.snapshot))
watch(
  () => props.snapshot.selectedInstallationId,
  (next) => {
    if (next) selectedId.value = next
  }
)
watch(
  () => props.snapshot.activeInstallationId,
  (next) => {
    if (!props.snapshot.selectedInstallationId) {
      selectedId.value = next ?? props.snapshot.installs[0]?.id ?? null
    }
  }
)
watch(
  () => props.snapshot.installs,
  (installs) => {
    if (props.snapshot.selectedInstallationId || props.snapshot.activeInstallationId) return
    if (selectedId.value) return
    const first = installs[0]
    if (first) {
      selectedId.value = first.id
    }
  }
)

const selectedInstall = computed<Installation | null>(() => {
  const id = selectedId.value
  if (id) {
    const found = installations.value.find((i) => i.id === id)
    if (found) return found
  }
  return null
})

const runningSet = computed(() => new Set(props.snapshot.runningInstallationIds))

function isRowRunning(inst: Installation): boolean {
  return runningSet.value.has(inst.id)
}

function handleSelect(inst: Installation): void {
  selectedId.value = inst.id
}

function handleNewInstall(): void {
  bridge?.openNewInstall()
}

watch(
  () => selectedInstall.value?.id ?? null,
  (next) => {
    bridge?.setPickerSelectedInstall(next)
  }
)

// Install-less host (chooser/dashboard): when the picker opens with
// no explicit user pick and no host install, `resolveInitialSelection`
// falls back to `installs[0]`. The reactive watcher above only fires
// on *change*, so the initial fallback never reaches main. Persist
// once on mount so main owns the selection from the first frame.
if (
  selectedId.value &&
  !props.snapshot.selectedInstallationId &&
  !props.snapshot.activeInstallationId
) {
  bridge?.setPickerSelectedInstall(selectedId.value)
}

const initialExpandedTab = computed<PickerTab>(() =>
  resolvePickerTab(props.snapshot.initialTab, 'config')
)

watch(
  () => props.snapshot.runningInstallationIds.join(','),
  () => hydrateSessionStoreFromSnapshot(),
  { immediate: true }
)

onMounted(() => {
  void ensurePanelLocaleMerged()
})

function handleSettingsShowProgress(opts: ShowProgressOpts): void {
  if (!opts.actionId) return
  bridge?.pickerForwardShowProgress({
    installationId: opts.installationId,
    actionId: opts.actionId,
    actionData: opts.actionData,
    title: opts.title,
    cancellable: opts.cancellable,
    triggersInstanceStart: opts.triggersInstanceStart,
    opKind: opts.opKind,
    isRestart: opts.actionId === 'restart'
  })
}

function handleSettingsNavigateList(): void {
  selectedId.value = null
}

function handleExpandedPrimaryAction(running: boolean): void {
  const inst = selectedInstall.value
  if (!inst) return
  if (running) {
    bridge?.restartInstall(inst.id)
  } else {
    bridge?.pickInstall(inst.id)
  }
}
</script>

<template>
  <div class="picker">
    <div class="picker-search">
      <BaseInput
        v-model="searchQuery"
        :placeholder="$t('chooser.searchPlaceholder')"
        :aria-label="$t('chooser.searchPlaceholder')"
      >
        <template #leading><Search :size="20" class="picker-search-icon" /></template>
      </BaseInput>
    </div>

    <div
      class="picker-chips"
      role="tablist"
      :aria-label="$t('chooser.filterLabel', 'Source filter')"
    >
      <button
        v-for="chip in visibleChips"
        :key="chip.key"
        type="button"
        role="tab"
        class="picker-chip"
        :class="{ 'is-active': activeFilter === chip.key }"
        :aria-selected="activeFilter === chip.key"
        @click="activeFilter = chip.key"
      >
        {{ $t(chip.labelKey) }}
      </button>
    </div>

    <div class="picker-body">
      <div class="picker-left">
        <div class="picker-list-section">
          <div class="picker-list-section-title">{{ $t('instancePicker.instances') }}</div>

          <div class="picker-list" role="listbox">
            <InstanceRow
              v-if="showCloudCard && cloudInstall"
              :key="cloudInstall.id"
              :installation="cloudInstall"
              :active="selectedId === cloudInstall.id"
              :running="isRowRunning(cloudInstall)"
              :last-launched-short-label="lastLaunchedShortLabel(cloudInstall)"
              @select="handleSelect"
            />

            <InstanceRow
              v-for="inst in visibleInstalls"
              :key="inst.id"
              :installation="inst"
              :active="selectedId === inst.id"
              :running="isRowRunning(inst)"
              :last-launched-short-label="lastLaunchedShortLabel(inst)"
              @select="handleSelect"
            />

            <div v-if="showEmptyHint" class="picker-list-empty">
              {{ $t('chooser.noMatches') }}
            </div>
          </div>
        </div>

        <footer class="picker-left-footer">
          <button type="button" class="picker-new-install" @click="handleNewInstall">
            <Plus :size="16" />
            <span>{{ $t('instancePicker.newInstance') }}</span>
          </button>
        </footer>
      </div>

      <div class="picker-detail-wrap is-expanded">
        <div class="picker-detail">
          <template v-if="selectedInstall">
            <ComfyUISettingsContent
              :installation="selectedInstall"
              :initial-tab="initialExpandedTab"
              :auto-action="snapshot.autoAction ?? null"
              :show-back="true"
              class="picker-expanded-body"
              @show-progress="handleSettingsShowProgress"
              @navigate-list="handleSettingsNavigateList"
              @request-close="handleSettingsNavigateList"
              @primary-action="handleExpandedPrimaryAction"
            />
          </template>
          <div v-else class="picker-detail-empty">
            {{ $t('instancePicker.empty') }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.picker {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  box-sizing: border-box;
  background: var(--modal-surface-bg);
}

.picker-search {
  border-bottom: 1px solid var(--brand-surface-border-hover, var(--chooser-surface-border));
  padding: 6px 12px 8px 12px;
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
  color: var(--text);
}
.picker-search :deep(.ui-input-control) {
  padding: 2px 0 0 0;
  font-size: 14px;
  line-height: 20px;
  color: var(--text);
}
.picker-search :deep(.ui-input-control::placeholder) {
  color: var(--text);
  opacity: 0.6;
}

.picker-search-icon {
  color: var(--accent-label);
  margin-top: 2px;
}
.picker-chips {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 8px 16px 10px 16px;
  border-bottom: 1px solid var(--brand-surface-border-hover, var(--chooser-surface-border));
}
.picker-chip {
  height: 22px;
  padding: 2px 10px;
  border-radius: 9999px;
  border: 1px solid var(--brand-surface-border-hover, var(--chooser-surface-border));
  background: transparent;
  font-size: 11px;
  font-weight: 500;
  line-height: 16px;
  color: var(--neutral-100);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  transition:
    background-color 100ms ease,
    border-color 100ms ease,
    color 100ms ease;
}
.picker-chip:hover,
.picker-chip:focus-visible {
  outline: none;
  color: var(--text);
}
.picker-chip.is-active {
  background: var(--chooser-surface-border);
  border-color: var(--brand-surface-border-hover);
  color: var(--text);
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
  border-right: 1px solid var(--chooser-surface-border);
  background: var(--modal-surface-bg);
}
.picker-left-footer {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  padding: 12px 16px;
  border-top: 1px solid var(--chooser-surface-border);
  background: var(--modal-surface-bg);
}
.picker-list-section {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.picker-list-section-title {
  flex: 0 0 auto;
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
  color: var(--neutral-100);
  opacity: 0.7;
  padding: 12px 18px 0 16px;
  margin-bottom: 14px;
}
.picker-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.picker-list-empty {
  padding: 8px 18px;
  font-size: 14px;
  color: var(--neutral-100);
}

.picker-new-install {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 32px;
  padding: 8px 14px;
  border-radius: 8px;
  width: fit-content;
  border: none;
  background: var(--chooser-surface-border-hover);
  color: var(--neutral-100);
  font-size: 12px;
  font-weight: 500;
  line-height: 16px;
  cursor: pointer;
  transition:
    background-color 120ms ease,
    color 120ms ease;
}
.picker-new-install:hover,
.picker-new-install:focus-visible {
  background: var(--brand-surface-border-hover);
  color: var(--text);
  outline: none;
}

.picker-detail-wrap {
  min-width: 0;
  min-height: 0;
  padding: 0 8px;
  display: flex;
  overflow: hidden;
}
.picker-detail {
  position: relative;
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.picker-detail-empty {
  margin: auto;
  font-size: 14px;
  color: var(--neutral-100);
  opacity: 0.7;
}

.picker-detail-wrap.is-expanded {
  padding: 0;
}
.picker-detail-wrap.is-expanded .picker-detail {
  gap: 0;
}

.picker-expanded-body {
  flex: 1 1 auto;
  min-height: 0;
  --text-muted: var(--neutral-100);
}
</style>
