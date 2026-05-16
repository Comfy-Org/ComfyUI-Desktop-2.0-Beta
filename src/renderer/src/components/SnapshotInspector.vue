<script setup lang="ts">
// TODO(stale-old-modal): delete after Settings drawer (v2,
// GlobalSettingsPanel) reaches functional parity and ships everywhere.
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import SnapshotDiffView from './SnapshotDiffView.vue'
import InfoTooltip from './InfoTooltip.vue'
import { diffHasChanges, formatDate, formatNodeVersion } from '../lib/snapshots'
import type { SnapshotDetailData, SnapshotDiffData, SnapshotListData } from '../types/ipc'

interface Props {
  detail: SnapshotDetailData | null
  detailLoading: boolean
  diffMode: 'previous' | 'current' | null
  diffData: SnapshotDiffData | null
  diffLoading: boolean
  snapshotIndex: number
  totalSnapshots: number
  context: SnapshotListData['context'] | null
}

const props = defineProps<Props>()

const emit = defineEmits<{
  'toggle-diff': [mode: 'previous' | 'current']
}>()

const { t } = useI18n()

const nodeSearch = ref('')
const nodesExpanded = ref(true)
const pipSearch = ref('')
const pipExpanded = ref(false)

watch(() => props.detail, () => {
  nodeSearch.value = ''
  nodesExpanded.value = true
  pipSearch.value = ''
  pipExpanded.value = false
})

const filteredCustomNodes = computed(() => {
  if (!props.detail) return []
  if (!nodeSearch.value) return props.detail.customNodes
  const q = nodeSearch.value.toLowerCase()
  return props.detail.customNodes.filter((n) => n.id.toLowerCase().includes(q))
})

const filteredPipPackages = computed(() => {
  if (!props.detail) return []
  const entries = Object.entries(props.detail.pipPackages)
  if (!pipSearch.value) return entries
  const q = pipSearch.value.toLowerCase()
  return entries.filter(([name]) => name.toLowerCase().includes(q))
})
</script>

<template>
  <div class="snapshot-inspector" @click.stop>
    <div v-if="detailLoading" class="snapshot-loading with-spinner">{{ t('common.loading') }}</div>
    <template v-else-if="detail">
      <div class="diff-toggle">
        <button
          :class="{ active: diffMode === 'previous' }"
          :disabled="snapshotIndex === totalSnapshots - 1"
          @click="emit('toggle-diff', 'previous')"
        >
          {{ t('snapshots.diffPrevious') }}
        </button>
        <button
          :class="{ active: diffMode === 'current' }"
          :disabled="snapshotIndex === 0"
          @click="emit('toggle-diff', 'current')"
        >
          {{ t('snapshots.diffCurrent') }}
        </button>
      </div>

      <div v-if="diffMode && !diffLoading && diffData" class="diff-view">
        <div v-if="!diffHasChanges(diffData.diff)" class="diff-empty">
          {{ t('snapshots.diffNoChanges') }}
        </div>
        <SnapshotDiffView v-else :diff="diffData.diff" />
      </div>
      <div v-else-if="diffMode && diffLoading" class="snapshot-loading with-spinner">{{ t('common.loading') }}</div>

      <div class="inspector-section">
        <div class="inspector-section-title">{{ t('snapshots.environment') }}</div>
        <div class="inspector-grid">
          <div class="inspector-field">
            <span class="inspector-field-label">{{ t('snapshots.comfyuiVersion') }}</span>
            <span class="inspector-field-value">{{ detail.comfyuiVersion }}</span>
          </div>
          <div class="inspector-field">
            <span class="inspector-field-label">{{ t('snapshots.releaseTag') }}</span>
            <span class="inspector-field-value">{{ detail.comfyui.releaseTag || '—' }}</span>
          </div>
          <div class="inspector-field">
            <span class="inspector-field-label">{{ t('snapshots.variant') }}</span>
            <span class="inspector-field-value">{{ context?.variantLabel || detail.comfyui.variant || '—' }}</span>
          </div>
          <div class="inspector-field">
            <span class="inspector-field-label">{{ t('snapshots.updateChannel') }}</span>
            <span class="inspector-field-value">{{ detail.updateChannel || context?.updateChannel || '—' }}</span>
          </div>
          <div class="inspector-field">
            <span class="inspector-field-label">{{ t('snapshots.pythonVersion') }}</span>
            <span class="inspector-field-value">{{ detail.pythonVersion || context?.pythonVersion || '—' }}</span>
          </div>
          <div class="inspector-field">
            <span class="inspector-field-label">{{ t('snapshots.capturedAt') }}</span>
            <span class="inspector-field-value">{{ formatDate(detail.createdAt) }}</span>
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div
          class="inspector-section-title collapsible"
          @click="nodesExpanded = !nodesExpanded"
        >
          <span>{{ t('snapshots.customNodes') }} ({{ detail.customNodes.length }})<InfoTooltip :text="t('tooltips.customNodes')" side="bottom" /></span>
          <span class="collapse-indicator">{{ nodesExpanded ? '▾' : '▸' }}</span>
        </div>
        <template v-if="nodesExpanded">
          <div v-if="detail.customNodes.length === 0" class="inspector-empty">—</div>
          <div v-else class="node-list recessed-list">
            <input
              v-if="detail.customNodes.length > 5"
              v-model="nodeSearch"
              class="recessed-search"
              type="text"
              :placeholder="t('snapshots.searchNodes')"
            >
            <div v-if="filteredCustomNodes.length === 0 && nodeSearch" class="inspector-empty">{{ t('snapshots.searchNoResults') }}</div>
            <template v-else>
              <div v-for="node in filteredCustomNodes" :key="node.id" class="ls-node-row">
                <span class="ls-node-status" :class="node.enabled ? 'ls-node-enabled' : 'ls-node-disabled'" />
                <span class="ls-node-name">{{ node.id }}</span>
                <span class="ls-node-type">{{ node.type }}</span>
                <span class="ls-node-version" :title="formatNodeVersion(node)">{{ formatNodeVersion(node) }}</span>
              </div>
            </template>
          </div>
        </template>
      </div>

      <div class="inspector-section">
        <div
          class="inspector-section-title collapsible"
          @click="pipExpanded = !pipExpanded"
        >
          <span>{{ t('snapshots.pipPackages') }} ({{ detail.pipPackageCount }})<InfoTooltip :text="t('tooltips.pipPackages')" side="bottom" /></span>
          <span class="collapse-indicator">{{ pipExpanded ? '▾' : '▸' }}</span>
        </div>
        <template v-if="pipExpanded">
          <div class="pip-list recessed-list">
            <input
              v-model="pipSearch"
              class="recessed-search"
              type="text"
              :placeholder="t('snapshots.searchPackages')"
            >
            <div v-if="filteredPipPackages.length === 0 && pipSearch" class="inspector-empty">{{ t('snapshots.searchNoResults') }}</div>
            <template v-else>
              <div v-for="[name, version] in filteredPipPackages" :key="name" class="ls-pip-row">
                <span class="ls-pip-name">{{ name }}</span>
                <span class="ls-pip-version" :title="version">{{ version }}</span>
              </div>
            </template>
          </div>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.snapshot-inspector {
  background: var(--surface);
  border: 1px solid var(--selected);
  border-top: none;
  border-radius: 0 0 8px 8px;
  padding: 12px 14px;
  margin-bottom: 6px;
}

.snapshot-loading {
  color: var(--text-muted);
  font-size: 13px;
  padding: 16px 0;
}

.diff-toggle {
  display: flex;
  gap: 4px;
  margin-bottom: 12px;
}
.diff-toggle button {
  flex: 1;
  padding: 5px 10px;
  font-size: 12px;
  border-radius: 5px;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s;
}
.diff-toggle button:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--border-hover);
}
.diff-toggle button.active {
  background: color-mix(in srgb, var(--accent) 15%, transparent);
  border-color: var(--accent);
  color: var(--accent);
}
.diff-toggle button:disabled {
  opacity: 0.4;
  cursor: default;
}

.diff-view {
  margin-bottom: 12px;
  background: var(--bg);
  border-radius: 6px;
  padding: 10px 12px;
}

.diff-empty {
  font-size: 13px;
  color: var(--text-muted);
  text-align: center;
  padding: 8px 0;
}

.inspector-section {
  margin-bottom: 12px;
}
.inspector-section:last-child {
  margin-bottom: 0;
}

.inspector-section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.3px;
  margin-bottom: 8px;
}
.inspector-section-title.collapsible {
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  user-select: none;
}
.collapse-indicator {
  font-size: 14px;
}

.inspector-empty {
  font-size: 14px;
  color: var(--text-muted);
}

.inspector-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 16px;
}

.inspector-field {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.inspector-field-label {
  font-size: 13px;
  color: var(--text-muted);
}

.inspector-field-value {
  font-size: 14px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: text;
}

.recessed-search {
  width: 100%;
  padding: 6px 10px;
  font-size: 13px;
  border-radius: 5px;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  margin-bottom: 6px;
  box-sizing: border-box;
}
.recessed-search:focus {
  outline: none;
  border-color: var(--accent);
}

.pip-list {
  max-height: 300px;
  overflow-y: auto;
}

/* Disabled-node dot uses faint colour to match the timeline dot styling. */
.ls-node-disabled {
  background: var(--text-faint);
}
</style>
