<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted, reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import { useModal, type ModalOption } from '../composables/useModal'
import { TID } from '../../../shared/testIds'
import InfoTooltip from './InfoTooltip.vue'
import MigrateConfirmBody from './MigrateConfirmBody.vue'
import BaseAlert from './ui/BaseAlert.vue'
import { formatNodeVersion } from '../lib/snapshots'

const { t } = useI18n()

const { state, close, dismiss } = useModal()

/** Whether the current confirm modal is the Migrate-to-Standalone flow.
 *  `snapshotPreview` is only set by `useMigrateAction`, so its presence
 *  is a reliable cue to swap into the brand layout (counts only, no
 *  device picker, yellow primary CTA — parallel to the Configure
 *  Continue precedent). Other `confirm` callers keep the legacy
 *  modal-box. */
const isMigrateConfirm = computed(() => state.type === 'confirm' && state.snapshotPreview != null)

/** A confirm is "simple" when it has no extras — no snapshot preview,
 *  no detail groups, no checkboxes, no loading state, no variant cards.
 *  These render through `BaseAlert` (cancel + primary). Rich confirms
 *  (migrate, snapshot preview, multi-line detail confirms) keep the
 *  legacy markup with its scrollable body. */
const isSimpleConfirm = computed(
  () =>
    state.type === 'confirm' &&
    !state.loading &&
    state.snapshotPreview == null &&
    state.messageDetails.length === 0 &&
    state.checkboxes.length === 0 &&
    state.variantCards.length === 0 &&
    !state.variantLoading
)

/** True when the current modal is rendered by `BaseAlert` (which owns
 *  its own teleport + overlay). The legacy overlay below must skip in
 *  that case so we don't double-mount a backdrop. */
const usesBaseAlert = computed(() => state.type === 'alert' || isSimpleConfirm.value)

const baseAlertTone = computed<'primary' | 'danger'>(() =>
  state.type === 'confirm' && state.confirmStyle === 'danger' ? 'danger' : 'primary'
)

/** Alert uses `buttonLabel` (single OK action); simple confirm uses
 *  `confirmLabel` (the primary action like "Delete" / "Switch"). */
const baseAlertButtonLabel = computed(() =>
  state.type === 'alert' ? state.buttonLabel : state.confirmLabel
)

function onBaseAlertClose(): void {
  // Alert: resolve void. Simple confirm: resolve `true`.
  if (state.type === 'alert') close(undefined)
  else close(true)
}

function onBaseAlertCancel(): void {
  // Only reached for simple confirms (showCancel=true).
  close(false)
}

/** MigrateConfirmBody emits when a checkbox flips. Mirror the change
 *  back into `state.checkboxes` so `useModal.getLastCheckboxValues()`
 *  picks up the new value at submit time. */
function onMigrateCheckboxToggle(id: string, checked: boolean): void {
  const cb = state.checkboxes.find((c) => c.id === id)
  if (cb) cb.checked = checked
}

const inputValue = ref('')
const error = ref('')
const inputRef = ref<HTMLInputElement | null>(null)
const overlayRef = ref<HTMLDivElement | null>(null)
const mouseDownOnOverlay = ref(false)
const spNodesExpanded = ref(true)
const spPipExpanded = ref(false)

const localOptions = reactive<(ModalOption & { checked: boolean })[]>([])

const anyChecked = computed(() => localOptions.some((o) => o.checked))

const confirmClass = computed(() =>
  state.confirmStyle === 'danger' ? 'danger-solid' : state.confirmStyle
)

function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

function linkify(text: string): string {
  if (!text) return ''
  const parts = text.split(/(https?:\/\/[^\s<>"']+)/g)
  return parts
    .map((part, i) => {
      const escaped = escapeHtml(part)
      if (i % 2 === 1) {
        return `<a href="#" class="modal-link" data-url="${escaped}">${escaped}</a>`
      }
      return escaped
    })
    .join('')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
}

const linkifiedMessage = computed(() => linkify(state.message))

function handleMessageClick(event: MouseEvent): void {
  const target = event.target as HTMLElement
  if (target.classList.contains('modal-link')) {
    event.preventDefault()
    const url = target.dataset.url
    if (url) {
      window.api.openExternal(url)
    }
  }
}

function submitPrompt(): void {
  const value = inputValue.value.trim()
  if (state.required && !value) {
    error.value = typeof state.required === 'string' ? state.required : 'This field is required'
    return
  }
  close(value)
}

function submitOptions(): void {
  const result: Record<string, boolean> = {}
  for (const opt of localOptions) {
    result[opt.id] = opt.checked
  }
  close(result)
}

function handleOverlayMouseDown(event: MouseEvent): void {
  mouseDownOnOverlay.value = event.target === overlayRef.value
}

function handleOverlayClick(event: MouseEvent): void {
  if (mouseDownOnOverlay.value && event.target === overlayRef.value) {
    dismiss()
  }
  mouseDownOnOverlay.value = false
}

function resetSnapshotExpansion(): void {
  const sp = state.snapshotPreview
  const hasVariantCards = state.variantCards.length > 0 || state.variantLoading
  spNodesExpanded.value = hasVariantCards ? false : sp ? sp.customNodes.length > 0 : true
  spPipExpanded.value = false
}

watch(
  () => state.snapshotPreview,
  () => {
    if (state.visible && state.type === 'confirm') {
      resetSnapshotExpansion()
    }
  }
)

watch(
  () => state.variantCards,
  () => {
    if (state.visible && state.type === 'confirm' && state.variantCards.length > 0) {
      spNodesExpanded.value = false
    }
  }
)

function handleKeydown(event: KeyboardEvent): void {
  if (!state.visible) return
  // BaseAlert owns its own ESC dismissal for alert + simple confirm.
  // Skip here to avoid double-resolving the promise.
  if (usesBaseAlert.value) return
  if (event.key === 'Escape') {
    dismiss()
  }
}

watch(
  () => state.visible,
  async (visible) => {
    if (!visible) return

    if (state.type === 'prompt') {
      inputValue.value = state.defaultValue
      error.value = ''
      await nextTick()
      inputRef.value?.focus()
      inputRef.value?.select()
    }

    if (state.type === 'confirm') {
      resetSnapshotExpansion()
    }

    if (state.type === 'confirmWithOptions') {
      localOptions.length = 0
      for (const opt of state.options) {
        localOptions.push({ id: opt.id, label: opt.label, checked: opt.checked ?? false })
      }
    }
  }
)

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <!-- Alerts and simple confirms render through the shared `BaseAlert`
       primitive (compact, role=alertdialog, focus restore, scroll lock,
       a11y baked in). Rich confirms / prompt / select / options stay in
       the legacy markup below until each gets its own dedicated
       primitive — they have substantial bespoke UI (snapshot preview,
       variant grid, detail groups) that doesn't fit the alert shape.
       Single <BaseAlert> handles both intents; computed props swap the
       primary label/tone and toggle Cancel based on `state.type`. -->
  <BaseAlert
    :open="state.visible && usesBaseAlert"
    :title="state.title"
    :message="state.message"
    :show-cancel="isSimpleConfirm"
    :button-label="baseAlertButtonLabel"
    :tone="baseAlertTone"
    :test-id-root="state.testIds.root"
    :test-id-action="state.testIds.action"
    :test-id-cancel="state.testIds.cancel"
    @close="onBaseAlertClose"
    @cancel="onBaseAlertCancel"
  />

  <Teleport to="body">
    <div
      v-if="state.visible && !usesBaseAlert"
      ref="overlayRef"
      class="modal-overlay"
      @mousedown="handleOverlayMouseDown"
      @click="handleOverlayClick"
    >
      <!-- Confirm (rich: snapshot preview, variants, details, checkboxes,
           or loading state). Simple confirms fall through to BaseAlert
           above. -->
      <div
        v-if="state.type === 'confirm'"
        class="modal-box"
        :class="{
          'modal-box-wide':
            state.snapshotPreview ||
            state.loading ||
            state.variantLoading ||
            state.variantCards.length > 0,
          'modal-box--brand mig-modal': isMigrateConfirm
        }"
      >
        <div class="modal-title">{{ state.title }}</div>
        <div class="modal-body">
          <!-- Prompt card hidden when message is empty (the migrate
               flow doesn't set a message; rendering an empty card
               leaves a stray box at the top of the modal). -->
          <div
            v-if="state.message"
            class="modal-prompt-card"
            @click="handleMessageClick"
            v-html="linkifiedMessage"
          ></div>

          <!-- Loading -->
          <div v-if="state.loading" class="modal-loading">
            <div class="modal-loading-spinner" />
            <span>{{ $t('common.loading') }}</span>
          </div>

          <!-- ──────────────────────────────────────────────────────
               Migrate-flow brand layout. Lives next to the legacy
               snapshot-preview / variant-picker / details blocks
               below so the older code is preserved (commented via
               v-if="false") for reference. CTO note: drop device
               picker entirely + collapse Custom Nodes / Pip Packages
               to counts only.
               ────────────────────────────────────────────────────── -->
          <template v-if="isMigrateConfirm && !state.loading && state.snapshotPreview">
            <MigrateConfirmBody
              :preview="state.snapshotPreview"
              :details="state.messageDetails"
              :checkboxes="state.checkboxes"
              @toggle-checkbox="onMigrateCheckboxToggle"
            />
          </template>

          <!-- Legacy snapshot preview (expandables) — preserved but
               disabled. Rendering is gated on `!isMigrateConfirm` so
               the brand layout above is the only thing the user sees
               in the migrate flow today; flip the flag back on if we
               ever need the detailed view. -->
          <template v-if="!isMigrateConfirm && !state.loading && state.snapshotPreview">
            <div class="ls-grid">
              <div class="ls-field">
                <span class="ls-label">{{ $t('snapshots.comfyuiVersion') }}</span>
                <span class="ls-value">{{ state.snapshotPreview.comfyuiVersion }}</span>
              </div>
              <div class="ls-field">
                <span class="ls-label">{{ $t('snapshots.variant') }}</span>
                <span class="ls-value">{{ state.snapshotPreview.comfyui.variant || '—' }}</span>
              </div>
              <div v-if="state.snapshotPreview.pythonVersion" class="ls-field">
                <span class="ls-label">{{ $t('snapshots.pythonVersion') }}</span>
                <span class="ls-value">{{ state.snapshotPreview.pythonVersion }}</span>
              </div>
            </div>

            <div class="ls-subsection">
              <div class="ls-subsection-title" @click="spNodesExpanded = !spNodesExpanded">
                <span
                  >{{ $t('snapshots.customNodes') }} ({{
                    state.snapshotPreview.customNodes.length
                  }})<InfoTooltip :text="t('tooltips.customNodes')" side="bottom"
                /></span>
                <span class="ls-collapse">{{ spNodesExpanded ? '▾' : '▸' }}</span>
              </div>
              <template v-if="spNodesExpanded">
                <div v-if="state.snapshotPreview.customNodes.length > 0" class="recessed-list">
                  <div
                    v-for="node in state.snapshotPreview.customNodes"
                    :key="node.id"
                    class="ls-node-row"
                  >
                    <span
                      class="ls-node-status"
                      :class="node.enabled ? 'ls-node-enabled' : 'ls-node-disabled'"
                    />
                    <span class="ls-node-name">{{ node.id }}</span>
                    <span class="ls-node-type">{{ node.type }}</span>
                    <span class="ls-node-version">{{ formatNodeVersion(node) }}</span>
                  </div>
                </div>
                <div v-else class="ls-empty">—</div>
              </template>
            </div>

            <div class="ls-subsection">
              <div class="ls-subsection-title" @click="spPipExpanded = !spPipExpanded">
                <span
                  >{{ $t('snapshots.pipPackages') }} ({{
                    state.snapshotPreview.pipPackageCount
                  }})<InfoTooltip :text="t('tooltips.pipPackages')" side="bottom"
                /></span>
                <span class="ls-collapse">{{ spPipExpanded ? '▾' : '▸' }}</span>
              </div>
              <template v-if="spPipExpanded">
                <div v-if="state.snapshotPreview.pipPackageCount > 0" class="recessed-list">
                  <div
                    v-for="(version, name) in state.snapshotPreview.pipPackages"
                    :key="name"
                    class="ls-pip-row"
                  >
                    <span class="ls-pip-name">{{ name }}</span>
                    <span class="ls-pip-version" :title="version">{{ version }}</span>
                  </div>
                </div>
                <div v-else class="ls-empty">—</div>
              </template>
            </div>
          </template>

          <!-- Generic message details + checkboxes (non-migrate
               confirms). The migrate brand layout above renders its
               own action list + checkbox row, so skip this when
               migrate is active to avoid duplication. -->
          <template v-if="!isMigrateConfirm">
            <div v-if="state.messageDetails.length" class="modal-details">
              <div v-for="(group, gi) in state.messageDetails" :key="gi" class="modal-detail-group">
                <span class="modal-detail-label">{{ group.label }}</span>
                <div class="modal-detail-recessed" @click="handleMessageClick">
                  <div
                    v-for="(item, ii) in group.items"
                    :key="ii"
                    class="modal-detail-item"
                    v-html="linkify(item)"
                  ></div>
                </div>
              </div>
            </div>
            <div v-if="state.checkboxes.length" class="modal-options">
              <label v-for="cb in state.checkboxes" :key="cb.id" class="modal-option">
                <input v-model="cb.checked" type="checkbox" />
                <span>{{ cb.label }}</span>
              </label>
            </div>
          </template>
        </div>
        <div class="modal-actions">
          <button :data-testid="TID.modalCancel" @click="close(false)">{{ $t('common.cancel') }}</button>
          <button
            :class="confirmClass"
            :disabled="
              state.loading ||
              state.variantLoading ||
              (state.variantCards.length > 0 && !state.selectedVariant)
            "
            :data-testid="TID.modalConfirm"
            @click="close(true)"
          >
            {{ state.confirmLabel }}
          </button>
        </div>
      </div>

      <!-- ConfirmWithOptions -->
      <div v-else-if="state.type === 'confirmWithOptions'" class="modal-box">
        <div class="modal-title">{{ state.title }}</div>
        <div class="modal-message">{{ state.message }}</div>
        <div class="modal-options">
          <label v-for="opt in localOptions" :key="opt.id" class="modal-option">
            <input v-model="opt.checked" type="checkbox" />
            <span>{{ opt.label }}</span>
          </label>
        </div>
        <div class="modal-actions">
          <button @click="close(null)">{{ $t('common.cancel') }}</button>
          <button :class="confirmClass" :disabled="!anyChecked" @click="submitOptions()">
            {{ state.confirmLabel }}
          </button>
        </div>
      </div>

      <!-- Prompt -->
      <div
        v-else-if="state.type === 'prompt'"
        class="modal-box"
        :class="{ 'modal-box-wide': state.messageDetails.length > 0 }"
      >
        <div class="modal-title">{{ state.title }}</div>
        <div class="modal-body">
          <div class="modal-prompt-card" v-html="linkify(state.message)"></div>
          <div v-if="state.messageDetails.length" class="modal-details">
            <div v-for="(group, gi) in state.messageDetails" :key="gi" class="modal-detail-group">
              <span class="modal-detail-label">{{ group.label }}</span>
              <div class="modal-detail-recessed" @click="handleMessageClick">
                <div
                  v-for="(item, ii) in group.items"
                  :key="ii"
                  class="modal-detail-item"
                  v-html="linkify(item)"
                ></div>
              </div>
            </div>
          </div>
          <div class="modal-input-wrap">
            <label class="modal-input-label">{{ $t('common.name') }}</label>
            <input
              ref="inputRef"
              v-model="inputValue"
              type="text"
              class="modal-input"
              :data-testid="TID.modalPromptInput"
              :placeholder="state.placeholder"
              @keydown.enter="submitPrompt"
            />
          </div>
          <div v-if="error" class="modal-error">{{ error }}</div>
        </div>
        <div class="modal-actions">
          <button :data-testid="TID.modalCancel" @click="close(null)">{{ $t('common.cancel') }}</button>
          <button class="primary" :data-testid="TID.modalConfirm" @click="submitPrompt">{{ state.confirmLabel }}</button>
        </div>
      </div>

      <!-- Select -->
      <div v-else-if="state.type === 'select'" class="modal-box modal-select-box">
        <div class="modal-title">{{ state.title }}</div>
        <div v-if="state.message" class="modal-message">{{ state.message }}</div>
        <div class="modal-select-list">
          <button
            v-for="item in state.items"
            :key="item.value"
            class="modal-select-item"
            @click="close(item.value)"
          >
            <span class="modal-select-item-label">{{ item.label }}</span>
            <span v-if="item.description" class="modal-select-item-desc">
              {{ item.description }}
            </span>
          </button>
        </div>
        <div class="modal-actions">
          <button @click="close(null)">{{ $t('common.cancel') }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped></style>
