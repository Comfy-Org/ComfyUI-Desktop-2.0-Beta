<script setup lang="ts">
/**
 * First-use takeover.
 *
 * Multi-step Tier 3 takeover that runs the first time the launcher
 * starts (or any subsequent launch where `launcherPrefs.firstUseCompleted`
 * is still false because the user dismissed mid-flow). Mounts in
 * PanelApp's overlay slot just like the four flow modals — see
 * `openFirstUseTakeover` for the host-side wiring.
 *
 * Step ordering:
 *   1. `start`   — Merged T&C + Cloud-vs-Local picker on a single page.
 *                  T&C + telemetry checkboxes, an Express-Install
 *                  opt-out modifier, and two radio cards (Cloud
 *                  pre-selected). A single Continue commit persists
 *                  telemetry, fires fork_chosen, and routes to the
 *                  next step. Cancel closes the host window.
 *   2. `mirrors` — Only inserted when the resolved locale starts with
 *                  'zh'. Reuses the existing `chineseMirrorsSuggest*`
 *                  copy in en/zh + the `useChineseMirrors` setting; we
 *                  flip the global flag through `setSetting`, no new
 *                  per-source override surface yet.
 *                  `chineseMirrorsPrompted` is also set so the
 *                  prompt machinery doesn't re-fire later. After the
 *                  user picks, `routePostStart` resumes the fork
 *                  routing from step 1.
 *   3. (routing) — From step 1 (or post-mirrors): Cloud emits
 *                  `complete-cloud` immediately. Local emits
 *                  `chain-local` so the host swaps this takeover for
 *                  the new-install Tier 3 takeover (Tier 3 → Tier 3
 *                  swap is silent in `useOverlay`); the host marks
 *                  completion when new-install ends successfully.
 *                  Local + Legacy Desktop detected routes to the
 *                  `localBranch` sub-step first.
 *
 * The takeover stays a pure stepper — it does NOT call `setSetting`
 * for `firstUseCompleted` itself; the host owns that flip so the
 * Local-branch chain (which finishes outside this component) can mark
 * complete consistently.
 *
 * `open()` resets all internal state to step 1 and re-fetches the
 * locale; the host calls it post-mount the same way the flow modals
 * are reset.
 */
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import { Check, Copy, FolderInput, Info, Loader2 } from 'lucide-vue-next'
import TakeoverHeader from '../components/TakeoverHeader.vue'
import ModalShell from '../components/ModalShell.vue'
import ChoiceCard from '../components/ChoiceCard.vue'
import WhyTryCloudModal from '../components/WhyTryCloudModal.vue'
import TermsModal from '../components/TermsModal.vue'
import Tooltip from '../components/ui/Tooltip.vue'
import BrandTakeoverLayout from '../components/BrandTakeoverLayout.vue'
import { emitTelemetryAction } from '../lib/telemetry'
import { useCloudCapacity } from '../composables/useCloudCapacity'

type Step = 'start' | 'mirrors' | 'localBranch'

const emit = defineEmits<{
  /** Cloud branch explicitly picked at the cloud-vs-local fork. Host
   *  marks `firstUseCompleted`, closes the takeover, and auto-launches
   *  the seeded Cloud install — the user asked for it. */
  'complete-cloud': []
  /** Returning user — `skipPick` was true so the cloud-vs-local fork
   *  was suppressed entirely. Host marks `firstUseCompleted` and
   *  closes the takeover, dropping the user on the chooser body where
   *  they can pick whichever existing install they want. NO implicit
   *  cloud launch — they didn't ask for it. */
  'complete-skip': []
  /** Local branch picked — host should chain into the new-install
   *  Tier 3 takeover (Tier 3 → Tier 3 swap is silent) and mark
   *  `firstUseCompleted` once new-install ends successfully. Naming
   *  happens inline on the Configure screen now. The optional payload
   *  flags whether the chain was reached via the Local → Start Fresh
   *  sub-step (vs. the direct no-legacy path) so the Configure screen
   *  can surface a Back link to return the user to localBranch, and
   *  whether the user opted into Express Install (skip Configure and
   *  run Standalone + recommended defaults straight through to the
   *  install-progress takeover). */
  'chain-local': [payload?: { cameFromLocalBranch?: boolean; express?: boolean }]
  /** Local-branch follow-up: a Legacy Desktop install was detected
   *  and the user chose to migrate it instead of installing fresh.
   *  Host runs the migration flow (`useMigrateAction.confirmMigration`
   *  → `runAction('migrate-to-standalone', …)` via `show-progress`)
   *  on the auto-tracked desktop install and marks `firstUseCompleted`
   *  once the migration finishes successfully. Same shape as
   *  `chain-local` — host owns completion + auto-launch. */
  'chain-migrate': []
}>()

const step = ref<Step>('start')
const telemetryEnabled = ref(true)
const locale = ref('en')
/** Cloud-vs-Local selection picked on the merged start screen.
 *  Cloud is the brand-anchor card (glow + beam target) so it ships
 *  pre-selected — users can flip to Local before pressing Continue. */
const pickedChoice = ref<'cloud' | 'local'>('cloud')

// Capacity-protection switch for Cloud (PostHog flag
// `desktop-cloud-capacity`). At first-use, we follow the flag
// verbatim — `disabled` greys the cloud card and pre-selects local,
// `degraded` shows a heads-up modal on Continue. The only relaxation
// anywhere in the gate is "known paid user", and that requires a
// signed-in session — which we don't have here. So first-use cannot
// soften, by design.
const cloudCapacity = useCloudCapacity()
const capacityReady = ref(false)
/** What the picker rendered as default before the user could interact —
 *  used to split `fork_chosen` conversion by signal-vs-defaulting: a
 *  user keeping the default cloud pick is different from a user
 *  actively flipping local→cloud. Reseeded on every `open()` from the
 *  resolved capacity status. */
const initialDefaultChoice = ref<'cloud' | 'local'>('cloud')
function deriveDefaultChoice(): 'cloud' | 'local' {
  return cloudCapacity.isDisabled() ? 'local' : 'cloud'
}
onMounted(async () => {
  await cloudCapacity.whenReady()
  if (cloudCapacity.isDisabled()) {
    pickedChoice.value = 'local'
  }
  initialDefaultChoice.value = deriveDefaultChoice()
  capacityReady.value = true
})
watch(cloudCapacity.status, (status) => {
  if (status === 'disabled' && pickedChoice.value === 'cloud') {
    pickedChoice.value = 'local'
  }
})
const cloudDescriptionKey = computed(() => {
  if (cloudCapacity.isDisabled()) return 'cloud.capacityDisabledHint'
  if (cloudCapacity.isDegraded()) return 'cloud.capacityDegradedHint'
  return 'firstUse.cloudDesc'
})
/** Express-install opt-out modifier on the start screen. Pre-ticked.
 *  Functional wiring (skipping optional setup steps) lands separately;
 *  for now the value is captured for telemetry only. */
const expressInstall = ref(true)
/** Detected GPU vendor — populated by `window.api.detectGPU()` on
 *  `open()`. Surfaces as an inline confirmation line under the Express
 *  checkbox so users on the wrong hardware can untick Express before
 *  the install kicks off. `null` when detection fails or returns no
 *  supported GPU; in that case the hint is suppressed and Express
 *  behaves as before (recommended-first picks downstream). */
const detectedGpuLabel = ref<string | null>(null)
const showGpuHint = computed(
  () => pickedChoice.value === 'local' && expressInstall.value && detectedGpuLabel.value !== null
)
/** Funnel-completion bookkeeping for `desktop2.first_use.completed`.
 *  `mountedAt` is reset in `open()` so a takeover replay measures
 *  duration from the replay, not from the original mount.
 *  `stepsSeen` is a Set so re-visiting a step (back-navigation, replay)
 *  doesn't double-count. */
let mountedAt = Date.now()
const stepsSeen = new Set<Step>()
let completedFired = false

function emitCompleted(exitPath: 'cloud' | 'local-new' | 'local-migrate' | 'skipped'): void {
  if (completedFired) return
  completedFired = true
  const durationMs = Date.now() - mountedAt
  // Cohort the onboarding-completion dashboard into fresh-user,
  // returning-user, and Desktop-1-migrator splits via had_legacy /
  // had_existing_install. Without these, the funnel's drop-off
  // analysis collapses all three audiences into one bucket.
  emitTelemetryAction('desktop2.first_use.completed', {
    exit_path: exitPath,
    steps_seen: stepsSeen.size,
    duration_ms: durationMs,
    duration_seconds: Math.round(durationMs / 1000),
    had_legacy: hasLegacyDesktop.value,
    had_existing_install: skipPick.value
  })
}
/** When the host detects prior usage of the launcher (any
 *  non-cloud, non-legacy-desktop install present), the cloud-vs-local
 *  pick is suppressed and Continue routes straight to `complete-skip`
 *  via `routePostStart`. T&C still resets on every `open()` — explicit
 *  re-consent is required on every takeover replay regardless of
 *  `skipPick`. Detection lives in main (`getFirstUseState()`) and is
 *  plumbed in via `open()`. */
const skipPick = ref(false)
/** When a Legacy Desktop install is detected on the machine
 *  (auto-tracked at startup as `sourceId === 'desktop'`),
 *  picking Local opens a follow-up sub-step where the user picks
 *  Migrate vs Install-new instead of immediately chaining into the
 *  new-install takeover. Detection lives in main; the host plumbs the
 *  flag in via `open()`. */
const hasLegacyDesktop = ref(false)
const whyCloudOpen = ref(false)
/** Which legal document to show when the terms modal is open, or null
 *  when the modal is closed. The two consent-row links on the Terms
 *  checkbox set this to 'eula' or 'tos'; the telemetry-row link sets
 *  it to 'privacy'. TermsModal receives the value via its `doc` prop. */
const termsDoc = ref<'eula' | 'tos' | 'privacy' | 'notices' | null>(null)
/** Required acceptance of the Terms of Service / Privacy Policy. The
 *  primary "Get Started" CTA stays disabled until this flips true. The
 *  telemetry checkbox is a separate, optional opt-in (see
 *  `telemetryEnabled`). */
const acceptedTos = ref(false)
/** True while Continue's downstream work (telemetry persist + Express
 *  prep IPC chain) is in flight. Drives the button's spinner + disabled
 *  state so the user gets feedback instead of staring at an unchanged
 *  screen during the multi-IPC express-install pre-roll. */
const isContinuing = ref(false)
/** Briefly true when the user clicks Continue without accepting ToS —
 *  drives a shake animation on the consent row so the required checkbox
 *  is impossible to miss even on tall viewports. */
const tosNudge = ref(false)
let nudgeTimer: ReturnType<typeof setTimeout> | undefined

const isChinese = computed(() => locale.value.startsWith('zh'))

/** Steps that render inside the shared `BrandTakeoverLayout`. Sharing
 *  a single chrome instance across these steps means the takeover
 *  entrance animation plays once on overlay open, not on every internal
 *  step swap. Mirrors still ships as `ModalShell` until it gets the
 *  brand treatment too. */
const isBrandStep = computed(() => step.value === 'start' || step.value === 'localBranch')

/** Single Continue commit for the merged start screen: T&C acceptance,
 *  telemetry pref, fork choice, and the Express-install modifier all
 *  resolve in one click. Telemetry persists immediately so a mid-flow
 *  cancel still respects the user's choice (the `firstUseCompleted`
 *  gate is separate — re-running the takeover surfaces the toggle in
 *  its current persisted state, not as a freshly-defaulted opt-in).
 *  China-mirror sub-step still runs first when the locale calls for
 *  it; the post-mirror branch reuses the same routing logic. */
function nudgeTos(): void {
  if (acceptedTos.value) return
  tosNudge.value = true
  clearTimeout(nudgeTimer)
  nudgeTimer = setTimeout(() => {
    tosNudge.value = false
  }, 600)
}

async function onContinue(): Promise<void> {
  if (isContinuing.value) return
  if (!acceptedTos.value) {
    nudgeTos()
    return
  }
  // Keep `isContinuing` true past `routePostStart()` because the chain
  // handlers (express prep, cloud auto-launch, new-install swap) all
  // either unmount this takeover or swap to a sub-step within ms. The
  // China-mirrors branch is the only path that lingers on this component
  // post-Continue, so it explicitly clears the flag on its return.
  isContinuing.value = true

  await window.api.setSetting('telemetryEnabled', telemetryEnabled.value)

  emitTelemetryAction('desktop2.first_use.consent_decision', {
    decision: telemetryEnabled.value ? 'accept' : 'decline',
    telemetry_enabled: telemetryEnabled.value,
    locale: locale.value
  })
  emitTelemetryAction('desktop2.first_use.fork_chosen', {
    choice: pickedChoice.value,
    has_legacy_desktop: hasLegacyDesktop.value,
    express_install: expressInstall.value,
    // Capacity-protection context. `capacity_status` is the resolved
    // boot-time `desktop-cloud-capacity` flag value at the moment of
    // commit; `was_default` is true when the user kept whatever card
    // was pre-selected for them, false when they actively flipped.
    // `user_tier` is whatever was hydrated from the persisted cache
    // at boot — `unknown` for users who've never opened cloud on this
    // device, `free` / `paid` for returning users. Lets the funnel
    // split conversion by (a) signal-vs-defaulting and (b) the gate
    // tier the user would have hit on dashboard / IPP.
    capacity_status: cloudCapacity.status.value,
    was_default: pickedChoice.value === initialDefaultChoice.value,
    user_tier: cloudCapacity.tier.value
  })

  if (isChinese.value) {
    step.value = 'mirrors'
    isContinuing.value = false
    return
  }

  void routePostStart()
}

/** Post-start routing — shared by `onContinue` (non-China path) and
 *  `chooseMirrors` (China path, after mirrors prompt). Honours
 *  `skipPick` for returning users by short-circuiting to `complete-skip`
 *  regardless of which card was selected. */
async function routePostStart(): Promise<void> {
  if (skipPick.value) {
    emitCompleted('skipped')
    emit('complete-skip')
    return
  }
  if (pickedChoice.value === 'cloud') {
    // Cloud capacity gate. `normal` resolves instantly; `degraded`
    // shows a confirm modal (user can back out); `disabled` resolves
    // false. There's an inherent race: the user can hit Continue with
    // `cloud` still picked before the boot-fetch reactive auto-flip
    // runs (PostHog network ~ a few hundred ms). When that happens,
    // un-stick `isContinuing` so the spinner clears, and flip the
    // pick to Local so a second Continue click just proceeds (the
    // Cloud card is already visually greyed). User sees: spinner
    // disappears, Local is now selected, hit Continue → moves on.
    if (!(await cloudCapacity.confirmEntry())) {
      // Separate event from `fork_chosen` because the user picked cloud
      // but never actually entered it — counting them as a cloud
      // converter would inflate the dashboard. `disabled` means the
      // kill-switch was hard-off (composable returned false directly);
      // `degraded_declined` means the user saw the heavy-load modal
      // and backed out.
      emitTelemetryAction('desktop2.first_use.cloud_blocked', {
        reason: cloudCapacity.isDisabled() ? 'disabled' : 'degraded_declined',
        capacity_status: cloudCapacity.status.value,
        user_tier: cloudCapacity.tier.value
      })
      isContinuing.value = false
      if (cloudCapacity.isDisabled()) pickedChoice.value = 'local'
      return
    }
    emitCompleted('cloud')
    emit('complete-cloud')
  } else if (hasLegacyDesktop.value && !expressInstall.value) {
    // Express takes precedence: when checked, skip the migrate-vs-fresh
    // sub-step and head straight to the express Standalone install. Only
    // surface the localBranch fork when Express is unticked.
    step.value = 'localBranch'
    isContinuing.value = false
  } else {
    emitCompleted('local-new')
    emit('chain-local', { express: expressInstall.value })
  }
}

/** China-mirror prompt always advances regardless of the user's pick;
 *  only the persisted `useChineseMirrors` flag differs.
 *  `chineseMirrorsPrompted` is set in both branches so the
 *  `suggest-chinese-mirrors` listener won't re-fire later. */
async function chooseMirrors(useMirrors: boolean): Promise<void> {
  await Promise.all([
    window.api.setSetting('useChineseMirrors', useMirrors),
    window.api.setSetting('chineseMirrorsPrompted', true)
  ])
  emitTelemetryAction('desktop2.first_use.mirrors_chosen', { use_mirrors: useMirrors })
  void routePostStart()
}

function openWhyCloud(): void {
  whyCloudOpen.value = true
  emitTelemetryAction('desktop2.first_use.why_cloud_opened', {})
}

function dismissWhyCloud(action: 'maybe_later' | 'dismiss'): void {
  whyCloudOpen.value = false
  emitTelemetryAction('desktop2.first_use.why_cloud_action', { action })
}

function onWhyCloudTryCloud(): void {
  whyCloudOpen.value = false
  emitTelemetryAction('desktop2.first_use.why_cloud_action', { action: 'try_cloud' })
  // "Try Cloud" inside the explainer modal flips the start-screen
  // selection to Cloud but leaves the user on the screen so they can
  // accept T&C and press Continue. The legal gate is non-negotiable —
  // we can't auto-commit on the user's behalf.
  pickedChoice.value = 'cloud'
}

function chooseMigrate(): void {
  emitTelemetryAction('desktop2.first_use.local_branch_chosen', { choice: 'migrate' })
  emitCompleted('local-migrate')
  emit('chain-migrate')
}

/** Radiogroup arrow-key handler for the Cloud/Local cards. WAI-ARIA
 *  APG §3.15: arrow keys cycle the checked radio and move DOM focus
 *  along with it. Without this, keyboard-only users can't switch
 *  between the two cards. */
function onStartCardsKeydown(e: KeyboardEvent): void {
  const target = e.target as HTMLElement | null
  if (!target?.closest('[role="radio"]')) return
  const order = ['cloud', 'local'] as const
  const currentIndex = order.indexOf(pickedChoice.value)
  let next: number
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    next = (currentIndex + 1) % order.length
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    next = (currentIndex - 1 + order.length) % order.length
  } else {
    return
  }
  const nextChoice = order[next]
  if (!nextChoice) return
  e.preventDefault()
  pickedChoice.value = nextChoice
  void nextTick(() => {
    const radios = (e.currentTarget as HTMLElement | null)?.querySelectorAll<HTMLElement>(
      '[role="radio"]'
    )
    radios?.[next]?.focus()
  })
}

function chooseInstallNew(): void {
  emitTelemetryAction('desktop2.first_use.local_branch_chosen', { choice: 'install_new' })
  // Skip the dedicated name screen — naming now happens inline on the
  // Configure screen (InstallWizardModal brand-config). Flag the origin so
  // Configure surfaces a Back link returning to localBranch.
  emitCompleted('local-new')
  emit('chain-local', { cameFromLocalBranch: true })
}

interface OpenOpts {
  /** Suppress the cloud-vs-local pick — caller has already detected
   *  that the user has prior launcher usage. Defaults to false. */
  skipPick?: boolean
  /** Surface the migrate-vs-install-new sub-step on the Local branch
   *  because a Legacy Desktop install was detected on this machine.
   *  Defaults to false. */
  hasLegacyDesktop?: boolean
  /** Skip ahead to a specific brand step on open. Used by the
   *  Configure → Back chain to land the user back on the localBranch
   *  sub-step instead of restarting at start. Defaults to 'start'. */
  initialStep?: 'start' | 'localBranch'
}

async function open(opts: OpenOpts = {}): Promise<void> {
  step.value = opts.initialStep ?? 'start'
  skipPick.value = opts.skipPick === true
  hasLegacyDesktop.value = opts.hasLegacyDesktop === true
  whyCloudOpen.value = false
  termsDoc.value = null
  acceptedTos.value = false
  // Re-derive default pick from current capacity. On first mount the
  // `onMounted` `whenReady` await handles this; on takeover replay
  // (capacity already resolved) we apply it inline so a `disabled`
  // flag isn't clobbered by the reset.
  pickedChoice.value = deriveDefaultChoice()
  initialDefaultChoice.value = deriveDefaultChoice()
  expressInstall.value = true
  // Reset funnel-completion bookkeeping so a takeover replay measures
  // duration / steps from the replay, not from the original mount.
  mountedAt = Date.now()
  stepsSeen.clear()
  // Re-seed with the current step so the funnel count includes the
  // initial step on both first mount and replay. The immediate watcher
  // also adds it on first mount, but Set.add is idempotent.
  stepsSeen.add(step.value)
  completedFired = false
  // Pre-load existing telemetry preference so the toggle reflects the
  // user's current persisted choice if the takeover is replaying after
  // a mid-flow cancel (the consent step is the only one that can flip
  // a destructive default).
  const existing = (await window.api.getSetting('telemetryEnabled')) as boolean | undefined
  telemetryEnabled.value = existing !== false
  // Locale + GPU detection run non-blocking so the start hero paints on
  // the first frame even if main is slow to resolve (e.g. cold IPC, no
  // GPU on CI). Sensible defaults (`'en'`, `null`) are already in place;
  // the reactive updates surface the real values when they arrive.
  void window.api
    .getLocale()
    .then((next) => {
      locale.value = next
    })
    .catch(() => {})
  void window.api
    .detectGPU()
    .then((g) => {
      detectedGpuLabel.value = g?.label ?? null
    })
    .catch(() => {})
}

onMounted(() => {
  // Initial mount path — host's `openFirstUseTakeover` calls open()
  // post-mount for the reset, but the auto-mount on PanelApp.onMounted
  // (when `firstUseCompleted === false`) goes through openOverlay
  // before nextTick, so we still need a baseline locale fetch here.
  void open()
})

/**
 * Push the current step to main as the host's `firstUseMode` so:
 *   - `buildTitlePopupMenuItems` can surface the Skip Onboarding entry
 *     once we're past the merged start step (`'post-consent'`).
 *   - The title bar can lock down during `'consent-lockdown'`.
 *
 * `immediate: true` makes the very first mount fire the watcher so the
 * initial step (`'start'`) lands on the host without waiting for a
 * step transition. The merged start screen still gates T&C, so
 * lockdown applies until the user presses Continue and the takeover
 * advances to mirrors / localBranch / completion.
 */
watch(
  step,
  (current) => {
    const mode = current === 'start' ? 'consent-lockdown' : 'post-consent'
    window.api.setFirstUseMode(mode)
    stepsSeen.add(current)
    emitTelemetryAction('desktop2.first_use.step_viewed', {
      step: current,
      skip_pick: skipPick.value,
      has_legacy_desktop: hasLegacyDesktop.value
    })
  },
  { immediate: true }
)

onUnmounted(() => {
  clearTimeout(nudgeTimer)
  // Clear the host's `firstUseMode` whenever the takeover unmounts,
  // regardless of why (Cloud-branch
  // completion, Local-branch chain swap, file-menu Skip Onboarding,
  // OS-chrome window close, dev-tools refresh). The host's
  // `dismissTakeoverDirect` ALSO pushes `'none'` for the renderer-
  // internal dismiss path; the duplicate landing here is harmless and
  // keeps unmount paths that go through useOverlay's silent Tier 3 →
  // Tier 3 swap (chain-local) covered too.
  window.api.setFirstUseMode('none')
})

defineExpose({ open })
</script>

<template>
  <BrandTakeoverLayout v-if="isBrandStep" :vignette="step === 'start'">
    <!-- Step 1: Merged start screen. Wordmark on top, Cloud-vs-Local
         radio cards in the middle, Express-Install opt-out modifier,
         then the legal/telemetry checkboxes and the Continue / Cancel
         action row. T&C must be accepted before Continue activates. -->
    <div v-if="step === 'start'" class="start-screen">
      <div class="brand-hero start-hero">
        <h1 class="brand-title">{{ $t('firstUse.pickTitle') }}</h1>
        <p class="brand-lead">{{ $t('firstUse.pickLead') }}</p>
        <div
          class="start-cards"
          role="radiogroup"
          :aria-label="$t('firstUse.pickTitle')"
          @keydown="onStartCardsKeydown"
        >
          <ChoiceCard
            class="start-card-cloud"
            :class="{ 'start-card-cloud--capacity-disabled': cloudCapacity.isDisabled() }"
            selectable
            :selected="pickedChoice === 'cloud'"
            :aria-disabled="cloudCapacity.isDisabled() ? true : undefined"
            glow
            :label="$t('cloud.label')"
            :tagline="cloudCapacity.isDisabled() ? $t('cloud.capacityDisabled') : (cloudCapacity.isDegraded() ? $t('cloud.capacityDegraded') : $t('firstUse.cloudTagline'))"
            :description="$t(cloudDescriptionKey)"
            data-testid="first-use-pick-cloud"
            @click="cloudCapacity.isDisabled() ? null : (pickedChoice = 'cloud')"
          >
            <template #label-trailing>
              <Tooltip :text="$t('firstUse.whyTryCloud')">
                <button
                  type="button"
                  class="start-cloud-info"
                  :aria-label="$t('firstUse.whyTryCloud')"
                  data-testid="first-use-why-cloud"
                  @click.stop="openWhyCloud"
                >
                  <Info :size="14" />
                </button>
              </Tooltip>
            </template>
          </ChoiceCard>
          <ChoiceCard
            selectable
            :selected="pickedChoice === 'local'"
            :label="$t('firstUse.localLabel')"
            :tagline="$t('firstUse.localTagline')"
            :description="$t('firstUse.localDesc')"
            data-testid="first-use-pick-local"
            @click="pickedChoice = 'local'"
          />
        </div>
        <label
          class="brand-checkbox start-express"
          :class="{ 'start-express--hidden': pickedChoice !== 'local' }"
          :aria-hidden="pickedChoice !== 'local'"
          data-testid="first-use-express-install"
        >
          <input
            v-model="expressInstall"
            type="checkbox"
            :tabindex="pickedChoice === 'local' ? 0 : -1"
          />
          <span class="start-express__body">
            <span class="start-express__label">{{ $t('firstUse.expressInstallLine') }}</span>
            <span
              class="start-express__gpu-hint"
              :class="{ 'start-express__gpu-hint--hidden': !showGpuHint }"
              :aria-hidden="!showGpuHint"
              data-testid="first-use-express-gpu-hint"
            >
              <template v-if="detectedGpuLabel">
                {{ $t('firstUse.expressGpuHintPrefix')
                }}<span class="start-express__gpu-vendor">{{ detectedGpuLabel }}</span
                >{{ $t('firstUse.expressGpuHintSuffix') }}
              </template>
              <template v-else>&nbsp;</template>
            </span>
          </span>
        </label>
      </div>
      <div class="start-bottom">
        <div class="start-consent-strip">
          <div class="start-consent-rows">
            <label
              class="brand-checkbox start-consent-row"
              :class="{ 'start-consent-row--nudge': tosNudge }"
              data-testid="first-use-consent-tos"
            >
              <input v-model="acceptedTos" type="checkbox" />
              <span class="start-consent-row__text">
                {{ $t('firstUse.consentTosHintPrefix') }}
                <button
                  type="button"
                  class="brand-checkbox__link"
                  data-testid="first-use-eula-link"
                  @click.prevent="termsDoc = 'eula'"
                >
                  {{ $t('firstUse.eulaLinkLabel') }}
                </button>
                {{ $t('firstUse.consentTosHintSep') }}
                <button
                  type="button"
                  class="brand-checkbox__link"
                  data-testid="first-use-tos-link"
                  @click.prevent="termsDoc = 'tos'"
                >
                  {{ $t('firstUse.tosLinkLabel') }}</button
                >{{ $t('firstUse.consentTosHintSuffix') }}
              </span>
            </label>
            <label
              class="brand-checkbox start-consent-row"
              data-testid="first-use-consent-telemetry"
            >
              <input v-model="telemetryEnabled" type="checkbox" />
              <span class="start-consent-row__text">
                {{ $t('firstUse.consentTelemetryHint') }}
                <button
                  type="button"
                  class="brand-checkbox__link"
                  data-testid="first-use-telemetry-learn-more"
                  @click.prevent="termsDoc = 'privacy'"
                >
                  {{ $t('common.learnMore') }}
                </button>
              </span>
            </label>
          </div>
          <button
            class="brand-primary start-continue"
            type="button"
            data-testid="first-use-continue"
            :disabled="isContinuing"
            :aria-busy="isContinuing"
            @click="onContinue"
          >
            <Loader2
              v-if="isContinuing"
              :size="16"
              class="start-continue__spinner"
              aria-hidden="true"
            />
            <span>{{
              isContinuing ? $t('firstUse.startContinueBusy') : $t('firstUse.startContinue')
            }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Step 4 (conditional): Local + Legacy Desktop detected. The
         card recipe is intentionally inlined (not ChoiceCard) — it's
         the only place this dense full-width stacked variant ships,
         so a new component or variant prop on ChoiceCard would be
         over-engineering. -->
    <div v-else-if="step === 'localBranch'" class="brand-hero local-branch-hero">
      <h1 class="brand-title">{{ $t('firstUse.localBranchTitle') }}</h1>
      <p class="brand-lead">{{ $t('firstUse.localBranchLead') }}</p>
      <div
        class="local-branch-list"
        role="radiogroup"
        :aria-label="$t('firstUse.localBranchTitle')"
      >
        <button
          type="button"
          class="lb-card lb-card--recommended"
          data-testid="first-use-local-migrate"
          @click="chooseMigrate"
        >
          <span class="lb-card__icon" aria-hidden="true">
            <FolderInput :size="16" :stroke-width="1.75" />
          </span>
          <span class="lb-card__text">
            <span class="lb-card__label">{{ $t('firstUse.localBranchMigrateLabel') }}</span>
            <span class="lb-card__desc">{{ $t('firstUse.localBranchMigrateDesc') }}</span>
          </span>
          <Check class="lb-card__check" :size="16" :stroke-width="2" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="lb-card"
          data-testid="first-use-local-install-new"
          @click="chooseInstallNew"
        >
          <span class="lb-card__icon" aria-hidden="true">
            <Copy :size="16" :stroke-width="1.75" />
          </span>
          <span class="lb-card__text lb-card__text--install-new">
            <span class="lb-card__label">{{ $t('firstUse.localBranchInstallNewLabel') }}</span>
            <span class="lb-card__desc">{{ $t('firstUse.localBranchInstallNewDesc') }}</span>
          </span>
        </button>
      </div>
    </div>

    <template #footer-left>
      <button
        v-if="step === 'localBranch'"
        class="pick-why-cloud"
        data-testid="first-use-local-branch-back"
        type="button"
        @click="step = 'start'"
      >
        ← {{ $t('common.back') }}
      </button>
    </template>

    <WhyTryCloudModal
      v-if="whyCloudOpen"
      @close="dismissWhyCloud('dismiss')"
      @try-cloud="onWhyCloudTryCloud"
    />
    <TermsModal
      v-if="termsDoc"
      :open="termsDoc !== null"
      :doc="termsDoc"
      @close="termsDoc = null"
    />
  </BrandTakeoverLayout>
  <ModalShell v-else binding hide-close content-class="first-use-takeover">
    <!-- Mirrors step retains the legacy ModalShell chrome until it gets
         the brand treatment. First-use is binding — no ✕ close. -->
    <template #header>
      <TakeoverHeader :title="$t('firstUse.grandTitle')" :subtitle="$t('firstUse.grandSubtitle')" />
    </template>
    <div class="view-scroll">
      <template v-if="step === 'mirrors'">
        <h3 class="first-use-step-title">{{ $t('settings.chineseMirrorsSuggestTitle') }}</h3>
        <p class="first-use-mirrors-lead">{{ $t('settings.chineseMirrorsSuggestMessage') }}</p>
      </template>
    </div>

    <div class="wizard-footer">
      <div class="wizard-back-placeholder"></div>
      <div></div>
      <template v-if="step === 'mirrors'">
        <div class="first-use-mirror-buttons">
          <button
            class="secondary"
            data-testid="first-use-mirrors-skip"
            @click="chooseMirrors(false)"
          >
            {{ $t('firstUse.notNow') }}
          </button>
          <button
            class="primary"
            data-testid="first-use-mirrors-accept"
            @click="chooseMirrors(true)"
          >
            {{ $t('settings.chineseMirrorsSuggestConfirm') }}
          </button>
        </div>
      </template>
      <template v-else>
        <div></div>
      </template>
    </div>
  </ModalShell>
</template>

<style scoped>
/* Layout for the legacy first-use modal body (mirrors step only). */
.first-use-takeover {
  display: flex;
  flex-direction: column;
}

.first-use-mirrors-lead {
  font-size: 15px;
  line-height: 1.6;
  color: var(--text);
  margin-bottom: 12px;
}

.first-use-step-title {
  font-size: 18px;
  font-weight: 600;
  margin: 0 0 12px 0;
  color: var(--text);
}

/* Merged start step.
 *
 * Layout: `.start-screen` fills the inner-frame as a vertical flex
 * column. `.start-hero` (title + lead + cards + express) flexes to
 * fill the available space and centres its content vertically so the
 * cards still land on the original `pick`-step beam target.
 * `.start-bottom` (consent rows + Continue) is the natural bottom of
 * the column — no `position: absolute`, so window resizing keeps the
 * two sections from overlapping. */
.start-screen {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  height: 100%;
  max-width: 760px;
  gap: 8px;
}
.start-hero {
  flex: 1 1 auto;
  justify-content: center;
  gap: var(--takeover-gap-md);
  max-width: 760px;
}
.start-cards {
  display: grid;
  width: 100%;
  grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr));
  gap: 32px;
}
/* Cloud card anchors the brand beam — keep the spotlight on the
 * Cloud card the same way the original pick step did. */
.start-card-cloud {
  anchor-name: --brand-beam-target;
}
/* Capacity-protection visual when cloud is currently disabled by the
 * `desktop-cloud-capacity` flag: grey the card and block pointer
 * interaction. The proceed handler also refuses to advance with cloud
 * picked, so this is defense-in-depth + a clear signal to the user. */
.start-card-cloud--capacity-disabled {
  opacity: 0.55;
  cursor: not-allowed;
  pointer-events: none;
}
.start-cloud-info {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 999px;
  background: transparent;
  border: none;
  padding: 0;
  color: color-mix(in oklab, var(--neutral-100) 65%, transparent);
  cursor: pointer;
  transition:
    color 120ms ease,
    background 120ms ease;
}
.start-cloud-info:hover {
  color: var(--neutral-100);
  background: color-mix(in oklab, var(--neutral-100) 10%, transparent);
}
.start-cloud-info:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

/* Express Install — intentionally low-weight: left-aligned single
 * line with the standard brand-checkbox box, smaller font + muted
 * text colour so it reads as an opt-out modifier, not a primary
 * decision. */
.start-express {
  display: inline-flex;
  align-self: center;
  align-items: flex-start;
  gap: 8px;
  margin-top: 4px;
  font-size: 13px;
  color: var(--neutral-300);
  opacity: 1;
  transform: translateY(0);
  transition:
    opacity 180ms ease-out,
    transform 180ms ease-out;
}
.start-express__body {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  min-width: 0;
}
.start-express__gpu-hint {
  font-size: 12px;
  line-height: 1.4;
  color: var(--neutral-400);
  min-height: 1.4em;
  transition: opacity 180ms ease-out;
}
.start-express__gpu-hint--hidden {
  opacity: 0;
  pointer-events: none;
}
.start-express__gpu-vendor {
  font-weight: 500;
  color: var(--neutral-100);
}
/* Cloud pick: reserve the row's space (no layout shift on swap) but
 * fade + nudge the content out and disable pointer/keyboard access. */
.start-express--hidden {
  opacity: 0;
  transform: translateY(-4px);
  pointer-events: none;
}
.start-express__label {
  line-height: 1.4;
}
@media (prefers-reduced-motion: reduce) {
  .start-express {
    transition: none;
  }
}

/* Bottom strip: consent checkboxes + Continue grouped into a single
 * glass panel so they read as one cohesive action block instead of
 * scattered centre-aligned lines. Left-aligned text (checkboxes
 * should never centre-align) with the CTA docked to the right. */
.start-bottom {
  flex: 0 0 auto;
  width: 95%;
}
.start-consent-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 16px 20px;
  border-radius: 10px;
  background: rgba(138, 134, 136, 0.06);
  backdrop-filter: blur(40px);
  border: 1px solid rgba(194, 191, 185, 0.08);
}
.start-consent-rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.start-consent-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: var(--neutral-200);
  line-height: 1.5;
}

.start-consent-row input[type='checkbox'] {
  margin-top: 0;
}
.start-consent-row__text {
  white-space: normal;
}

/* Shake nudge when the user clicks Continue without accepting ToS. */
.start-consent-row--nudge {
  animation: consent-shake 400ms cubic-bezier(0.36, 0.07, 0.19, 0.97) both;
}
.start-consent-row--nudge input[type='checkbox'] {
  border-color: var(--comfy-yellow) !important;
  box-shadow: 0 0 0 2px color-mix(in oklab, var(--comfy-yellow) 30%, transparent);
  transition:
    border-color 150ms ease,
    box-shadow 150ms ease;
}
@keyframes consent-shake {
  10%,
  90% {
    transform: translateX(-1px);
  }
  20%,
  80% {
    transform: translateX(2px);
  }
  30%,
  50%,
  70% {
    transform: translateX(-3px);
  }
  40%,
  60% {
    transform: translateX(3px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .start-consent-row--nudge {
    animation: none;
  }
}

.start-continue {
  flex-shrink: 0;
  min-width: 160px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.start-continue__spinner {
  animation: start-continue-spin 750ms linear infinite;
  flex-shrink: 0;
}
@keyframes start-continue-spin {
  to {
    transform: rotate(360deg);
  }
}

.pick-why-cloud {
  position: absolute;
  left: clamp(1.25rem, 2vw, 2rem);
  bottom: clamp(1.25rem, 2vw, 2rem);
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: none;
  padding: 6px 4px;
  color: color-mix(in oklab, var(--neutral-100) 70%, transparent);
  font: inherit;
  font-size: var(--takeover-fs-body);
  cursor: pointer;
}
.pick-why-cloud:hover {
  color: var(--neutral-100);
  transition: color 120ms ease;
}
.pick-why-cloud:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
  border-radius: 4px;
}

.local-branch-hero {
  max-width: 820px;
}
.local-branch-list {
  display: flex;
  flex-direction: column;
  width: 100%;
  gap: 16px;
}
.lb-card {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 16px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: rgba(138, 134, 136, 0.05);
  backdrop-filter: blur(75px);
  color: var(--neutral-200);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    background 120ms ease,
    border-color 120ms ease,
    color 120ms ease;
}
.lb-card:hover {
  background: rgba(138, 134, 136, 0.1);
  border-color: rgba(194, 191, 185, 0.09);
  color: var(--neutral-100);
}
.lb-card:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}
.lb-card--recommended {
  background: rgba(138, 134, 136, 0.1);
  border-color: rgba(194, 191, 185, 0.09);
  box-shadow: 0 1px 0 0 rgba(255, 255, 255, 0.1) inset;
  color: var(--neutral-100);
}
.lb-card__icon {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 6px;
  background: var(--chooser-surface-bg);
  color: var(--text);
}
.lb-card__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1 1 auto;
}
.lb-card__label {
  font-size: var(--takeover-fs-body);
  color: var(--neutral-100);
}
.lb-card__desc {
  font-size: var(--takeover-fs-body);
  color: var(--neutral-100);
}
.lb-card__text--install-new {
  opacity: 0.5;
}
.lb-card__text--install-new:hover {
  color: var(--text);
  transition: color 120ms ease;
  opacity: 1;
}

.lb-card__check {
  flex: 0 0 auto;
  color: var(--neutral-100);
}

.first-use-mirror-buttons {
  display: flex;
  gap: 8px;
}
</style>
