<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseModal from '../components/ui/BaseModal.vue'
import DetailModal from './DetailModal.vue'
import type { Installation, ShowProgressOpts } from '../types/ipc'

/**
 * Per-install management modal. Opens centered from the four dashboard /
 * chooser entry-points (chooser-card kebab "Manage…", install-pill kebab,
 * `comfy://install-update/<id>` deep link, `comfy://open-settings`
 * deep link). Carries the per-install body (DetailModal in `embedded`
 * mode); global settings and directories/downloads live in the
 * title-popup, not here.
 *
 * Chrome is delegated to the shared `BaseModal` primitive: Teleport,
 * fade transition, focus capture+restore, body scroll lock, ESC dismiss,
 * backdrop dismiss, and the close affordance all come from there. We
 * only own the size + the embedded body's padding gutter.
 *
 * The in-app title-bar Settings icon (running ComfyUI window) is a
 * separate surface — see `ComfyUISettingsPanel.vue`.
 */

type DetailTab = 'status' | 'update' | 'snapshots' | 'settings'

interface Props {
  installation: Installation | null
  /** Tab to land on. `'settings'` here is DetailModal's launch-settings
   *  tab (not "global settings"). Default `'status'`. */
  initialTab?: DetailTab
  /** Pre-arm an action ID to auto-fire on mount — used by chooser-card
   *  update / migrate pills so the user lands directly on the action. */
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

// `BaseModal` owns `open` as a one-way prop; flip it on installation
// presence so the modal unmounts cleanly when the host clears the
// overlay payload (e.g. install removed via DetailModal's delete flow).
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
    :aria-label="t('settingsModal.title', 'Manage Installation')"
    content-class="manage-install-modal-content"
    @close="handleClose"
  >
    <!-- DetailModal's embedded body owns its full internal layout
         (title row, tab strip, scrollable body, pinned action bar).
         The 20px gutter wrapper gives the bottom action bar's negative
         `margin: 0 -20px` a body edge to align with. -->
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
/* BaseModal's `.base-modal-body` adds 16px/24px padding by default; the
 * embedded DetailModal already paints to the edges, so we zero it out
 * via `:deep()` on the consumer's `content-class`. */
:deep(.manage-install-modal-content) .base-modal-body {
  padding: 0;
}

/* 20px gutter — DetailModal's pinned action bar uses `margin: 0 -20px`
 * to span the full width, so this padding is load-bearing. The column
 * itself stays `overflow: hidden` so the embedded `.view-scroll` is
 * the only scrollable surface. */
.manage-install-body {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 0 20px;
  overflow: hidden;
}
</style>
