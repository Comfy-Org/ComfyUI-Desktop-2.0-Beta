<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseModal from '../components/ui/BaseModal.vue'
import DetailModal from './DetailModal.vue'
import type { Installation, ShowProgressOpts } from '../types/ipc'

/**
 * Per-install management modal carrying the per-install body (DetailModal in `embedded` mode); chrome comes from `BaseModal`.
 * The running-window title-bar Settings icon is a separate surface (`ComfyUISettingsPanel.vue`).
 */

type DetailTab = 'status' | 'update' | 'snapshots' | 'settings'

interface Props {
  installation: Installation | null
  /** Tab to land on. `'settings'` here is DetailModal's launch-settings tab, not global settings. */
  initialTab?: DetailTab
  /** Pre-arm an action ID to auto-fire on mount (chooser-card update / migrate pills). */
  autoAction?: string | null
}

const props = withDefaults(defineProps<Props>(), {
  initialTab: 'status',
  autoAction: null,
})

const emit = defineEmits<{
  close: []
  'show-progress': [opts: ShowProgressOpts]
  'navigate-list': []
  'update:installation': [inst: Installation]
}>()

const { t } = useI18n()

// Flip `open` on installation presence so the modal unmounts when the host clears the overlay payload.
const open = computed(() => props.installation !== null)

function handleClose() {
  emit('close')
}

function handleShowProgress(opts: ShowProgressOpts) {
  emit('show-progress', opts)
}

function handleNavigateList() {
  emit('navigate-list')
}

function handleUpdateInstallation(inst: Installation) {
  emit('update:installation', inst)
}
</script>

<template>
  <BaseModal
    :open="open"
    size="lg"
    :aria-label="t('settingsModal.title', 'Manage Instance')"
    content-class="manage-install-modal-content"
    @close="handleClose"
  >
    <!-- The 20px gutter wrapper gives DetailModal's action bar (`margin: 0 -20px`) a body edge to align with. -->
    <div v-if="installation" class="manage-install-body">
      <DetailModal
        :installation="installation"
        :initial-tab="initialTab"
        :auto-action="autoAction"
        embedded
        @show-progress="handleShowProgress"
        @navigate-list="handleNavigateList"
        @update:installation="handleUpdateInstallation"
      />
    </div>
  </BaseModal>
</template>

<style scoped>
/* Zero BaseModal's default body padding — the embedded DetailModal paints to the edges. */
:deep(.manage-install-modal-content) .base-modal-body {
  padding: 0;
}

/* 20px gutter is load-bearing: DetailModal's action bar uses `margin: 0 -20px` to span full width. */
.manage-install-body {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 0 20px;
  overflow: hidden;
}
</style>
