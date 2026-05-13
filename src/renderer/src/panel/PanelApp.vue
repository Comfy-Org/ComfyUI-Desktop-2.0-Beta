<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import SettingsModal from '../views/SettingsModal.vue'
import ProgressModal from '../views/ProgressModal.vue'
import ModalDialog from '../components/ModalDialog.vue'
import ComfyLifecycleView from './ComfyLifecycleView.vue'
import ChooserView from '../views/ChooserView.vue'
import NewInstallModal from '../views/NewInstallModal.vue'
import TrackModal from '../views/TrackModal.vue'
import LoadSnapshotModal from '../views/LoadSnapshotModal.vue'
import QuickInstallModal from '../views/QuickInstallModal.vue'
import FirstUseTakeover from '../views/FirstUseTakeover.vue'
import { useTheme } from '../composables/useTheme'
import { useSessionStore } from '../stores/sessionStore'
import { useInstallationStore } from '../stores/installationStore'
import { useProgressStore } from '../stores/progressStore'
import { useLauncherPrefs } from '../composables/useLauncherPrefs'
import { useMigrateAction } from '../composables/useMigrateAction'
import { useModal } from '../composables/useModal'
import { useAppUpdatePrompts } from '../composables/useAppUpdatePrompts'
import { useSendFeedback } from '../composables/useSendFeedback'
import { useDeepLinkRouter } from '../composables/useDeepLinkRouter'
import { isFlowPanel, isValidPanel, usePanelOverlays } from './usePanelOverlays'
import { useChooserHandoff } from './useChooserHandoff'
import type { Installation } from '../types/ipc'

const { mergeLocaleMessage, locale, t } = useI18n()
useTheme()

const params = new URLSearchParams(window.location.search)
const installationId = params.get('installationId') || ''

/**
 * Set when the first-use takeover's Local branch chains into the
 * new-install Tier 3 takeover. The new-install modal emits `close`
 * after a successful install (the same hook used everywhere); when
 * that fires while this flag is true the host marks `firstUseCompleted`
 * and clears the flag. A Cloud-branch pick marks completion immediately
 * and never sets this flag, so the two paths can't double-fire the
 * pref write.
 */
const chainingFirstUseToNewInstall = ref(false)

/**
 * Installation id of the Standalone install that the first-use chain
 * (new-install or migration) just kicked off. Captured from the
 * corresponding `show-progress` while a chain flag is set. The
 * progressStore watcher below auto-launches the install once its op
 * finishes successfully, so the user lands on a running ComfyUI as the
 * natural endpoint of first-use without having to click play again.
 */
const pendingFirstUseAutoLaunchId = ref<string | null>(null)

const sessionStore = useSessionStore()
const installationStore = useInstallationStore()
const progressStore = useProgressStore()
const launcherPrefs = useLauncherPrefs()

const modal = useModal()
const { showAppUpdateRestartPrompt, showAppUpdateDownloadPrompt } = useAppUpdatePrompts()
useSendFeedback()

// installationStore.fetchInstallations() is wired to onInstallationsChanged
// inside the store itself, so the panel just needs to read from it.
const installation = computed<Installation | null>(
  () => (installationId ? installationStore.getById(installationId) ?? null : null),
)

/**
 * Resolves once `onMounted` has finished its async bootstrap (locale +
 * sessionStore + installationStore + launcherPrefs). The install-update
 * deep-link handler awaits this before resolving the installation so a
 * `panel-trigger-overlay` IPC that arrives during the panelView's first
 * `did-finish-load` (i.e. before the store has hydrated) doesn't
 * silently drop the click — it queues until the unified Settings modal
 * can render against a populated store and translated copy.
 */
let resolveBootstrap: (() => void) | null = null
const bootstrapReady: Promise<void> = new Promise<void>((resolve) => {
  resolveBootstrap = resolve
})

// Template refs for the overlay slot's mounted components — the
// composable consumes these but doesn't own them so vue-tsc can see
// the bindings as used by the template's `ref="…"` props.
const progressRef = ref<InstanceType<typeof ProgressModal> | null>(null)
const newInstallRef = ref<InstanceType<typeof NewInstallModal> | null>(null)
const trackRef = ref<InstanceType<typeof TrackModal> | null>(null)
const loadSnapshotRef = ref<InstanceType<typeof LoadSnapshotModal> | null>(null)
const quickInstallRef = ref<InstanceType<typeof QuickInstallModal> | null>(null)
const firstUseRef = ref<InstanceType<typeof FirstUseTakeover> | null>(null)

// usePanelOverlays + useChooserHandoff form a small dependency cycle:
// the overlay's `handleShowProgress` needs to subscribe the chooser
// host's close-on-instance-started fallback when an install-less
// host fires a launch-class op; the chooser handoff needs to mount
// its launches through the overlay's `handleShowProgress` and use
// `switchPanel` for the missing-launch-action fallback. Break the
// cycle with a deferred lazy reference: the overlays composable
// receives a callback that reads `chooserHandoff` at call time, by
// which point chooserHandoff has been assigned below.
let chooserHandoff!: ReturnType<typeof useChooserHandoff>

const {
  activePanel,
  initialPanel,
  currentOverlay,
  openOverlay,
  closeOverlay,
  handleShowProgress,
  handleProgressClose,
  openFirstUseTakeover,
  dismissTakeoverDirect,
  switchPanel,
} = usePanelOverlays({
  installationId,
  installation,
  progressRef,
  newInstallRef,
  trackRef,
  loadSnapshotRef,
  quickInstallRef,
  firstUseRef,
  prepareChooserHostHandoff: (id) => chooserHandoff.prepareChooserHostHandoff(id),
  firstUseChain: {
    shouldForceTakeover: () => chainingFirstUseToNewInstall.value,
    onShowProgress: (showOpts) => {
      // Capture the operation's installation id when a first-use chain
      // is in flight (new-install or migrate). The progressStore
      // watcher below auto-launches the resulting install once the op
      // finishes successfully. New-install ops carry the new install's
      // id directly; migrate ops carry the Legacy Desktop install's id
      // and the watcher resolves the resulting Standalone install
      // after the op finishes. Only the first chained op captures the
      // id — subsequent show-progress calls leave it untouched.
      if (chainingFirstUseToNewInstall.value && pendingFirstUseAutoLaunchId.value === null) {
        pendingFirstUseAutoLaunchId.value = showOpts.installationId
        // Flip the persisted gate now so the takeover doesn't re-run
        // on the next launch — the overlay handoff doesn't go through
        // NewInstallModal's close emit.
        void launcherPrefs.markFirstUseCompleted()
      }
    },
  },
})

chooserHandoff = useChooserHandoff({
  showProgress: handleShowProgress,
  switchPanel,
})
const { performChooserLaunch, handleChooserPick, handleChooserShowNewInstall } = chooserHandoff

let unsubPanel: (() => void) | null = null
let unsubLocale: (() => void) | null = null
let unsubCloseRequest: (() => void) | null = null
let unsubFirstUseSkip: (() => void) | null = null
let unsubAppUpdatePromptRestart: (() => void) | null = null
let unsubAppUpdateUserActionFailed: (() => void) | null = null

useDeepLinkRouter({
  installationId,
  bootstrapReady,
  openOverlay,
  showAppUpdateRestartPrompt,
  showAppUpdateDownloadPrompt,
})

async function loadLocale(): Promise<void> {
  const messages = await window.api.getLocaleMessages()
  // Merge — not replace — so the renderer-side catalog from
  // `lib/i18nMessages.ts` (the authoritative en source for keys main
  // doesn't yet ship in `locales/en.json`, e.g. `downloadsTab.*`,
  // `downloadsPopup.*`, `fileMenu.*`) survives this layer-on of
  // main's JSON.
  mergeLocaleMessage('en', messages)
  locale.value = 'en'
}

/** Shared completion helper. The Cloud-branch pick
 *  (`handleFirstUseComplete`), the file-menu Skip Onboarding entry
 *  (`onFirstUseSkip` listener) and the new-install chain close
 *  (`handleNewInstallTakeoverClose`) all run the same
 *  `markFirstUseCompleted` → dismiss sequence; extracting the pair
 *  keeps them in sync if the gate flip ever needs extra state cleanup. */
async function completeFirstUseAndDismiss(): Promise<void> {
  // Clear chain state so the auto-launch watcher doesn't fire after a
  // Skip Onboarding triggered mid-chain (the user wants OUT of
  // onboarding, not to land on a freshly-installed Comfy).
  chainingFirstUseToNewInstall.value = false
  pendingFirstUseAutoLaunchId.value = null
  await launcherPrefs.markFirstUseCompleted()
  // dismissTakeoverDirect pushes `'none'` only when the overlay is
  // the first-use takeover itself; chain dismiss paths can have a
  // new-install / progress takeover in the slot, so push it
  // explicitly to keep the file-menu builder in steady state.
  window.api.setFirstUseMode('none')
  dismissTakeoverDirect()
}

/** First-use takeover Cloud-branch pick (`complete-cloud` emit) — the
 *  user explicitly picked Cloud at the cloud-vs-local fork. Mark
 *  completion, close the takeover, and auto-launch the always-present
 *  Cloud install so they reach a running ComfyUI as the natural
 *  endpoint of first-use without having to click play again. The
 *  launch goes through the same `useListAction` pipeline the chooser
 *  uses (close-host-window-on-instance-started, etc.). If the cloud
 *  install can't be found we still mark complete and close the
 *  takeover — the chooser body underneath is the fallback.
 *
 *  The returning-user `complete-skip` emit is wired directly to
 *  `completeFirstUseAndDismiss` instead — those users never picked
 *  Cloud (the fork was suppressed), so auto-launching it would hijack
 *  their existing local install. */
async function handleFirstUseComplete(): Promise<void> {
  chainingFirstUseToNewInstall.value = false
  // Mark completion but DON'T dismiss the takeover yet — dismissing
  // first would expose the dashboard underneath while the launch
  // action races to mount its own progress overlay. Cloud's launch
  // action has `showProgress: true`, so the launch goes through
  // `handleShowProgress` → `openOverlay({ kind: 'takeover',
  // component: 'update' })` which silently swaps the first-use
  // takeover for the connect-progress takeover (Tier 3 → Tier 3).
  await launcherPrefs.markFirstUseCompleted()
  window.api.setFirstUseMode('none')
  // Find the auto-seeded Cloud install. The store may not be hydrated
  // yet on first-launch, so we fall back to a fresh fetch via main.
  let cloud = installationStore.installations.find((i) => i.sourceCategory === 'cloud') ?? null
  if (!cloud) {
    try {
      const all = await window.api.getInstallations()
      cloud = all.find((i) => i.sourceCategory === 'cloud') ?? null
    } catch {}
  }
  if (cloud) {
    // If the cloud install has no resolvable launch action (defensive
    // fallback — production cloud sources always provide one), dismiss
    // the takeover so the user lands on the chooser body. The happy
    // path leaves the takeover up; the launch action's `showProgress:
    // true` swaps it for a connect-progress takeover via
    // `handleShowProgress` (Tier 3 → Tier 3 silent).
    await performChooserLaunch(cloud, dismissTakeoverDirect)
    return
  }
  // No cloud install to launch into — fall back to dismissing the
  // takeover so the user lands on the chooser body underneath.
  dismissTakeoverDirect()
}

/** First-use takeover Local-branch pick — chain into the new-install
 *  Tier 3 takeover. The Tier 3 → Tier 3 swap is silent in
 *  `useOverlay`, so the first-use takeover unmounts as the new-install
 *  takeover mounts. The completion flip is deferred to the new-install
 *  close path (see `handleNewInstallTakeoverClose`). */
async function handleFirstUseChainLocal(): Promise<void> {
  chainingFirstUseToNewInstall.value = true
  pendingFirstUseAutoLaunchId.value = null
  await switchPanel('new-install', 'first_use')
  // FirstUseTakeover.onUnmounted just pushed `'none'` as the chain
  // swap unmounted it. Re-assert `'post-consent'` so the file-menu
  // builder keeps the chain locked down to Skip Onboarding while
  // the new-install / install-progress takeover is up.
  window.api.setFirstUseMode('post-consent')
}

/** First-use takeover migrate-branch pick — runs the migrate-to-
 *  standalone action against the auto-tracked Legacy Desktop install.
 *  Same shape as the chain-local path: the migration progress op
 *  flows through `handleShowProgress` (Tier 2 progress modal),
 *  capturing `pendingFirstUseAutoLaunchId` for the resulting
 *  Standalone install along the way. The progressStore watcher below
 *  auto-launches once the op finishes successfully. */
const { confirmMigration } = useMigrateAction()
async function handleFirstUseChainMigrate(): Promise<void> {
  let legacy = installationStore.installations.find((i) => i.sourceId === 'desktop') ?? null
  if (!legacy) {
    try {
      const all = await window.api.getInstallations()
      legacy = all.find((i) => i.sourceId === 'desktop') ?? null
    } catch {}
  }
  if (!legacy) {
    // Detection drift — main flagged hasLegacyDesktop=true but the
    // install is gone now. Bail to chain-local so the user still gets
    // to the new-install Standalone path.
    handleFirstUseChainLocal()
    return
  }
  // confirmMigration shows its own modal (variant pick / preview /
  // confirm); a `null` return means user cancelled, in which case we
  // leave the takeover mounted on the localBranch step (no state
  // change).
  const result = await confirmMigration(legacy)
  if (!result) return

  // Pre-mark the chain so the new install kicked off by migration
  // gets captured as the auto-launch target. The migration emits
  // installations-changed when the new Standalone install is added,
  // and `handleShowProgress` carries the `installationId` through —
  // we record it there.
  chainingFirstUseToNewInstall.value = true
  pendingFirstUseAutoLaunchId.value = null
  // Dismiss the takeover before kicking off the migration so the
  // Tier 2 progress modal isn't blocked by the takeover overlay.
  dismissTakeoverDirect()
  await handleShowProgress({
    installationId: legacy.id,
    title: `Migrating — ${legacy.name}`,
    apiCall: () => window.api.runAction(legacy!.id, 'migrate-to-standalone', result),
    cancellable: true,
  })
  // dismissTakeoverDirect pushed `'none'` as it cleared the first-use
  // overlay; re-assert `'post-consent'` so the file-menu builder
  // keeps the chain locked down to Skip Onboarding for the duration
  // of the migration progress + auto-launch.
  window.api.setFirstUseMode('post-consent')
}

/** Wrapper around `closeOverlay` for the new-install takeover branch
 *  that also flips `firstUseCompleted` when the close arrives at the
 *  end of a first-use → Local chain. The new-install modal emits
 *  `close` after a successful install AND on user-cancel (✕); both
 *  cases count as "the user got past the cloud-or-local pick". */
async function handleNewInstallTakeoverClose(): Promise<void> {
  if (chainingFirstUseToNewInstall.value) {
    await launcherPrefs.markFirstUseCompleted()
    // The chain pushed `'post-consent'` to keep Skip Onboarding the
    // only file-menu entry while the new-install takeover was up.
    // Clear it here — whatever follows (dismiss back to chooser, or
    // an in-flight progress / launch overlay swap) is post-onboarding.
    window.api.setFirstUseMode('none')
    // Don't clear `chainingFirstUseToNewInstall` yet — the auto-launch
    // watcher uses it together with `pendingFirstUseAutoLaunchId` to
    // decide whether to fire. The watcher clears both after launch.
  }
  // Only dismiss when the new-install takeover is still in the slot.
  // The happy-path install handoff in NewInstallModal swaps the
  // overlay to a progress takeover via @show-progress without first
  // emitting `close`, but `@navigate-list` still routes here for the
  // skipInstall branch — and dismissing then would clear an unrelated
  // overlay if anything else has claimed the slot in between.
  if (
    currentOverlay.value?.kind === 'takeover'
    && currentOverlay.value.component === 'new-install'
  ) {
    dismissTakeoverDirect()
  }
}

/** Watch progressStore for the new-install / migration op finishing
 *  and auto-launch the resulting Standalone install. The chain flag
 *  (`chainingFirstUseToNewInstall`) gates the watcher so we only
 *  auto-launch when the op was actually driven by the first-use
 *  chain. The captured id is set inside `usePanelOverlays`'
 *  `firstUseChain.onShowProgress` hook at the moment the chained op
 *  begins. */
watch(
  () => {
    const id = pendingFirstUseAutoLaunchId.value
    if (!id) return null
    const op = progressStore.operations.get(id)
    return op && op.finished ? op : null
  },
  async (op) => {
    if (!op) return
    if (!chainingFirstUseToNewInstall.value) return
    const id = pendingFirstUseAutoLaunchId.value
    chainingFirstUseToNewInstall.value = false
    pendingFirstUseAutoLaunchId.value = null
    // Chain is done (success or failure) — drop the file-menu lock.
    // The launch path that follows (when the op succeeded) replaces
    // the install-progress takeover with its own connect-progress
    // takeover; either way the user is past onboarding now.
    window.api.setFirstUseMode('none')
    if (!id) return
    if (op.cancelRequested || op.error || !op.result?.ok) return
    // The migrate-to-standalone op runs against the Legacy Desktop
    // install but produces a fresh Standalone install — wait for the
    // store to reflect the new install, then launch the most-recently-
    // created non-cloud, non-legacy local install (the migration's
    // result). For new-install ops, the captured id is the new install's
    // id directly so this branch resolves immediately.
    let inst = installationStore.installations.find((i) => i.id === id) ?? null
    if (!inst || inst.sourceId === 'desktop') {
      try {
        await installationStore.fetchInstallations()
      } catch {}
      inst = installationStore.installations.find(
        (i) => (i as unknown as { copiedFrom?: string }).copiedFrom === id,
      ) ?? installationStore.installations
        .filter((i) => i.sourceCategory === 'local')
        .sort((a, b) => Date.parse(String(b.createdAt ?? '')) - Date.parse(String(a.createdAt ?? '')))[0]
        ?? null
    }
    if (inst) {
      void performChooserLaunch(inst)
    }
  },
  { deep: false },
)

function handleUpdateInstallation(inst: Installation): void {
  // Optimistic local update for snappier UX while the broadcast-driven
  // refetch is in flight (e.g. rename via the editable title).
  const idx = installationStore.installations.findIndex((i) => i.id === inst.id)
  if (idx >= 0) installationStore.installations.splice(idx, 1, inst)
}

function handleNavigateList(): void {
  // The install was removed from the list (e.g. deleted, migrated). The
  // ComfyUI window that hosts this panel no longer has an install backing
  // it, so ask main to close the parent window. Falls back to the
  // missing-install placeholder if the close fails for any reason
  // (e.g. window already torn down) — the onInstallationsChanged broadcast
  // wired into installationStore has already cleared the local record.
  if (installationId) {
    void window.api.closeComfyWindow(installationId)
  }
}

onMounted(async () => {
  await loadLocale()

  unsubLocale = window.api.onLocaleChanged((messages) => {
    mergeLocaleMessage('en', messages as Record<string, unknown>)
  })

  // Main can request a panel switch (e.g. from title-bar buttons, or when
  // the install lifecycle changes — main flips us to 'comfy-lifecycle' when
  // the instance stops so the Comfy tab body shows the right transient UI).
  // Flow panels (new-install / track / load-snapshot / quick-install) need
  // the imperative open() reset to run after mount, so funnel through
  // switchPanel() rather than assigning activePanel directly.
  unsubPanel = window.api.onPanelSwitch((data) => {
    if (isValidPanel(data.panel)) {
      void switchPanel(data.panel)
    }
  })

  // Main consults the panel renderer before tearing down the host
  // window. Funnel the consult through `closeOverlay()` so a Tier 2
  // progress / Tier 3 takeover op can prompt the user via the
  // standardised cancel-prompt copy. `closeOverlay` returns true when
  // the slot is empty or the user confirmed cancellation; false when
  // the user dismissed the prompt. We echo the boolean back to main
  // along with the original `requestId` so main can pair it with the
  // request that fired it.
  unsubCloseRequest = window.api.onCloseRequest(({ requestId }) => {
    // Ack synchronously so main extends its hung-renderer timeout —
    // the actual response can take arbitrary time when the user is
    // looking at a cancel-prompt confirmation modal, and the old
    // 5s response timeout was racing slow user input and force-
    // closing the window.
    window.api.ackCloseRequest({ requestId })
    void (async () => {
      const cleared = currentOverlay.value === null ? true : await closeOverlay()
      window.api.respondCloseRequest({ requestId, cleared })
    })()
  })

  // Auto-fire the restart prompt when an auto-off user-initiated
  // download finishes — closes the loop on the single-gesture flow
  // (Download → wait → Restart) without forcing the user to find the
  // pill again.
  unsubAppUpdatePromptRestart = window.api.onAppUpdatePromptRestart(({ version }) => {
    void showAppUpdateRestartPrompt(version || null)
  })

  // Surface user-initiated update failures (download/install) as an
  // alert. Background auto-on download errors stay silent (main
  // doesn't broadcast them on this channel).
  unsubAppUpdateUserActionFailed = window.api.onAppUpdateUserActionFailed(({ message }) => {
    void modal.alert({
      title: t('appUpdate.errorTitle'),
      message,
    })
  })

  // Main forwards a file-menu Skip Onboarding click here. Run the
  // same `markFirstUseCompleted` + dismiss-takeover sequence the
  // Cloud-branch pick uses; if the overlay isn't a first-use takeover
  // (defensive — main only sends this when the menu surfaced the
  // entry, which only happens in `post-consent`) the dismiss is a
  // no-op for the overlay slot but the gate flip still has to land
  // so the takeover doesn't auto-remount on the next launch.
  unsubFirstUseSkip = window.api.onFirstUseSkip(() => {
    void completeFirstUseAndDismiss()
  })

  // Initialize stores / prefs needed by the embedded DetailModal that
  // backs the unified Settings modal's "ComfyUI Settings" tab.
  // installationStore wires its own onInstallationsChanged listener.
  await Promise.all([
    sessionStore.init(),
    installationStore.fetchInstallations(),
    launcherPrefs.loadPrefs(),
  ])

  // Release any panel-trigger-overlay handler that arrived during the
  // async bootstrap and parked on `bootstrapReady`. By this point the
  // installation store, session store, and locales are all populated,
  // so the unified Settings modal can render correctly on the first
  // install-update pill click.
  resolveBootstrap?.()
  resolveBootstrap = null

  // If the URL-driven initial panel mounts as an overlay (flow wizard
  // or unified Settings modal), kick that open now — script-setup
  // couldn't because the template hadn't rendered yet.
  if (isFlowPanel(initialPanel) || initialPanel === 'settings') {
    void switchPanel(initialPanel, 'url')
  }

  // First-use takeover auto-mounts when the persisted gate is still
  // false. Runs AFTER the URL-driven flow panel branch so a
  // `?panel=new-install` request still wins (e.g. when main re-routes
  // a chooser pick into new-install for an un-installed source); the
  // first-use takeover will replay on the next launch since
  // `firstUseCompleted` stays false until the explicit completion
  // path runs.
  if (!launcherPrefs.firstUseCompleted.value && !isFlowPanel(initialPanel)) {
    void openFirstUseTakeover()
  }
})

onUnmounted(() => {
  unsubPanel?.()
  unsubLocale?.()
  unsubCloseRequest?.()
  unsubFirstUseSkip?.()
  unsubAppUpdatePromptRestart?.()
  unsubAppUpdateUserActionFailed?.()
  sessionStore.dispose()
})
</script>

<template>
  <div class="panel-shell">
    <main class="panel-content">
      <div v-if="activePanel === 'comfy-lifecycle'" class="panel-comfy-lifecycle">
        <ComfyLifecycleView
          :installation="installation"
          :installation-id="installationId"
          @show-progress="handleShowProgress"
        />
      </div>

      <div v-else-if="activePanel === 'chooser'" class="panel-chooser">
        <ChooserView
          @pick="handleChooserPick"
          @show-new-install="handleChooserShowNewInstall"
          @show-progress="handleShowProgress"
        />
      </div>

    </main>

    <!-- Host-level overlay slot. One DOM node at a
         time, owned by `useOverlay`. Mounts either a Tier 1 popover,
         the in-flight progress modal (Tier 2), or one of the Tier 3
         takeovers (the four flow modals + the first-use takeover).
         The branches are mutually exclusive because `useOverlay` only
         ever holds one overlay in `current.value`.

         App-update is NOT in this chain — the title-bar app-update
         pill click pops a `useModal.confirm` modal (issue #488) that
         lives in the global ModalDialog mount below, not in the
         overlay slot. -->
    <!-- Tier 1 unified Settings modal. Mounted with `installation`
         carried by the overlay payload (chooser-card Manage uses
         the card's install, install-pill / waffle uses the host's
         install, install-less host's waffle entry passes null).
         The body underneath stays on chooser / comfy-lifecycle so
         dismissing returns there. -->
    <SettingsModal
      v-if="currentOverlay?.kind === 'settings'"
      :installation="currentOverlay.installation"
      :initial-tab="currentOverlay.initialTab"
      :initial-detail-tab="currentOverlay.initialDetailTab"
      :auto-action="currentOverlay.autoAction"
      :no-sidebar="currentOverlay.noSidebar"
      @close="dismissTakeoverDirect"
      @show-progress="handleShowProgress"
      @update:installation="handleUpdateInstallation"
      @navigate-list="handleNavigateList"
    />
    <!-- Tier 2 progress slot. ProgressModal owns its own backdrop via
         the unified Modal primitive. -->
    <ProgressModal
      v-else-if="currentOverlay?.kind === 'progress'"
      ref="progressRef"
      :installation-id="currentOverlay.installationId"
      @close="handleProgressClose"
    />

    <!-- Tier 3 binding modals. Each child component owns its own
         backdrop via the unified Modal primitive. -->
    <template v-else-if="currentOverlay?.kind === 'takeover'">
      <ProgressModal
        v-if="currentOverlay.component === 'update'"
        ref="progressRef"
        :installation-id="currentOverlay.installationId ?? ''"
        binding
        @close="handleProgressClose"
      />
      <NewInstallModal
        v-else-if="currentOverlay.component === 'new-install'"
        ref="newInstallRef"
        :hide-back-to-dashboard="chainingFirstUseToNewInstall"
        @close="handleNewInstallTakeoverClose"
        @navigate-list="handleNewInstallTakeoverClose"
        @show-progress="handleShowProgress"
      />
      <TrackModal
        v-else-if="currentOverlay.component === 'track'"
        ref="trackRef"
        @close="dismissTakeoverDirect"
        @navigate-list="dismissTakeoverDirect"
      />
      <LoadSnapshotModal
        v-else-if="currentOverlay.component === 'load-snapshot'"
        ref="loadSnapshotRef"
        @close="dismissTakeoverDirect"
        @show-progress="handleShowProgress"
      />
      <QuickInstallModal
        v-else-if="currentOverlay.component === 'quick-install'"
        ref="quickInstallRef"
        @close="dismissTakeoverDirect"
        @show-progress="handleShowProgress"
      />
      <FirstUseTakeover
        v-else-if="currentOverlay.component === 'first-use'"
        ref="firstUseRef"
        @complete-cloud="handleFirstUseComplete"
        @complete-skip="completeFirstUseAndDismiss"
        @chain-local="handleFirstUseChainLocal"
        @chain-migrate="handleFirstUseChainMigrate"
      />
    </template>

    <ModalDialog />
  </div>
</template>

<style scoped>
.panel-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100vw;
  background: var(--bg);
  color: var(--text);
  overflow: hidden;
}

.panel-content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  /* Match the launcher window's `.content` padding so tab-mode views
   * (SettingsView etc.) have the same gutter as in the standalone window. */
  padding: 24px 28px;
  overflow: hidden;
}

/* The comfy-lifecycle view fills its own background and the chooser
 * owns its own filter / grid padding (and needs the full panel height
 * so its grid can scroll vertically) — negate the panel-content
 * gutter for those branches. */
.panel-content:has(.panel-comfy-lifecycle),
.panel-content:has(.panel-chooser) {
  padding: 0;
}

.panel-comfy-lifecycle,
.panel-chooser {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.panel-placeholder {
  padding: 24px;
  color: var(--text-muted);
  font-size: 14px;
  line-height: 1.6;
}

.panel-placeholder code {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
</style>
