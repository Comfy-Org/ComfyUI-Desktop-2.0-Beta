<script setup lang="ts">
import { computed } from 'vue'
import { useProgressStore } from '../stores/progressStore'
import { ArrowRightLeft } from 'lucide-vue-next'
import type { Installation } from '../types/ipc'

const props = defineProps<{
  installation: Installation
}>()

const emit = defineEmits<{
  'show-progress': [opts: {
    installationId: string
    title: string
    apiCall: () => Promise<unknown>
    cancellable?: boolean
  }]
}>()

const progressStore = useProgressStore()

const activeOp = computed(() => {
  const op = progressStore.operations.get(props.installation.id)
  return op && !op.finished ? op : null
})

const progressInfo = computed(() =>
  progressStore.getProgressInfo(props.installation.id)
)

function viewProgress(): void {
  // Emit with a dummy apiCall — App.vue's showProgress detects the existing
  // in-progress operation and just reopens the ProgressModal without starting a new one.
  emit('show-progress', {
    installationId: props.installation.id,
    title: '',
    apiCall: () => Promise.resolve({} as unknown),
  })
}
</script>

<template>
  <!-- Only renders when a migration is currently in progress for this install.
       The default "Migrate to Standalone" choice now lives in OnboardingView. -->
  <div v-if="activeOp" class="migration-banner-progress-wrap">
    <div class="migration-banner-progress-content">
      <div class="migration-banner-progress-icon">
        <ArrowRightLeft :size="20" />
      </div>
      <div class="migration-banner-progress-text">
        <div class="migration-banner-progress-title">{{ $t('desktop.migrating') }}</div>
        <div class="migration-banner-progress-status">
          {{ progressInfo?.status || $t('progress.starting') }}
        </div>
      </div>
      <button class="primary" @click="viewProgress">
        {{ $t('list.viewProgress') }}
      </button>
    </div>
    <div
      class="progress-bar-track"
      :class="{ indeterminate: !progressInfo || progressInfo.percent < 0 }"
    >
      <div
        class="progress-bar-fill"
        :style="{ width: progressInfo && progressInfo.percent >= 0 ? `${progressInfo.percent}%` : '0%' }"
      ></div>
    </div>
  </div>
</template>

<style scoped>
.migration-banner-progress-wrap {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  margin-bottom: 16px;
}

.migration-banner-progress-content {
  display: flex;
  align-items: center;
  gap: 12px;
}

.migration-banner-progress-icon {
  color: var(--accent);
  flex-shrink: 0;
}

.migration-banner-progress-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex-grow: 1;
  min-width: 0;
}

.migration-banner-progress-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.migration-banner-progress-status {
  font-size: 12px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
