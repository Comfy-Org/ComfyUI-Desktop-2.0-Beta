<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, toRaw, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  AlertCircle,
  Check,
  Cloud,
  Cpu,
  Download,
  ExternalLink,
  FolderSearch,
  HardDrive,
  Import,
  Loader2,
  Play,
  RotateCw,
  Sparkles,
} from 'lucide-vue-next'
import { useInstallationStore } from '../stores/installationStore'
import { useProgressStore } from '../stores/progressStore'
import { useOnboardingPrefs } from '../composables/useOnboardingPrefs'
import { useMigrateAction } from '../composables/useMigrateAction'
import { useModal } from '../composables/useModal'
import { emitTelemetryAction } from '../lib/telemetry'
import type { FieldOption } from '../types/ipc'

// TODO: replace with the final EULA URL once Legal signs off.
const EULA_URL = 'https://www.comfy.org/legal/desktop-eula'

// --- IPC timeout matrix (per §9.0 spec) ----------------------------------
// Every async user-initiated action has an explicit timeout via Promise.race.
// Values picked per the spec timeout matrix; documented inline so reviewers
// can verify each.
const TIMEOUT_SET_SETTING_MS = 3_000              // setSetting (any single key)
const TIMEOUT_OPEN_EXTERNAL_MS = 2_000            // shell.openExternal — just acks the OS
const TIMEOUT_FORM_PREFLIGHT_MS = 10_000          // getDefaultInstallDir + getFieldOptions + detectGPU + validateHardware
const TIMEOUT_INSTALL_SETUP_MS = 15_000           // 4-call submit chain ending in addInstallation
const TIMEOUT_CLOUD_LAUNCH_MS = 30_000            // runAction(id, 'launch') for cloud — waitForUrl poll
const TIMEOUT_LOCAL_LAUNCH_MS = 15_000            // runAction(id, 'launch') for local
const TIMEOUT_CANCEL_LAUNCH_MS = 3_000            // cancelLaunch — must escape regardless
const TIMEOUT_DONE_RETRY_MS = 15_000              // §8 explicit done-state retry timeout
const CARD_LOADING_PAINT_MS = 400                 // ensure card-loading state renders before stage flips

// Helper: wraps a promise in a Promise.race against an explicit timeout.
// Returns a discriminated rejection value the caller can pattern-match on.
function withTimeout<T>(p: Promise<T>, ms: number, timeoutValue: T): Promise<T> {
  return Promise.race<T>([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(timeoutValue), ms)),
  ])
}

// Variant that REJECTS on timeout. Use this when the caller has a try/catch
// and wants to treat the timeout as a thrown error (e.g. setSetting toggles
// where the catch block reverts UI state).
function withTimeoutOrThrow<T>(p: Promise<T>, ms: number, errorMessage: string): Promise<T> {
  return Promise.race<T>([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(errorMessage)), ms)),
  ])
}

const emit = defineEmits<{
  complete: []
  'show-progress': [opts: {
    installationId: string
    title: string
    apiCall: () => Promise<unknown>
    cancellable?: boolean
  }]
}>()

const { t } = useI18n()
const installationStore = useInstallationStore()
const progressStore = useProgressStore()
const onboardingPrefs = useOnboardingPrefs()
const modal = useModal()
const { confirmMigration } = useMigrateAction()

type Stage = 'consent' | 'mode' | 'local-fork' | 'install-form' | 'installing' | 'connecting-cloud' | 'done'
// Returning users (EULA already accepted) skip straight to the mode picker.
// We seed the initial stage from prefs at composition time.
const stage = ref<Stage>(onboardingPrefs.eulaAccepted.value ? 'mode' : 'consent')
const busy = ref(false)

// --- Install form state ---
const installPath = ref('')
const defaultInstallPath = ref('')
const releaseOptions = ref<FieldOption[]>([])
const selectedRelease = ref<FieldOption | null>(null)
const detectedGpuLabel = ref('')
const formLoading = ref(false)
const formError = ref('')
// Surfaced in the mode picker after a failed cloud connect attempt so the
// user understands why they bounced back instead of seeing a silent revert.
const cloudError = ref('')

// --- Install progress state ---
const installingId = ref<string | null>(null)
const installingName = ref('')
const installStartedAt = ref(0)
const elapsedSeconds = ref(0)
let elapsedTimer: ReturnType<typeof setInterval> | null = null

const installOp = computed(() => {
  if (!installingId.value) return null
  return progressStore.operations.get(installingId.value) ?? null
})

// The standalone install backend doesn't emit a `steps` list — it only
// streams a flat percent + status. To give the user a sense of "where am I
// in the install", we render a fixed step ladder and light it up based on
// the live percent. If percent is unknown (negative), we fall back to a
// time-based estimate so the slider still moves.
const FAUX_STEPS = [
  { label: 'Validating environment', threshold: 5 },
  { label: 'Downloading ComfyUI runtime', threshold: 35 },
  { label: 'Setting up Python', threshold: 65 },
  { label: 'Installing dependencies', threshold: 90 },
  { label: 'Finalizing', threshold: 100 },
]
// Heuristic install duration for time-based fallback (3 min). Caps at 95%
// so the bar never sits at 100% while we're still waiting on the backend.
const FAUX_DURATION_SECONDS = 180

const installPercent = computed(() => {
  const op = installOp.value
  if (!op) return 0
  if (op.flatPercent >= 0) return op.flatPercent
  // Stall-aware fallback (§9.5): when stalled, freeze at the last observed
  // percent rather than continuing the time-based estimate forward — the
  // estimate would be a lie if no real progress is happening.
  if (isStalled.value) return lastFlatPercent.value
  // Backend didn't send a percent — estimate from elapsed time so the slider
  // still advances and the user knows things are happening.
  return Math.min(95, (elapsedSeconds.value / FAUX_DURATION_SECONDS) * 100)
})

const installPercentDisplay = computed(() => {
  const p = installPercent.value
  return `${Math.round(p)}%`
})

const installStatus = computed(
  () => installOp.value?.flatStatus || t('progress.starting'),
)

interface DisplayStep {
  label: string
  state: 'pending' | 'active' | 'done'
}

const displaySteps = computed<DisplayStep[]>(() => {
  const p = installPercent.value
  return FAUX_STEPS.map((step, i) => {
    const prev = i === 0 ? 0 : FAUX_STEPS[i - 1]!.threshold
    let state: DisplayStep['state'] = 'pending'
    if (p >= step.threshold) state = 'done'
    else if (p >= prev) state = 'active'
    return { label: step.label, state }
  })
})

const activeStepLabel = computed(() => {
  const active = displaySteps.value.find((s) => s.state === 'active')
  return active?.label ?? displaySteps.value[displaySteps.value.length - 1]?.label ?? ''
})

// Latched so the watch only finalizes once. Vue's `watch` can fire multiple
// times for the same `finished=true` value if upstream reactivity nudges
// `installOp` (e.g. a late progress event clearing flatStatus). Without this,
// we'd run the launch + complete sequence twice.
const hasFinalized = ref(false)

watch(
  () => installOp.value?.finished,
  (finished) => {
    if (!finished || stage.value !== 'installing') return
    if (hasFinalized.value) return
    const op = installOp.value
    if (!op) return
    hasFinalized.value = true
    stopElapsedTimer()

    // Cancellation path — user clicked cancel mid-install. progressStore
    // surfaces this as `op.result.cancelled === true` (no error). Return
    // them to the form so they can retry without seeing a generic failure.
    if (op.result?.cancelled) {
      stage.value = 'install-form'
      installingId.value = null
      // Allow re-entry on a future install attempt.
      hasFinalized.value = false
      return
    }

    if (op.error) {
      // Install failed — surface the error, return to form so user can retry.
      formError.value = op.error
      stage.value = 'install-form'
      installingId.value = null
      hasFinalized.value = false
      return
    }
    // Show the success ack, then launch ComfyUI in the same window so the
    // user has a continuous experience. We call runAction directly (not via
    // useListAction) because executeAction's `showProgress` branch is
    // fire-and-forget — it returns before the launch completes. runAction
    // awaits until launch.ts's inline `_onLaunch` callback creates the new
    // ComfyUI window. Only then do we hide the launcher.
    //
    // Note: `onboardingPrefs.complete('manual')` is intentionally NOT called
    // here — it's already been persisted at install kickoff in `startInstall`,
    // so a renderer death between install-completion and launch can't strand
    // the user back at onboarding next boot.
    stage.value = 'done'
    const id = installingId.value
    void (async () => {
      try {
        await onboardingPrefs.setLastUsedMode('local')
      } catch (err) {
        // Non-blocking: lastUsedMode is just a default-restore preference. The
        // user can still proceed; surface via telemetry only.
        emitTelemetryAction('onboarding.setLastUsedMode.failed', {
          message: (err as Error)?.message,
        })
      }
      if (!id) {
        emit('complete')
        return
      }
      try {
        await window.api.setSetting('primaryInstallId', id)
      } catch (err) {
        // Idempotent best-effort: primaryInstallId is a "remember last" hint,
        // not load-bearing. The launch path below is what matters.
        emitTelemetryAction('onboarding.setPrimaryInstallId.failed', {
          message: (err as Error)?.message,
        })
      }
      try {
        await installationStore.fetchInstallations()
      } catch (err) {
        emitTelemetryAction('onboarding.fetchInstallations.failed', {
          message: (err as Error)?.message,
        })
      }
      // Done state stays visible for the duration of the launch — the user
      // sees "Your studio is ready / Opening ComfyUI…" until the new window
      // actually appears. We use the §8 retry pattern so a hung or failing
      // launch surfaces an actual error rather than a silent hang.
      const launchOk = await launchWithTimeout(id, TIMEOUT_LOCAL_LAUNCH_MS)
      if (launchOk) {
        try {
          await window.api.hideLauncherWindow()
          emit('complete')
        } catch (err) {
          // Launcher hide failed — user can still see the launcher window
          // but ComfyUI did open. Surface as a non-fatal warning via the
          // done-state retry block so the user has a manual escape.
          retryError.value = (err as Error)?.message || t('onboarding.openComfyUiErrorSubtitle')
        }
      }
      // If launchOk is false, retryError is already populated by
      // launchWithTimeout — the done state will render the §8 error block
      // and "Try again" button. No further action needed here.
    })()
  },
)

onMounted(async () => {
  await installationStore.fetchInstallations()
})

// Cleanup on unmount — if the user closes the launcher mid-install or
// mid-cloud-connect, neither timer should keep firing in the detached state.
onUnmounted(() => {
  stopElapsedTimer()
  clearCloudTimeout()
})

const desktopOnlyInstall = computed(() => {
  const locals = installationStore.installations.filter((i) => i.sourceCategory === 'local')
  if (locals.length !== 1) return null
  const only = locals[0]!
  return only.sourceId === 'desktop' ? only : null
})

const cloudInstall = computed(() =>
  installationStore.installations.find((i) => i.sourceCategory === 'cloud') ?? null,
)

const canContinue = computed(() => onboardingPrefs.eulaAccepted.value)
const canSubmitForm = computed(
  () => !!selectedRelease.value && !!installPath.value && !busy.value && !formLoading.value,
)

// --- Section A handlers (consent — §9.1) ---
// Per-checkbox error refs. Bound to inline helper text below each row so a
// failed setSetting reverts the checkbox AND shows the user why.
const telemetryError = ref<string | null>(null)
const eulaError = ref<string | null>(null)
const eulaLinkError = ref<string | null>(null)
let eulaLinkErrorTimer: ReturnType<typeof setTimeout> | null = null

async function onTelemetryToggle(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement
  const checked = target.checked
  const previous = onboardingPrefs.telemetryEnabled.value
  telemetryError.value = null
  try {
    await withTimeoutOrThrow(onboardingPrefs.setTelemetry(checked), TIMEOUT_SET_SETTING_MS, 'timeout')
    emitTelemetryAction('onboarding.telemetry.toggled', { enabled: checked })
  } catch (err) {
    // Revert visually + state-wise.
    onboardingPrefs.telemetryEnabled.value = previous
    target.checked = previous
    telemetryError.value = t('onboarding.telemetrySaveError')
    emitTelemetryAction('onboarding.telemetry.persist_failed', {
      message: (err as Error)?.message,
    })
  }
}

async function onEulaToggle(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement
  const checked = target.checked
  const previous = onboardingPrefs.eulaAccepted.value
  eulaError.value = null
  try {
    await withTimeoutOrThrow(onboardingPrefs.setEulaAccepted(checked), TIMEOUT_SET_SETTING_MS, 'timeout')
    if (checked) emitTelemetryAction('onboarding.eula.accepted')
  } catch (err) {
    // Revert — canContinue is bound to eulaAccepted so this re-gates Continue.
    onboardingPrefs.eulaAccepted.value = previous
    target.checked = previous
    eulaError.value = t('onboarding.eulaSaveError')
    emitTelemetryAction('onboarding.eula.persist_failed', {
      message: (err as Error)?.message,
    })
  }
}

async function openEula(): Promise<void> {
  emitTelemetryAction('onboarding.eula.viewed')
  if (eulaLinkErrorTimer) {
    clearTimeout(eulaLinkErrorTimer)
    eulaLinkErrorTimer = null
  }
  try {
    // openExternal returns void on most paths — we treat any thrown error as a
    // failure and surface it. The 2s timeout is a soft signal (the OS may take
    // a moment to dispatch); we don't reject on timeout, just log and assume
    // the OS got it.
    const result = window.api.openExternal(EULA_URL) as unknown
    if (result instanceof Promise) {
      await withTimeout(result, TIMEOUT_OPEN_EXTERNAL_MS, undefined)
    }
    eulaLinkError.value = null
  } catch (err) {
    eulaLinkError.value = t('onboarding.eulaLinkError')
    emitTelemetryAction('onboarding.eula.openExternal_failed', {
      message: (err as Error)?.message,
    })
    // Auto-clear the error after 5s so the user can retry without a stale
    // message persisting.
    eulaLinkErrorTimer = setTimeout(() => {
      eulaLinkError.value = null
      eulaLinkErrorTimer = null
    }, 5_000)
  }
}

function onContinue(): void {
  if (!canContinue.value) return
  emitTelemetryAction('onboarding.continue.clicked')
  stage.value = 'mode'
}

// --- Section B (mode picker) ---
// Cloud opens in a managed Electron window (the existing remote-launch path).
// We bypass `useListAction.executeAction` so the ProgressModal popup never
// shows — onboarding owns the screen during the 1-15s `waitForUrl` poll, then
// the Electron window renders cloud.comfy.org and onboarding closes.
//
// `connecting-cloud` previously had no timeout and no Back affordance — if
// the launch hung the user was stuck. We now show a "Still connecting…" hint
// + Back button after CLOUD_TIMEOUT_MS so they can retry from the picker.
const CLOUD_TIMEOUT_MS = 30_000
const cloudTimeoutFired = ref(false)
let cloudTimeoutHandle: ReturnType<typeof setTimeout> | null = null

function clearCloudTimeout(): void {
  if (cloudTimeoutHandle) {
    clearTimeout(cloudTimeoutHandle)
    cloudTimeoutHandle = null
  }
}

// §9.2: card-level loading state refs. Set synchronously on click so the
// card paints "Connecting…" / "Opening…" within 200ms of pointerdown.
const cloudCardLoading = ref(false)
const localCardLoading = ref(false)
// Cancel-warning banner if `cancelLaunch` failed during back-from-cloud-connect.
const cancelWarning = ref<string | null>(null)

async function backFromCloudConnect(): Promise<void> {
  // Per §9.6: await cancelLaunch with a 3s timeout. On failure, surface a
  // helper next to the button and force-route to mode regardless — the user
  // must always escape, even if cancel didn't clean up cleanly.
  const TIMEOUT_SENTINEL = '__cancel_timeout__' as const
  cancelWarning.value = null
  try {
    // cancelLaunch resolves with void; coerce to undefined so the sentinel
    // union is well-typed. Same pattern used in cancelInstall().
    const result = await withTimeout<undefined | typeof TIMEOUT_SENTINEL>(
      window.api.cancelLaunch().then(() => undefined),
      TIMEOUT_CANCEL_LAUNCH_MS,
      TIMEOUT_SENTINEL,
    )
    if (result === TIMEOUT_SENTINEL) {
      // Timed out — set warning, but still bail out to mode.
      cancelWarning.value = t('onboarding.cancelInstallFailed')
      emitTelemetryAction('onboarding.cloud.cancel_timeout')
    }
  } catch (err) {
    cancelWarning.value = (err as Error)?.message || t('onboarding.cancelInstallFailed')
    emitTelemetryAction('onboarding.cloud.cancel_failed', {
      message: (err as Error)?.message,
    })
  }
  clearCloudTimeout()
  cloudTimeoutFired.value = false
  busy.value = false
  stage.value = 'mode'
}

async function pickCloud(): Promise<void> {
  if (busy.value) return
  const inst = cloudInstall.value
  if (!inst) {
    // Cloud entry should always be seeded; bail gracefully if not.
    try {
      await onboardingPrefs.complete('manual')
    } catch (err) {
      // Non-blocking: completion flag is best-effort here. Worst case the
      // user sees onboarding again on next boot — annoying, not broken.
      emitTelemetryAction('onboarding.complete.failed', {
        message: (err as Error)?.message,
      })
    }
    emit('complete')
    return
  }
  busy.value = true
  // Paint card-loading state synchronously so the user sees "Connecting…"
  // within 200ms of pointerdown — independent of the IPC duration.
  cloudCardLoading.value = true
  cloudError.value = ''
  cloudTimeoutFired.value = false
  // Hold on the mode screen for CARD_LOADING_PAINT_MS so the loading state
  // visibly registers before the screen flips. Without this, fast IPCs
  // make the card-loading state effectively invisible.
  await new Promise((r) => setTimeout(r, CARD_LOADING_PAINT_MS))
  stage.value = 'connecting-cloud'
  clearCloudTimeout()
  cloudTimeoutHandle = setTimeout(() => {
    cloudTimeoutFired.value = true
  }, CLOUD_TIMEOUT_MS)

  // setSetting is non-blocking for cloud connect — primaryInstallId is just a
  // default-restore preference. Surface failure via telemetry but don't gate.
  try {
    await withTimeout(
      window.api.setSetting('primaryInstallId', inst.id),
      TIMEOUT_SET_SETTING_MS,
      undefined,
    )
  } catch (err) {
    emitTelemetryAction('onboarding.setPrimaryInstallId.failed', {
      message: (err as Error)?.message,
    })
  }

  emitTelemetryAction('onboarding.cloud.connecting')
  try {
    type Result = { ok?: boolean; message?: string; cancelled?: boolean; __timeout?: true }
    const timeoutMarker: Result = { ok: false, message: t('onboarding.cloudConnectingTimeout'), __timeout: true }
    let result: Result
    try {
      result = await withTimeout<Result>(
        window.api.runAction(inst.id, 'launch') as Promise<Result>,
        TIMEOUT_CLOUD_LAUNCH_MS,
        timeoutMarker,
      )
    } catch (err) {
      // §9.2 fix: surface the verbatim thrown message instead of generic.
      cloudError.value = (err as Error)?.message || t('onboarding.cloudConnectError')
      emitTelemetryAction('onboarding.cloud.failed', {
        message: (err as Error)?.message,
      })
      stage.value = 'mode'
      return
    }

    if (!result?.ok) {
      // Surface verbatim message from the IPC ("Another operation is already
      // running for this installation" etc.) — not a generic fallback first.
      cloudError.value = result?.message || t('onboarding.cloudConnectError')
      emitTelemetryAction('onboarding.cloud.failed')
      stage.value = 'mode'
      return
    }

    // Cloud launch succeeded — clear any prior error banner.
    cloudError.value = ''
    // Show the success ack briefly so the user sees a clear handoff, then
    // focus the cloud window and hide the launcher chrome.
    stage.value = 'done'
    try {
      await onboardingPrefs.setLastUsedMode('cloud')
    } catch (err) {
      emitTelemetryAction('onboarding.setLastUsedMode.failed', {
        message: (err as Error)?.message,
      })
    }
    try {
      await onboardingPrefs.complete('manual')
    } catch (err) {
      emitTelemetryAction('onboarding.complete.failed', {
        message: (err as Error)?.message,
      })
    }
    await new Promise((r) => setTimeout(r, 1200))
    try {
      window.api.focusComfyWindow(inst.id)
    } catch (err) {
      emitTelemetryAction('onboarding.focusComfyWindow.failed', {
        message: (err as Error)?.message,
      })
    }
    try {
      await withTimeout(window.api.hideLauncherWindow(), 3_000, undefined)
      emit('complete')
    } catch (err) {
      // Cloud launched but launcher didn't hide. Surface via the §8 retry
      // block — user has a manual escape ("Try again" → which will hit the
      // already-running gate, or "Quit ComfyUI Desktop").
      retryError.value = (err as Error)?.message || t('onboarding.openComfyUiErrorSubtitle')
    }
  } finally {
    clearCloudTimeout()
    cloudTimeoutFired.value = false
    busy.value = false
    cloudCardLoading.value = false
  }
}

async function pickLocal(): Promise<void> {
  if (busy.value) return
  cloudError.value = ''
  // Returning users with an installed local instance should land in it
  // directly — no install form, no extra screen.
  const installed = installationStore.installations.find(
    (i) => i.sourceCategory === 'local' && i.status === 'installed' && i.sourceId !== 'desktop',
  )
  if (installed) {
    busy.value = true
    localCardLoading.value = true
    // Same 400ms paint shim as pickCloud — let the card render its loading
    // state before we flip to the done screen.
    await new Promise((r) => setTimeout(r, CARD_LOADING_PAINT_MS))
    try {
      try {
        await onboardingPrefs.setLastUsedMode('local')
      } catch (err) {
        emitTelemetryAction('onboarding.setLastUsedMode.failed', {
          message: (err as Error)?.message,
        })
      }
      try {
        await withTimeout(
          window.api.setSetting('primaryInstallId', installed.id),
          TIMEOUT_SET_SETTING_MS,
          undefined,
        )
      } catch (err) {
        emitTelemetryAction('onboarding.setPrimaryInstallId.failed', {
          message: (err as Error)?.message,
        })
      }
      if (!onboardingPrefs.completed.value) {
        try {
          await onboardingPrefs.complete('manual')
        } catch (err) {
          emitTelemetryAction('onboarding.complete.failed', {
            message: (err as Error)?.message,
          })
        }
      }
      stage.value = 'done'
      // §9.2 fix: §8 retry pattern — Promise.race(15s) + verbatim error.
      // No more silent swallow.
      const ok = await launchWithTimeout(installed.id, TIMEOUT_LOCAL_LAUNCH_MS)
      if (ok) {
        try {
          await withTimeout(window.api.hideLauncherWindow(), 3_000, undefined)
          emit('complete')
        } catch (err) {
          retryError.value = (err as Error)?.message || t('onboarding.openComfyUiErrorSubtitle')
        }
      }
      // On failure, retryError is set by launchWithTimeout — done state will
      // render the §8 error block with "Try again" + "Quit ComfyUI Desktop".
    } finally {
      busy.value = false
      localCardLoading.value = false
    }
    return
  }
  // No installed local — fork (if legacy) or go straight to the install form.
  if (desktopOnlyInstall.value) {
    stage.value = 'local-fork'
  } else {
    void enterInstallForm()
  }
}

// --- Section C (local fork — §9.3) ---
// Card-level loading flags so the user sees response within 200ms of click,
// even if the migrate-confirm modal takes time to open or the preflight chain
// is slow.
const migrateCardLoading = ref(false)
const freshCardLoading = ref(false)
const forkError = ref<string | null>(null)

async function pickMigrate(): Promise<void> {
  if (busy.value) return
  const inst = desktopOnlyInstall.value
  if (!inst) return
  busy.value = true
  migrateCardLoading.value = true
  forkError.value = null
  try {
    let result: Awaited<ReturnType<typeof confirmMigration>>
    try {
      result = await confirmMigration(inst)
    } catch (err) {
      // §9.3 fix: confirmMigration throwing today goes unhandled. Surface
      // verbatim into the card-level error footer.
      forkError.value = (err as Error)?.message || t('onboarding.migrationFailed')
      return
    }
    if (!result) return
    try {
      await onboardingPrefs.complete('migrate')
    } catch (err) {
      // Non-blocking — the migrate flow can still proceed. Failure means the
      // onboarding flag may not flip; surface via telemetry.
      emitTelemetryAction('onboarding.complete.failed', {
        message: (err as Error)?.message,
      })
    }
    emit('show-progress', {
      installationId: inst.id,
      title: `${t('desktop.migrating')} — ${inst.name}`,
      apiCall: () => window.api.runAction(inst.id, 'migrate-to-standalone', result),
      cancellable: true,
    })
    emit('complete')
  } finally {
    busy.value = false
    migrateCardLoading.value = false
  }
}

async function pickStartFresh(): Promise<void> {
  if (busy.value) return
  freshCardLoading.value = true
  // Render the loading state for at least CARD_LOADING_PAINT_MS so the user
  // sees "Detecting hardware…" before the screen flips. enterInstallForm sets
  // its own formLoading, but the card-loading paint gives an earlier signal.
  await new Promise((r) => setTimeout(r, CARD_LOADING_PAINT_MS))
  try {
    await enterInstallForm()
  } finally {
    freshCardLoading.value = false
  }
}

// --- Section D (install form — §9.4) ---
// Loading flags for the browse button and install-button submit chain. Set
// synchronously so the button paints its loading state within 200ms of click.
const browseLoading = ref(false)
const installSubmitting = ref(false)
// Hint shown when getDefaultInstallDir failed: instead of a silent empty path,
// tell the user to pick one. Non-blocking — user can still browse.
const noDefaultPathHint = ref<string | null>(null)
// Hint shown when detectGPU returned null (GPU detection failure). The form
// still works without GPU input; this just surfaces that we couldn't detect.
const gpuDetectionFailed = ref(false)

async function enterInstallForm(): Promise<void> {
  stage.value = 'install-form'
  formLoading.value = true
  formError.value = ''
  noDefaultPathHint.value = null
  gpuDetectionFailed.value = false
  try {
    // Track each failure independently so we know which one to surface.
    let pathFailed = false
    let gpuFailed = false
    type PreflightResult = {
      path: string
      releases: FieldOption[]
      gpu: { label?: string } | null
      hw: { supported: boolean; error?: string }
      __timeout?: true
    }
    const TIMEOUT_SENTINEL: PreflightResult = {
      path: '',
      releases: [],
      gpu: null,
      hw: { supported: true },
      __timeout: true,
    }
    const preflight = withTimeout<PreflightResult>(
      Promise.all([
        window.api.getDefaultInstallDir().catch(() => {
          pathFailed = true
          return ''
        }),
        window.api.getFieldOptions('standalone', 'release', {}, { includeLatestStable: true }),
        window.api.detectGPU().catch(() => {
          gpuFailed = true
          return null
        }),
        window.api.validateHardware(),
      ]).then(([path, releases, gpu, hw]) => ({ path, releases, gpu, hw })),
      TIMEOUT_FORM_PREFLIGHT_MS,
      TIMEOUT_SENTINEL,
    )
    const result = await preflight
    if (result.__timeout) {
      formError.value = t('onboarding.preflightTimeout')
      return
    }
    const { path, releases, gpu, hw } = result
    if (!hw.supported) {
      await modal.alert({
        title: t('newInstall.unsupportedHardwareTitle'),
        message: hw.error || '',
      })
      stage.value = desktopOnlyInstall.value ? 'local-fork' : 'mode'
      return
    }
    if (pathFailed) {
      // Non-blocking: surface a hint above the path field so the user knows
      // we couldn't suggest a default and they need to pick one.
      noDefaultPathHint.value = t('onboarding.noDefaultPathHint')
    }
    if (gpuFailed || !gpu) {
      gpuDetectionFailed.value = true
    }
    defaultInstallPath.value = path
    installPath.value = path
    releaseOptions.value = releases
    selectedRelease.value = releases[0] ?? null
    detectedGpuLabel.value = gpu?.label ?? ''
    if (releases.length === 0) {
      formError.value = t('newInstall.noOptions')
    }
  } catch (err) {
    formError.value = (err as Error)?.message || String(err)
  } finally {
    formLoading.value = false
  }
}

async function onBrowsePath(): Promise<void> {
  if (browseLoading.value) return
  browseLoading.value = true
  try {
    const chosen = await window.api.browseFolder(installPath.value)
    if (chosen) installPath.value = chosen
  } catch (err) {
    // §9.4 fix: today line 435 has no error handling. Surface verbatim.
    formError.value = (err as Error)?.message || t('onboarding.browseFailed')
    emitTelemetryAction('onboarding.browseFolder.failed', {
      message: (err as Error)?.message,
    })
  } finally {
    browseLoading.value = false
  }
}

async function startInstall(): Promise<void> {
  if (!canSubmitForm.value || !selectedRelease.value || !installPath.value) return
  busy.value = true
  installSubmitting.value = true
  formError.value = ''
  // Wrap the entire 4-call chain in a Promise.race against a 15s aggregate
  // timeout. On timeout, surface a clear error and reset the button state.
  type ChainResult = { ok: true } | { ok: false; message: string } | { __timeout: true }
  const run = async (): Promise<ChainResult> => {
    try {
      // Pick the recommended variant for the chosen release silently.
      const variants = await window.api.getFieldOptions('standalone', 'variant', {
        release: JSON.parse(JSON.stringify(toRaw(selectedRelease.value!))) as FieldOption,
      })
      const variant = variants.find((v) => v.recommended) ?? variants[0]
      if (!variant) {
        return { ok: false, message: t('newInstall.noOptions') }
      }

      const instData = await window.api.buildInstallation('standalone', {
        release: JSON.parse(JSON.stringify(toRaw(selectedRelease.value!))) as FieldOption,
        variant: JSON.parse(JSON.stringify(toRaw(variant))) as FieldOption,
      })

      const name = await window.api.getUniqueName('ComfyUI')
      const result = await window.api.addInstallation({
        name,
        installPath: installPath.value,
        ...instData,
      })
      if (!result.ok || !result.entry) {
        // Surface verbatim message (per §9.4 — render result.message verbatim,
        // not a generic fallback first).
        return { ok: false, message: result.message || t('errors.cannotAdd') }
      }

      emitTelemetryAction('onboarding.install.started', {
        release: selectedRelease.value!.value,
        variant: variant.value,
      })

      // Persist `onboardingCompleted=true` BEFORE kicking off the install.
      // If the renderer dies mid-install (cmd+Q, crash) the install still
      // completes at the backend, but if we waited until post-launch to flip
      // the flag, the user would land back at onboarding next boot.
      if (!onboardingPrefs.completed.value) {
        try {
          await onboardingPrefs.complete('manual')
        } catch (err) {
          // Non-blocking: install can still proceed; surface via telemetry.
          emitTelemetryAction('onboarding.complete.failed', {
            message: (err as Error)?.message,
          })
        }
      }

      hasFinalized.value = false

      // Switch to the inline progress view and start the operation directly
      // via the progress store. We wrap startOperation in a try/catch — if it
      // throws synchronously, revert to the form so the user isn't stuck on
      // an installing screen with no actual operation.
      installingId.value = result.entry.id
      installingName.value = name
      installStartedAt.value = Date.now()
      elapsedSeconds.value = 0
      startElapsedTimer()
      stage.value = 'installing'
      try {
        progressStore.startOperation({
          installationId: result.entry.id,
          title: `${t('newInstall.installing')} — ${name}`,
          apiCall: () => window.api.installInstance(result.entry!.id),
        })
      } catch (err) {
        // §9.4 fix: revert and surface. The user is on `installing` stage
        // with no operation if we don't.
        stopElapsedTimer()
        installingId.value = null
        stage.value = 'install-form'
        return { ok: false, message: (err as Error)?.message || t('onboarding.installCantStart') }
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, message: (err as Error)?.message || String(err) }
    }
  }

  const TIMEOUT_SENTINEL: ChainResult = { __timeout: true }
  try {
    const result = await withTimeout<ChainResult>(run(), TIMEOUT_INSTALL_SETUP_MS, TIMEOUT_SENTINEL)
    if ('__timeout' in result && result.__timeout) {
      formError.value = t('onboarding.installSetupTimeout')
      return
    }
    if ('ok' in result && !result.ok) {
      formError.value = result.message
    }
  } finally {
    busy.value = false
    installSubmitting.value = false
  }
}

// --- Section H (installing — §9.5) ---
// Stall detection: if flatStatus + flatPercent haven't changed in 30s, we
// surface a warning strip + reveal the Cancel button. The progress bar stops
// estimating forward when stalled (don't lie about progress).
const INSTALL_STALL_THRESHOLD_MS = 30_000
const lastProgressAt = ref(Date.now())
const lastFlatPercent = ref(0)
const lastFlatStatus = ref('')
const isStalled = ref(false)
const cancelInProgress = ref(false)
const cancelError = ref<string | null>(null)

// Watch the upstream progress events. When either flatPercent or flatStatus
// changes, mark progress as fresh.
watch(
  () => [installOp.value?.flatPercent, installOp.value?.flatStatus] as const,
  ([percent, status]) => {
    if (typeof percent === 'number' && percent !== lastFlatPercent.value) {
      lastFlatPercent.value = percent
      lastProgressAt.value = Date.now()
      isStalled.value = false
    }
    if (typeof status === 'string' && status !== lastFlatStatus.value) {
      lastFlatStatus.value = status
      lastProgressAt.value = Date.now()
      isStalled.value = false
    }
  },
)

// Tick the stall flag from the elapsed timer. Cheap — runs once a second.
function checkInstallStall(): void {
  if (stage.value !== 'installing') return
  if (Date.now() - lastProgressAt.value > INSTALL_STALL_THRESHOLD_MS) {
    isStalled.value = true
  }
}

// Cancel control. Shown unless install is in finalize phase (>= 95%).
const cancelDisabled = computed(() => installPercent.value >= 95)

async function cancelInstall(): Promise<void> {
  if (cancelInProgress.value) return
  if (cancelDisabled.value) return
  cancelError.value = null
  // Confirm via modal so the user understands downloaded files will be removed.
  let confirmed: boolean
  try {
    confirmed = await modal.confirm({
      title: t('onboarding.cancelInstallConfirmTitle'),
      message: t('onboarding.cancelInstallConfirmMessage'),
      confirmLabel: t('onboarding.cancelInstall'),
      confirmStyle: 'danger',
    })
  } catch (err) {
    cancelError.value = (err as Error)?.message || t('onboarding.cancelInstallFailed')
    return
  }
  if (!confirmed) return

  cancelInProgress.value = true
  try {
    const TIMEOUT_SENTINEL = '__cancel_timeout__' as const
    // cancelLaunch() resolves with void; we coerce to undefined so the
    // sentinel union (undefined | typeof TIMEOUT_SENTINEL) is well-typed.
    const result = await withTimeout<undefined | typeof TIMEOUT_SENTINEL>(
      window.api.cancelLaunch().then(() => undefined),
      TIMEOUT_CANCEL_LAUNCH_MS,
      TIMEOUT_SENTINEL,
    )
    if (result === TIMEOUT_SENTINEL) {
      // 3s timeout — assume cancel may have failed but force-route anyway so
      // the user has an escape. The watch on installOp.finished will route
      // them back to install-form when the cancel actually completes.
      cancelError.value = t('onboarding.cancelInstallFailed')
      emitTelemetryAction('onboarding.cancel.timeout')
    }
  } catch (err) {
    cancelError.value = (err as Error)?.message || t('onboarding.cancelInstallFailed')
    emitTelemetryAction('onboarding.cancel.failed', {
      message: (err as Error)?.message,
    })
  } finally {
    cancelInProgress.value = false
  }
}

// Structured status parsing: split on `·` (the backend status format) and map
// to phase title / detail / speed-elapsed-eta. Falls back to raw if parsing
// fails — never crashes the layout.
interface StructuredStatus {
  title: string
  detail: string
  meta: string
}

const structuredStatus = computed<StructuredStatus>(() => {
  const raw = installStatus.value
  if (!raw) return { title: '', detail: '', meta: '' }
  // Backend phase prefixes are stable: 'download', 'extract', 'setup'. Map to
  // human copy. If the status doesn't start with one of those, fall back to
  // showing the whole string in the detail line.
  const parts = raw.split('·').map((s) => s.trim()).filter(Boolean)
  if (parts.length === 0) {
    return { title: '', detail: raw, meta: '' }
  }
  // Heuristic: try to detect the phase prefix from the first chunk.
  const firstChunk = parts[0] || ''
  const firstLower = firstChunk.toLowerCase()
  let title: string
  let detail: string
  if (firstLower.startsWith('download')) {
    title = 'Downloading runtime'
    detail = parts[1] || firstChunk
  } else if (firstLower.startsWith('extract')) {
    title = 'Extracting files'
    detail = parts[1] || firstChunk
  } else if (firstLower.startsWith('setup') || firstLower.startsWith('install')) {
    title = 'Installing dependencies'
    detail = parts[1] || firstChunk
  } else {
    // Unknown phase prefix — show the whole first chunk as detail with no title.
    title = ''
    detail = firstChunk
  }
  const meta = parts.slice(2).join(' · ')
  return { title, detail, meta }
})

// --- Helpers ---
function startElapsedTimer(): void {
  stopElapsedTimer()
  // Reset stall tracking each time we start a new install so a prior stalled
  // session doesn't bleed into the new one.
  lastProgressAt.value = Date.now()
  lastFlatPercent.value = 0
  lastFlatStatus.value = ''
  isStalled.value = false
  elapsedTimer = setInterval(() => {
    elapsedSeconds.value = Math.floor((Date.now() - installStartedAt.value) / 1000)
    checkInstallStall()
  }, 1000)
}

function stopElapsedTimer(): void {
  if (elapsedTimer) {
    clearInterval(elapsedTimer)
    elapsedTimer = null
  }
}

function formatElapsed(s: number): string {
  const mm = Math.floor(s / 60).toString().padStart(2, '0')
  const ss = (s % 60).toString().padStart(2, '0')
  return `${mm}:${ss}`
}

// Direction tracks forward vs backward stage transitions so the slide animation
// can mirror direction (forward slides up, backward slides down). Set by
// goBack() and any other backwards-moving handler.
const transitionDirection = ref<'forward' | 'backward'>('forward')

function goBack(): void {
  if (busy.value) return
  transitionDirection.value = 'backward'
  switch (stage.value) {
    case 'mode':
      stage.value = 'consent'
      break
    case 'local-fork':
      stage.value = 'mode'
      break
    case 'install-form':
      stage.value = desktopOnlyInstall.value ? 'local-fork' : 'mode'
      break
    // 'consent' has no back; 'installing' is non-cancellable from the back link.
  }
}

// --- Section E: install-form helpers ---
// "Reset to default" affordance. Surfaced when the user has changed installPath
// from the auto-detected default. No new IPC — just snaps the input back.
const isInstallPathCustom = computed(
  () => !!defaultInstallPath.value && installPath.value !== defaultInstallPath.value,
)

function resetInstallPath(): void {
  if (busy.value) return
  installPath.value = defaultInstallPath.value
}

// --- Section F: connecting-cloud visual checklist (§9.6) ---
// Wired to elapsed-time gates rather than a fixed 3s timer. We don't have a
// real backend signal for which step we're actually on, so this is partially
// aspirational — but freezing on timeout (per spec) avoids the lie of
// "Workspace step lit while we know nothing's actually happening."
//
// Gates (per §9.6 designer guess):
//   0–8s    → step 0 (Authenticating session) active
//   8–18s   → step 1 (Reserving compute) active
//   18s+    → step 2 (Opening workspace) active — ONLY if !cloudTimeoutFired
//
// On timeout (cloudTimeoutFired=true), the active step is frozen at step 1
// (no auto-advance). The active marker also recolors to warning per §6 polish.
const CLOUD_CHECKS = ['cloudCheckAuth', 'cloudCheckCompute', 'cloudCheckWorkspace'] as const
const CLOUD_CHECK_STEP1_GATE_MS = 8_000
const CLOUD_CHECK_STEP2_GATE_MS = 18_000
const cloudConnectStartedAt = ref(0)
const cloudConnectElapsed = ref(0)
let cloudConnectTimer: ReturnType<typeof setInterval> | null = null

const cloudCheckIndex = computed<number>(() => {
  const elapsed = cloudConnectElapsed.value
  if (elapsed < CLOUD_CHECK_STEP1_GATE_MS) return 0
  if (elapsed < CLOUD_CHECK_STEP2_GATE_MS) return 1
  // Past the third gate: only advance if we haven't timed out — freezing
  // avoids lying about progress when the backend has gone silent.
  if (cloudTimeoutFired.value) return 1
  return 2
})

function startCloudCheckCycle(): void {
  stopCloudCheckCycle()
  cloudConnectStartedAt.value = Date.now()
  cloudConnectElapsed.value = 0
  cloudConnectTimer = setInterval(() => {
    cloudConnectElapsed.value = Date.now() - cloudConnectStartedAt.value
  }, 500)
}

function stopCloudCheckCycle(): void {
  if (cloudConnectTimer) {
    clearInterval(cloudConnectTimer)
    cloudConnectTimer = null
  }
}

interface CloudCheck {
  key: (typeof CLOUD_CHECKS)[number]
  state: 'pending' | 'active' | 'done'
}
const cloudChecks = computed<CloudCheck[]>(() =>
  CLOUD_CHECKS.map((key, i) => ({
    key,
    state: i < cloudCheckIndex.value ? 'done' : i === cloudCheckIndex.value ? 'active' : 'pending',
  })),
)

// --- Section G: done-state recovery v2 (§8) ---
// View-local timers for the done screen. The button-reveal threshold is purely
// view-state (when to show "Open ComfyUI" the first time); the retry timeout is
// independent (per spec — different concern, different ref).
const DONE_STUCK_THRESHOLD_S = 15
const doneEnteredAt = ref(0)
const doneElapsedSeconds = ref(0)
let doneTimer: ReturnType<typeof setInterval> | null = null
// `doneStuck` controls whether the "Open ComfyUI" button is rendered at all.
// It does NOT govern subtitle copy escalation — that's driven by retry state.
const doneStuck = computed(() => doneElapsedSeconds.value >= DONE_STUCK_THRESHOLD_S)

// §8 retry state. `retrying` is a UI gate that paints synchronously on click
// (before await) so the button shows its loading state within 200ms even if
// the IPC takes ~1s to return. `retryError` is the verbatim message from the
// IPC (or a friendly fallback) — surfaced in the inline error block.
const retrying = ref(false)
const retryError = ref<string | null>(null)
// `retryAttempted` flips true after the FIRST explicit user retry click. Used
// to gate the "Quit ComfyUI Desktop" affordance per §8 ("only renders when
// `retryError !== null`" — but more precisely: only after the user has
// explicitly retried at least once and seen a failure).
const retryAttempted = ref(false)

function startDoneTimer(): void {
  stopDoneTimer()
  doneEnteredAt.value = Date.now()
  doneElapsedSeconds.value = 0
  retryError.value = null
  retrying.value = false
  retryAttempted.value = false
  doneTimer = setInterval(() => {
    doneElapsedSeconds.value = Math.floor((Date.now() - doneEnteredAt.value) / 1000)
  }, 1000)
}

function stopDoneTimer(): void {
  if (doneTimer) {
    clearInterval(doneTimer)
    doneTimer = null
  }
}

// Pick which install id to operate on for retry. Prefer the local install id
// (set during installing flow), fall back to the cloud install id.
function activeLaunchId(): string | null {
  return installingId.value ?? cloudInstall.value?.id ?? null
}

// Subtitle copy per §8 state table.
const doneSubtitleKey = computed(() => {
  if (retryError.value) return 'onboarding.openComfyUiErrorSubtitle'
  if (retrying.value) return 'onboarding.connectingSubtitle'
  if (doneStuck.value) return 'onboarding.doneSubtitleStuckV2'
  return 'onboarding.doneSubtitle'
})

const doneTitleKey = computed(() => {
  if (retryError.value) return 'onboarding.openComfyUiError'
  if (retrying.value) return 'onboarding.connectingTitle'
  return 'onboarding.doneTitle'
})

// Button copy + state per §8 state table.
type DoneButtonState = 'idle' | 'loading' | 'error'
const doneButtonState = computed<DoneButtonState>(() => {
  if (retrying.value) return 'loading'
  if (retryError.value) return 'error'
  return 'idle'
})

const doneButtonLabelKey = computed(() => {
  switch (doneButtonState.value) {
    case 'loading': return 'onboarding.openComfyUiLoading'
    case 'error': return 'onboarding.openComfyUiTryAgain'
    default: return 'onboarding.openComfyUiCta'
  }
})

// Core launch helper — wraps runAction in a Promise.race against the supplied
// timeout, surfaces any failure into `retryError`. Returns true on launch
// success (caller should hideLauncherWindow + emit complete), false otherwise.
//
// Used by both the install-completion auto-launch path AND the §8 retry
// button. Sharing the same code path means every launch surface fails loudly,
// not just the explicit retry.
async function launchWithTimeout(id: string, timeoutMs: number): Promise<boolean> {
  type Result = { ok?: boolean; message?: string; cancelled?: boolean; __timeout?: true }
  const timeoutMarker: Result = { ok: false, message: t('onboarding.openComfyUiTimeout'), __timeout: true }
  let result: Result
  try {
    result = await withTimeout<Result>(
      window.api.runAction(id, 'launch') as Promise<Result>,
      timeoutMs,
      timeoutMarker,
    )
  } catch (err) {
    retryError.value = (err as Error)?.message || t('onboarding.openComfyUiErrorSubtitle')
    return false
  }
  if (result?.ok) {
    retryError.value = null
    return true
  }
  // ok: false (or timeout sentinel) — surface verbatim.
  retryError.value = result?.message || t('onboarding.openComfyUiErrorSubtitle')
  return false
}

// §8 retry handler — called when user clicks "Open ComfyUI" / "Try again".
// Synchronous gate: `retrying.value = true` BEFORE await so the button paints
// its loading state within 200ms, regardless of how long the IPC takes.
async function retryLaunch(): Promise<void> {
  // UI re-entry gate (the IPC also gates server-side via _operationAborts,
  // but the spec says "UI must not rely solely on backend gate").
  if (retrying.value) return
  const id = activeLaunchId()
  if (!id) {
    retryError.value = t('onboarding.openComfyUiNoActiveInstall')
    retryAttempted.value = true
    return
  }
  retrying.value = true
  retryError.value = null
  retryAttempted.value = true
  try {
    const ok = await launchWithTimeout(id, TIMEOUT_DONE_RETRY_MS)
    if (ok) {
      // Success — focus the window and tear down the launcher.
      try {
        window.api.focusComfyWindow(id)
      } catch (err) {
        // focus is best-effort; the runAction success is what matters.
        emitTelemetryAction('onboarding.focusComfyWindow.failed', {
          message: (err as Error)?.message,
        })
      }
      try {
        await withTimeout(window.api.hideLauncherWindow(), 3_000, undefined)
        emit('complete')
      } catch (err) {
        retryError.value = (err as Error)?.message || t('onboarding.openComfyUiErrorSubtitle')
      }
    }
    // Failure path: retryError is already populated by launchWithTimeout.
  } finally {
    retrying.value = false
  }
}

// Quit affordance shown only after a retry has actually failed. Calls quit-app
// IPC directly. Wrapped in error handling so a failing quit doesn't strand the
// user — fall back to hideLauncherWindow if quit fails (last-ditch escape).
async function quitDesktop(): Promise<void> {
  try {
    await withTimeout(window.api.quitApp(), 3_000, undefined)
  } catch (err) {
    // If quit failed (rare), at least hide the launcher chrome so the user
    // isn't stuck on the failure screen.
    emitTelemetryAction('onboarding.quitApp.failed', {
      message: (err as Error)?.message,
    })
    try {
      await window.api.hideLauncherWindow()
    } catch {
      // truly stuck — but this is a last-ditch path. The user can hit OS-level
      // window close; we've done what we can.
    }
  }
}

// Track stage transitions to drive the done timer + cloud checklist + screen
// reader announcements. Watching `stage` keeps lifecycle hooks in one place.
watch(stage, (next, prev) => {
  // Done timer
  if (next === 'done') {
    startDoneTimer()
  } else if (prev === 'done') {
    stopDoneTimer()
  }
  // Cloud checklist
  if (next === 'connecting-cloud') {
    startCloudCheckCycle()
  } else if (prev === 'connecting-cloud') {
    stopCloudCheckCycle()
  }
})

// Screen reader announcement string for the current stage. A live region
// mirrors this so each stage transition reads the new screen title.
const stageAnnouncement = computed(() => {
  switch (stage.value) {
    case 'consent':
      return t('onboarding.welcomeTitle')
    case 'mode':
      return t('onboarding.modeTitle')
    case 'local-fork':
      return t('onboarding.legacyDetectedTitle')
    case 'install-form':
      return t('onboarding.installFormTitle')
    case 'installing':
      return t('onboarding.installingTitle')
    case 'connecting-cloud':
      return t('onboarding.cloudConnectingTitle')
    case 'done':
      return t(doneTitleKey.value)
    default:
      return ''
  }
})

// Reset transition direction back to 'forward' AFTER the back transition has
// kicked in. We use a microtask so the `:name` binding sees 'backward' for the
// frame the screen change happens, then resets for any subsequent forward move.
watch(stage, () => {
  void Promise.resolve().then(() => {
    transitionDirection.value = 'forward'
  })
})

// Cleanup the done + cloud-check timers on unmount in addition to the
// existing elapsed/cloud-timeout cleanups above.
onUnmounted(() => {
  stopDoneTimer()
  stopCloudCheckCycle()
})
</script>

<template>
  <div class="onboarding-view">
    <!-- Live region for screen reader stage announcements. Mirrors the title
         of the current screen so each transition reads aloud the new screen. -->
    <div class="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
      {{ stageAnnouncement }}
    </div>
    <div class="onboarding-container">
      <Transition :name="`onboarding-step-${transitionDirection}`" mode="out-in">

        <!-- =====================================================
             1 / Consent
             ===================================================== -->
        <section v-if="stage === 'consent'" key="consent" class="onboarding-screen">
          <header class="onboarding-screen-header onboarding-consent-header">
            <div class="onboarding-hero-icon" aria-hidden="true">
              <Sparkles :size="24" />
            </div>
            <h1 class="onboarding-title">{{ t('onboarding.welcomeTitle') }}</h1>
            <p class="onboarding-subtitle">{{ t('onboarding.welcomeSubtitle') }}</p>
          </header>

          <div class="onboarding-screen-body onboarding-consent-body">
            <div class="onboarding-consent">
              <!-- EULA first — load-bearing consent goes at the top of the
                   visual hierarchy. -->
              <label class="consent-row">
                <input
                  type="checkbox"
                  class="consent-checkbox"
                  :checked="onboardingPrefs.eulaAccepted.value"
                  @change="onEulaToggle"
                />
                <span class="consent-body">
                  <span class="consent-label">{{ t('onboarding.eulaLabel') }}</span>
                  <span class="consent-hint">{{ t('onboarding.eulaHint') }}</span>
                  <button type="button" class="consent-link" @click.prevent="openEula">
                    {{ t('onboarding.eulaViewLink') }}
                    <ExternalLink :size="12" />
                  </button>
                  <!-- §9.1: persistence-failure helper. Shown only when the
                       setSetting IPC failed; checkbox state has been reverted
                       so the user can retry. -->
                  <span v-if="eulaError" class="consent-error" role="alert">
                    {{ eulaError }}
                  </span>
                  <!-- §9.1: link-failure helper. openExternal returned false
                       or threw — surface the URL so the user can copy it. -->
                  <span v-if="eulaLinkError" class="consent-error" role="alert">
                    {{ eulaLinkError }}
                  </span>
                </span>
              </label>

              <label class="consent-row">
                <input
                  type="checkbox"
                  class="consent-checkbox"
                  :checked="onboardingPrefs.telemetryEnabled.value"
                  @change="onTelemetryToggle"
                />
                <span class="consent-body">
                  <span class="consent-label">{{ t('onboarding.telemetryLabel') }}</span>
                  <span class="consent-hint">{{ t('onboarding.telemetryHint') }}</span>
                  <span v-if="telemetryError" class="consent-error" role="alert">
                    {{ telemetryError }}
                  </span>
                </span>
              </label>
            </div>
          </div>

          <footer class="onboarding-screen-footer">
            <!-- Replaces the title-attribute tooltip with a visible helper.
                 Tooltips are invisible to most users. -->
            <span class="onboarding-helper-text" :class="{ visible: !canContinue }">
              <template v-if="!canContinue">{{ t('onboarding.continueDisabledHint') }}</template>
            </span>
            <button
              class="primary onboarding-primary-btn onboarding-continue-fade"
              :class="{ ready: canContinue }"
              :disabled="!canContinue"
              @click="onContinue"
            >
              {{ t('onboarding.continue') }}
            </button>
          </footer>
        </section>

        <!-- =====================================================
             2 / Mode picker — Cloud vs Local
             ===================================================== -->
        <section v-else-if="stage === 'mode'" key="mode" class="onboarding-screen">
          <header class="onboarding-screen-header">
            <h2 class="onboarding-screen-title">{{ t('onboarding.modeTitle') }}</h2>
            <p class="onboarding-screen-subtitle">{{ t('onboarding.modeSubtitle') }}</p>
          </header>

          <div class="onboarding-screen-body">
            <div class="onboarding-card-row">
              <button
                class="onboarding-card"
                :class="{
                  'onboarding-card-loading': cloudCardLoading,
                  'onboarding-card-dimmed': localCardLoading && !cloudCardLoading,
                }"
                type="button"
                :disabled="busy"
                :aria-busy="cloudCardLoading ? 'true' : 'false'"
                @click="pickCloud"
              >
                <Cloud :size="22" class="onboarding-card-icon" />
                <span class="onboarding-card-title">{{ t('onboarding.cloudCardTitle') }}</span>
                <span class="onboarding-card-desc">{{ t('onboarding.cloudCardDesc') }}</span>
                <!-- CTA swaps to a loading state while the IPC chain is
                     in flight. Per §9.0: gerund + ellipsis copy. -->
                <span class="onboarding-card-cta">
                  <Loader2 v-if="cloudCardLoading" :size="14" class="spin" />
                  <template v-else>→</template>
                  {{ cloudCardLoading ? t('onboarding.connectingCloudCard') : t('onboarding.cloudCardCta') }}
                </span>
                <!-- Inline error attached to the failing card only — replaces
                     the wide red banner above the row. -->
                <span v-if="cloudError" class="onboarding-card-error" role="alert">
                  <RotateCw :size="12" />
                  {{ cloudError }}
                </span>
              </button>
              <button
                class="onboarding-card onboarding-card-recommended"
                :class="{
                  'onboarding-card-loading': localCardLoading,
                  'onboarding-card-dimmed': cloudCardLoading && !localCardLoading,
                }"
                type="button"
                :disabled="busy"
                :aria-busy="localCardLoading ? 'true' : 'false'"
                @click="pickLocal"
              >
                <span class="onboarding-card-badge">{{ t('onboarding.recommendedBadge') }}</span>
                <HardDrive :size="22" class="onboarding-card-icon" />
                <span class="onboarding-card-title">{{ t('onboarding.localCardTitle') }}</span>
                <span class="onboarding-card-desc">{{ t('onboarding.localCardDesc') }}</span>
                <span class="onboarding-card-cta">
                  <Loader2 v-if="localCardLoading" :size="14" class="spin" />
                  <template v-else>→</template>
                  {{ localCardLoading ? t('onboarding.openingComfyUiCard') : t('onboarding.localCardCta') }}
                </span>
              </button>
            </div>
          </div>

          <footer class="onboarding-screen-footer">
            <button
              type="button"
              class="onboarding-back-btn"
              :disabled="busy"
              @click="goBack"
            >
              ← {{ t('onboarding.back') }}
            </button>
            <span /><!-- no primary; cards are primary actions -->
          </footer>
        </section>

        <!-- =====================================================
             3 / Local fork — Migrate vs Fresh (only when legacy detected)
             ===================================================== -->
        <section v-else-if="stage === 'local-fork'" key="local-fork" class="onboarding-screen">
          <header class="onboarding-screen-header">
            <h2 class="onboarding-screen-title">{{ t('onboarding.legacyDetectedTitle') }}</h2>
            <p class="onboarding-screen-subtitle">{{ t('onboarding.localForkSubtitle') }}</p>
          </header>

          <div class="onboarding-screen-body">
            <div class="onboarding-card-row">
              <button
                class="onboarding-card onboarding-card-recommended"
                type="button"
                :disabled="busy"
                @click="pickMigrate"
              >
                <span class="onboarding-card-badge">{{ t('onboarding.recommendedBadge') }}</span>
                <Import :size="22" class="onboarding-card-icon" />
                <span class="onboarding-card-title">{{ t('onboarding.migrateCardTitle') }}</span>
                <span class="onboarding-card-desc">{{ t('onboarding.migrateCardDesc') }}</span>
                <span class="onboarding-card-subdesc">{{ t('onboarding.migrateCardSubdesc') }}</span>
                <span class="onboarding-card-cta">→ {{ t('onboarding.migrateCardCta') }}</span>
              </button>
              <button
                class="onboarding-card"
                type="button"
                :disabled="busy"
                @click="pickStartFresh"
              >
                <Download :size="22" class="onboarding-card-icon" />
                <span class="onboarding-card-title">{{ t('onboarding.startFreshCardTitle') }}</span>
                <span class="onboarding-card-desc">{{ t('onboarding.startFreshCardDesc') }}</span>
                <span class="onboarding-card-subdesc">{{ t('onboarding.startFreshSubdesc') }}</span>
                <span class="onboarding-card-cta">→ {{ t('onboarding.startFreshCardCta') }}</span>
              </button>
            </div>
          </div>

          <footer class="onboarding-screen-footer">
            <button
              type="button"
              class="onboarding-back-btn"
              :disabled="busy"
              @click="goBack"
            >
              ← {{ t('onboarding.back') }}
            </button>
            <span />
          </footer>
        </section>

        <!-- =====================================================
             4 / Install form — path + version
             ===================================================== -->
        <section v-else-if="stage === 'install-form'" key="install-form" class="onboarding-screen">
          <header class="onboarding-screen-header">
            <h2 class="onboarding-screen-title">{{ t('onboarding.installFormTitle') }}</h2>
            <p class="onboarding-screen-subtitle">{{ t('onboarding.installFormSubtitle') }}</p>
          </header>

          <div class="onboarding-screen-body onboarding-install-form">
            <div v-if="formLoading" class="onboarding-form-loading">
              <div class="onboarding-spinner" />
              <span class="onboarding-form-loading-label">{{ t('onboarding.formLoading') }}</span>
            </div>

            <template v-else>
              <div class="onboarding-form-field">
                <div class="onboarding-form-label-row">
                  <label class="onboarding-form-label">{{ t('onboarding.installPathLabel') }}</label>
                  <button
                    v-if="isInstallPathCustom"
                    type="button"
                    class="onboarding-form-reset"
                    :disabled="busy"
                    @click="resetInstallPath"
                  >
                    {{ t('onboarding.installPathReset') }}
                  </button>
                </div>
                <div class="onboarding-form-row">
                  <input
                    v-model="installPath"
                    type="text"
                    class="onboarding-form-input"
                    :placeholder="defaultInstallPath"
                    :disabled="busy"
                  />
                  <button
                    type="button"
                    class="onboarding-form-browse"
                    :disabled="busy"
                    @click="onBrowsePath"
                  >
                    <FolderSearch :size="14" />
                    {{ t('onboarding.browse') }}
                  </button>
                </div>
                <p class="onboarding-form-hint">{{ t('onboarding.installPathHint') }}</p>
              </div>

              <div class="onboarding-form-field">
                <label class="onboarding-form-label">{{ t('onboarding.versionLabel') }}</label>
                <select
                  v-model="selectedRelease"
                  class="onboarding-form-select"
                  :disabled="busy || releaseOptions.length === 0"
                >
                  <option
                    v-for="opt in releaseOptions"
                    :key="opt.value"
                    :value="opt"
                  >
                    {{ opt.label }}
                  </option>
                </select>
                <!-- GPU detection promoted to an inline pill — feels like a
                     fact the app is showing off, not buried text. -->
                <span v-if="detectedGpuLabel" class="onboarding-gpu-chip">
                  <Cpu :size="12" />
                  {{ t('onboarding.detectedGpu', { gpu: detectedGpuLabel }) }}
                </span>
              </div>

              <div v-if="formError" class="onboarding-form-error">{{ formError }}</div>
            </template>
          </div>

          <footer v-if="!formLoading" class="onboarding-screen-footer">
            <button
              type="button"
              class="onboarding-back-btn"
              :disabled="busy"
              @click="goBack"
            >
              ← {{ t('onboarding.back') }}
            </button>
            <button
              class="primary onboarding-primary-btn"
              :disabled="!canSubmitForm"
              @click="startInstall"
            >
              {{ t('onboarding.installCta') }}
            </button>
          </footer>
        </section>

        <!-- =====================================================
             5a / Connecting to Comfy Cloud (after Cloud picked)
             ===================================================== -->
        <section v-else-if="stage === 'connecting-cloud'" key="connecting-cloud" class="onboarding-screen onboarding-installing">
          <header class="onboarding-screen-header">
            <div class="installing-meta">{{ t('onboarding.cloudConnectingMeta') }}</div>
            <h2 class="installing-title">{{ t('onboarding.cloudConnectingTitle') }}</h2>
            <!-- When the timeout fires we wrap the flavor in a soft warning
                 treatment so users can read a clear "something off" signal —
                 mirrors the form-error block grammar but in warning palette. -->
            <p
              class="installing-flavor"
              :class="{ 'installing-flavor-warning': cloudTimeoutFired }"
            >
              {{ cloudTimeoutFired ? t('onboarding.cloudConnectingTimeout') : t('onboarding.cloudConnectingFlavor') }}
            </p>
          </header>

          <div class="onboarding-screen-body">
            <div class="installing-progress-track">
              <div class="installing-progress-fill indeterminate" style="width: 40%" />
            </div>
            <div class="installing-progress-row">
              <span class="installing-status">
                <span
                  class="installing-status-dot"
                  :class="{ 'installing-status-dot-warning': cloudTimeoutFired }"
                />
                {{ t('onboarding.cloudConnectingStatus') }}
              </span>
            </div>

            <!-- 3-step visible signposts so the user has *something* to watch
                 during the silent waitForUrl poll. Pure UI; no backend hookup. -->
            <ol class="install-step-list" aria-label="Cloud connect progress">
              <li
                v-for="check in cloudChecks"
                :key="check.key"
                class="install-step"
                :class="check.state"
                :aria-current="check.state === 'active' ? 'step' : undefined"
              >
                <span class="install-step-marker" aria-hidden="true">
                  <Check v-if="check.state === 'done'" :size="12" />
                  <span v-else-if="check.state === 'active'" class="install-step-dot" />
                </span>
                <span class="install-step-label">{{ t(`onboarding.${check.key}`) }}</span>
              </li>
            </ol>
          </div>

          <!-- After CLOUD_TIMEOUT_MS the launch is probably stuck — give the
               user an escape hatch. Wrapped in a Transition so it fades in
               instead of popping when the timeout fires. -->
          <Transition name="onboarding-fade">
            <footer v-if="cloudTimeoutFired" class="onboarding-screen-footer">
              <button
                type="button"
                class="onboarding-back-btn"
                @click="backFromCloudConnect"
              >
                ← {{ t('onboarding.back') }}
              </button>
              <span />
            </footer>
          </Transition>
        </section>

        <!-- =====================================================
             5 / Installing — inline progress with step ladder
             ===================================================== -->
        <section v-else-if="stage === 'installing'" key="installing" class="onboarding-screen onboarding-installing">
          <header class="onboarding-screen-header">
            <div class="installing-meta">{{ t('onboarding.installingFor') }} {{ installingName }}</div>
            <h2 class="installing-title">{{ t('onboarding.installingTitle') }}</h2>
            <p class="installing-flavor">{{ activeStepLabel }}</p>
            <!-- Reassurance for first-timers; hides once we're near completion
                 so it doesn't read as wrong on a fast install. -->
            <p v-if="installPercent < 95" class="installing-time-hint">
              {{ t('onboarding.installingTimeHint') }}
            </p>
          </header>

          <div class="onboarding-screen-body">
            <div
              class="installing-progress-track"
              role="progressbar"
              :aria-valuenow="Math.round(installPercent)"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-label="t('onboarding.installingTitle')"
            >
              <div
                class="installing-progress-fill"
                :class="{ indeterminate: installPercent <= 0 }"
                :style="{ width: installPercent > 0 ? `${installPercent}%` : '40%' }"
              />
            </div>

            <div class="installing-progress-row">
              <span class="installing-percent">{{ installPercentDisplay }}</span>
              <span class="installing-elapsed-inline">{{ formatElapsed(elapsedSeconds) }}</span>
            </div>

            <ol class="install-step-list" aria-label="Installation progress">
              <li
                v-for="(step, i) in displaySteps"
                :key="i"
                class="install-step"
                :class="step.state"
                :aria-current="step.state === 'active' ? 'step' : undefined"
              >
                <span class="install-step-marker" aria-hidden="true">
                  <Check v-if="step.state === 'done'" :size="12" />
                  <span v-else-if="step.state === 'active'" class="install-step-dot" />
                  <span v-else class="install-step-pending">{{ i + 1 }}</span>
                </span>
                <span class="install-step-label">{{ step.label }}</span>
              </li>
            </ol>

            <!-- Structured status: phase title + detail (bytes/files) + meta
                 (speed · elapsed · ETA), parsed from the backend's status
                 string. Falls back to raw if the parse misses. -->
            <div class="installing-structured" aria-live="polite">
              <span v-if="structuredStatus.title" class="installing-structured-title">
                {{ structuredStatus.title }}
              </span>
              <span class="installing-structured-detail">
                <span class="installing-status-glyph" aria-hidden="true">›</span>
                {{ structuredStatus.detail || installStatus }}
              </span>
              <span v-if="structuredStatus.meta" class="installing-structured-meta">
                {{ structuredStatus.meta }}
              </span>
            </div>

            <!-- Stalled-state escape: appears when no progress events have
                 fired in 30s. Cancel routes through modal.confirm; disabled
                 once we're past the finalize threshold (95%) since cancelling
                 mid-finalize can corrupt state. Per §9.4. -->
            <div v-if="isStalled" class="installing-stalled" role="alert">
              <p class="installing-stalled-text">{{ t('onboarding.installStalled') }}</p>
              <button
                type="button"
                class="installing-cancel-btn"
                :disabled="cancelInProgress || cancelDisabled"
                @click="cancelInstall"
              >
                {{ cancelInProgress ? t('progress.starting') : t('onboarding.cancelInstall') }}
              </button>
              <p v-if="cancelError" class="installing-cancel-error">{{ cancelError }}</p>
            </div>
          </div>
        </section>

        <!-- =====================================================
             6 / Done — success ack with §8 recovery v2
             Single primary button surfaces a working retry path with verbatim
             error surface + 15s timeout + Quit affordance after explicit
             retry-failure. No "Show details", no "Close launcher", no
             disclosure — every state has direct, actionable feedback.
             ===================================================== -->
        <section v-else-if="stage === 'done'" key="done" class="onboarding-screen onboarding-done">
          <div class="done-inner">
            <!-- Check icon: success tint normally, danger tint when retry failed.
                 No pulsing on error (per §8). -->
            <div
              class="done-check"
              :class="{
                'done-check-stuck': doneStuck && !retryError,
                'done-check-error': !!retryError,
              }"
            >
              <Check v-if="!retryError" :size="32" />
              <AlertCircle v-else :size="32" />
            </div>
            <h2 class="done-title">{{ t(doneTitleKey) }}</h2>
            <!-- aria-live announces the subtitle when retry state flips.
                 Hidden when the inline error block is rendering (the error
                 block carries the message in that state). -->
            <p
              v-if="!retryError"
              class="done-subtitle"
              :class="{ 'done-subtitle-stuck': doneStuck }"
              aria-live="polite"
            >
              {{ t(doneSubtitleKey) }}
            </p>

            <!-- Inline error block (state 6 only). Above the button, below
                 the subtitle. Verbatim message from IPC. -->
            <Transition name="onboarding-fade">
              <div
                v-if="retryError"
                class="done-error-block"
                role="alert"
              >
                <AlertCircle :size="14" class="done-error-icon" />
                <span class="done-error-text">
                  {{ t('onboarding.openComfyUiError') }}: {{ retryError }}
                </span>
              </div>
            </Transition>

            <!-- §8 recovery: single primary button, gated on doneStuck reveal -->
            <Transition name="onboarding-fade">
              <div v-if="doneStuck" class="done-recovery">
                <button
                  type="button"
                  class="primary onboarding-primary-btn done-retry-btn"
                  :class="{
                    'done-retry-loading': doneButtonState === 'loading',
                    'done-retry-error': doneButtonState === 'error',
                  }"
                  :disabled="retrying"
                  :aria-busy="retrying ? 'true' : 'false'"
                  @click="retryLaunch"
                >
                  <Loader2 v-if="doneButtonState === 'loading'" :size="16" class="done-btn-icon spin" />
                  <RotateCw v-else-if="doneButtonState === 'error'" :size="16" class="done-btn-icon" />
                  <Play v-else :size="16" class="done-btn-icon" />
                  {{ t(doneButtonLabelKey) }}
                </button>

                <!-- Quit affordance: ONLY after an explicit retry-failure.
                     Per §8: "only renders when retryError !== null" — and we
                     additionally require retryAttempted to disambiguate from
                     install-completion errors that populate retryError. -->
                <Transition name="onboarding-fade">
                  <button
                    v-if="retryError && retryAttempted"
                    type="button"
                    class="done-text-btn done-text-btn-quiet"
                    @click="quitDesktop"
                  >
                    {{ t('onboarding.quitDesktop') }}
                  </button>
                </Transition>
              </div>
            </Transition>
          </div>
        </section>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.onboarding-view {
  position: fixed;
  inset: var(--titlebar-height, 37px) 0 0 0;
  background: var(--bg);
  overflow-y: auto;
  /* Below the global ModalDialog (z-index 100) so guard / migration confirm
     modals render on top of onboarding. */
  z-index: 50;
}

.onboarding-container {
  max-width: 640px;
  margin: 0 auto;
  padding: 80px 32px;
  min-height: 100%;
  box-sizing: border-box;
}

/* Each screen is a flex column with header / body / footer.
   Footer sticks to the bottom of the screen for consistent button placement
   across the flow (Back left, Primary right). */
.onboarding-screen {
  display: flex;
  flex-direction: column;
  gap: 24px;
  min-height: 560px;
}

.onboarding-screen-header {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.onboarding-screen-body {
  flex-grow: 1;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* Install form has the densest content in the flow — fields tend to fuse
   visually because the inner label-to-input gap is half the inter-field gap.
   Bumping the field gap to 24 here makes the two fields breathe without
   imposing the wider gap on simpler screens. */
.onboarding-install-form {
  gap: 24px;
}

/* Visually-hidden but available to screen readers — used for the stage
   announcement live region. */
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  border: 0;
  clip: rect(0 0 0 0);
  overflow: hidden;
  white-space: nowrap;
}

.onboarding-screen-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 8px;
}

.onboarding-screen-title {
  font-size: 22px;
  font-weight: 700;
  color: var(--text);
  margin: 0;
  line-height: 1.25;
}

.onboarding-screen-subtitle {
  font-size: 14px;
  color: var(--text-muted);
  margin: 0;
  line-height: 1.5;
}

.onboarding-back-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-muted);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  transition: border-color 0.15s ease, color 0.15s ease;
}

.onboarding-back-btn:hover:not(:disabled) {
  border-color: var(--border-hover);
  color: var(--text);
}

.onboarding-back-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.onboarding-primary-btn {
  padding: 8px 20px;
  font-size: 14px;
}

.onboarding-primary-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Multi-step transitions: fade + slight slide on enter/exit. 140ms each side
   keeps the total handoff under the 300ms perception threshold for delay
   while still allowing the 6px slide to read. Direction mirrors based on
   forward vs backward stage navigation. */
.onboarding-step-forward-enter-active,
.onboarding-step-forward-leave-active,
.onboarding-step-backward-enter-active,
.onboarding-step-backward-leave-active {
  transition: opacity 0.14s ease, transform 0.14s ease;
}

.onboarding-step-forward-enter-from {
  opacity: 0;
  transform: translateY(6px);
}

.onboarding-step-forward-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

/* Reverse the slide direction when going backward in the flow. */
.onboarding-step-backward-enter-from {
  opacity: 0;
  transform: translateY(-6px);
}

.onboarding-step-backward-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

/* Generic fade transition used for tier-revealing affordances (footer fade-in
   on cloud timeout, done-stuck recovery buttons, etc.). */
.onboarding-fade-enter-active,
.onboarding-fade-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.onboarding-fade-enter-from,
.onboarding-fade-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

/* Single accent icon block above the hero — replaces the muted-uppercase
   wordmark which was fighting the 28px hero immediately below. The window
   chrome already says ComfyUI. */
.onboarding-hero-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--accent);
  margin-bottom: 24px;
}

.onboarding-consent-header {
  /* 32 between icon and hero, 40 between header and consent block —
     enforced via the body's `gap: 40px` override below. */
  gap: 12px;
}

.onboarding-consent-body {
  /* Replace the visual divider with spacing — one focal point, no slicing. */
  gap: 40px;
}

.onboarding-title {
  font-size: 28px;
  font-weight: 700;
  color: var(--text);
  margin: 0;
  line-height: 1.2;
}

.onboarding-subtitle {
  font-size: 14px;
  color: var(--text-muted);
  margin: 0;
  line-height: 1.5;
}

.onboarding-consent {
  display: flex;
  flex-direction: column;
  gap: 18px;
  margin-bottom: 8px;
}

/* Helper text shown to the LEFT of the disabled Continue button explaining
   why it can't be clicked. Tooltips are invisible to most users. */
.onboarding-helper-text {
  font-size: 12px;
  color: var(--text-faint);
  line-height: 1.4;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.onboarding-helper-text.visible {
  opacity: 1;
}

/* Continue button: animate opacity 0.5 → 1 as EULA flips, no layout shift. */
.onboarding-continue-fade {
  transition: opacity 0.15s ease, background 0.15s ease, border-color 0.15s ease;
}

.onboarding-continue-fade:not(:disabled).ready {
  opacity: 1;
}

.consent-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  cursor: pointer;
}

.consent-checkbox {
  margin-top: 2px;
  flex-shrink: 0;
}

.consent-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.consent-label {
  font-size: 14px;
  font-weight: 500;
  color: var(--text);
  line-height: 1.4;
}

.consent-hint {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
}

/* EULA link as a discrete chip on its own line, NOT inside the hint paragraph.
   Reads as a real action rather than decoration. Underline appears on hover. */
.consent-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  align-self: flex-start;
  border: none;
  background: none;
  color: var(--accent);
  cursor: pointer;
  padding: 0;
  font-size: 13px;
  text-decoration: none;
  font-family: inherit;
}

.consent-link:hover {
  color: var(--accent-hover);
  background: none;
  text-decoration: underline;
}

.onboarding-cta-row {
  display: flex;
  align-items: center;
  margin-top: 16px;
}

.onboarding-continue-btn {
  padding: 10px 28px;
  font-size: 14px;
}

.onboarding-continue-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.onboarding-section-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.onboarding-section-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text);
  margin: 0;
  line-height: 1.3;
}

.onboarding-section-subtitle {
  font-size: 13px;
  color: var(--text-muted);
  margin: 0;
  line-height: 1.5;
}

.onboarding-back-link {
  border: none;
  background: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0;
  font-size: 13px;
  font-family: inherit;
}

.onboarding-back-link:hover:not(:disabled) {
  color: var(--text);
  background: none;
}

.onboarding-back-link:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.onboarding-card-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

@media (max-width: 900px) {
  .onboarding-card-row {
    grid-template-columns: 1fr;
  }
}

.onboarding-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 24px;
  min-height: 160px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  cursor: pointer;
  text-align: left;
  color: var(--text);
  font-family: inherit;
  transition: border-color 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease;
}

.onboarding-card:hover:not(:disabled) {
  border-color: var(--accent);
  transform: translateY(-2px);
  /* Box-shadow ring matches accent so the border-thickening doesn't shift the
     layout by 1px on theme borders. */
  box-shadow: 0 0 0 1px var(--accent);
}

.onboarding-card:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  transform: none;
  box-shadow: none;
}

.onboarding-card-icon {
  color: var(--accent);
  margin-bottom: 4px;
  transition: transform 0.2s ease-out;
}

.onboarding-card:hover:not(:disabled) .onboarding-card-icon {
  transform: scale(1.08);
}

.onboarding-card-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
  line-height: 1.3;
}

.onboarding-card-desc {
  font-size: 13px;
  color: var(--text-muted);
  line-height: 1.4;
  flex-grow: 1;
}

/* Sub-description rendered under the main desc on the local-fork cards. */
.onboarding-card-subdesc {
  font-size: 12px;
  color: var(--text-faint);
  line-height: 1.4;
  margin-top: -2px;
}

.onboarding-card-cta {
  font-size: 13px;
  font-weight: 500;
  color: var(--accent);
  margin-top: 6px;
}

/* RECOMMENDED badge — top-right of the recommended card.
   `.badge` style row from DESIGN.md: 11/600 uppercase, success on bg surface. */
.onboarding-card-badge {
  position: absolute;
  top: 12px;
  right: 12px;
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  color: var(--success);
  background: var(--bg);
  border: 1px solid color-mix(in srgb, var(--success) 40%, transparent);
  border-radius: 999px;
  line-height: 1.4;
}

/* Inline error footer strip on a failing card — confined to the card the
   error belongs to, not splayed across the row. */
.onboarding-card-error {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid color-mix(in srgb, var(--danger) 25%, transparent);
  font-size: 12px;
  color: var(--danger);
  align-self: stretch;
}

/* ---- Install form ---- */
.onboarding-form-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 40px 0;
  background: var(--surface);
  border-radius: 8px;
  font-size: 13px;
  color: var(--text-muted);
}

.onboarding-form-loading-label {
  font-size: 13px;
  color: var(--text-muted);
}

.onboarding-form-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* Label row hosts the label on the left and (when relevant) the
   "Reset to default" affordance on the right. */
.onboarding-form-label-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.onboarding-form-reset {
  border: none;
  background: none;
  padding: 0;
  font-family: inherit;
  font-size: 12px;
  color: var(--text-faint);
  cursor: pointer;
  transition: color 0.15s ease;
}

.onboarding-form-reset:hover:not(:disabled) {
  color: var(--accent);
  background: none;
}

.onboarding-form-reset:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.onboarding-form-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.onboarding-form-row {
  display: flex;
  gap: 8px;
}

.onboarding-form-input {
  flex: 1;
  padding: 8px 10px;
  font-size: 14px;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: inherit;
}

.onboarding-form-input:focus {
  outline: none;
  border-color: var(--accent);
}

.onboarding-form-input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.onboarding-form-browse {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  font-size: 13px;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
  font-family: inherit;
}

.onboarding-form-browse:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
  /* Visible background lift on hover beyond just border color — matches the
     install-step.active pattern. */
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}

.onboarding-form-browse:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.onboarding-form-select {
  padding: 8px 10px;
  font-size: 14px;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: inherit;
  cursor: pointer;
}

.onboarding-form-select:focus {
  outline: none;
  border-color: var(--accent);
}

.onboarding-form-hint {
  font-size: 12px;
  color: var(--text-faint);
  margin: 0;
  line-height: 1.4;
}

/* GPU detection chip: promoted from a passive form-hint paragraph to an
   inline pill so the user reads it as a fact the app is showing off. */
.onboarding-gpu-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  font-size: 12px;
  color: var(--text-muted);
  background: color-mix(in srgb, var(--info) 10%, transparent);
  border-radius: 6px;
  align-self: flex-start;
  line-height: 1.4;
}

.onboarding-gpu-chip svg {
  color: var(--info);
}

.onboarding-form-error {
  padding: 10px 12px;
  font-size: 13px;
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
  border-radius: 6px;
}

/* ---- Installing ---- */
.onboarding-installing {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 32px 0 24px;
}

.installing-meta {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--text-faint);
}

.installing-title {
  /* Per typography rhythm: 22/700 across all body screens (only consent is
     the 28/700 hero). */
  font-size: 22px;
  font-weight: 700;
  color: var(--text);
  margin: 0;
  line-height: 1.2;
}

.installing-flavor {
  font-size: 14px;
  color: var(--text-muted);
  margin: 0;
  line-height: 1.5;
  min-height: 1.5em;
}

/* Warning-tinted treatment for the connecting-cloud timeout state.
   Mirrors the form-error block grammar but in warning palette. */
.installing-flavor-warning {
  padding: 10px 12px;
  background: color-mix(in srgb, var(--warning) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--warning) 30%, transparent);
  border-radius: 6px;
  color: var(--warning);
}

/* "This usually takes 2-4 minutes" line — a small, faint reassurance. */
.installing-time-hint {
  font-size: 13px;
  color: var(--text-faint);
  margin: 0;
  line-height: 1.4;
}

.installing-progress-track {
  position: relative;
  height: 10px;
  width: 100%;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 999px;
  overflow: hidden;
  margin-top: 12px;
}

.installing-progress-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 999px;
  transition: width 0.4s ease;
}

.installing-progress-fill.indeterminate {
  background: linear-gradient(90deg,
    color-mix(in srgb, var(--accent) 20%, transparent),
    var(--accent),
    color-mix(in srgb, var(--accent) 20%, transparent)
  );
  background-size: 200% 100%;
  /* 2.4s shimmer paired with 2.0s pulse — same family of motion, no jitter.
     TODO(design-system): replace with --motion-slow when motion tokens land. */
  animation: install-shimmer 2.4s linear infinite;
}

@keyframes install-shimmer {
  from { background-position: 200% 0; }
  to { background-position: -200% 0; }
}

.installing-progress-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 4px;
}

.installing-status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.installing-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  flex-shrink: 0;
  /* 2.0s to pair with the 2.4s shimmer — calm, reassuring rhythm. */
  animation: install-pulse 2s ease-in-out infinite;
}

/* When the cloud connect timeout fires, switch the dot color to warning. */
.installing-status-dot-warning {
  background: var(--warning);
}

@keyframes install-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.85); }
}

.installing-percent {
  font-variant-numeric: tabular-nums;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  flex-shrink: 0;
}

.installing-elapsed-inline {
  font-variant-numeric: tabular-nums;
  font-size: 13px;
  color: var(--text-faint);
}

/* --- Install step ladder --- */
.install-step-list {
  list-style: none;
  margin: 12px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.install-step {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 13px;
  color: var(--text-faint);
  transition: background 0.15s ease, color 0.15s ease;
}

.install-step.active {
  color: var(--text);
  /* Brighter tint so the active row is unmistakable on the dark theme. */
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}

.install-step.done {
  color: var(--text-muted);
}

.install-step-marker {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 600;
}

.install-step.pending .install-step-marker {
  background: var(--surface);
  border: 1px solid var(--border);
}

.install-step.active .install-step-marker {
  background: var(--accent);
  /* TODO(design-system): replace with --accent-fg token when it lands.
     Using --bg as the closest existing token (same value in dark, white in
     light — the accent is blue in both, so this still reads). */
  color: var(--bg);
}

.install-step.done .install-step-marker {
  background: color-mix(in srgb, var(--accent) 30%, transparent);
  color: var(--accent);
}

.install-step-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  /* TODO(design-system): replace with --accent-fg token when it lands. */
  background: var(--bg);
  animation: install-pulse 2s ease-in-out infinite;
}

.install-step-pending {
  color: var(--text-faint);
}

.install-step-label {
  flex-grow: 1;
}

/* Structured status block — replaces the single status line with a 3-row
   grid (phase title / detail / meta) parsed from the backend status string.
   Surfaces real download bytes / extract % / file counts / speed / ETA
   instead of a long pipe-delimited line. */
.installing-structured {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 8px 0 0;
  padding-top: 12px;
  border-top: 1px solid var(--border);
  font-variant-numeric: tabular-nums;
}

.installing-structured-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  line-height: 1.3;
}

.installing-structured-detail {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.installing-structured-meta {
  font-size: 12px;
  color: var(--text-faint);
}

.installing-status-glyph {
  color: var(--text-faint);
  flex-shrink: 0;
  font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
}

/* Stalled-state escape — appears below the structured status when no
   progress events have fired in 30s. Per §9.4 spec. */
.installing-stalled {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 16px;
  padding: 12px 14px;
  background: color-mix(in srgb, var(--warning) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--warning) 30%, transparent);
  border-radius: 6px;
}

.installing-stalled-text {
  font-size: 13px;
  color: var(--warning);
  margin: 0;
}

.installing-cancel-btn {
  align-self: flex-start;
  padding: 6px 14px;
  font-size: 13px;
  background: transparent;
  color: var(--warning);
  border: 1px solid color-mix(in srgb, var(--warning) 50%, transparent);
  border-radius: 6px;
  cursor: pointer;
  font-family: inherit;
}

.installing-cancel-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--warning) 12%, transparent);
}

.installing-cancel-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.installing-cancel-error {
  font-size: 12px;
  color: var(--danger);
  margin: 0;
}

/* --- Done screen --- */
.onboarding-done {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 64px 0;
}

.done-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  max-width: 360px;
  width: 100%;
}

.done-check {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--success) 18%, transparent);
  color: var(--success);
  display: flex;
  align-items: center;
  justify-content: center;
  /* Subtle pulse during the patient phase keeps the screen feeling alive. */
  animation: install-pulse 2s ease-in-out infinite;
}

/* Stop the pulse once we move past the patient threshold — the screen is
   now in a recovery posture, not a celebratory one. */
.done-check-stuck {
  animation: none;
}

.done-title {
  font-size: 22px;
  font-weight: 700;
  color: var(--text);
  margin: 0;
  line-height: 1.2;
}

.done-subtitle {
  font-size: 14px;
  color: var(--text-muted);
  margin: 0;
  line-height: 1.5;
  transition: color 0.2s ease;
}

/* Tier 3: warning color when we cross the very-stuck threshold. */
.done-subtitle-very-stuck {
  color: var(--warning);
}

/* Tier 2+ recovery affordances cluster. */
.done-recovery {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  width: 100%;
  margin-top: 8px;
}

.done-recovery-buttons {
  display: flex;
  align-items: center;
  gap: 16px;
}

/* Quiet text-button for "Show details" / "Close launcher". */
.done-text-btn {
  border: none;
  background: none;
  padding: 6px 8px;
  color: var(--text-muted);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: color 0.15s ease;
  border-radius: 4px;
}

.done-text-btn:hover {
  color: var(--text);
  background: none;
}

.done-text-btn-quiet {
  color: var(--text-faint);
  font-size: 12px;
}

.done-text-btn-quiet:hover {
  color: var(--text-muted);
}

/* Recessed-list disclosure block for the "Show details" content. */
.done-details {
  width: 100%;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  text-align: left;
}

.done-details p {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
}

.done-details-explain {
  color: var(--text-muted);
}

.done-details-status {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  /* Selectable for users who want to copy the status line into a bug report.
     Per DESIGN.md rules — selectable text where it helps the user. */
  user-select: text;
}

.done-details-glyph {
  color: var(--text-faint);
  font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
  flex-shrink: 0;
}

.done-details-path-value {
  display: block;
  margin-top: 4px;
  font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
  font-size: 11px;
  color: var(--text);
  word-break: break-all;
  user-select: text;
}

.onboarding-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

/* Larger spinner when shown inside the centered loading block — treats the
   loading state as a real state, not a placeholder hint. */
.onboarding-form-loading .onboarding-spinner {
  width: 24px;
  height: 24px;
  border-width: 2.5px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
