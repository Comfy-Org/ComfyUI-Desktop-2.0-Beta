<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { CheckCircle, XCircle, Ban } from 'lucide-vue-next'
import { operationInflightLabel, operationSuccessLabel } from '../lib/progressStatusLabel'
import { MSG_CANCELLED } from '../../../shared/operationStatus'
import type { PopupInstancePickerSnapshot } from '../../../preload/comfyTitlePopupPreload'

type OperationStatus = PopupInstancePickerSnapshot['installOperationStatus'][string]

interface Props {
  operation: OperationStatus
  installationName: string
}

const props = defineProps<Props>()

const emit = defineEmits<{
  open: []
  cancel: []
  retry: []
  dismiss: []
}>()

const { t } = useI18n()

const isInflight  = computed(() => !props.operation.done)
const isSuccess   = computed(() => props.operation.done && props.operation.ok === true)
const isError     = computed(() => props.operation.done && props.operation.ok === false && props.operation.error !== MSG_CANCELLED)
const isCancelled = computed(() => props.operation.done && props.operation.error === MSG_CANCELLED)

const progressPercent   = computed(() => Math.min(100, Math.max(0, props.operation.percent)))
const isIndeterminate   = computed(() => props.operation.percent < 0 && !props.operation.done)

const statusLabel = computed(() => {
  if (isCancelled.value) return t('instancePicker.progressCancelled')
  if (isError.value)     return props.operation.error ?? t('instancePicker.progressError')
  if (isSuccess.value)   return operationSuccessLabel(props.operation, t)
  return props.operation.status || operationInflightLabel(props.operation, t)
})
</script>

<template>
  <div class="pip">
    <!-- In-flight -->
    <Transition name="pip-fade" mode="out-in">
      <div v-if="isInflight" key="inflight" class="pip__body">
        <div class="pip__spinner" aria-hidden="true">
          <svg viewBox="0 0 36 36" class="pip__ring">
            <circle class="pip__ring-track" cx="18" cy="18" r="15" />
            <circle
              class="pip__ring-fill"
              cx="18" cy="18" r="15"
              :class="{ 'is-indeterminate': isIndeterminate }"
              :style="isIndeterminate ? {} : { strokeDashoffset: 94.25 - (94.25 * progressPercent) / 100 }"
            />
          </svg>
          <span v-if="!isIndeterminate" class="pip__pct">{{ progressPercent }}%</span>
        </div>

        <p class="pip__label">{{ statusLabel }}</p>

        <button
          v-if="operation.cancellable"
          type="button"
          class="pip__ghost-btn"
          @click="emit('cancel')"
        >
          {{ t('instancePicker.progressCancel') }}
        </button>
      </div>

      <!-- Success -->
      <div v-else-if="isSuccess" key="success" class="pip__body">
        <div class="pip__icon pip__icon--success">
          <CheckCircle :size="40" />
        </div>
        <p class="pip__heading">{{ operationSuccessLabel(operation, t) }}</p>
        <p class="pip__subtext">{{ installationName }} {{ t('instancePicker.progressSuccessSubtext') }}</p>
        <button
          type="button"
          class="pip__primary-btn"
          @click="emit('open')"
        >
          {{ t('instancePicker.progressOpenInstance') }}
        </button>
      </div>

      <!-- Error -->
      <div v-else-if="isError" key="error" class="pip__body">
        <div class="pip__icon pip__icon--error">
          <XCircle :size="40" />
        </div>
        <p class="pip__heading pip__heading--error">{{ t('instancePicker.progressError') }}</p>
        <p class="pip__subtext pip__subtext--error">{{ operation.error }}</p>
        <div class="pip__actions">
          <button
            type="button"
            class="pip__primary-btn"
            @click="emit('retry')"
          >
            {{ t('instancePicker.progressRetry') }}
          </button>
          <button
            type="button"
            class="pip__ghost-btn"
            @click="emit('dismiss')"
          >
            {{ t('instancePicker.progressDismiss') }}
          </button>
        </div>
      </div>

      <!-- Cancelled -->
      <div v-else-if="isCancelled" key="cancelled" class="pip__body">
        <div class="pip__icon pip__icon--cancelled">
          <Ban :size="36" />
        </div>
        <p class="pip__heading">{{ t('instancePicker.progressCancelled') }}</p>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.pip {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  width: 100%;
  box-sizing: border-box;
  padding: 32px 24px;
}

/* ── State body ─────────────────────────────────────────────────── */
.pip__body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  max-width: 260px;
  width: 100%;
  text-align: center;
}

/* ── SVG ring spinner ───────────────────────────────────────────── */
.pip__spinner {
  position: relative;
  width: 64px;
  height: 64px;
  flex-shrink: 0;
}
.pip__ring {
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}
.pip__ring-track {
  fill: none;
  stroke: var(--chooser-surface-border);
  stroke-width: 3;
}
.pip__ring-fill {
  fill: none;
  stroke: var(--brand-accent, #f5c518);
  stroke-width: 3;
  stroke-linecap: round;
  stroke-dasharray: 94.25;
  stroke-dashoffset: 94.25;
  transition: stroke-dashoffset 300ms ease;
}
.pip__ring-fill.is-indeterminate {
  stroke-dashoffset: 56;
  animation: pip-ring-spin 1.2s linear infinite;
  transform-origin: center;
  transform-box: fill-box;
}
@keyframes pip-ring-spin {
  to { transform: rotate(360deg); }
}

.pip__pct {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: -0.3px;
}

/* ── Status icon (success / error / cancelled) ──────────────────── */
.pip__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 4px;
}
.pip__icon--success { color: var(--brand-success, #27ae60); }
.pip__icon--error   { color: var(--brand-error,   #e74c3c); }
.pip__icon--cancelled {
  color: var(--text-muted, var(--neutral-100));
  opacity: 0.45;
}

/* ── Text ───────────────────────────────────────────────────────── */
.pip__label {
  font-size: 12px;
  color: var(--text-muted, var(--neutral-100));
  margin: 0;
  line-height: 1.4;
  word-break: break-word;
}
.pip__heading {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  margin: 0;
  line-height: 1.3;
}
.pip__heading--error { color: var(--brand-error, #e74c3c); }
.pip__subtext {
  font-size: 12px;
  color: var(--text-muted, var(--neutral-100));
  margin: 0;
  line-height: 1.5;
  word-break: break-word;
}
.pip__subtext--error {
  color: var(--brand-error, #e74c3c);
  opacity: 0.8;
}

/* ── Buttons ────────────────────────────────────────────────────── */
.pip__primary-btn {
  margin-top: 4px;
  height: 34px;
  padding: 0 20px;
  border-radius: 8px;
  border: none;
  background: var(--brand-accent, #f5c518);
  color: #000;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 120ms ease;
}
.pip__primary-btn:hover  { opacity: 0.85; }
.pip__primary-btn:active { opacity: 0.7; }

.pip__ghost-btn {
  height: 30px;
  padding: 0 16px;
  border-radius: 8px;
  border: 1px solid var(--chooser-surface-border);
  background: transparent;
  color: var(--text-muted, var(--neutral-100));
  font-size: 12px;
  cursor: pointer;
  transition: color 120ms ease, border-color 120ms ease;
}
.pip__ghost-btn:hover { color: var(--text); border-color: var(--text-muted, var(--neutral-100)); }

.pip__actions {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: 100%;
  margin-top: 4px;
}

/* ── Fade transition between states ────────────────────────────── */
.pip-fade-enter-active,
.pip-fade-leave-active {
  transition: opacity 200ms ease, transform 200ms ease;
}
.pip-fade-enter-from,
.pip-fade-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
</style>
