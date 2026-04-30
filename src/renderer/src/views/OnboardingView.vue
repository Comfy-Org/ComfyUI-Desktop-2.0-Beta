<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, toRaw, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowRightLeft, Check, Cloud, Download, ExternalLink, FolderSearch, HardDrive } from 'lucide-vue-next'
import { useInstallationStore } from '../stores/installationStore'
import { useProgressStore } from '../stores/progressStore'
import { useOnboardingPrefs } from '../composables/useOnboardingPrefs'
import { useMigrateAction } from '../composables/useMigrateAction'
import { useModal } from '../composables/useModal'
import { emitTelemetryAction } from '../lib/telemetry'
import type { FieldOption } from '../types/ipc'

// TODO: replace with the final EULA URL once Legal signs off.
const EULA_URL = 'https://www.comfy.org/legal/desktop-eula'

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
      await onboardingPrefs.setLastUsedMode('local')
      if (id) {
        try {
          await window.api.setSetting('primaryInstallId', id)
          await installationStore.fetchInstallations()
          // Done state stays visible for the duration of the launch — the
          // user sees "Your studio is ready / Opening ComfyUI…" until the
          // new window actually appears.
          try { await window.api.runAction(id, 'launch') } catch {}
          try { await window.api.hideLauncherWindow() } catch {}
        } catch {}
      }
      emit('complete')
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

// --- Section A handlers ---
async function onTelemetryToggle(event: Event): Promise<void> {
  const checked = (event.target as HTMLInputElement).checked
  await onboardingPrefs.setTelemetry(checked)
  emitTelemetryAction('onboarding.telemetry.toggled', { enabled: checked })
}

async function onEulaToggle(event: Event): Promise<void> {
  const checked = (event.target as HTMLInputElement).checked
  await onboardingPrefs.setEulaAccepted(checked)
  if (checked) emitTelemetryAction('onboarding.eula.accepted')
}

function openEula(): void {
  emitTelemetryAction('onboarding.eula.viewed')
  window.api.openExternal(EULA_URL)
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

function backFromCloudConnect(): void {
  // Best-effort: abort any in-flight cloud launch operation. cancelLaunch
  // aborts ALL active operations, which is broader than we want, but it's
  // the closest IPC available — and during onboarding nothing else should
  // be running anyway.
  try { void window.api.cancelLaunch() } catch {}
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
    await onboardingPrefs.complete('manual')
    emit('complete')
    return
  }
  busy.value = true
  // Clear any prior failure message — user is retrying.
  cloudError.value = ''
  cloudTimeoutFired.value = false
  stage.value = 'connecting-cloud'
  clearCloudTimeout()
  cloudTimeoutHandle = setTimeout(() => {
    cloudTimeoutFired.value = true
  }, CLOUD_TIMEOUT_MS)

  let launched: boolean
  try {
    await window.api.setSetting('primaryInstallId', inst.id)
    emitTelemetryAction('onboarding.cloud.connecting')
    try {
      const result = await window.api.runAction(inst.id, 'launch')
      // runAction normally returns `{ ok: true }`; treat anything else as a failure.
      launched = !!result?.ok
    } catch {
      launched = false
    }

    if (!launched) {
      // Surface a recoverable error: route back to the picker with an inline
      // message. We do NOT mark onboarding completed or persist
      // `lastUsedMode='cloud'` — the user hasn't successfully picked anything.
      cloudError.value = t('onboarding.cloudConnectError')
      emitTelemetryAction('onboarding.cloud.failed')
      stage.value = 'mode'
      return
    }

    // Cloud launch succeeded — clear any prior error banner.
    cloudError.value = ''
    // Show the success ack briefly so the user sees a clear handoff, then
    // focus the cloud window and hide the launcher chrome.
    stage.value = 'done'
    await onboardingPrefs.setLastUsedMode('cloud')
    await onboardingPrefs.complete('manual')
    await new Promise((r) => setTimeout(r, 1200))
    try { window.api.focusComfyWindow(inst.id) } catch {}
    try { await window.api.hideLauncherWindow() } catch {}
    emit('complete')
  } finally {
    clearCloudTimeout()
    cloudTimeoutFired.value = false
    busy.value = false
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
    try {
      await onboardingPrefs.setLastUsedMode('local')
      await window.api.setSetting('primaryInstallId', installed.id)
      if (!onboardingPrefs.completed.value) {
        await onboardingPrefs.complete('manual')
      }
      stage.value = 'done'
      // Direct runAction so we await until the new ComfyUI window is open.
      // Same reasoning as the install completion path.
      try { await window.api.runAction(installed.id, 'launch') } catch {}
      try { await window.api.hideLauncherWindow() } catch {}
      emit('complete')
    } finally {
      busy.value = false
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

// --- Section C (local fork) ---
async function pickMigrate(): Promise<void> {
  if (busy.value) return
  const inst = desktopOnlyInstall.value
  if (!inst) return
  busy.value = true
  try {
    const result = await confirmMigration(inst)
    if (!result) return
    await onboardingPrefs.complete('migrate')
    emit('show-progress', {
      installationId: inst.id,
      title: `${t('desktop.migrating')} — ${inst.name}`,
      apiCall: () => window.api.runAction(inst.id, 'migrate-to-standalone', result),
      cancellable: true,
    })
    emit('complete')
  } finally {
    busy.value = false
  }
}

function pickStartFresh(): void {
  if (busy.value) return
  void enterInstallForm()
}

// --- Section D (install form) ---
async function enterInstallForm(): Promise<void> {
  stage.value = 'install-form'
  formLoading.value = true
  formError.value = ''
  try {
    const [path, releases, gpu, hw] = await Promise.all([
      window.api.getDefaultInstallDir().catch(() => ''),
      window.api.getFieldOptions('standalone', 'release', {}, { includeLatestStable: true }),
      window.api.detectGPU().catch(() => null),
      window.api.validateHardware(),
    ])
    if (!hw.supported) {
      await modal.alert({
        title: t('newInstall.unsupportedHardwareTitle'),
        message: hw.error || '',
      })
      stage.value = desktopOnlyInstall.value ? 'local-fork' : 'mode'
      return
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
  const chosen = await window.api.browseFolder(installPath.value)
  if (chosen) installPath.value = chosen
}

async function startInstall(): Promise<void> {
  if (!canSubmitForm.value || !selectedRelease.value || !installPath.value) return
  busy.value = true
  formError.value = ''
  try {
    // Pick the recommended variant for the chosen release silently.
    const variants = await window.api.getFieldOptions('standalone', 'variant', {
      release: JSON.parse(JSON.stringify(toRaw(selectedRelease.value))) as FieldOption,
    })
    const variant = variants.find((v) => v.recommended) ?? variants[0]
    if (!variant) {
      formError.value = t('newInstall.noOptions')
      busy.value = false
      return
    }

    const instData = await window.api.buildInstallation('standalone', {
      release: JSON.parse(JSON.stringify(toRaw(selectedRelease.value))) as FieldOption,
      variant: JSON.parse(JSON.stringify(toRaw(variant))) as FieldOption,
    })

    const name = await window.api.getUniqueName('ComfyUI')
    const result = await window.api.addInstallation({
      name,
      installPath: installPath.value,
      ...instData,
    })
    if (!result.ok || !result.entry) {
      formError.value = result.message || t('errors.cannotAdd')
      busy.value = false
      return
    }

    emitTelemetryAction('onboarding.install.started', {
      release: selectedRelease.value.value,
      variant: variant.value,
    })

    // Persist `onboardingCompleted=true` BEFORE kicking off the install.
    // If the renderer dies mid-install (cmd+Q, crash) the install still
    // completes at the backend, but if we waited until post-launch to flip
    // the flag, the user would land back at onboarding next boot. The
    // onboarding-completed flag is independent of "did we successfully
    // launch" — once the user has picked Local + named an install, the
    // onboarding decision has been made.
    if (!onboardingPrefs.completed.value) {
      await onboardingPrefs.complete('manual')
    }

    // Reset the watch latch so the install-completion handler runs for this
    // new operation. (`hasFinalized` may have been left at `false` after a
    // prior cancel/error retry, but make it explicit.)
    hasFinalized.value = false

    // Switch to the inline progress view and start the operation directly via
    // the progress store — no ProgressModal popup, the onboarding owns the screen.
    installingId.value = result.entry.id
    installingName.value = name
    installStartedAt.value = Date.now()
    elapsedSeconds.value = 0
    startElapsedTimer()
    stage.value = 'installing'

    progressStore.startOperation({
      installationId: result.entry.id,
      title: `${t('newInstall.installing')} — ${name}`,
      apiCall: () => window.api.installInstance(result.entry!.id),
    })
  } catch (err) {
    formError.value = (err as Error)?.message || String(err)
  } finally {
    busy.value = false
  }
}

// --- Helpers ---
function startElapsedTimer(): void {
  stopElapsedTimer()
  elapsedTimer = setInterval(() => {
    elapsedSeconds.value = Math.floor((Date.now() - installStartedAt.value) / 1000)
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

function goBack(): void {
  if (busy.value) return
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
</script>

<template>
  <div class="onboarding-view">
    <div class="onboarding-container">
      <Transition name="onboarding-step" mode="out-in">

        <!-- =====================================================
             1 / Consent
             ===================================================== -->
        <section v-if="stage === 'consent'" key="consent" class="onboarding-screen">
          <header class="onboarding-screen-header">
            <div class="onboarding-wordmark">ComfyUI</div>
            <h1 class="onboarding-title">{{ t('onboarding.welcomeTitle') }}</h1>
            <p class="onboarding-subtitle">{{ t('onboarding.welcomeSubtitle') }}</p>
          </header>

          <div class="onboarding-screen-body">
            <div class="onboarding-divider" />
            <div class="onboarding-consent">
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
                </span>
              </label>

              <label class="consent-row">
                <input
                  type="checkbox"
                  class="consent-checkbox"
                  :checked="onboardingPrefs.eulaAccepted.value"
                  @change="onEulaToggle"
                />
                <span class="consent-body">
                  <span class="consent-label">{{ t('onboarding.eulaLabel') }}</span>
                  <span class="consent-hint">
                    {{ t('onboarding.eulaHint') }}
                    <button type="button" class="consent-link" @click.prevent="openEula">
                      {{ t('onboarding.eulaViewLink') }}
                      <ExternalLink :size="12" />
                    </button>
                  </span>
                </span>
              </label>
            </div>
          </div>

          <footer class="onboarding-screen-footer">
            <span /><!-- spacer; no Back on the first screen -->
            <button
              class="primary onboarding-primary-btn"
              :disabled="!canContinue"
              :title="canContinue ? '' : t('onboarding.continueDisabledTooltip')"
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
            <div v-if="cloudError" class="onboarding-form-error" role="alert">
              {{ cloudError }}
            </div>
            <div class="onboarding-card-row">
              <button
                class="onboarding-card"
                type="button"
                :disabled="busy"
                @click="pickCloud"
              >
                <Cloud :size="22" class="onboarding-card-icon" />
                <span class="onboarding-card-title">{{ t('onboarding.cloudCardTitle') }}</span>
                <span class="onboarding-card-desc">{{ t('onboarding.cloudCardDesc') }}</span>
                <span class="onboarding-card-cta">{{ t('onboarding.cloudCardCta') }}</span>
              </button>
              <button
                class="onboarding-card"
                type="button"
                :disabled="busy"
                @click="pickLocal"
              >
                <HardDrive :size="22" class="onboarding-card-icon" />
                <span class="onboarding-card-title">{{ t('onboarding.localCardTitle') }}</span>
                <span class="onboarding-card-desc">{{ t('onboarding.localCardDesc') }}</span>
                <span class="onboarding-card-cta">{{ t('onboarding.localCardCta') }}</span>
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
          </header>

          <div class="onboarding-screen-body">
            <div class="onboarding-card-row">
              <button
                class="onboarding-card"
                type="button"
                :disabled="busy"
                @click="pickMigrate"
              >
                <ArrowRightLeft :size="22" class="onboarding-card-icon" />
                <span class="onboarding-card-title">{{ t('onboarding.migrateCardTitle') }}</span>
                <span class="onboarding-card-desc">{{ t('onboarding.migrateCardDesc') }}</span>
                <span class="onboarding-card-cta">{{ t('onboarding.migrateCardCta') }}</span>
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
                <span class="onboarding-card-cta">{{ t('onboarding.startFreshCardCta') }}</span>
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

          <div class="onboarding-screen-body">
            <div v-if="formLoading" class="onboarding-form-loading">
              <div class="onboarding-spinner" />
              <span>{{ t('onboarding.formLoading') }}</span>
            </div>

            <template v-else>
              <div class="onboarding-form-field">
                <label class="onboarding-form-label">{{ t('onboarding.installPathLabel') }}</label>
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
                <p v-if="detectedGpuLabel" class="onboarding-form-hint">
                  {{ t('onboarding.detectedGpu', { gpu: detectedGpuLabel }) }}
                </p>
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
            <p class="installing-flavor">
              {{ cloudTimeoutFired ? t('onboarding.cloudConnectingTimeout') : t('onboarding.cloudConnectingFlavor') }}
            </p>
          </header>

          <div class="onboarding-screen-body">
            <div class="installing-progress-track">
              <div class="installing-progress-fill indeterminate" style="width: 40%" />
            </div>
            <div class="installing-progress-row">
              <span class="installing-status">
                <span class="installing-status-dot" />
                {{ t('onboarding.cloudConnectingStatus') }}
              </span>
            </div>
          </div>

          <!-- After CLOUD_TIMEOUT_MS the launch is probably stuck — give the
               user an escape hatch. The footer is hidden until then so the
               normal happy-path stays uncluttered. -->
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
        </section>

        <!-- =====================================================
             5 / Installing — inline progress with step ladder
             ===================================================== -->
        <section v-else-if="stage === 'installing'" key="installing" class="onboarding-screen onboarding-installing">
          <header class="onboarding-screen-header">
            <div class="installing-meta">{{ t('onboarding.installingFor') }} {{ installingName }}</div>
            <h2 class="installing-title">{{ t('onboarding.installingTitle') }}</h2>
            <p class="installing-flavor">{{ activeStepLabel }}</p>
          </header>

          <div class="onboarding-screen-body">
            <div class="installing-progress-track">
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

            <ol class="install-step-list">
              <li
                v-for="(step, i) in displaySteps"
                :key="i"
                class="install-step"
                :class="step.state"
              >
                <span class="install-step-marker" aria-hidden="true">
                  <Check v-if="step.state === 'done'" :size="12" />
                  <span v-else-if="step.state === 'active'" class="install-step-dot" />
                  <span v-else class="install-step-pending">{{ i + 1 }}</span>
                </span>
                <span class="install-step-label">{{ step.label }}</span>
              </li>
            </ol>

            <p class="installing-status-line">{{ installStatus }}</p>
          </div>
        </section>

        <!-- =====================================================
             6 / Done — success ack before launcher hides
             ===================================================== -->
        <section v-else-if="stage === 'done'" key="done" class="onboarding-screen onboarding-done">
          <div class="done-check">
            <Check :size="32" />
          </div>
          <h2 class="done-title">{{ t('onboarding.doneTitle') }}</h2>
          <p class="done-subtitle">{{ t('onboarding.doneSubtitle') }}</p>
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

/* Multi-step transitions: fade + slight slide on enter/exit. */
.onboarding-step-enter-active,
.onboarding-step-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.onboarding-step-enter-from {
  opacity: 0;
  transform: translateY(6px);
}

.onboarding-step-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

.onboarding-wordmark {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-muted);
  letter-spacing: 0.4px;
  text-transform: uppercase;
  margin-bottom: 4px;
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

.onboarding-divider {
  height: 1px;
  background: var(--border);
  margin: 24px 0 8px;
}

.onboarding-consent {
  display: flex;
  flex-direction: column;
  gap: 18px;
  margin-bottom: 8px;
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

.consent-link {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: 4px;
  border: none;
  background: none;
  color: var(--accent);
  cursor: pointer;
  padding: 0;
  font-size: 12px;
  text-decoration: underline;
  font-family: inherit;
}

.consent-link:hover {
  color: var(--accent-hover);
  background: none;
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
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 20px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  cursor: pointer;
  text-align: left;
  color: var(--text);
  font-family: inherit;
  transition: border-color 0.15s ease, transform 0.15s ease;
}

.onboarding-card:hover:not(:disabled) {
  border-color: var(--accent);
  transform: translateY(-2px);
}

.onboarding-card:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  transform: none;
}

.onboarding-card-icon {
  color: var(--accent);
  margin-bottom: 4px;
}

.onboarding-card-title {
  font-size: 15px;
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

.onboarding-card-cta {
  font-size: 13px;
  font-weight: 600;
  color: var(--accent);
  margin-top: 6px;
}

/* ---- Install form ---- */
.onboarding-form-loading {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 0;
  font-size: 13px;
  color: var(--text-muted);
}

.onboarding-form-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
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
  font-size: 24px;
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
  animation: install-shimmer 1.6s linear infinite;
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
  animation: install-pulse 1.2s ease-in-out infinite;
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
  background: color-mix(in srgb, var(--accent) 8%, transparent);
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
  color: #0c0c0c;
}

.install-step.done .install-step-marker {
  background: color-mix(in srgb, var(--accent) 30%, transparent);
  color: var(--accent);
}

.install-step-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #0c0c0c;
  animation: install-pulse 1.2s ease-in-out infinite;
}

.install-step-pending {
  color: var(--text-faint);
}

.install-step-label {
  flex-grow: 1;
}

.installing-status-line {
  font-size: 12px;
  color: var(--text-faint);
  margin: 4px 0 0;
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* --- Done screen --- */
.onboarding-done {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 16px;
  padding: 64px 0;
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
}

.onboarding-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
