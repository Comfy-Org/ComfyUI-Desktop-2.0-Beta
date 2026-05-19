<script setup lang="ts">
// TODO(stale-old-modal): delete after Settings drawer (v2,
// ComfyUISettingsPanel) reaches functional parity and ships everywhere.
import { useI18n } from 'vue-i18n'
import ModalShell from './ModalShell.vue'
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
</script>

<template>
  <ModalShell
    width="regular"
    content-class="ip-content"
    :title="t('snapshots.importPreviewTitle')"
    @close="emit('cancel')"
  >
    <div v-if="loading" class="ip-loading with-spinner">{{ t('common.loading') }}</div>
    <template v-else-if="preview">
      <SnapshotFilePreviewContent :preview="preview" />
    </template>

    <template #footer>
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
    </template>
  </ModalShell>
</template>

<style scoped>
.ip-content {
  max-width: 700px;
}

.ip-loading {
  justify-content: center;
  color: var(--text-muted);
  font-size: 14px;
  padding: 32px 0;
}
</style>
