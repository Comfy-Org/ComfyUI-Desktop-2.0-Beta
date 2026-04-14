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

const mouseDownOnOverlay = ref(false)

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

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString()
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
      class="modal-overlay import-preview-overlay"
      @mousedown="handleOverlayMouseDown"
      @click="handleOverlayClick"
    >
      <div class="modal-box import-preview-box">
        <div class="modal-title">{{ t('snapshots.importPreviewTitle') }}</div>

        <div v-if="loading" class="import-preview-loading with-spinner">{{ t('common.loading') }}</div>

        <template v-else-if="preview">
          <div class="import-preview-meta">
            <span class="import-preview-label">{{ t('snapshots.importSourceName') }}:</span>
            <span class="import-preview-value">{{ preview.installationName }}</span>
          </div>
          <div class="import-preview-meta">
            <span class="import-preview-label">{{ t('snapshots.importSnapshotCount') }}:</span>
            <span class="import-preview-value">{{ preview.snapshotCount }}</span>
          </div>

          <div class="import-preview-list recessed-list">
            <div
              v-for="snap in preview.snapshots"
              :key="snap.filename"
              class="import-preview-row"
            >
              <span class="import-preview-trigger">{{ snap.trigger }}</span>
              <span class="import-preview-version">{{ snap.comfyuiVersion }}</span>
              <span class="import-preview-nodes">{{ snap.nodeCount }} nodes</span>
              <span class="import-preview-pips">{{ snap.pipPackageCount }} pkgs</span>
              <span class="import-preview-date">{{ formatDate(snap.createdAt) }}</span>
            </div>
          </div>
        </template>

        <div class="modal-actions">
          <button @click="emit('cancel')">{{ t('common.cancel') }}</button>
          <button
            v-if="preview"
            class="primary"
            @click="emit('confirm')"
          >
            {{ t('snapshots.importConfirm') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.import-preview-overlay {
  z-index: 75;
}

.import-preview-box {
  min-width: 400px;
  max-width: 600px;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
}

.import-preview-loading {
  justify-content: center;
  color: var(--text-muted);
  font-size: 13px;
  padding: 16px 0;
}

.import-preview-meta {
  font-size: 14px;
  margin-bottom: 4px;
}

.import-preview-label {
  color: var(--text-muted);
  margin-right: 6px;
}

.import-preview-value {
  color: var(--text);
}

.import-preview-list {
  max-height: 300px;
  overflow-y: auto;
  margin: 8px 0 16px;
}

.import-preview-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  padding: 4px 0;
  border-bottom: 1px solid var(--border);
}
.import-preview-row:last-child {
  border-bottom: none;
}

.import-preview-trigger {
  font-weight: 600;
  text-transform: capitalize;
  color: var(--text);
  min-width: 80px;
}

.import-preview-version {
  color: var(--text);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.import-preview-nodes,
.import-preview-pips {
  color: var(--text-muted);
  font-size: 12px;
  white-space: nowrap;
}

.import-preview-date {
  color: var(--text-muted);
  font-size: 12px;
  white-space: nowrap;
  margin-left: auto;
}
</style>
