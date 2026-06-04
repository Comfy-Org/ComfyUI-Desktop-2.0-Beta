<script setup lang="ts">
import { computed } from 'vue'
import BasePrompt from './ui/BasePrompt.vue'
import BaseActionSheet from './ui/BaseActionSheet.vue'
import BaseAlert from './ui/BaseAlert.vue'
import SnapshotDiffView from './SnapshotDiffView.vue'
import { useDialogs } from '../composables/useDialogs'

// Singleton renderer for useDialogs(), mirroring ModalDialog.vue's role for
// useModal(). Mount once per renderer entry point next to <ModalDialog />.

const {
  state,
  submitPrompt,
  selectActionSheet,
  acknowledgeAlert,
  confirmPrimary,
  confirmSecondary,
  cancel
} = useDialogs()

const showPrompt = computed(() => state.open && state.kind === 'prompt')
const showActionSheet = computed(() => state.open && state.kind === 'actionSheet')
const showAlert = computed(() => state.open && state.kind === 'alert')
const showConfirm = computed(() => state.open && state.kind === 'confirm')
</script>

<template>
  <BasePrompt
    :open="showPrompt"
    :title="state.prompt.title"
    :message="state.prompt.message"
    :placeholder="state.prompt.placeholder"
    :default-value="state.prompt.defaultValue"
    :confirm-label="state.prompt.confirmLabel"
    :cancel-label="state.prompt.cancelLabel"
    :input-label="state.prompt.inputLabel"
    :required="state.prompt.required"
    :message-details="state.prompt.messageDetails"
    :size="state.prompt.size"
    @submit="submitPrompt"
    @cancel="cancel"
  />

  <BaseActionSheet
    :open="showActionSheet"
    :title="state.actionSheet.title"
    :message="state.actionSheet.message"
    :items="state.actionSheet.items"
    :cancel-label="state.actionSheet.cancelLabel"
    :size="state.actionSheet.size"
    @select="selectActionSheet"
    @cancel="cancel"
  />

  <!-- ESC / backdrop resolve via `close` (acknowledgement), matching
       browser alert() semantics where there's nothing to cancel. -->
  <BaseAlert
    :open="showAlert"
    :title="state.alert.title"
    :message="state.alert.message"
    :button-label="state.alert.buttonLabel"
    :tone="state.alert.tone"
    :message-details="state.alert.messageDetails"
    @close="acknowledgeAlert"
  />

  <BaseAlert
    :open="showConfirm"
    :title="state.confirm.title"
    :message="state.confirm.message"
    :button-label="state.confirm.confirmLabel"
    :tone="state.confirm.tone"
    :show-cancel="state.confirm.showCancel"
    :cancel-label="state.confirm.cancelLabel"
    :secondary-label="state.confirm.secondaryLabel"
    :secondary-tone="state.confirm.secondaryTone"
    :show-close-icon="state.confirm.showCloseIcon"
    :message-details="state.confirm.messageDetails"
    @close="confirmPrimary"
    @secondary="confirmSecondary"
    @cancel="cancel"
  >
    <!-- Restore-confirm diff preview; only rendered when a diff is attached. -->
    <template v-if="state.confirm.restoreDiff" #extra>
      <SnapshotDiffView :diff="state.confirm.restoreDiff" collapsible />
    </template>
  </BaseAlert>
</template>
