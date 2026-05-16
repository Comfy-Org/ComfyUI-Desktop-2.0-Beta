<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, X, TriangleAlert } from 'lucide-vue-next'
import { useModal } from '../composables/useModal'

import { useTerminalScroll } from '../composables/useTerminalScroll'
import { useProgressStore } from '../stores/progressStore'
import type { Operation } from '../stores/progressStore'
import type { ActionResult, ProgressStep, KillResult } from '../types/ipc'
import ModalShell from '../components/ModalShell.vue'
import BrandTakeoverLayout from '../components/BrandTakeoverLayout.vue'
import ComfyWordmark from '../components/icons/ComfyWordmark.vue'
import BrandProgressGlyph from '../components/icons/BrandProgressGlyph.vue'

interface Props {
  installationId: string | null
  /** Tier 3 update-while-running mounts pass `binding`; Tier 2 doesn't. */
  binding?: boolean
  /** Render minimal brand chrome (BrandTakeoverLayout) instead of
   *  ModalShell. Set by the host only on the first-use install chain. */
  brandChrome?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  binding: false,
  brandChrome: false
})

const emit = defineEmits<{
  close: []
  'show-detail': [installationId: string]
  'show-console': [installationId: string]
}>()

const { t } = useI18n()
const modal = useModal()
const progressStore = useProgressStore()

const currentId = ref<string | null>(null)
const resolvingConflict = ref(false)

const currentOp = computed(() => {
  const id = currentId.value ?? props.installationId
  if (!id) return null
  return progressStore.operations.get(id) ?? null
})

const displayId = computed(() => currentId.value ?? props.installationId)

/**
 * Caption text for the brand progress screen. Stepped installs (the
 * new-install flow) write live status into `lastStatus[activePhase]`
 * and leave `flatStatus` frozen at "Starting…"; flat installs write
 * straight to `flatStatus`. Read the active-phase status first so the
 * caption reflects the in-flight phase (e.g. "Downloading… X / Y MB"),
 * with `flatStatus` and the i18n fallback below it.
 */
const brandCaption = computed(() => {
  const op = currentOp.value
  if (!op) return t('progress.starting')
  if (op.activePhase) {
    const phaseStatus = op.lastStatus[op.activePhase]
    if (phaseStatus) return phaseStatus
  }
  return op.flatStatus || t('progress.starting')
})

const terminalRef = ref<HTMLDivElement | null>(null)
const { isAtBottom, terminalExpanded, handleTerminalScroll } = useTerminalScroll(
  terminalRef,
  () => currentOp.value?.terminalOutput
)

// Sync currentId with prop
watch(
  () => props.installationId,
  (id) => {
    if (id) {
      currentId.value = id
      isAtBottom.value = true
      terminalExpanded.value = true
    }
  },
  { immediate: true }
)

function showOperation(installationId: string): void {
  const op = progressStore.operations.get(installationId)
  if (!op) return
  currentId.value = installationId
}

function startOperation(opts: {
  installationId: string
  title: string
  apiCall: () => Promise<ActionResult>
  cancellable?: boolean
  returnTo?: string
}): void {
  currentId.value = opts.installationId
  resolvingConflict.value = false
  progressStore.startOperation(opts)
}

// Auto-close modal on window-mode launch success
watch(
  () => {
    const id = displayId.value
    if (!id) return null
    const op = progressStore.operations.get(id)
    if (!op) return null
    return op.finished && (op.result?.cancelled || (op.result?.ok && op.result.mode === 'window'))
      ? id
      : null
  },
  (autoCloseId) => {
    if (autoCloseId && displayId.value === autoCloseId && props.installationId !== null) {
      emit('close')
    }
  }
)

function handleCancel(): void {
  const id = displayId.value
  if (!id) return
  progressStore.cancelOperation(id)
}

function handleDone(): void {
  const id = displayId.value
  if (!id) return
  const op = progressStore.operations.get(id)
  if (!op?.result) return
  emit('close')
  if (op.returnTo === 'detail' || op.result.navigate === 'detail') {
    emit('show-detail', id)
  } else if (op.result.mode === 'console') {
    emit('show-console', id)
  }
}

function handleUseNextPort(nextPort: number): void {
  if (resolvingConflict.value) return
  const id = displayId.value
  if (!id) return
  const op = progressStore.operations.get(id)
  if (!op) return
  resolvingConflict.value = true
  startOperation({
    installationId: id,
    title: op.title,
    apiCall: () => window.api.runAction(id, 'launch', { portOverride: nextPort }),
    returnTo: op.returnTo
  })
}

async function handleKillProcess(port: number): Promise<void> {
  if (resolvingConflict.value) return
  const id = displayId.value
  if (!id) return
  const op = progressStore.operations.get(id)
  if (!op) return
  const confirmed = await modal.confirm({
    title: t('errors.portConflictKillConfirmTitle'),
    message: t('errors.portConflictKillConfirmMessage'),
    confirmLabel: t('errors.portConflictKill'),
    confirmStyle: 'danger'
  })
  if (!confirmed) return
  resolvingConflict.value = true

  const killResult: KillResult = await window.api.killPortProcess(port)
  if (killResult.ok) {
    startOperation({
      installationId: id,
      title: op.title,
      apiCall: op.apiCall || (() => window.api.runAction(id, 'launch')),
      returnTo: op.returnTo
    })
  } else {
    resolvingConflict.value = false
  }
}

function getStepClass(op: Operation, stepIndex: number): string {
  if (!op.steps) return 'progress-step'
  const activeIndex = op.activePhase ? op.steps.findIndex((s) => s.phase === op.activePhase) : -1

  if (stepIndex < activeIndex) return 'progress-step done'
  if (stepIndex === activeIndex) {
    if (op.finished && op.cancelRequested) return 'progress-step cancelled'
    if (op.finished && op.error) return 'progress-step error'
    if (op.done) return 'progress-step done'
    return 'progress-step active'
  }
  if (op.done && !op.cancelRequested && !op.error) return 'progress-step done'
  return 'progress-step'
}

function getStepIndicator(
  op: Operation,
  stepIndex: number
): 'check' | 'error' | 'cancelled' | 'number' {
  if (!op.steps) return 'number'
  const activeIndex = op.activePhase ? op.steps.findIndex((s) => s.phase === op.activePhase) : -1

  if (stepIndex < activeIndex) return 'check'
  if (stepIndex === activeIndex) {
    if (op.finished && op.cancelRequested) return 'cancelled'
    if (op.finished && op.error) return 'error'
    if (op.done) return 'check'
  }
  return 'number'
}

function isStepDetailVisible(op: Operation, stepIndex: number): boolean {
  if (!op.steps) return false
  const activeIndex = op.activePhase ? op.steps.findIndex((s) => s.phase === op.activePhase) : -1
  if (stepIndex !== activeIndex) return false
  if (op.done) return false
  return true
}

function getStepStatus(op: Operation, step: ProgressStep): string {
  if (op.error && op.activePhase === step.phase) {
    return t('progress.error', { message: op.error })
  }
  if (op.cancelRequested) return t('progress.cancelling')
  return op.lastStatus[step.phase] || step.phase
}

function getStepSummary(op: Operation, step: ProgressStep, stepIndex: number): string | null {
  if (!op.steps) return null
  const activeIndex = op.activePhase ? op.steps.findIndex((s) => s.phase === op.activePhase) : -1
  if ((op.done || stepIndex < activeIndex) && op.lastStatus[step.phase]) {
    return op.lastStatus[step.phase] ?? null
  }
  return null
}

defineExpose({ startOperation, showOperation })
</script>

<template>
  <BrandTakeoverLayout v-if="brandChrome && installationId && currentOp">
    <div class="brand-progress">
      <BrandProgressGlyph class="brand-progress__glyph" aria-hidden="true" />
      <div class="brand-progress__stack">
        <ComfyWordmark class="brand-progress__wordmark" />
        <div
          class="brand-progress__bar"
          :class="{ 'is-indeterminate': currentOp.activePercent < 0 }"
        >
          <div
            class="brand-progress__bar-fill"
            :style="{
              width: currentOp.activePercent >= 0 ? `${currentOp.activePercent}%` : '0%'
            }"
          />
        </div>
        <div class="brand-progress__caption">
          {{ brandCaption }}
        </div>
      </div>
    </div>
  </BrandTakeoverLayout>

  <ModalShell
    v-else-if="installationId && currentOp"
    :binding="binding"
    :title="currentOp.title"
    :close-glyph="currentOp.finished ? '✕' : '−'"
    @close="emit('close')"
  >
    <!-- body -->
    <!-- Status banner -->
    <div
      v-if="currentOp.finished && !currentOp.result?.portConflict"
      class="progress-banner"
      :class="{
        'progress-banner-cancelled': currentOp.cancelRequested,
        'progress-banner-success': !currentOp.cancelRequested && currentOp.result?.ok,
        'progress-banner-error': !currentOp.cancelRequested && currentOp.error
      }"
    >
      <TriangleAlert v-if="currentOp.cancelRequested" :size="16" />
      <Check v-else-if="currentOp.result?.ok" :size="16" />
      <X v-else :size="16" />
      <span>
        {{
          currentOp.cancelRequested
            ? $t('progress.completedCancelled')
            : currentOp.result?.ok
              ? $t('progress.completedSuccess')
              : $t('progress.completedError')
        }}
      </span>
    </div>

    <!-- Stepped progress -->
    <template v-if="currentOp.steps">
      <div class="progress-steps">
        <div
          v-for="(step, i) in currentOp.steps"
          :key="step.phase"
          :class="getStepClass(currentOp, i)"
          :data-phase="step.phase"
        >
          <div class="progress-step-header">
            <span class="progress-step-indicator">
              <Check v-if="getStepIndicator(currentOp, i) === 'check'" :size="14" />
              <X v-else-if="getStepIndicator(currentOp, i) === 'error'" :size="14" />
              <TriangleAlert
                v-else-if="getStepIndicator(currentOp, i) === 'cancelled'"
                :size="14"
              />
              <template v-else>{{ i + 1 }}</template>
            </span>
            <span class="progress-step-label">{{ step.label }}</span>
          </div>
          <div v-if="isStepDetailVisible(currentOp, i)" class="progress-step-detail">
            <div class="progress-step-status">
              {{ getStepStatus(currentOp, step) }}
            </div>
            <div
              v-if="!(currentOp.error && currentOp.activePhase === step.phase)"
              class="progress-bar-track"
              :class="{ indeterminate: currentOp.activePercent < 0 }"
            >
              <div
                class="progress-bar-fill"
                :style="{
                  width: currentOp.activePercent >= 0 ? `${currentOp.activePercent}%` : '0%'
                }"
              ></div>
            </div>
          </div>
          <div v-if="getStepSummary(currentOp, step, i)" class="progress-step-summary">
            {{ getStepSummary(currentOp, step, i) }}
          </div>
        </div>
      </div>
    </template>

    <!-- Flat progress -->
    <template v-else>
      <div
        v-if="currentOp.finished && currentOp.error"
        class="progress-status progress-error-message"
      >
        {{ currentOp.error }}
      </div>
      <div
        v-else-if="currentOp.finished && currentOp.result?.portConflict && !resolvingConflict"
        class="progress-status progress-error-message"
      >
        {{ currentOp.result.message }}
      </div>
      <div v-else class="progress-status">{{ currentOp.flatStatus }}</div>
      <div
        v-if="!currentOp.finished"
        class="progress-bar-track"
        :class="{ indeterminate: currentOp.flatPercent < 0 }"
      >
        <div
          class="progress-bar-fill"
          :style="{
            width: currentOp.flatPercent >= 0 ? `${currentOp.flatPercent}%` : '0%'
          }"
        ></div>
      </div>
    </template>

    <!-- Terminal output -->
    <template v-if="currentOp.terminalOutput">
      <button
        type="button"
        class="terminal-toggle"
        :aria-expanded="terminalExpanded"
        @click="terminalExpanded = !terminalExpanded"
      >
        <span class="terminal-toggle-icon">{{ terminalExpanded ? '▾' : '▸' }}</span>
        <span>{{ $t('list.console') }}</span>
      </button>
      <div
        v-show="terminalExpanded"
        id="progress-terminal"
        ref="terminalRef"
        class="terminal-output"
        @scroll="handleTerminalScroll"
      >
        {{ currentOp.terminalOutput }}
      </div>
    </template>

    <!-- Bottom bar (pinned outside scrollable body) -->
    <template #footer>
      <!-- Port conflict actions -->
      <div
        v-if="
          currentOp.finished &&
          currentOp.result?.portConflict &&
          !currentOp.result.ok &&
          !resolvingConflict
        "
        class="progress-conflict-actions"
      >
        <button
          v-if="currentOp.result.portConflict.nextPort"
          class="primary"
          @click="handleUseNextPort(currentOp.result.portConflict.nextPort!)"
        >
          {{
            $t('errors.portConflictUsePort', {
              port: currentOp.result.portConflict.nextPort
            })
          }}
        </button>
        <button
          v-if="currentOp.result.portConflict.isComfy"
          class="danger"
          @click="handleKillProcess(currentOp.result.portConflict.port)"
        >
          {{ $t('errors.portConflictKill') }}
        </button>
      </div>

      <div class="view-bottom">
        <button
          v-if="currentOp.finished && currentOp.result?.ok"
          class="primary"
          @click="handleDone"
        >
          {{ $t('common.done') }}
        </button>
        <button
          v-else-if="!currentOp.finished"
          class="danger-solid"
          :disabled="currentOp.cancelRequested"
          @click="handleCancel"
        >
          {{ currentOp.cancelRequested ? $t('progress.cancelling') : $t('common.cancel') }}
        </button>
      </div>
    </template>
  </ModalShell>
</template>

<style scoped>
.brand-progress {
  position: relative;
  align-self: stretch;
  flex: 1 1 auto;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.brand-progress__glyph {
  position: absolute;
  top: 50%;
  left: 60%;
  transform: translate(-50%, -50%);
  height: 100vh;
  width: auto;
  pointer-events: none;
  z-index: 0;
  opacity: 0.9;
}

.brand-progress__stack {
  position: relative;
  z-index: 2;
  width: min(85%, 880px);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: clamp(1rem, 3vh, 2rem);
  text-align: center;
}
.brand-progress__wordmark {
  width: clamp(140px, 9.7vw, 240px);
  height: auto;
  color: var(--comfy-yellow);
  anchor-name: --brand-beam-target;
}
.brand-progress__bar {
  width: 100%;
  height: 5.079px;
  border-radius: 16px;
  background: var(--brand-surface-bg);
  border: 1px solid var(--brand-surface-border);
  overflow: hidden;
}
.brand-progress__bar-fill {
  height: 100%;
  background: var(--neutral-50);
  border-radius: inherit;
  transition: width 200ms cubic-bezier(0.22, 1, 0.36, 1);
}
.brand-progress__bar.is-indeterminate .brand-progress__bar-fill {
  width: 35% !important;
  animation: brand-progress-slide 1.4s ease-in-out infinite;
}
@keyframes brand-progress-slide {
  0% {
    transform: translateX(-110%);
  }
  100% {
    transform: translateX(330%);
  }
}
.brand-progress__caption {
  font-size: var(--takeover-fs-body);
  color: var(--neutral-300);
}
</style>
