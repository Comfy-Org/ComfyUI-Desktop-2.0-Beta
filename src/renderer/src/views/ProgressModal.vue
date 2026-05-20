<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, X, TriangleAlert, ChevronDown } from 'lucide-vue-next'
import { useModal } from '../composables/useModal'

import { useTerminalScroll } from '../composables/useTerminalScroll'
import { useProgressStore } from '../stores/progressStore'
import type { ActionResult, KillResult } from '../types/ipc'
import ModalShell from '../components/ModalShell.vue'
import BrandTakeoverLayout from '../components/BrandTakeoverLayout.vue'
import ComfyWordmark from '../components/icons/ComfyWordmark.vue'
import BrandProgressGlyph from '../components/icons/BrandProgressGlyph.vue'
import BaseAccordion from '../components/ui/BaseAccordion.vue'

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
 * Unified 0→100 progress for the bar. Reads through `progressStore.
 * globalProgressFor` which handles flat vs stepped + the monotonic
 * clamp + the held-fill-on-indeterminate trick. See the store helper
 * for the full contract.
 */
const globalProgress = computed<{ percent: number; indeterminate: boolean }>(() => {
  const op = currentOp.value
  if (!op) return { percent: 0, indeterminate: true }
  return progressStore.globalProgressFor(op)
})

/**
 * User-facing caption that swaps as phases advance.
 *
 * Stepped ops: maps `activePhase` to `progress.phaseLabel.<phase>` —
 * curated strings like "Downloading ComfyUI…" instead of the developer-y
 * `lastStatus` string. Falls back to `lastStatus[activePhase]` for any
 * phase not in the i18n table (e.g. a new main-side phase shipped before
 * the table is updated) so we never go blank.
 *
 * Flat ops: pass through `flatStatus` — chooser-launch overrides this
 * anyway via the existing `launchCaption` branch.
 */
const friendlyCaption = computed<string>(() => {
  const op = currentOp.value
  if (!op) return t('progress.starting')
  if (op.steps && op.activePhase) {
    const key = `progress.phaseLabel.${op.activePhase}`
    const friendly = t(key)
    // vue-i18n returns the key itself when missing — fall back to the raw
    // status string so the UI never shows the dotted key.
    if (friendly !== key) return friendly
    return op.lastStatus[op.activePhase] || op.activePhase
  }
  return op.flatStatus || t('progress.starting')
})

/**
 * Optional plain-English sub-line under the main caption. Reserved for
 * curated copy only — we intentionally do NOT surface raw
 * `lastStatus[activePhase]` here (it's developer-y, like
 * "Copying packages… 4123 / 8721 files"). When there's no curated
 * sub-copy for a phase, this returns null and the sub-line is hidden.
 *
 * Today no phase has curated sub-copy, so this always returns null.
 * Kept wired so a future "Almost there, just a moment…" type line can
 * drop in without retemplating.
 */
const subStatus = computed<string | null>(() => null)

/**
 * Brand-loader launch step list — chooser-tile launch path only.
 *
 * Active ONLY when `brandChrome && currentOp && currentOp.steps === null`.
 * That second guard is what keeps this off the other surfaces that also
 * mount the brand branch:
 *   - First-use install op (`steps` is non-null → multi-step install).
 *   - Update-while-running on first-use (also has `steps`).
 *
 * Launch ops are flat (`steps === null`) so this list activates cleanly
 * for chooser-tile launches and stays dormant everywhere else. When
 * dormant, the brand branch falls through to `friendlyCaption`.
 *
 * Five narrative rows:
 *   1. securityScan     — narrative, advanced by the timer below.
 *   2. mountLibraries   — narrative, advanced by the timer below.
 *   3. gpu              — Comfy stdout `Total VRAM <N> MB` line. Falls
 *                         back to the no-VRAM label until parsed.
 *   4. customNodes      — Comfy stdout custom-node / ComfyUI-Manager
 *                         load lines.
 *   5. startingServer   — stays active until the launch op finishes
 *                         (terminal "To see the GUI go to: …" line or
 *                          op.finished).
 *
 * Steps 1 + 2 are decorative — main only emits launch.starting /
 * launch.waiting today. If real integrity / library-mount phases land
 * in main later (sendProgress in launch.ts), drop the narrative timer
 * and key off `op.lastStatus.launch` instead.
 */
type LaunchStepKey =
  | 'securityScan'
  | 'mountLibraries'
  | 'gpu'
  | 'customNodes'
  | 'startingServer'

const LAUNCH_STEP_ORDER: readonly LaunchStepKey[] = [
  'securityScan',
  'mountLibraries',
  'gpu',
  'customNodes',
  'startingServer',
]

const isBrandLaunch = computed(
  () => props.brandChrome && !!currentOp.value && currentOp.value.steps === null,
)

/**
 * `captionFloor` is a monotonically-rising index ticked by a fixed-
 * interval timer (900ms). The active caption is `max(floor, stdoutStep)`
 * clamped so it never gets more than one step *ahead* of the floor —
 * that's what guarantees the first two narrative captions ("security
 * scan", "mount libraries") each get ~900ms of airtime even when Comfy
 * stdout immediately races to step 4. Without the clamp, a fast local
 * launch would silently skip both rows.
 */
const captionFloor = ref(0)
let captionTimer: ReturnType<typeof setInterval> | null = null
const CAPTION_TICK_MS = 900

/**
 * Latched VRAM (GB) and furthest stdout-driven step, both maintained by
 * the tail-walking watcher below.
 *
 * Why a watcher instead of a `computed(() => out.match(…))`:
 * `terminalOutput` is mutated on every Comfy stdout chunk (string += in
 * the progress store). A computed would re-scan the *entire* growing
 * buffer per chunk — O(N) per chunk, O(N²) cumulative across a launch.
 * ComfyUI-Manager dumps hundreds of lines while custom nodes load and
 * the buffer easily hits hundreds of KB, so the quadratic shape is real
 * even on a launch the user perceives as a few seconds.
 *
 * Instead, we scan only the *new tail* of stdout, keep a small overlap
 * so a pattern split across the chunk boundary still matches, and short-
 * circuit once every regex has hit (no further work for the rest of the
 * launch).
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
    // Stop ticking the moment stdout (or op completion) has already
    // walked us to the last step — saves a per-900ms ref bump after the
    // server is up and complements the watcher short-circuit above.
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

// Reset + (re)arm the caption timer when the brand-launch op changes.
// Keyed on `displayId` so each launch starts the rolling caption fresh.
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
  { immediate: true },
)

// Snap to the terminal caption the moment the op finishes (success or
// cancel) so the user doesn't see "Mounting model libraries…" hanging
// after the server is up.
watch(
  () => currentOp.value?.finished ?? false,
  (finished) => {
    if (finished) {
      clearCaptionTimer()
      captionFloor.value = LAUNCH_STEP_ORDER.length - 1
    }
  },
)

onBeforeUnmount(clearCaptionTimer)

// Tail-only stdout scanner. Replaces two full-buffer regex computeds
// (see comment on `vramGb` above for why).
watch(
  () => (isBrandLaunch.value ? (currentOp.value?.terminalOutput ?? '') : ''),
  (out) => {
    if (!out) {
      lastScanLen = 0
      return
    }
    // Already at the terminal step — nothing left to detect.
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
  },
)

const launchActiveIndex = computed(() => {
  if (!isBrandLaunch.value) return 0
  const op = currentOp.value
  if (!op) return 0
  if (op.finished) return LAUNCH_STEP_ORDER.length - 1
  // Cap stdout's contribution at floor+1: that's what makes the timer
  // load-bearing instead of decorative — stdout can fast-forward by at
  // most one step per tick, so every caption gets its ~900ms of airtime.
  const stdoutClamped = Math.min(stdoutStep.value, captionFloor.value + 1)
  return Math.max(captionFloor.value, stdoutClamped)
})

/** Single rolling caption — picks the label for the current active step
 *  (or the last one once the op has finished). The bar shows progress
 *  visually; this just swaps the text as phases advance. */
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

// Independent of the modal-branch terminal toggle (`terminalExpanded`)
// so the brand accordion's state doesn't leak into the Tier-2 modal
// reopen path.
const brandLogsExpanded = ref(false)
const brandTerminalRef = ref<HTMLDivElement | null>(null)
// Short-circuit the watcher inside `useTerminalScroll` when the
// accordion is closed: with two `useTerminalScroll` instances live on
// this surface (brand + modal terminal), every stdout chunk would wake
// both watchers and post a `nextTick → scrollToBottom` on a `null` ref.
// Gating the getter elides that fan-out until the disclosure is open.
const {
  isAtBottom: brandIsAtBottom,
  handleTerminalScroll: handleBrandTerminalScroll,
} = useTerminalScroll(brandTerminalRef, () =>
  brandLogsExpanded.value ? currentOp.value?.terminalOutput : undefined,
)

function toggleBrandLogs(): void {
  brandLogsExpanded.value = !brandLogsExpanded.value
}

// Collapse brand logs when the op id changes — each launch starts with
// the accordion closed.
watch(
  () => (isBrandLaunch.value ? displayId.value : null),
  () => {
    brandLogsExpanded.value = false
    brandIsAtBottom.value = true
  },
)

const terminalRef = ref<HTMLDivElement | null>(null)
const { isAtBottom, terminalExpanded, handleTerminalScroll } = useTerminalScroll(
  terminalRef,
  () => currentOp.value?.terminalOutput
)

/**
 * Cap what we actually render. The store keeps the full unbounded
 * `terminalOutput` string (telemetry / error reports still see the
 * whole thing) but rendering megabytes of text into a single text
 * node — which is what install-class ops can produce — re-layouts the
 * whole takeover. A trailing window is what the user wants anyway when
 * inspecting "what just happened."
 */
const MAX_LOG_TAIL_CHARS = 256 * 1024
const displayedTerminalOutput = computed(() => {
  const s = currentOp.value?.terminalOutput ?? ''
  return s.length > MAX_LOG_TAIL_CHARS ? s.slice(-MAX_LOG_TAIL_CHARS) : s
})

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
          :class="{ 'is-indeterminate': globalProgress.indeterminate }"
        >
          <div
            class="brand-progress__bar-fill"
            :style="{ width: `${globalProgress.percent}%` }"
          />
        </div>
        <div
          v-if="!isBrandLaunch && !globalProgress.indeterminate"
          class="brand-progress__percent"
          aria-hidden="true"
        >
          {{ Math.round(globalProgress.percent) }}%
        </div>

        <!-- Single rolling caption. For chooser-tile launches the
             caption cycles through `launchCaption` (5 narrative + stdout-
             driven phases). All other brand mounts (install screen,
             update-while-running) keep the existing `brandCaption` so
             their UX is untouched. The `:key` swap drives a tiny
             crossfade on text change.

             ⚠️ The key embeds `vramGb` because that's the only
             *intra-step* dynamic var we want to crossfade on (null → 24).
             Don't add more parametric vars to this key without thinking —
             every value change forces a remount + crossfade, which looks
             like a stutter when the underlying text is identical. -->
        <Transition name="brand-caption-fade" mode="out-in">
          <div
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

        <!-- View logs disclosure — brand-launch only, and only when stdout
             has actually emitted something. Independent state from the
             modal-branch terminal toggle. -->
        <template v-if="isBrandLaunch && currentOp.terminalOutput">
          <button
            type="button"
            class="brand-progress__logs-toggle"
            :aria-expanded="brandLogsExpanded"
            aria-controls="brand-progress-logs"
            @click="toggleBrandLogs"
          >
            <ChevronDown
              :size="14"
              class="brand-progress__logs-chevron"
              :class="{ 'is-open': brandLogsExpanded }"
            />
            <span>{{ $t('launch.viewLogs') }}</span>
          </button>
          <BaseAccordion :open="brandLogsExpanded" class="brand-progress__logs-wrap">
            <div
              id="brand-progress-logs"
              ref="brandTerminalRef"
              class="brand-progress__logs"
              @scroll="handleBrandTerminalScroll"
            >
              {{ displayedTerminalOutput }}
            </div>
          </BaseAccordion>
        </template>
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

    <!-- Unified progress block — same shape for stepped + flat ops.
         The CTO ask is: ONE 0→100 bar across the whole op, with the
         caption underneath changing through phases. Stepped ops feed
         their per-phase percent into `globalProgressFor` (weighted),
         flat ops pass through. Caption swaps via the brand-caption-fade
         transition keyed on `activePhase`.

         Error / port-conflict copy is preserved as a finished-op
         overlay — fires for both stepped and flat ops if the op ends
         badly (previously the stepped branch had no inline error
         render). -->
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
    <template v-else>
      <Transition name="brand-caption-fade" mode="out-in">
        <div
          :key="currentOp.activePhase ?? 'flat'"
          class="progress-status"
          aria-live="polite"
        >
          {{ friendlyCaption }}
        </div>
      </Transition>
      <div v-if="subStatus" class="progress-substatus">{{ subStatus }}</div>
    </template>
    <div v-if="!currentOp.finished" class="progress-bar-wrap">
      <div
        class="progress-bar-track"
        :class="{ indeterminate: globalProgress.indeterminate }"
      >
        <div
          class="progress-bar-fill"
          :style="{ width: `${globalProgress.percent}%` }"
        ></div>
      </div>
      <div
        v-if="!globalProgress.indeterminate"
        class="progress-bar-percent"
        aria-hidden="true"
      >
        {{ Math.round(globalProgress.percent) }}%
      </div>
    </div>

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
        {{ displayedTerminalOutput }}
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
  text-align: center;
  min-height: 1.5em;
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
  transition: opacity 180ms ease, transform 180ms ease;
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

.brand-progress__logs-toggle {
  appearance: none;
  background: transparent;
  border: none;
  color: var(--neutral-400);
  font-size: var(--takeover-fs-caption, 12px);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  cursor: pointer;
  border-radius: 6px;
  transition: color 160ms ease, background-color 160ms ease;
}
.brand-progress__logs-toggle:hover,
.brand-progress__logs-toggle:focus-visible {
  color: var(--neutral-200);
  background: var(--brand-surface-bg);
  outline: none;
}
.brand-progress__logs-chevron {
  transition: transform 200ms cubic-bezier(0.22, 1, 0.36, 1);
}
.brand-progress__logs-chevron.is-open {
  transform: rotate(180deg);
}
.brand-progress__logs-wrap {
  width: 100%;
}
.brand-progress__logs {
  width: 100%;
  height: clamp(160px, 28vh, 320px);
  overflow-y: auto;
  margin-top: 8px;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid var(--brand-surface-border);
  background: var(--brand-surface-bg);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.55;
  color: var(--neutral-300);
  text-align: left;
  white-space: pre-wrap;
  word-break: break-word;
  backdrop-filter: blur(4px);
}
</style>
