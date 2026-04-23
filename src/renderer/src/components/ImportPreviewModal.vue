<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useModalOverlay } from '../composables/useModalOverlay'
import type { SnapshotFilePreview } from '../types/ipc'
import SnapshotFilePreviewContent from './SnapshotFilePreviewContent.vue'

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

const { handleOverlayMouseDown, handleOverlayClick } = useModalOverlay(
  () => true,
  () => emit('cancel'),
)
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
              <SnapshotFilePreviewContent :preview="preview" />
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
</style>
