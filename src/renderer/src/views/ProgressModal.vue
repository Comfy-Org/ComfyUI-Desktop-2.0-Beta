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
  /** Picker-driven mutating ops that opted into a `successTerminal`
   *  resolve here instead of auto-closing. The host maps the action id
   *  (`go-dashboard`, `open-instance`, future presets) to behaviour. */
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

/**
 * Whether the op finished with an unresolved port conflict. Used by
 * the brand layout to swap the generic finished-state UI (banner + Back
 * to dashboard) for the port-specific banner + Use-Port / Kill-Process
 * footer. `resolvingConflict` flips to true the moment the user picks
 * a fix and the op is re-started, which drops us back into the running
 * state — so this guard fires only while the conflict is actionable.
 */
const isPortConflictOpen = computed<boolean>(() => {
  const op = currentOp.value
  if (!op?.finished) return false
  if (resolvingConflict.value) return false
  const conflict = op.result?.portConflict
  if (!conflict) return false
  if (op.result?.ok) return false
  return true
})

/**
 * Detail-line text to render under the finished-state banner — either
 * the generic error string or the port-conflict message. Centralised
 * so the `<div>` gate and the `<BaseCopyButton>` `value` can't drift:
 * whatever the user sees is exactly what gets copied.
 *
 * Returns null while the op is in flight or in any other terminal
 * state (success, cancelled) so the row collapses cleanly.
 */
const finishedErrorMessage = computed<string | null>(() => {
  const op = currentOp.value
  if (!op?.finished) return null
  if (op.cancelRequested) return null
  if (isPortConflictOpen.value) return op.result?.message ?? null
  if (op.error) return op.error
  return null
})

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
 * Per-step weight slots for the launch 0→100% bar. Each entry is the
 * end-of-slot percent; the active step interpolates between the
 * previous slot's end and its own end as elapsed-time-in-step grows.
 * Calibrated so gpu + customNodes — the two long ones — own the middle
 * of the bar, and startingServer holds the final 25% for the port-wait.
 *
 * Indexed by `LAUNCH_STEP_ORDER`:
 *   [securityScan, mountLibraries, gpu, customNodes, startingServer]
 */
const LAUNCH_SLOT_ENDS = [10, 25, 45, 70, 95] as const
const LAUNCH_SLOT_STARTS = [0, 10, 25, 45, 70] as const
/** Soft estimate (ms) for how long the active step takes when no
 *  stdout signal arrives — used purely to interpolate the bar fill
 *  inside its slot. Steps still advance only on the 900ms timer +
 *  stdout regexes; this constant just keeps the bar from looking
 *  frozen between transitions. */
const LAUNCH_STEP_BUDGET_MS = 4_000

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
 * Optional second-line caption rendered under `friendlyCaption`. Today
 * surfaces the main-side rich `lastStatus[activePhase]` string for any
 * stepped phase where `friendlyCaption` is showing a curated label —
 * giving the user the bytes / speed / ETA detail main already computed
 * (see `installer.ts` download progress emitter) without the dev-y
 * raw phase id leaking through as a headline.
 *
 * Gated on:
 *  - stepped op (so the launch-style flat ops don't get a substatus —
 *    their narrative captions already convey what's happening).
 *  - the curated phase label *was* found (`friendlyCaption !==
 *    op.lastStatus[activePhase]`); otherwise headline + substatus would
 *    say the same thing.
 *  - the raw status is meaningfully different from the headline (a
 *    string equality check) — for phases that only emit the curated
 *    label, this collapses to null and the line is hidden.
 *
 * Flat ops fall through to null since `flatStatus` already lands as
 * the headline.
 */
const subStatus = computed<string | null>(() => {
  const op = currentOp.value
  if (!op?.steps || !op.activePhase) return null
  const raw = op.lastStatus[op.activePhase]
  if (!raw) return null
  if (raw === friendlyCaption.value) return null
  return raw
})

/**
 * Polish the rich substatus string main produces (e.g. `"250 / 1000 MB ·
 * 12.3 MB/s · 1m30s elapsed · 45s remaining"`). Three passes:
 *   1. Group 4+ digit byte counts (`1000 MB` → `1,000 MB`). Lookahead is
 *      scoped to a byte-unit suffix so unrelated numerics (port, PID,
 *      timestamp) elsewhere in the string can't be mangled into
 *      `12,345`.
 *   2. Drop the "· 0s remaining" / "· — remaining" tail at the very end
 *      of the elapsed window — it's noise once the ETA has collapsed.
 *   3. Collapse the doubled separator left behind and trim a trailing
 *      one so we never render `"… elapsed  ·  "`.
 */
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
type LaunchStepKey = 'securityScan' | 'mountLibraries' | 'gpu' | 'customNodes' | 'startingServer'

const LAUNCH_STEP_ORDER: readonly LaunchStepKey[] = [
  'securityScan',
  'mountLibraries',
  'gpu',
  'customNodes',
  'startingServer'
]

// True only for launch-class ops in the brand layout. Drives the
// rolling 5-step launchCaption pipeline ("security scan → mount
// libraries → GPU → custom nodes → starting server") + the GPU stdout
// scanner + the `launchPercent` bar interpolation. Non-launch ops
// (delete / update / install / snapshot / generic) fall through to
// `friendlyCaption`, which maps `progress.phaseLabel.<phase>` or
// `flatStatus` to a user-facing string — so a delete op now reads
// "Deleting installation…" instead of "Mounting model libraries…".
const isBrandLaunch = computed(
  () => !!currentOp.value && currentOp.value.opKind === 'launch' && currentOp.value.steps === null
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
  { immediate: true }
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
  }
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
  }
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
 *  (or the last one once the op has finished). The unified bar carries
 *  the % story; this just swaps the text as launch phases advance.
 *  Mirrors `friendlyCaption` for non-launch ops; the template picks
 *  one or the other based on `isBrandLaunch`. */
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

/**
 * Wall-clock timestamp the current launch step became active. Used by
 * `launchPercent` to interpolate the bar's fill within its slot so the
 * user sees forward motion between step transitions even though the
 * step itself only advances on the 900ms timer / stdout regex match.
 *
 * `launchStepNow` is a low-frequency reactive clock that re-evaluates
 * `launchPercent` every ~250ms. It only ticks during an in-flight
 * launch op (gated below); other ops bypass `launchPercent` entirely.
 */
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

// Reset the step-elapsed clock whenever the launch op changes or the
// active step advances. Anchoring on `launchActiveIndex` is what makes
// the bar's slot-internal interpolation snap forward at each transition
// instead of carrying stale elapsed-time from the previous step.
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

/**
 * Launch progress as a 0→100 percent for the unified bar. Maps the
 * 5-step state machine onto `LAUNCH_SLOT_ENDS`:
 *   - Completed steps contribute their full slot.
 *   - Active step interpolates `[slotStart, slotEnd)` by elapsed time
 *     against `LAUNCH_STEP_BUDGET_MS`, capped so we never reach the next
 *     slot before the step itself advances.
 *   - When the final step has fired AND stdout has matched the "server
 *     ready" regex (encoded as `stdoutStep >= 4`), snap to 100.
 *
 * Standalone-launch flows feed this into `unifiedPercent` directly
 * (the launch op carries the whole 0→100 by itself); chained-launch
 * flows feed it through the 70→100 mapping so install+launch read as
 * one journey.
 */
const launchPercent = computed<number>(() => {
  if (!isBrandLaunch.value) return 0
  const op = currentOp.value
  if (!op) return 0
  if (op.finished && op.result?.ok) return 100
  const idx = launchActiveIndex.value
  // Final step reached AND server-ready regex fired → snap to 100. The
  // regex matching is what set `stdoutStep` to 4 in the first place, so
  // checking either side is equivalent; we check `stdoutStep` directly
  // so the bar doesn't sit at 95% while the user waits for the comfy
  // window to appear.
  if (idx >= LAUNCH_STEP_ORDER.length - 1 && stdoutStep.value >= LAUNCH_STEP_ORDER.length - 1) {
    return 100
  }
  const slotStart = LAUNCH_SLOT_STARTS[idx] ?? 0
  const slotEnd = LAUNCH_SLOT_ENDS[idx] ?? 100
  const elapsed = Math.max(0, launchStepNow.value - launchStepStartMs.value)
  const ratio = Math.min(1, elapsed / LAUNCH_STEP_BUDGET_MS)
  return slotStart + (slotEnd - slotStart) * ratio
})

/**
 * Unified 0→100 percent for the bar across an install→launch chain.
 *
 * - `chainSpan === 'install'`: install op's `globalProgress` mapped to
 *   0→70% so the install never visually saturates before the launch
 *   leg begins. The remaining 30% is reserved for the launch.
 * - `chainSpan === 'launch'`: launch op's `launchPercent` mapped to
 *   70→100% so the bar picks up where the install left off.
 * - Standalone launch (`opKind === 'launch'`, no chainSpan): launch
 *   op's `launchPercent` mapped 0→100. Bar moves through all five slots
 *   on its own.
 * - Anything else: pass-through `globalProgress.percent`.
 *
 * Monotonic by construction — install caps at 70 and launch starts at
 * 70, so the seam between the two ops is invisible.
 */
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

/** Whether the bar should render with the indeterminate slide animation
 *  rather than a determinate fill. Launch ops always render determinate
 *  now (the 5-step state machine + `launchPercent` give us a number);
 *  non-launch ops fall back to the existing `globalProgress.indeterminate`
 *  signal. */
const unifiedIndeterminate = computed<boolean>(() => {
  if (isBrandLaunch.value) return false
  const op = currentOp.value
  if (op?.chainSpan === 'install') return false
  return globalProgress.value.indeterminate
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
const { isAtBottom: brandIsAtBottom, handleTerminalScroll: handleBrandTerminalScroll } =
  useTerminalScroll(brandTerminalRef, () =>
    brandLogsExpanded.value ? currentOp.value?.terminalOutput : undefined
  )

function toggleBrandLogs(): void {
  brandLogsExpanded.value = !brandLogsExpanded.value
}

// Collapse brand logs when the op id changes — each op (launch, delete,
// update, …) starts with the accordion closed.
watch(displayId, () => {
  brandLogsExpanded.value = false
  brandIsAtBottom.value = true
})

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

/** Copy-button getter for the log Copy affordance — returns the FULL
 *  unbounded `terminalOutput` (not the truncated render copy), since
 *  the user copies for sharing and the whole buffer is what they want
 *  in the issue thread / Google query. Wrapped as a function so the
 *  string is materialised at click time instead of on every keystroke
 *  the buffer grows. */
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
  /** Forwarded straight to the store so a host that drives the modal
   *  via the exposed handle (instead of `handleShowProgress`) can still
   *  set up an install→launch chain. Without this widening the field
   *  would be silently dropped — bar resets at the seam. */
  chainSpan?: ShowProgressOpts['chainSpan']
  successTerminal?: ShowProgressOpts['successTerminal']
}): void {
  currentId.value = opts.installationId
  resolvingConflict.value = false
  progressStore.startOperation(opts)
}

/** True when a successful op is parked on its terminal-choice screen
 *  instead of auto-closing. Drives the footer template swap and the
 *  auto-close gate. */
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

// Auto-close modal on window-mode launch success. Other op kinds are
// auto-closed via the brand-loader's `handleDone`-driven watcher below
// (after a short delay so the success banner registers visually).
// Window-mode launches need to close instantly so the new comfy
// window can take focus without the takeover lingering.
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
  // Destroy ops: detach the host (no-op if not install-backed) before
  // closing the takeover, so a delete that finished against the install
  // currently backing this window doesn't leave the host pointing at a
  // now-removed install.
  if (op.destroysInstance) {
    void window.api.returnToDashboard()
  }
  emit('close')
  // Copy / copy-update / release-update produced a new install — open
  // it in its own window. The source host stays where it is so the
  // user keeps the running session / panel state they had.
  const newInstallationId = op.result.newInstallationId
  if (newInstallationId) {
    void window.api.openInstallWindow(newInstallationId)
    return
  }
  // Guard show-detail against a stale install id — destroy ops (or any
  // op whose success removes the install from the registry) would
  // otherwise route to a now-missing detail view.
  const installStillExists = !!installationStore.getById(id)
  if (installStillExists && (op.returnTo === 'detail' || op.result.navigate === 'detail')) {
    emit('show-detail', id)
  } else if (op.result.mode === 'console') {
    emit('show-console', id)
  }
}

/** Return-to-Dashboard from any op state. In-flight runs the
 *  shared confirm (local installs are prompted because returning stops a
 *  running ComfyUI); error / finished states skip the prompt because
 *  the install is already idle. Closes the takeover and, if the
 *  current window is install-backed, flips it back to chooser mode in
 *  place via the panel IPC. */
async function returnToDashboard(reason: ReturnToDashboardReason): Promise<void> {
  const id = displayId.value
  const op = id ? progressStore.operations.get(id) : null
  const installation = id ? (installationStore.getById(id) ?? null) : null
  // confirmReturnToDashboard is a no-op for the crashed / finished branches —
  // only the in-flight footer button can actually surface the prompt.
  const ok = await confirmReturnToDashboard(installation, reason)
  if (!ok) return
  // Cancel the in-flight op so it doesn't keep running in the background.
  if (reason === 'in_flight' && op && !op.finished && id) {
    progressStore.cancelOperation(id)
  }
  emitTelemetryAction('comfy.desktop.instance.return_to_dashboard', { from: 'progress', reason })
  emit('close')
  // No-op when the calling host isn't install-backed (chooser host
  // launches that errored before the swap).
  await window.api.returnToDashboard()
}

/** Re-run the same op that just errored. Mirrors the port-conflict
 *  retry pattern: feed the stored `apiCall` (or, for legacy launch
 *  ops without one, fall back to a fresh `runAction('launch')`) back
 *  into `startOperation`. */
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

/** Cancel an in-flight destroy op. Gated by the same local-install
 *  confirm helper for consistency (a delete-in-flight cancel still
 *  leaves the install in an unknown partial state, so the prompt is
 *  worth the friction). Closes the takeover after main acknowledges
 *  the cancel — the destroy op leaves the host in its current state
 *  rather than auto-detaching. */
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

/** Auto-close the brand loader on success or cancel so the user
 *  doesn't have to click Done. A short delay (~700 ms) lets the
 *  banner crossfade in long enough to register, then `handleDone`
 *  runs the same navigation logic as the manual click. Errors
 *  don't auto-close — the user needs time to read / copy the
 *  message and pick their next step. */
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
    // successTerminal opt-in parks the modal on a choice screen so the
    // user explicitly picks the next step. Auto-close would race the
    // first frame of that screen and dismiss it before it's readable.
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

        <!-- Progress bar — single 0→100% fill that spans the full
             install→launch journey. `unifiedPercent` maps the install
             leg into 0–70% and the launch leg into 70–100%; standalone
             ops just run 0→100 directly. Bar hides once the op finishes
             so the finished-state banner owns the visual focus. -->
        <template v-if="!currentOp.finished">
          <div class="brand-progress__bar" :class="{ 'is-indeterminate': unifiedIndeterminate }">
            <div class="brand-progress__bar-fill" :style="{ width: `${unifiedPercent}%` }" />
          </div>
          <div v-if="!unifiedIndeterminate" class="brand-progress__percent" aria-hidden="true">
            {{ Math.round(unifiedPercent) }}%
          </div>
        </template>

        <!-- Finished-state banner — appears in place of the running
             caption when the op resolves. Success / cancelled auto-
             close after a short delay (see auto-close watcher); error
             stays mounted so the user can read and copy the message.
             Port-conflict ops render their own "Port N is in use…"
             variant so the footer's Use-Port / Kill-Process actions
             have matching headline copy — falling through to the
             generic "Operation failed" banner alongside port-conflict
             buttons reads as inconsistent.
             `resolvingConflict` flips back to `false` once the new
             launch attempt starts, so the in-flight caption block
             takes over again automatically. -->
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

          <!-- Running caption. Launch ops cycle through `launchCaption`
               (5 narrative + stdout-driven phases). Every other op kind
               (delete, update, install, snapshot, generic) maps through
               `friendlyCaption`. The `:key` swap drives a tiny crossfade
               on text change.

               ⚠️ The key embeds `vramGb` because that's the only
               *intra-step* dynamic var we want to crossfade on
               (null → 24). Don't add more parametric vars without
               thinking — every value change forces a remount + crossfade,
               which looks like a stutter when the underlying text is
               identical. -->
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

        <!-- Success terminal action buttons — centered below the banner,
             outside the caption Transition so it doesn't count as a
             second child. Slides in once successTerminalActive. -->
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

        <!-- Substatus line — the rich main-side detail string (bytes
             received / total, MB/s, elapsed, ETA) for stepped phases
             whose curated label hides those numbers. Launch ops keep
             it hidden because their rolling launchCaption already
             cycles through narrative phases. -->
        <div
          v-if="!currentOp.finished && !isBrandLaunch && formattedSubStatus"
          class="brand-progress__substatus"
          aria-live="polite"
        >
          {{ formattedSubStatus }}
        </div>

        <!-- Error / port-conflict detail line beneath the banner.
             • Generic error: `currentOp.error` is set.
             • Port conflict: `result.portConflict` set, not mid-
               resolution. Uses `result.message` (server-side copy
               with the port number filled in).
             Body text is selectable; the inline Copy button writes
             the same string the user could grab manually so the
             share-to-Google / paste-into-issue-thread flow doesn't
             require keyboard chording. -->
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

        <!-- Error actions — centered in the hero stack, directly below the
             error message, mirroring the success-terminal action row. Keeps
             the primary Reboot CTA with the failure context instead of
             stranding it bottom-left in the footer. -->
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
    <!-- Footer band — sibling to the centered hero stack so the action
         row pins to the takeover's bottom edge without crowding the
         caption / banner area above. Same geometry as
         InstallWizardModal's Configure footer.
         • In-flight → Return to Dashboard (shared confirm gates
           local installs because returning cancels the running op /
           ComfyUI). Cancels the op then flips the host back to
           chooser mode in place.
         • Port conflict → up to two source-driven actions:
           Use port N (when main suggested a next port) and Kill
           process (when the offender is itself a ComfyUI process).
           `handleUseNextPort` / `handleKillProcess` restart the op
           with the appropriate fix and flip `resolvingConflict`, which
           collapses the conflict UI back to the running state.
         • Error → Reboot (re-runs the same `apiCall`) + Return to
           Dashboard.
         Success / cancelled auto-close after a short delay so no
         buttons render then — the band collapses to zero height. -->
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
/* Second-line detail under the curated phase headline. Used for the
   bytes / speed / ETA string main computes for download + extract
   phases. Tabular numbers keep the digits from jittering as totals
   tick, and `pre-wrap` + `min-height` prevent reflow when the line
   collapses between updates. */
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
/* Log panel that opens above the footer bar. `min-height: 0` lets the
   accordion shrink within the bounded footer so short windows scroll
   the log body (capped via the panel's own `max-height`) instead of
   pushing the footer bar off-screen. Display stays `grid` (set by
   BaseAccordion) so the 0fr→1fr open/close animation is untouched. */
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
  /* `max-height` (not a fixed `height`) so the panel shrinks on short
     windows instead of forcing the footer past the viewport. `25vh`
     tracks window height; the 88px floor keeps a couple of readable
     lines even on a very short window, and 260px caps it on tall ones. */
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

/* Finished-state banner. Sits in place of the running caption when the
   op resolves. Icon + label crossfade in via the existing
   brand-caption-fade transition that wraps both branches. */
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

/* Success terminal CTAs — centered in the hero stack, directly below
   the success banner. Matching gap to the stack's natural rhythm. */
.brand-progress__terminal-actions {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 12px;
  flex-wrap: wrap;
}

/* Error CTAs — centered in the hero stack under the error message.
   Back (ghost) sits left, Reboot (primary) right; both flex to equal
   width within a bounded row so the pair reads as a balanced unit
   rather than two differently-sized chips. */
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

/* Error detail line beneath the banner. Selectable so users can copy
   manually. Bounded so a long Python traceback / `uv pip` failure
   doesn't stretch the takeover past the viewport — chosen slightly
   shorter than the sibling `.brand-progress__logs` panel so the error
   reads as visually subordinate to the (more verbose) logs when both
   are open. */
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

/* Footer — positioned container for the bar + the logs panel above it.
   `top` is anchored so the block can never grow taller than the gap
   between the takeover's top padding and its bottom inset — on a short
   window the logs panel shrinks (see its flexible height + min-height
   below) instead of overflowing off the top edge and clipping the
   toggle. `min-height: 0` lets the flex child shrink past its content. */
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
/* Re-enable interaction on the actual content — the container is only a
   geometric bound, so it stays click-through where it's empty. */
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
/* Destructive variant for the port-conflict Kill Process button.
   Pairs with `.brand-ghost` to keep the chrome consistent — same
   border/padding as the primary button — but tinted with the
   semantic danger color so the irreversible action reads as such. */
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
