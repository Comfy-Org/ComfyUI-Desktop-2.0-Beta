<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SnapshotFilePreview } from '../types/ipc'

interface Props {
  preview: SnapshotFilePreview | null
  loading: boolean
}

defineProps<Props>()

const emit = defineEmits<{
  cancel: []
  confirm: []
}>()

const { t } = useI18n()

const nodesExpanded = ref(true)
const pipExpanded = ref(false)
const mouseDownOnOverlay = ref(false)

function triggerLabel(trigger: string): string {
  switch (trigger) {
    case 'boot': return t('snapshots.triggerBoot')
    case 'restart': return t('snapshots.triggerRestart')
    case 'manual': return t('snapshots.triggerManual')
    case 'pre-update': return t('snapshots.triggerPreUpdate')
    case 'post-update': return t('snapshots.triggerPostUpdate')
    case 'post-restore': return t('snapshots.triggerPostRestore')
    default: return trigger
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString()
}

function formatNodeVersion(node: { version?: string; commit?: string }): string {
  if (node.version) return node.version
  if (node.commit) return node.commit.slice(0, 7)
  return '—'
}

function handleOverlayMouseDown(event: MouseEvent): void {
  mouseDownOnOverlay.value = event.target === (event.currentTarget as HTMLElement)
}

function handleOverlayClick(event: MouseEvent): void {
  if (mouseDownOnOverlay.value && event.target === (event.currentTarget as HTMLElement)) {
    emit('cancel')
  }
  mouseDownOnOverlay.value = false
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopImmediatePropagation()
    emit('cancel')
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <Teleport to="body">
    <div
      class="view-modal active"
      @mousedown="handleOverlayMouseDown"
      @click="handleOverlayClick"
    >
      <div class="view-modal-content ip-content">
        <div class="view-modal-header">
          <div class="view-modal-title">{{ t('snapshots.importPreviewTitle') }}</div>
          <button class="view-modal-close" @click="emit('cancel')">✕</button>
        </div>
        <div class="view-modal-body">
          <div class="view-scroll">
            <div v-if="loading" class="ip-loading with-spinner">{{ t('common.loading') }}</div>

            <template v-else-if="preview">
              <!-- Source info -->
              <div class="ls-section">
                <div class="ls-field">
                  <span class="ls-label">{{ t('list.snapshotSourceName') }}</span>
                  <span class="ls-value">{{ preview.installationName }}</span>
                </div>
                <div class="ls-field">
                  <span class="ls-label">{{ t('list.snapshotCount') }}</span>
                  <span class="ls-value">{{ preview.snapshotCount }}</span>
                </div>
              </div>

              <!-- Snapshot timeline -->
              <div class="ls-section">
                <div class="ls-section-title">{{ t('list.snapshotTimeline') }}</div>
                <div class="ls-timeline">
                  <div
                    v-for="(snap, i) in preview.snapshots"
                    :key="snap.filename"
                    class="ls-timeline-item"
                  >
                    <span class="ls-trigger" :class="'ls-trigger-' + snap.trigger">{{ triggerLabel(snap.trigger) }}</span>
                    <span v-if="i === 0" class="ls-current-tag">{{ t('snapshots.current') }}</span>
                    <span class="ls-meta">{{ snap.comfyuiVersion }} · {{ t('snapshots.nodesCount', { count: snap.nodeCount }) }} · {{ t('snapshots.packagesCount', { count: snap.pipPackageCount }) }}</span>
                    <span class="ls-time">{{ formatDate(snap.createdAt) }}</span>
                  </div>
                </div>
              </div>

              <!-- Newest snapshot detail -->
              <div class="ls-section">
                <div class="ls-section-title">{{ t('list.snapshotNewestDetail') }}</div>

                <div class="ls-grid">
                  <div class="ls-field">
                    <span class="ls-label">{{ t('snapshots.comfyuiVersion') }}</span>
                    <span class="ls-value">{{ preview.newestSnapshot.comfyuiVersion }}</span>
                  </div>
                  <div class="ls-field">
                    <span class="ls-label">{{ t('snapshots.variant') }}</span>
                    <span class="ls-value">{{ preview.newestSnapshot.comfyui.variant || '—' }}</span>
                  </div>
                  <div class="ls-field">
                    <span class="ls-label">{{ t('snapshots.pythonVersion') }}</span>
                    <span class="ls-value">{{ preview.newestSnapshot.pythonVersion || '—' }}</span>
                  </div>
                  <div class="ls-field">
                    <span class="ls-label">{{ t('snapshots.capturedAt') }}</span>
                    <span class="ls-value">{{ formatDate(preview.newestSnapshot.createdAt) }}</span>
                  </div>
                </div>

                <!-- Custom nodes -->
                <div class="ls-subsection">
                  <div class="ls-subsection-title" @click="nodesExpanded = !nodesExpanded">
                    <span>{{ t('snapshots.customNodes') }} ({{ preview.newestSnapshot.customNodes.length }})</span>
                    <span class="ls-collapse">{{ nodesExpanded ? '▾' : '▸' }}</span>
                  </div>
                  <template v-if="nodesExpanded">
                    <div v-if="preview.newestSnapshot.customNodes.length > 0" class="recessed-list">
                      <div v-for="node in preview.newestSnapshot.customNodes" :key="node.id" class="ls-node-row">
                        <span class="ls-node-status" :class="node.enabled ? 'ls-node-enabled' : 'ls-node-disabled'" />
                        <span class="ls-node-name">{{ node.id }}</span>
                        <span class="ls-node-type">{{ node.type }}</span>
                        <span class="ls-node-version" :title="formatNodeVersion(node)">{{ formatNodeVersion(node) }}</span>
                      </div>
                    </div>
                    <div v-else class="ls-empty">—</div>
                  </template>
                </div>

                <!-- Pip packages -->
                <div class="ls-subsection">
                  <div class="ls-subsection-title" @click="pipExpanded = !pipExpanded">
                    <span>{{ t('snapshots.pipPackages') }} ({{ preview.newestSnapshot.pipPackageCount }})</span>
                    <span class="ls-collapse">{{ pipExpanded ? '▾' : '▸' }}</span>
                  </div>
                  <template v-if="pipExpanded">
                    <div v-if="preview.newestSnapshot.pipPackageCount > 0" class="recessed-list">
                      <div v-for="(version, name) in preview.newestSnapshot.pipPackages" :key="name" class="ls-pip-row">
                        <span class="ls-pip-name">{{ name }}</span>
                        <span class="ls-pip-version" :title="version">{{ version }}</span>
                      </div>
                    </div>
                    <div v-else class="ls-empty">—</div>
                  </template>
                </div>
              </div>
            </template>
          </div>

          <!-- Bottom actions -->
          <div class="view-bottom">
            <button @click="emit('cancel')">{{ t('common.cancel') }}</button>
            <button
              v-if="preview"
              class="primary"
              :disabled="loading"
              @click="emit('confirm')"
            >
              {{ t('snapshots.importConfirm') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ip-content {
  max-width: 700px;
  height: auto;
  max-height: calc(100vh - 60px);
}

.ip-loading {
  justify-content: center;
  color: var(--text-muted);
  font-size: 14px;
  padding: 32px 0;
}

/* Sections — mirrored from LoadSnapshotModal */
.ls-section {
  margin-bottom: 16px;
}
.ls-section:last-child {
  margin-bottom: 0;
}

.ls-section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.3px;
  margin-bottom: 8px;
}

.ls-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 16px;
  margin-bottom: 10px;
}

.ls-field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 4px;
}

.ls-label {
  font-size: 13px;
  color: var(--text-muted);
}

.ls-value {
  font-size: 14px;
  color: var(--text);
  user-select: text;
}

/* Timeline */
.ls-timeline {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 200px;
  overflow-y: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px;
}

.ls-timeline-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  padding: 6px 10px;
  background: var(--bg);
  border-radius: 5px;
}

.ls-trigger {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  padding: 1px 6px;
  border-radius: 3px;
  flex-shrink: 0;
  color: var(--text-muted);
  background: var(--surface);
}

.ls-trigger-boot { color: var(--text-muted); }
.ls-trigger-restart { color: var(--info); }
.ls-trigger-manual { color: var(--success); }
.ls-trigger-pre-update { color: var(--success); }
.ls-trigger-post-update { color: var(--warning); }
.ls-trigger-post-restore { color: var(--warning); }

.ls-current-tag {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  flex-shrink: 0;
}

.ls-meta {
  color: var(--text-muted);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ls-time {
  color: var(--text-muted);
  font-size: 13px;
  flex-shrink: 0;
}

/* Subsections (nodes, packages) */
.ls-subsection {
  margin-top: 10px;
}

.ls-subsection-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  user-select: none;
  margin-bottom: 6px;
}

.ls-collapse {
  font-size: 14px;
}

.ls-node-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  padding: 2px 0;
}

.ls-node-status {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.ls-node-enabled { background: var(--info); }
.ls-node-disabled { background: var(--text-muted); }

.ls-node-name {
  color: var(--text);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: text;
}

.ls-node-type {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--text-muted);
  padding: 1px 5px;
  border: 1px solid var(--border);
  border-radius: 3px;
  flex-shrink: 0;
}

.ls-node-version {
  font-size: 13px;
  color: var(--text-muted);
  font-family: monospace;
  flex-shrink: 0;
  user-select: text;
}

.ls-empty {
  font-size: 14px;
  color: var(--text-muted);
}

.ls-pip-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 2px 0;
  font-size: 13px;
}

.ls-pip-name {
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
  user-select: text;
}

.ls-pip-version {
  color: var(--text-muted);
  font-family: monospace;
  margin-left: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 50%;
  user-select: text;
}
</style>
