<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, X, TriangleAlert, ChevronDown, ArrowLeft, RefreshCcw } from 'lucide-vue-next'
import { useModal } from '../composables/useModal'
import {
  useReturnToDashboardConfirm,
  type ReturnToDashboardReason
} from '../composables/useReturnToDashboardConfirm'
import { useInstallationStore } from '../stores/installationStore'
import { emitTelemetryAction } from '../lib/telemetry'

import { useTerminalScroll } from '../composables/useTerminalScroll'
import { useProgressStore } from '../stores/progressStore'
import type { ActionResult, KillResult, ShowProgressOpts } from '../types/ipc'
import BrandTakeoverLayout from '../components/BrandTakeoverLayout.vue'
import ComfyWordmark from '../components/icons/ComfyWordmark.vue'
import BrandProgressGlyph from '../components/icons/BrandProgressGlyph.vue'
import BaseAccordion from '../components/ui/BaseAccordion.vue'
import BaseCopyButton from '../components/ui/BaseCopyButton.vue'
import BrandProgressView from '../components/BrandProgressView.vue'
import type { ProgressStepVM } from '../lib/progressViewModel'
import { TID } from '../../../shared/testIds'

interface Props {
  installationId: string | null
}

const props = defineProps<Props>()

const emit = defineEmits<{
  close: []
  'show-detail': [installationId: string]
  'show-console': [installationId: string]
  /** `successTerminal` ops resolve here instead of auto-closing; the host maps the action id to behaviour. */
  'success-choice': [actionId: string, installationId: string]
}>()

const { t } = useI18n()
const modal = useModal()
const progressStore = useProgressStore()
const installationStore = useInstallationStore()
const { confirmReturnToDashboard } = useReturnToDashboardConfirm()

const currentId = ref<string | null>(null)
const resolvingConflict = ref(false)

const currentOp = computed(() => {
  const id = currentId.value ?? props.installationId
  if (!id) return null
  return progressStore.operations.get(id) ?? null
})

const displayId = computed(() => currentId.value ?? props.installationId)

// A finished, successful INSTALL leg of a chain is NOT the end — the launch
// leg is about to take over. During this brief handoff we suppress the
// success banner and keep the in-progress bar+stepper mounted, so install →
// launch reads as one continuous stepper with no flash/remount seam.
const isChainHandoff = computed<boolean>(() => {
  const op = currentOp.value
  return !!op?.finished && !!op.result?.ok && op.chainSpan === 'install'
})

// True while a finished op has an unresolved, still-actionable port conflict (false once the user picks a fix and re-runs).
const isPortConflictOpen = computed<boolean>(() => {
  const op = currentOp.value
  if (!op?.finished) return false
  if (resolvingConflict.value) return false
  const conflict = op.result?.portConflict
  if (!conflict) return false
  if (op.result?.ok) return false
  return true
})

// Error / port-conflict detail under the finished banner. Centralised so the gate and the copy value can't drift. Null in any non-error terminal state.
const finishedErrorMessage = computed<string | null>(() => {
  const op = currentOp.value
  if (!op?.finished) return null
  if (op.cancelRequested) return null
  if (isPortConflictOpen.value) return op.result?.message ?? null
  if (op.error) return op.error
  return null
})

// Unified 0→100 progress via `progressStore.globalProgressFor` (handles flat/stepped + monotonic clamp).
const globalProgress = computed<{ percent: number; indeterminate: boolean }>(() => {
  const op = currentOp.value
  if (!op) return { percent: 0, indeterminate: true }
  return progressStore.globalProgressFor(op)
})

// Friendly label registered by main via `sendProgress('steps', { steps })` for the active phase (used by the adopt/migration flow).
const activeStepLabel = computed<string | null>(() => {
  const op = currentOp.value
  if (!op?.steps || !op.activePhase) return null
  return op.steps.find((s) => s.phase === op.activePhase)?.label?.trim() || null
})

// Live sub-status for the active phase. Main may push either a literal
// (e.g. node count "3 / 7 · Manager") or an i18n key (`launch.activity.*`,
// translated here so the tracker stays locale-agnostic). Keys that don't
// resolve fall back to null rather than leaking a dev-y slug.
const activePhaseStatus = computed<string | null>(() => {
  const op = currentOp.value
  if (!op?.steps || !op.activePhase) return null
  const raw = op.lastStatus[op.activePhase]?.trim()
  if (!raw) return null
  if (/^[a-z][\w-]*(?:\.[\w-]+)+$/i.test(raw)) {
    const translated = t(raw)
    return translated !== raw ? translated : null
  }
  return raw
})

// User-facing caption per phase. Stepped ops resolve in order: curated `progress.phaseLabel.<phase>` → registered step label → real status detail → raw phase id (last resort). Flat ops pass through `flatStatus`.
const friendlyCaption = computed<string>(() => {
  const op = currentOp.value
  if (!op) return t('progress.starting')
  if (op.steps && op.activePhase) {
    const key = `progress.phaseLabel.${op.activePhase}`
    const friendly = t(key)
    if (friendly !== key) return friendly
    if (activeStepLabel.value) return activeStepLabel.value
    const raw = activePhaseStatus.value
    if (raw && raw !== op.activePhase) return raw
    return op.activePhase
  }
  return op.flatStatus || t('progress.starting')
})

// Second-line caption: rich `lastStatus[activePhase]` (bytes/speed/ETA) when it adds info beyond the headline. Suppresses the raw phase-id fallback so dev-y slugs never leak in as a sub-label.
const subStatus = computed<string | null>(() => {
  const raw = activePhaseStatus.value
  if (!raw) return null
  const op = currentOp.value
  if (op?.activePhase && raw === op.activePhase) return null
  if (raw === activeStepLabel.value) return null
  if (raw === friendlyCaption.value) return null
  return raw
})

// Polish the rich substatus: group byte counts (lookahead scoped to a byte unit so ports/PIDs aren't mangled), drop a collapsed "· 0s remaining" tail, fix the leftover separator.
const formattedSubStatus = computed<string | null>(() => {
  const raw = subStatus.value
  if (!raw) return null
  return (
    raw
      .replace(/(\d{4,})(?=\s*(?:GB|MB|KB|B)\b)/gi, (_, n) => Number(n).toLocaleString())
      .replace(/\s*·\s*(?:0s?|—)\s*remaining/gi, '')
      .replace(/\s*·\s*·\s*/g, '  ·  ')
      .replace(/\s*·\s*$/, '')
      .trim() || null
  )
})

// The bar binds DIRECTLY to the store's real percent — no creep, no synthetic
// motion. The store already clamps monotonically (`_globalFloor`) so the value
// only ever moves forward, and only on real log milestones. During a silent
// gap (e.g. the ~110s GPU/torch init) the bar simply HOLDS; the active step's
// spinner conveys "working". Honest by construction.
const displayedPercent = computed<number>(() => globalProgress.value.percent)

// Resolve a step's display label: curated `progress.phaseLabel.<phase>` first
// (matches `friendlyCaption`), then the registered step label, never the slug.
function stepLabel(phase: string, fallback?: string): string {
  const key = `progress.phaseLabel.${phase}`
  const friendly = t(key)
  return friendly !== key ? friendly : fallback?.trim() || phase
}

// Two-level step rows for the swappable progress view, rendered as ONE
// continuous list across a chain: the completed prior leg (`priorSteps`, e.g.
// install) is prepended as done steps, then the current op's steps. So
// install → launch reads as a single stepper with no seam and the user can
// see the next step coming. Steps before the active one are `done`, the
// active one carries the live sub-activity, the rest are `pending`.
const progressSteps = computed<ProgressStepVM[]>(() => {
  const op = currentOp.value
  if (!op) return []

  const prior: ProgressStepVM[] = (op.priorSteps ?? []).map((step) => ({
    phase: step.phase,
    label: stepLabel(step.phase, step.label),
    status: 'done' as const,
    detail: null,
    subPercent: null
  }))

  // Launch leg's steps haven't arrived yet (IPC in flight) but the prior leg
  // exists — keep the merged stepper on screen with a synthetic active
  // "Starting ComfyUI…" tail so there's no flash back to the flat caption.
  if (!op.steps?.length) {
    if (!prior.length) return []
    return [
      ...prior,
      {
        phase: 'launchStart',
        label: stepLabel('launchStart'),
        status: 'active' as const,
        detail: null,
        subPercent: null
      }
    ]
  }

  const activeIdx = op.activePhase ? op.steps.findIndex((s) => s.phase === op.activePhase) : -1
  const current: ProgressStepVM[] = op.steps.map((step, i) => {
    const status: ProgressStepVM['status'] = op.finished
      ? 'done'
      : activeIdx < 0
        ? i === 0
          ? 'active'
          : 'pending'
        : i < activeIdx
          ? 'done'
          : i === activeIdx
            ? 'active'
            : 'pending'
    return {
      phase: step.phase,
      label: stepLabel(step.phase, step.label),
      status,
      detail: status === 'active' ? formattedSubStatus.value : null,
      subPercent:
        status === 'active' && !globalProgress.value.indeterminate ? op.activePercent : null
    }
  })

  return [...prior, ...current]
})

// Separate from the modal-branch `terminalExpanded` so the brand accordion's state doesn't leak into the modal reopen path.
const brandLogsExpanded = ref(false)
const brandTerminalRef = ref<HTMLDivElement | null>(null)
// Gate the getter while the accordion is closed so the two live `useTerminalScroll` instances don't both wake on every stdout chunk and scroll a null ref.
const { isAtBottom: brandIsAtBottom, handleTerminalScroll: handleBrandTerminalScroll } =
  useTerminalScroll(brandTerminalRef, () =>
    brandLogsExpanded.value ? currentOp.value?.terminalOutput : undefined
  )

function toggleBrandLogs(): void {
  brandLogsExpanded.value = !brandLogsExpanded.value
}

// Each op starts with the logs accordion closed.
watch(displayId, () => {
  brandLogsExpanded.value = false
  brandIsAtBottom.value = true
})

// Render only a trailing window; the store keeps the full buffer for telemetry. Rendering megabytes into one text node re-layouts the whole takeover.
const MAX_LOG_TAIL_CHARS = 256 * 1024
const displayedTerminalOutput = computed(() => {
  const s = currentOp.value?.terminalOutput ?? ''
  return s.length > MAX_LOG_TAIL_CHARS ? s.slice(-MAX_LOG_TAIL_CHARS) : s
})

// Copy returns the FULL buffer (not the truncated render copy); materialised at click time.
function getTerminalLogText(): string {
  return currentOp.value?.terminalOutput ?? ''
}

// Sync currentId with prop
watch(
  () => props.installationId,
  (id) => {
    if (id) {
      currentId.value = id
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
  opKind?: ShowProgressOpts['opKind']
  destroysInstance?: boolean
  /** Forwarded to the store so a host driving the modal via the exposed handle can still set up an install→launch chain. */
  chainSpan?: ShowProgressOpts['chainSpan']
  successTerminal?: ShowProgressOpts['successTerminal']
}): void {
  currentId.value = opts.installationId
  resolvingConflict.value = false
  progressStore.startOperation(opts)
}

// True when a successful op is parked on its terminal-choice screen; gates the footer swap and auto-close.
const successTerminalActive = computed<boolean>(() => {
  const op = currentOp.value
  if (!op?.finished) return false
  if (!op.result?.ok) return false
  if (op.error) return false
  if (op.cancelRequested) return false
  return !!op.successTerminal
})

function handleSuccessChoice(actionId: string): void {
  const id = displayId.value
  if (!id) return
  emit('success-choice', actionId, id)
  emit('close')
}

// Window-mode launches close instantly so the new comfy window takes focus; other op kinds auto-close via the delayed `handleDone` watcher below.
watch(
  () => {
    const id = displayId.value
    if (!id) return null
    const op = progressStore.operations.get(id)
    if (!op) return null
    return op.finished && op.result?.ok && op.result.mode === 'window' ? id : null
  },
  (autoCloseId) => {
    if (autoCloseId && displayId.value === autoCloseId && props.installationId !== null) {
      emit('close')
    }
  }
)

function handleDone(): void {
  const id = displayId.value
  if (!id) return
  const op = progressStore.operations.get(id)
  if (!op?.result) return
  // Destroy ops: detach the host before closing so it isn't left pointing at a now-removed install.
  if (op.destroysInstance) {
    void window.api.returnToDashboard()
  }
  emit('close')
  // copy / copy-update / release-update produced a new install — open it in its own window; the source host stays put.
  const newInstallationId = op.result.newInstallationId
  if (newInstallationId) {
    void window.api.openInstallWindow(newInstallationId)
    return
  }
  // Guard show-detail against a stale id (destroy ops would route to a missing detail view).
  const installStillExists = !!installationStore.getById(id)
  if (installStillExists && (op.returnTo === 'detail' || op.result.navigate === 'detail')) {
    emit('show-detail', id)
  } else if (op.result.mode === 'console') {
    emit('show-console', id)
  }
}

// Return-to-Dashboard from any op state. In-flight prompts local installs (returning stops a running ComfyUI); idle states skip it. Flips an install-backed window back to chooser mode in place.
async function returnToDashboard(reason: ReturnToDashboardReason): Promise<void> {
  const id = displayId.value
  const op = id ? progressStore.operations.get(id) : null
  const installation = id ? (installationStore.getById(id) ?? null) : null
  // No-op for the finished branches; only the in-flight footer button surfaces the prompt.
  const ok = await confirmReturnToDashboard(installation, reason)
  if (!ok) return
  if (reason === 'in_flight' && op && !op.finished && id) {
    progressStore.cancelOperation(id)
  }
  emitTelemetryAction('comfy.desktop.instance.return_to_dashboard', { from: 'progress', reason })
  emit('close')
  // No-op when the host isn't install-backed (chooser launches that errored before the swap).
  await window.api.returnToDashboard()
}

// Re-run the errored op: feed the stored `apiCall` (or a fresh `runAction('launch')`) back into `startOperation`.
function handleReboot(): void {
  const id = displayId.value
  if (!id) return
  const op = progressStore.operations.get(id)
  if (!op) return
  startOperation({
    installationId: id,
    title: op.title,
    apiCall: op.apiCall || (() => window.api.runAction(id, 'launch')),
    returnTo: op.returnTo,
    opKind: op.opKind,
    destroysInstance: op.destroysInstance
  })
}

// Cancel an in-flight destroy op, gated by the local-install confirm (a cancelled delete leaves the install partial). Host stays put rather than auto-detaching.
async function cancelDestructiveOp(): Promise<void> {
  const id = displayId.value
  if (!id) return
  const op = progressStore.operations.get(id)
  if (!op || op.finished) return
  const installation = installationStore.getById(id) ?? null
  const ok = await confirmReturnToDashboard(installation, 'in_flight')
  if (!ok) return
  emitTelemetryAction('comfy.desktop.instance.return_to_dashboard', {
    from: 'progress',
    reason: 'in_flight'
  })
  progressStore.cancelOperation(id)
  emit('close')
}

// Auto-close on success/cancel after a short delay (lets the banner register), then run `handleDone`. Errors don't auto-close.
const AUTO_CLOSE_DELAY_MS = 700
let autoCloseTimer: ReturnType<typeof setTimeout> | null = null
function clearAutoCloseTimer(): void {
  if (autoCloseTimer) {
    clearTimeout(autoCloseTimer)
    autoCloseTimer = null
  }
}
watch(
  () => {
    const op = currentOp.value
    if (!op?.finished) return null
    if (op.error) return null
    if (op.result?.portConflict) return null
    // successTerminal parks on a choice screen; auto-close would race and dismiss it before it's readable.
    if (successTerminalActive.value) return null
    return displayId.value
  },
  (id) => {
    clearAutoCloseTimer()
    if (!id) return
    autoCloseTimer = setTimeout(() => {
      autoCloseTimer = null
      if (displayId.value === id) handleDone()
    }, AUTO_CLOSE_DELAY_MS)
  }
)
onBeforeUnmount(clearAutoCloseTimer)

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

defineExpose({ startOperation, showOperation })
</script>

<template>
  <BrandTakeoverLayout v-if="installationId && currentOp">
    <div class="brand-progress">
      <BrandProgressGlyph class="brand-progress__glyph" aria-hidden="true" />
      <div class="brand-progress__stack">
        <!-- Plate wraps logo + status and carries the radial scrim that knocks
             back the yellow glyph so stepper text stays legible. -->
        <div class="brand-progress__plate">
          <div class="brand-progress__core">
            <ComfyWordmark class="brand-progress__wordmark" />

            <template v-if="!currentOp.finished || isChainHandoff">
              <div class="brand-progress__bar-wrap">
                <!-- Determinate fill bound directly to the store's real
                     percent — moves only on log milestones, holds during gaps. -->
                <div class="brand-progress__bar">
                  <div class="brand-progress__bar-fill" :style="{ width: `${displayedPercent}%` }" />
                </div>
                <div class="brand-progress__percent" aria-hidden="true">
                  {{ Math.round(displayedPercent) }}%
                </div>
              </div>
            </template>

            <Transition v-if="currentOp.finished && !isChainHandoff" name="brand-caption-fade" mode="out-in">
              <div
                v-if="isPortConflictOpen"
                key="finished-port-conflict"
                class="brand-progress__banner brand-progress__banner--error"
                :data-testid="TID.progressPortConflictBanner"
                aria-live="polite"
              >
                <X :size="20" />
                <span>{{ $t('errors.portConflictTitle') }}</span>
              </div>
              <div
                v-else
                :key="`finished-${
                  currentOp.cancelRequested ? 'cancelled' : currentOp.error ? 'error' : 'success'
                }`"
                class="brand-progress__banner"
                :class="{
                  'brand-progress__banner--success':
                    !currentOp.cancelRequested && currentOp.result?.ok,
                  'brand-progress__banner--error': !currentOp.cancelRequested && !!currentOp.error,
                  'brand-progress__banner--cancelled': currentOp.cancelRequested
                }"
                aria-live="polite"
              >
                <Check v-if="!currentOp.cancelRequested && currentOp.result?.ok" :size="20" />
                <X v-else-if="!currentOp.cancelRequested" :size="20" />
                <TriangleAlert v-else :size="20" />
                <span>
                  {{
                    currentOp.cancelRequested
                      ? $t('progress.completedCancelled')
                      : currentOp.result?.ok
                        ? (currentOp.successTerminal?.title ?? $t('progress.completedSuccess'))
                        : $t('progress.completedError')
                  }}
                </span>
              </div>
            </Transition>

            <div v-if="!currentOp.finished || isChainHandoff" class="brand-progress__status">
              <Transition name="brand-status-fade" mode="out-in">
                <BrandProgressView
                  v-if="progressSteps.length"
                  key="stepper"
                  :steps="progressSteps"
                  class="brand-progress__steps"
                />
                <div v-else key="caption" class="brand-progress__status-flat">
                  <div class="brand-progress__caption" aria-live="polite">
                    {{ friendlyCaption }}
                  </div>
                  <div
                    v-if="formattedSubStatus"
                    class="brand-progress__substatus"
                    aria-live="polite"
                  >
                    {{ formattedSubStatus }}
                  </div>
                </div>
              </Transition>
            </div>
          </div>
        </div>

        <!-- Success terminal actions, outside the caption Transition so it isn't a second child. -->
        <div
          v-if="successTerminalActive && currentOp.successTerminal"
          class="brand-progress__terminal-actions"
        >
          <button
            v-for="action in currentOp.successTerminal.actions"
            :key="action.id"
            type="button"
            :class="[
              action.variant === 'primary' ? 'brand-primary' : 'brand-ghost',
              'brand-progress__footer-btn'
            ]"
            @click="handleSuccessChoice(action.id)"
          >
            {{ action.label }}
          </button>
        </div>

        <!-- Error / port-conflict detail beneath the banner. Copy writes the same string shown. -->
        <div v-if="finishedErrorMessage" class="brand-progress__error-row">
          <div class="brand-progress__error-message" :data-testid="TID.progressErrorMessage">
            {{ finishedErrorMessage }}
          </div>
          <BaseCopyButton
            :value="finishedErrorMessage"
            :aria-label="$t('common.copy')"
            class="brand-progress__error-copy"
          />
        </div>

        <!-- Error actions in the hero stack, keeping the Reboot CTA with the failure context. -->
        <div
          v-if="
            currentOp.finished &&
            !!currentOp.error &&
            !currentOp.cancelRequested &&
            !isPortConflictOpen
          "
          class="brand-progress__error-actions"
        >
          <button
            type="button"
            :class="
              currentOp.destroysInstance
                ? 'brand-primary brand-progress__footer-btn'
                : 'brand-ghost brand-progress__footer-btn'
            "
            @click="returnToDashboard('crashed')"
          >
            <ArrowLeft :size="14" />
            {{ $t('common.back') }}
          </button>
          <button
            v-if="!currentOp.destroysInstance"
            type="button"
            class="brand-primary brand-progress__footer-btn"
            :data-testid="TID.progressReboot"
            @click="handleReboot"
          >
            <RefreshCcw :size="14" />
            {{ $t('progress.reboot') }}
          </button>
        </div>
      </div>
    </div>
    <!-- Footer band pinned to the takeover's bottom edge. In-flight → Return to Dashboard; port conflict → Use-Port / Kill-Process; error → Reboot + Return. Empty (collapsed) on success/cancel. -->
    <template #footer>
      <div v-if="currentOp" class="brand-progress__footer">
        <!-- Log panel (opens above the footer bar) -->
        <BaseAccordion
          v-if="currentOp.terminalOutput"
          :open="brandLogsExpanded"
          class="brand-progress__logs-wrap"
          :class="{ 'is-expanded': brandLogsExpanded }"
        >
          <div class="brand-progress__logs-panel-header">
            <span class="brand-progress__logs-panel-title">{{ $t('launch.viewLogs') }}</span>
            <BaseCopyButton
              :get-value="getTerminalLogText"
              :aria-label="$t('common.copy')"
              class="brand-progress__logs-copy"
            />
          </div>
          <div
            id="brand-progress-logs"
            ref="brandTerminalRef"
            class="brand-progress__logs"
            :data-testid="TID.progressLogs"
            @scroll="handleBrandTerminalScroll"
          >
            {{ displayedTerminalOutput }}
          </div>
        </BaseAccordion>
        <div
          class="brand-progress__footer-bar"
          :class="{ 'is-centered': !currentOp.terminalOutput }"
        >
          <div class="brand-progress__footer-left">
            <template v-if="!currentOp.finished">
              <button
                v-if="currentOp.destroysInstance"
                type="button"
                class="brand-ghost brand-progress__footer-btn"
                @click="cancelDestructiveOp"
              >
                <X :size="14" />
                {{ $t('common.cancel') }}
              </button>
              <button
                v-else
                type="button"
                class="brand-ghost brand-progress__footer-btn"
                @click="returnToDashboard('in_flight')"
              >
                <ArrowLeft :size="14" />
                {{ $t('progress.returnToDashboard') }}
              </button>
            </template>
            <template v-else-if="isPortConflictOpen && currentOp.result?.portConflict">
              <button
                type="button"
                class="brand-ghost brand-progress__footer-btn"
                @click="returnToDashboard('crashed')"
              >
                <ArrowLeft :size="14" />
                {{ $t('progress.returnToDashboard') }}
              </button>
              <button
                v-if="currentOp.result.portConflict.nextPort"
                type="button"
                class="brand-primary brand-progress__footer-btn"
                :data-testid="TID.progressPortConflictUsePort"
                @click="handleUseNextPort(currentOp.result.portConflict.nextPort!)"
              >
                {{ $t('errors.portConflictUsePort') }}
              </button>
              <button
                v-if="currentOp.result.portConflict.isComfy"
                type="button"
                class="brand-ghost brand-progress__footer-btn brand-progress__footer-btn--danger"
                :data-testid="TID.progressPortConflictKill"
                @click="handleKillProcess(currentOp.result.portConflict.port)"
              >
                {{ $t('errors.portConflictKill') }}
              </button>
            </template>
          </div>
          <button
            v-if="currentOp.terminalOutput"
            type="button"
            class="brand-ghost brand-progress__footer-btn brand-progress__logs-toggle"
            :aria-expanded="brandLogsExpanded"
            aria-controls="brand-progress-logs"
            @click="toggleBrandLogs"
          >
            <ChevronDown
              :size="14"
              class="brand-progress__logs-chevron"
              :class="{ 'is-open': brandLogsExpanded }"
            />
            {{ $t('launch.viewLogs') }}
          </button>
        </div>
      </div>
    </template>
  </BrandTakeoverLayout>
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
  max-width: calc(100vw - 48px);
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  overflow: visible;
}
/* Scrim plate: dark radial sits above the glyph, below text — extended
   downward during in-flight ops so the stepper stays readable. */
.brand-progress__plate {
  position: relative;
  width: 100%;
  isolation: isolate;
}
.brand-progress__plate::before {
  content: '';
  position: absolute;
  top: 46%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: min(148%, 38rem);
  height: min(340%, 34rem);
  border-radius: 50%;
  background: radial-gradient(
    ellipse at center,
    color-mix(in srgb, var(--neutral-800) 58%, transparent) 0%,
    color-mix(in srgb, var(--neutral-800) 38%, transparent) 34%,
    transparent 62%
  );
  pointer-events: none;
  z-index: -1;
}
.brand-progress__core {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: clamp(0.75rem, 1.8vh, 1.125rem);
  width: 100%;
}
.brand-progress__bar-wrap {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.brand-progress__status {
  position: absolute;
  top: calc(100% + 0.625rem);
  left: 50%;
  transform: translateX(-50%);
  width: 100%;
  z-index: 1;
}
.brand-progress__status-flat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
}
.brand-progress__steps {
  width: 100%;
}
.brand-status-fade-enter-active,
.brand-status-fade-leave-active {
  transition: opacity 180ms ease;
}
.brand-status-fade-enter-from,
.brand-status-fade-leave-to {
  opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
  .brand-status-fade-enter-active,
  .brand-status-fade-leave-active {
    transition-duration: 0ms;
  }
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
  background: var(--comfy-yellow);
  border-radius: inherit;
  /* Eases the discrete jumps between log milestones so the bar glides instead
     of snapping. */
  transition: width 420ms cubic-bezier(0.33, 0, 0.2, 1);
}
@media (prefers-reduced-motion: reduce) {
  .brand-progress__bar-fill {
    transition: none;
  }
}

.brand-progress__caption {
  font-size: var(--takeover-fs-body);
  color: var(--neutral-200);
  text-align: center;
  line-height: 1.35;
  min-height: 1.35em;
  text-shadow:
    0 1px 2px rgba(0, 0, 0, 0.65),
    0 0 20px rgba(25, 19, 29, 0.85);
  user-select: text;
  -webkit-user-select: text;
}
/* Second-line bytes/speed/ETA detail; tabular numbers keep digits from jittering as totals tick. */
.brand-progress__substatus {
  font-size: var(--takeover-fs-caption, 12px);
  color: var(--neutral-200);
  text-align: center;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.01em;
  line-height: 1.35;
  text-shadow:
    0 1px 2px rgba(0, 0, 0, 0.65),
    0 0 20px rgba(25, 19, 29, 0.85);
  user-select: text;
  -webkit-user-select: text;
}
.brand-progress__percent {
  font-size: 11px;
  color: var(--neutral-100);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
  align-self: flex-end;
  line-height: 1;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.55);
}

.brand-caption-fade-enter-active,
.brand-caption-fade-leave-active {
  transition:
    opacity 180ms ease,
    transform 180ms ease;
}
.brand-caption-fade-enter-from {
  opacity: 0;
  transform: translateY(4px);
}
.brand-caption-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
@media (prefers-reduced-motion: reduce) {
  .brand-caption-fade-enter-active,
  .brand-caption-fade-leave-active {
    transition-duration: 0ms;
  }
  .brand-caption-fade-enter-from,
  .brand-caption-fade-leave-to {
    transform: none;
  }
}

/* View Logs toggle (lives in the footer bar) */
.brand-progress__logs-toggle {
  gap: 6px;
  border-radius: 6px;
  border: 1px solid rgba(194, 191, 185, 0.09);
  background: rgba(138, 134, 136, 0.1);
  box-shadow: 0 1px 0 0 rgba(255, 255, 255, 0.1) inset;
  backdrop-filter: blur(75px);
  color: var(--text);
}
.brand-progress__logs-chevron {
  transform: rotate(180deg);
  transition: transform 200ms cubic-bezier(0.22, 1, 0.36, 1);
}
.brand-progress__logs-chevron.is-open {
  transform: rotate(0deg);
}
/* `min-height: 0` lets the accordion shrink within the footer so short windows scroll the log body instead of pushing the footer off-screen. */
.brand-progress__logs-wrap {
  border-radius: 10px;
  overflow: hidden;
  min-height: 0;
}
.brand-progress__logs-wrap.is-expanded {
  border: 1px solid var(--brand-surface-border);
  background: var(--brand-surface-bg);
  backdrop-filter: blur(8px);
}
.brand-progress__logs-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--brand-surface-border);
}
.brand-progress__logs-panel-title {
  font-size: var(--takeover-fs-caption, 12px);
  color: var(--neutral-200);
  font-weight: 500;
}
.brand-progress__logs-copy {
  flex: none;
}
.brand-progress__logs {
  width: 100%;
  /* `max-height` (not fixed) so the panel shrinks on short windows instead of forcing the footer past the viewport. */
  max-height: clamp(88px, 25vh, 260px);
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 12px 14px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.55;
  color: var(--neutral-300);
  text-align: left;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
  -webkit-user-select: text;
}

/* Row hosting the error / port-conflict detail line + its inline
   Copy button. Flex with the copy button hugging the right edge so
   the message text reads naturally on the left. */
.brand-progress__error-row {
  width: 100%;
  max-width: 640px;
  margin-top: -4px;
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.brand-progress__error-row .brand-progress__error-message {
  margin-top: 0;
  flex: 1 1 auto;
}
.brand-progress__error-copy {
  flex: none;
  margin-top: 4px;
}

/* Finished-state banner; crossfades in via the wrapping brand-caption-fade transition. */
.brand-progress__banner {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-size: var(--takeover-fs-body);
  letter-spacing: 0.01em;
  min-height: 1.5em;
  color: var(--neutral-200);
}
.brand-progress__banner :deep(svg) {
  flex: none;
}
.brand-progress__banner--success {
  color: var(--semantic-success, var(--neutral-50));
}
.brand-progress__banner--error {
  color: var(--semantic-danger, #ff7a7a);
}
.brand-progress__banner--cancelled {
  color: var(--neutral-300);
}

.brand-progress__terminal-actions {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 12px;
  flex-wrap: wrap;
}

/* Error CTAs: Back (ghost) + Reboot (primary), flexed to equal width so the pair reads as a balanced unit. */
.brand-progress__error-actions {
  display: flex;
  flex-direction: row;
  align-items: stretch;
  gap: 12px;
  width: 100%;
  max-width: 420px;
}
.brand-progress__error-actions > .brand-progress__footer-btn {
  flex: 1 1 0;
  justify-content: center;
}

/* Error detail beneath the banner. Bounded so a long traceback doesn't stretch the takeover; shorter than the logs panel so it reads as subordinate. */
.brand-progress__error-message {
  width: 100%;
  max-width: 640px;
  max-height: clamp(120px, 22vh, 240px);
  overflow-y: auto;
  overscroll-behavior: contain;
  margin-top: -4px;
  padding: 12px 14px;
  border-radius: 8px;
  border: 1px solid var(--brand-surface-border);
  background: var(--brand-surface-bg);
  color: var(--neutral-200);
  font-size: 13px;
  line-height: 1.55;
  text-align: left;
  user-select: text;
  -webkit-user-select: text;
  word-break: break-word;
  white-space: pre-wrap;
}

/* Footer container, anchored top + bottom so the logs panel shrinks on short windows instead of overflowing the top edge. */
.brand-progress__footer {
  position: absolute;
  top: clamp(72px, 14vh, 160px);
  bottom: clamp(16px, 2.5vh, 32px);
  left: clamp(16px, 2.5vw, 32px);
  right: clamp(16px, 2.5vw, 32px);
  z-index: 3;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 8px;
  min-height: 0;
  pointer-events: none;
}
/* Re-enable interaction on the content; the container is only a geometric bound and stays click-through where empty. */
.brand-progress__footer > * {
  pointer-events: auto;
}
.brand-progress__footer-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.brand-progress__footer-bar.is-centered {
  justify-content: center;
}
.brand-progress__footer-left {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}
.brand-progress__footer-btn {
  min-width: auto;
  padding: 7px 14px;
  font-size: 13px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.brand-progress__footer-btn.brand-ghost {
  border-color: var(--neutral-500);
  color: var(--neutral-100);
}
@media (max-width: 720px) {
  .brand-progress__footer-btn {
    padding: 6px 10px;
    font-size: 12px;
  }
}
/* Danger tint for the Kill Process button; pairs with `.brand-ghost` for consistent chrome. */
.brand-progress__footer-btn--danger {
  color: var(--semantic-danger, #ff7a7a);
  border-color: color-mix(in srgb, var(--semantic-danger, #ff7a7a) 40%, transparent);
}
.brand-progress__footer-btn--danger:hover,
.brand-progress__footer-btn--danger:focus-visible {
  background: color-mix(in srgb, var(--semantic-danger, #ff7a7a) 14%, transparent);
  border-color: var(--semantic-danger, #ff7a7a);
}
</style>
