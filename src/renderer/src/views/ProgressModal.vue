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

// End-of-slot percents for the launch bar (indexed by LAUNCH_STEP_ORDER); the active step interpolates within its slot.
const LAUNCH_SLOT_ENDS = [10, 25, 45, 70, 95] as const
const LAUNCH_SLOT_STARTS = [0, 10, 25, 45, 70] as const
/** Soft per-step duration estimate for interpolating the bar fill when no stdout signal arrives. Steps still advance on the timer + stdout regexes. */
const LAUNCH_STEP_BUDGET_MS = 4_000

// Friendly label registered by main via `sendProgress('steps', { steps })` for the active phase (used by the adopt/migration flow).
const activeStepLabel = computed<string | null>(() => {
  const op = currentOp.value
  if (!op?.steps || !op.activePhase) return null
  return op.steps.find((s) => s.phase === op.activePhase)?.label?.trim() || null
})

// Trimmed raw status string main pushed for the active phase.
const activePhaseStatus = computed<string | null>(() => {
  const op = currentOp.value
  if (!op?.steps || !op.activePhase) return null
  return op.lastStatus[op.activePhase]?.trim() || null
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

// Launch-caption step list for the flat chooser-tile launch path (steps 1-2 narrative/timer-driven, 3-4 from stdout, 5 until op finishes). Dormant for stepped ops, which fall through to `friendlyCaption`.
type LaunchStepKey = 'securityScan' | 'mountLibraries' | 'gpu' | 'customNodes' | 'startingServer'

const LAUNCH_STEP_ORDER: readonly LaunchStepKey[] = [
  'securityScan',
  'mountLibraries',
  'gpu',
  'customNodes',
  'startingServer'
]

// True only for flat launch-class ops; drives the rolling launchCaption pipeline, GPU stdout scanner, and `launchPercent` interpolation. Other op kinds use `friendlyCaption`.
const isBrandLaunch = computed(
  () => !!currentOp.value && currentOp.value.opKind === 'launch' && currentOp.value.steps === null
)

// Monotonic caption index ticked every 900ms; the active caption is `max(floor, stdoutStep)` clamped to floor+1 so the first narrative captions each get airtime even when stdout races ahead.
const captionFloor = ref(0)
let captionTimer: ReturnType<typeof setInterval> | null = null
const CAPTION_TICK_MS = 900

/**
 * Latched VRAM and furthest stdout step, maintained by the tail-walking watcher below.
 * A `computed(() => out.match(…))` would re-scan the whole growing buffer per chunk (O(N²) across a launch), so we scan only the new tail with a small overlap and short-circuit once every regex has hit.
 */
const vramGb = ref<number | null>(null)
const stdoutStep = ref(-1)
let lastScanLen = 0
const SCAN_OVERLAP_CHARS = 64

function clearCaptionTimer(): void {
  if (captionTimer) {
    clearInterval(captionTimer)
    captionTimer = null
  }
}

function startCaptionTimer(): void {
  clearCaptionTimer()
  captionTimer = setInterval(() => {
    // Stop ticking once stdout / completion has reached the last step.
    if (
      currentOp.value?.finished ||
      stdoutStep.value >= LAUNCH_STEP_ORDER.length - 1 ||
      captionFloor.value >= LAUNCH_STEP_ORDER.length - 1
    ) {
      clearCaptionTimer()
      return
    }
    captionFloor.value += 1
  }, CAPTION_TICK_MS)
}

// Reset + re-arm the caption timer on each new launch op (keyed on `displayId`).
watch(
  () => (isBrandLaunch.value ? displayId.value : null),
  (id) => {
    captionFloor.value = 0
    vramGb.value = null
    stdoutStep.value = -1
    lastScanLen = 0
    clearCaptionTimer()
    if (id && !currentOp.value?.finished) {
      startCaptionTimer()
    }
  },
  { immediate: true }
)

// Snap to the terminal caption on finish so a mid-pipeline caption doesn't hang after the server is up.
watch(
  () => currentOp.value?.finished ?? false,
  (finished) => {
    if (finished) {
      clearCaptionTimer()
      captionFloor.value = LAUNCH_STEP_ORDER.length - 1
    }
  }
)

onBeforeUnmount(clearCaptionTimer)

// Tail-only stdout scanner (see `vramGb` above for why not a computed).
watch(
  () => (isBrandLaunch.value ? (currentOp.value?.terminalOutput ?? '') : ''),
  (out) => {
    if (!out) {
      lastScanLen = 0
      return
    }
    // Already at the terminal step.
    if (stdoutStep.value >= LAUNCH_STEP_ORDER.length - 1 && vramGb.value !== null) {
      lastScanLen = out.length
      return
    }
    const tail = out.slice(Math.max(0, lastScanLen - SCAN_OVERLAP_CHARS))
    lastScanLen = out.length

    if (vramGb.value === null) {
      const m = tail.match(/Total VRAM\s+(\d+)\s*MB/i)
      if (m) {
        const mb = Number(m[1])
        if (Number.isFinite(mb) && mb > 0) vramGb.value = Math.round(mb / 1024)
        if (stdoutStep.value < 2) stdoutStep.value = 2
      }
    }
    if (stdoutStep.value < 3 && /custom[\s_-]*node|ComfyUI-Manager/i.test(tail)) {
      stdoutStep.value = 3
    }
    if (
      stdoutStep.value < 4 &&
      /To see the GUI|Starting server|server started|Uvicorn running on/i.test(tail)
    ) {
      stdoutStep.value = 4
    }
  }
)

const launchActiveIndex = computed(() => {
  if (!isBrandLaunch.value) return 0
  const op = currentOp.value
  if (!op) return 0
  if (op.finished) return LAUNCH_STEP_ORDER.length - 1
  // Cap stdout at floor+1 so every caption gets its ~900ms of airtime.
  const stdoutClamped = Math.min(stdoutStep.value, captionFloor.value + 1)
  return Math.max(captionFloor.value, stdoutClamped)
})

// Rolling caption for the active launch step. The template picks this or `friendlyCaption` via `isBrandLaunch`.
const launchCaption = computed<string>(() => {
  if (!isBrandLaunch.value) return ''
  const idx = Math.min(launchActiveIndex.value, LAUNCH_STEP_ORDER.length - 1)
  const key = LAUNCH_STEP_ORDER[idx]
  if (key === 'gpu') {
    return vramGb.value !== null
      ? t('launch.steps.gpu', { vram: vramGb.value })
      : t('launch.steps.gpuFallback')
  }
  return t(`launch.steps.${key}`)
})

// Timestamp the active launch step became active; `launchStepNow` is a ~250ms clock that drives `launchPercent`'s within-slot interpolation. Ticks only during an in-flight launch.
const launchStepStartMs = ref(0)
const launchStepNow = ref(0)
let launchTickTimer: ReturnType<typeof setInterval> | null = null
const LAUNCH_TICK_MS = 250

function clearLaunchTick(): void {
  if (launchTickTimer) {
    clearInterval(launchTickTimer)
    launchTickTimer = null
  }
}

function startLaunchTick(): void {
  clearLaunchTick()
  launchStepNow.value = Date.now()
  launchTickTimer = setInterval(() => {
    if (currentOp.value?.finished || !isBrandLaunch.value) {
      clearLaunchTick()
      return
    }
    launchStepNow.value = Date.now()
  }, LAUNCH_TICK_MS)
}

// Reset the step-elapsed clock when the launch op changes or the active step advances, so interpolation snaps forward at each transition.
watch(
  () => (isBrandLaunch.value ? `${displayId.value}:${launchActiveIndex.value}` : null),
  (key) => {
    if (!key) {
      clearLaunchTick()
      return
    }
    launchStepStartMs.value = Date.now()
    launchStepNow.value = launchStepStartMs.value
    if (!currentOp.value?.finished) startLaunchTick()
  },
  { immediate: true }
)

onBeforeUnmount(clearLaunchTick)

// Launch progress as 0→100 for the bar: completed steps own their slot, the active step interpolates within its slot, and the final step + server-ready regex snaps to 100. Chained launches remap this to 70→100 downstream.
const launchPercent = computed<number>(() => {
  if (!isBrandLaunch.value) return 0
  const op = currentOp.value
  if (!op) return 0
  if (op.finished && op.result?.ok) return 100
  const idx = launchActiveIndex.value
  // Snap to 100 once the final step + server-ready regex fired, so the bar doesn't sit at 95% waiting for the window.
  if (idx >= LAUNCH_STEP_ORDER.length - 1 && stdoutStep.value >= LAUNCH_STEP_ORDER.length - 1) {
    return 100
  }
  const slotStart = LAUNCH_SLOT_STARTS[idx] ?? 0
  const slotEnd = LAUNCH_SLOT_ENDS[idx] ?? 100
  const elapsed = Math.max(0, launchStepNow.value - launchStepStartMs.value)
  const ratio = Math.min(1, elapsed / LAUNCH_STEP_BUDGET_MS)
  return slotStart + (slotEnd - slotStart) * ratio
})

// Bar percent across an install→launch chain: `install` maps to 0–70%, `launch` to 70–100%, standalone launch to 0–100%, else pass-through. Install caps at 70 and launch starts at 70, so the seam is invisible.
const unifiedPercent = computed<number>(() => {
  const op = currentOp.value
  if (!op) return 0
  if (op.chainSpan === 'install') {
    return Math.min(70, globalProgress.value.percent * 0.7)
  }
  if (op.chainSpan === 'launch') {
    return 70 + launchPercent.value * 0.3
  }
  if (isBrandLaunch.value) {
    return launchPercent.value
  }
  return globalProgress.value.percent
})

// Launch ops always render determinate (launchPercent gives a number); others fall back to `globalProgress.indeterminate`.
const unifiedIndeterminate = computed<boolean>(() => {
  if (isBrandLaunch.value) return false
  const op = currentOp.value
  if (op?.chainSpan === 'install') return false
  return globalProgress.value.indeterminate
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
        <ComfyWordmark class="brand-progress__wordmark" />

        <!-- Single bar across the install→launch journey; hides once finished so the banner takes focus. -->
        <template v-if="!currentOp.finished">
          <div class="brand-progress__bar" :class="{ 'is-indeterminate': unifiedIndeterminate }">
            <div class="brand-progress__bar-fill" :style="{ width: `${unifiedPercent}%` }" />
          </div>
          <div v-if="!unifiedIndeterminate" class="brand-progress__percent" aria-hidden="true">
            {{ Math.round(unifiedPercent) }}%
          </div>
        </template>

        <!-- Finished-state banner. Error stays mounted to read/copy; success/cancel auto-close. Port-conflict ops get their own banner so it matches the Use-Port / Kill-Process footer. -->
        <Transition name="brand-caption-fade" mode="out-in">
          <div
            v-if="currentOp.finished && isPortConflictOpen"
            key="finished-port-conflict"
            class="brand-progress__banner brand-progress__banner--error"
            :data-testid="TID.progressPortConflictBanner"
            aria-live="polite"
          >
            <X :size="20" />
            <span>{{ $t('errors.portConflictTitle') }}</span>
          </div>
          <div
            v-else-if="currentOp.finished"
            :key="`finished-${
              currentOp.cancelRequested ? 'cancelled' : currentOp.error ? 'error' : 'success'
            }`"
            class="brand-progress__banner"
            :class="{
              'brand-progress__banner--success': !currentOp.cancelRequested && currentOp.result?.ok,
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

          <!-- Running caption; `:key` swap crossfades on text change.
               ⚠️ Don't add parametric vars to the key beyond `vramGb` — each value change forces a remount + crossfade, which stutters when the text is identical. -->
          <div
            v-else
            :key="
              isBrandLaunch
                ? `launch-${launchActiveIndex}-${vramGb ?? 'na'}`
                : (currentOp.activePhase ?? 'caption')
            "
            class="brand-progress__caption"
            aria-live="polite"
          >
            {{ isBrandLaunch ? launchCaption : friendlyCaption }}
          </div>
        </Transition>

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

        <!-- Substatus line: the rich detail (bytes/speed/ETA) for stepped phases whose curated label hides it. Hidden for launch ops. -->
        <div
          v-if="!currentOp.finished && !isBrandLaunch && formattedSubStatus"
          class="brand-progress__substatus"
          aria-live="polite"
        >
          {{ formattedSubStatus }}
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
  gap: clamp(1rem, 3vh, 2rem);
  text-align: center;
  overflow: hidden;
}
.brand-progress__stack::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 130%;
  height: 160%;
  border-radius: 50%;
  background: radial-gradient(
    ellipse at center,
    color-mix(in srgb, var(--neutral-800) 60%, transparent) 0%,
    color-mix(in srgb, var(--neutral-800) 40%, transparent) 35%,
    transparent 60%
  );
  pointer-events: none;
  z-index: -1;
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
  color: var(--neutral-100);
  text-align: center;
  min-height: 1.5em;
  text-shadow: 0 1px 8px rgba(0, 0, 0, 0.5);
  user-select: text;
  -webkit-user-select: text;
}
/* Second-line bytes/speed/ETA detail; tabular numbers keep digits from jittering as totals tick. */
.brand-progress__substatus {
  margin-top: -8px;
  font-size: var(--takeover-fs-caption, 12px);
  color: var(--neutral-200);
  text-align: center;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.01em;
  min-height: 1.4em;
  text-shadow: 0 1px 8px rgba(0, 0, 0, 0.5);
  user-select: text;
  -webkit-user-select: text;
}
.brand-progress__percent {
  font-size: 12px;
  color: var(--neutral-400);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
  margin-top: -4px;
  align-self: flex-end;
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
