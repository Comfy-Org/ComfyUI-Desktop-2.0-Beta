<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import ProgressModal from '../views/ProgressModal.vue'
import ModalDialog from '../components/ModalDialog.vue'
import DownloadsModal from '../components/DownloadsModal.vue'
import FeedbackModal from '../components/FeedbackModal.vue'
import ComfyLifecycleView from './ComfyLifecycleView.vue'
import ChooserView from '../views/ChooserView.vue'
import InstallWizardModal from '../views/InstallWizardModal.vue'
import TrackModal from '../views/TrackModal.vue'
import LoadSnapshotModal from '../views/LoadSnapshotModal.vue'
import QuickInstallModal from '../views/QuickInstallModal.vue'
import FirstUseTakeover from '../views/FirstUseTakeover.vue'
import MigrateConfirmTakeover from '../views/MigrateConfirmTakeover.vue'
import { useTheme } from '../composables/useTheme'
import { useSessionStore } from '../stores/sessionStore'
import { useInstallationStore } from '../stores/installationStore'
import { seedLauncherPrefsFromUrl, useLauncherPrefs } from '../composables/useLauncherPrefs'
import { useModal } from '../composables/useModal'
import { useAppUpdatePrompts } from '../composables/useAppUpdatePrompts'
import { useReturnToDashboardConfirm } from '../composables/useReturnToDashboardConfirm'
import { useQuitDesktopConfirm } from '../composables/useQuitDesktopConfirm'
import { useSendFeedback } from '../composables/useSendFeedback'
import { emitTelemetryAction } from '../lib/telemetry'
import { useDeepLinkRouter } from '../composables/useDeepLinkRouter'
import { useInstallContextMenu } from '../composables/useInstallContextMenu'
import { registerMigrateTakeover } from '../composables/useMigrateAction'
import { isFlowPanel, isValidPanel, usePanelOverlays } from './usePanelOverlays'
import { useChooserHandoff } from './useChooserHandoff'
import { useFirstUseChain } from './useFirstUseChain'
import { bindE2EPanelHooks } from './e2eRendererHooks'
import { resolvePickerTab } from '../lib/pickerTabs'
import type { Installation } from '../types/ipc'

const { mergeLocaleMessage, locale, t } = useI18n()
useTheme()

const params = new URLSearchParams(window.location.search)
const installationId = params.get('installationId') || ''
// Main passes the persisted first-use gate synchronously so cold
// start doesn't wait on IPC before painting chooser vs takeover.
seedLauncherPrefsFromUrl(window.location.search)
const urlFirstUseCompleted = params.get('firstUseCompleted') === 'true'
const urlFirstUsePending = params.get('firstUseCompleted') === 'false'

const sessionStore = useSessionStore()
const installationStore = useInstallationStore()
const launcherPrefs = useLauncherPrefs()
// Overlap the IPC round-trip with panel bundle parse / Vue mount.
void launcherPrefs.loadPrefs()
// Surface `loaded` as a top-level template binding so Vue auto-unwraps
// it in the body-gate `v-if`. Refs accessed as object properties on
// `launcherPrefs` aren't auto-unwrapped in templates, only top-level
// setup bindings are.
const { loaded: launcherPrefsLoaded, firstUseCompleted } = launcherPrefs

const modal = useModal()
const { showAppUpdateRestartPrompt, showAppUpdateDownloadPrompt } = useAppUpdatePrompts()
const { feedbackOpen, feedbackUrl, closeFeedback } = useSendFeedback()

// installationStore.fetchInstallations() is wired to onInstallationsChanged
// inside the store itself, so the panel just needs to read from it.
const installation = computed<Installation | null>(() =>
  installationId ? (installationStore.getById(installationId) ?? null) : null
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
const newInstallRef = ref<InstanceType<typeof InstallWizardModal> | null>(null)
const trackRef = ref<InstanceType<typeof TrackModal> | null>(null)
const loadSnapshotRef = ref<InstanceType<typeof LoadSnapshotModal> | null>(null)
const quickInstallRef = ref<InstanceType<typeof QuickInstallModal> | null>(null)
const firstUseRef = ref<InstanceType<typeof FirstUseTakeover> | null>(null)
const migrateTakeoverRef = ref<InstanceType<typeof MigrateConfirmTakeover> | null>(null)

// The three panel composables form a small dependency cycle:
//   - useFirstUseChain needs overlay helpers (dismissTakeoverDirect,
//     switchPanel, handleShowProgress) and chooser launch.
//   - usePanelOverlays needs the chain's hooks bag + the chooser's
//     prepareChooserHostHandoff.
//   - useChooserHandoff needs the overlay's handleShowProgress +
//     switchPanel.
// Break the cycle with deferred lazy references: composables that
// have to be instantiated first take callbacks that read the later-
// assigned holders at call time (not at construction time). By the
// time any callback fires (user click, IPC, watcher) all three
// holders are populated.
let overlays!: ReturnType<typeof usePanelOverlays>
let chooserHandoff!: ReturnType<typeof useChooserHandoff>

const firstUseChain = useFirstUseChain({
  dismissTakeoverDirect: () => overlays.dismissTakeoverDirect(),
  switchPanel: (panel, entrypoint) => overlays.switchPanel(panel, entrypoint),
  handleShowProgress: (showOpts) => overlays.handleShowProgress(showOpts),
  performChooserLaunch: (inst, onMissing) => chooserHandoff.performChooserLaunch(inst, onMissing),
  openFirstUseTakeover: (firstUseOpts) => overlays.openFirstUseTakeover(firstUseOpts),
})
const {
  chainingFirstUseToNewInstall,
  completeFirstUseAndDismiss,
  handleFirstUseComplete,
  handleFirstUseChainLocal,
  handleFirstUseChainMigrate,
  handleNewInstallTakeoverClose,
  handleNewInstallBackToLocalBranch,
} = firstUseChain

overlays = usePanelOverlays({
  installationId,
  progressRef,
  newInstallRef,
  trackRef,
  loadSnapshotRef,
  quickInstallRef,
  firstUseRef,
  prepareChooserHostHandoff: (id) => chooserHandoff.prepareChooserHostHandoff(id),
  firstUseChain: firstUseChain.hooks,
})
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
} = overlays

// E2E surface: tests drive UI-level flows (e.g. inject a finished
// failed op to render ProgressModal's error state) by calling into
// `handleShowProgress` from outside the Vue tree. Gated on the
// `e2e=1` URL flag main propagates only when `process.env.E2E === '1'`,
// matching the registration gate in `panel/main.ts`; `__e2eRenderer`
// is never present in production.
if (params.get('e2e') === '1') {
  bindE2EPanelHooks({ showProgress: handleShowProgress })
}

const firstUseTakeoverActive = computed(
  () =>
    currentOverlay.value?.kind === 'takeover' &&
    currentOverlay.value.component === 'first-use',
)

/** Chooser/lifecycle body: show immediately when main already knows
 *  first-use is done; otherwise wait for prefs IPC. Always hide while
 *  the first-use takeover is mounted (prevents chooser bleed-through). */
const showPanelBody = computed(() => {
  if (firstUseTakeoverActive.value) return false
  if (urlFirstUseCompleted) return true
  return launcherPrefsLoaded.value && firstUseCompleted.value
})

chooserHandoff = useChooserHandoff({
  showProgress: handleShowProgress,
  switchPanel,
})
const { handleChooserPick, handleChooserShowNewInstall } = chooserHandoff

// When an overlay closes on a chooser host without producing an attach
// (cancel / error / dismiss), revert the install identity preview that
// `claimAttachHost` pushed to the title bar — otherwise the chooser host
// keeps showing the last-attempted install's name. On a successful
// attach the chooser PanelApp tears down before this watcher fires, so
// the happy path never triggers a release.
if (!installationId) {
  watch(currentOverlay, (next, prev) => {
    if (prev && !next) {
      void window.api.releaseAttachHostPreview()
    }
  })
}

let unsubPanel: (() => void) | null = null
let unsubLocale: (() => void) | null = null
let unsubCloseRequest: (() => void) | null = null
let unsubReturnToDashboardRequest: (() => void) | null = null
let unsubAppUpdatePromptRestart: (() => void) | null = null
let unsubAppUpdateUserActionFailed: (() => void) | null = null
const { confirmReturnToDashboard } = useReturnToDashboardConfirm()
const { confirmQuitDesktop } = useQuitDesktopConfirm()

// All Manage routes go through `window.api.openInstancePicker` — the picker's
// expanded mode is the single per-install settings surface. Delete keeps its
// fast path (confirm + show-progress) so the user never sees the picker for
// that action; everything else opens the picker.
const { triggerAction: triggerInstallAction } = useInstallContextMenu({
  onManage: (inst, manageOpts) => {
    const autoAction = manageOpts?.autoAction ?? null
    const initialTab = manageOpts?.initialTab
    if (initialTab === undefined && autoAction === null) {
      window.api.openInstancePicker({ installationId: inst.id })
      return
    }
    window.api.openInstancePicker({
      installationId: inst.id,
      mode: 'expanded',
      initialTab: resolvePickerTab(initialTab, 'config'),
      autoAction,
    })
  },
  onShowProgress: (showOpts) => handleShowProgress(showOpts),
})

useDeepLinkRouter({
  installationId,
  bootstrapReady,
  openOverlay,
  showAppUpdateRestartPrompt,
  showAppUpdateDownloadPrompt,
  pickInstallFromPicker: async (inst) => {
    // Chooser-host pick (no installationId backing this host) → swap
    // in-place via the same path the dashboard chooser uses, so the
    // dashboard window becomes the picked install. Install-backed
    // pick → spawn a new Comfy window for the picked install
    // (focus-or-launch contract — main already short-circuits to
    // focus-existing when the install is already running in another
    // window before this IPC fires, so we only ever see launches
    // here for installs that aren't running yet).
    if (!installationId) {
      await chooserHandoff.handleChooserPick(inst)
    } else {
      await chooserHandoff.performPickerLaunch(inst)
    }
  },
  runInstallActionFromPicker: async (inst, actionId) => {
    // The IPC carries the composable's menu-item id (`copy-install`,
    // `untrack`, `delete`, `reveal-in-folder`), so this is a direct
    // dispatch — `triggerAction` resolves each id to either a
    // `runAction` IPC or an `onManage` overlay open.
    await triggerInstallAction(actionId, inst)
  },
  showProgressFromPicker: (showOpts) => handleShowProgress(showOpts),
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

// `'downloads-v2'` brings the panel forward in an overlay mode; the renderer
// mounts `DownloadsModal` and dismiss routes back through `closeCurrentPanel`
// so the body returns to comfy/lifecycle without leaving stale state.
function closeDownloadsV2(): void {
  window.api.closeCurrentPanel()
}

// Toggles transparency rules in the non-scoped <style> block so the
// live ComfyUI canvas composites through while an overlay panel
// (downloads-v2 / feedback) is mounted.
watch(
  activePanel,
  (next) => {
    document.body.classList.toggle(
      'panel-overlay-mode',
      next === 'downloads-v2' || next === 'feedback',
    )
  },
  { immediate: true },
)

onMounted(async () => {
  // Register the brand-takeover surface so `useMigrateAction` can route
  // chain-migrate confirms here instead of the legacy Modal. Other
  // callsites (MigrationBanner, DetailModal) keep the Modal default.
  // Wired before bootstrap because the surface is read by the
  // FirstUseTakeover chain — if it landed mid-takeover (e.g. due to a
  // slow bootstrap) the chain would silently fall back to the modal.
  registerMigrateTakeover({
    open: (title, confirmLabel) =>
      migrateTakeoverRef.value!.open(title, confirmLabel),
    update: (opts) => migrateTakeoverRef.value?.update(opts)
  })

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
  //
  // Chooser host (install-less) idle close pops a "Quit Desktop?"
  // confirm instead of clearing silently. Install-backed hosts still
  // clear silently when no overlay is in flight — only the dashboard
  // ✕ is gated.
  unsubCloseRequest = window.api.onCloseRequest(({ requestId }) => {
    // Ack synchronously so main extends its hung-renderer timeout —
    // the actual response can take arbitrary time when the user is
    // looking at a cancel-prompt confirmation modal, and the old
    // 5s response timeout was racing slow user input and force-
    // closing the window.
    window.api.ackCloseRequest({ requestId })
    void (async () => {
      let cleared: boolean
      if (currentOverlay.value !== null) {
        cleared = await closeOverlay()
      } else if (!installationId) {
        cleared = await confirmQuitDesktop()
      } else {
        cleared = true
      }
      window.api.respondCloseRequest({ requestId, cleared })
    })()
  })

  // File menu's "Return to Dashboard" consult. Layered:
  //   - In-flight overlay → tier-aware cancel-prompt via `closeOverlay`.
  //   - No overlay + local install → "Stop ComfyUI?" confirm so the
  //     user knows the running session is about to be stopped.
  // Cloud / remote installs (and chooser hosts) clear silently.
  unsubReturnToDashboardRequest = window.api.onReturnToDashboardRequest(({ requestId }) => {
    window.api.ackReturnToDashboardRequest({ requestId })
    void (async () => {
      // The inner await chain is wrapped so a thrown / rejected confirm doesn't
      // strand main waiting forever on the response; the catch returns a
      // default `cleared: false` and the response always fires below.
      const { cleared, reason } = await (async (): Promise<{
        cleared: boolean
        reason: 'in_flight' | 'running' | 'stopped' | 'crashed'
      }> => {
        try {
          if (currentOverlay.value !== null) {
            return { cleared: await closeOverlay(), reason: 'in_flight' }
          }
          const id = installationId
          const inst = id ? (installationStore.getById(id) ?? null) : null
          const r: 'running' | 'crashed' | 'stopped' =
            id && sessionStore.isRunning(id)
              ? 'running'
              : id && sessionStore.errorInstances.has(id)
                ? 'crashed'
                : 'stopped'
          return { cleared: await confirmReturnToDashboard(inst, r), reason: r }
        } catch (err) {
          console.error('return-to-dashboard consult failed', err)
          return { cleared: false, reason: 'stopped' }
        }
      })()
      if (cleared) {
        emitTelemetryAction('desktop2.instance.return_to_dashboard', {
          from: 'menu',
          reason,
        })
      }
      window.api.respondReturnToDashboardRequest({ requestId, cleared })
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
      message
    })
  })

// The file-menu "Skip Onboarding" IPC subscription lives in
  // useFirstUseChain so the chain owns its own input surface; no
  // duplicate listener here.

  try {
    // Initialize stores / prefs needed by the embedded DetailModal that
    // backs the unified Settings modal's "ComfyUI Settings" tab.
    // installationStore wires its own onInstallationsChanged listener.
    const shouldOpenFirstUse =
      urlFirstUsePending ||
      (!urlFirstUseCompleted &&
        (!launcherPrefsLoaded.value || !firstUseCompleted.value))

    if (shouldOpenFirstUse && !isFlowPanel(initialPanel)) {
      void openFirstUseTakeover()
    }

    await Promise.all([
      sessionStore.init(),
      installationStore.fetchInstallations(),
      launcherPrefs.loadPrefs(),
      loadLocale().catch((err) => {
        console.error('Panel: loadLocale failed', err)
      }),
    ])

    // If the URL-driven initial panel mounts as a flow wizard takeover,
    // kick it open now — script-setup couldn't because the template
    // hadn't rendered yet.
    if (isFlowPanel(initialPanel)) {
      void switchPanel(initialPanel, 'url')
    }

    // First-use takeover auto-mounts when the persisted gate is still
    // false. Runs AFTER the URL-driven flow panel branch so a
    // `?panel=new-install` request still wins (e.g. when main re-routes
    // a chooser pick into new-install for an un-installed source); the
    // first-use takeover will replay on the next launch since
    // `firstUseCompleted` stays false until the explicit completion
    // path runs.
    if (!firstUseCompleted.value && !isFlowPanel(initialPanel)) {
      void openFirstUseTakeover()
    }
  } catch (err) {
    console.error('Panel: bootstrap failed', err)
  } finally {
    // bootstrapReady must always resolve — useDeepLinkRouter awaits it
    // before resolving overlay deep-links, and a never-resolved promise
    // would silently wedge any panel-trigger-overlay IPC the user fires
    // after a partial-bootstrap failure.
    resolveBootstrap?.()
    resolveBootstrap = null
  }
})

onUnmounted(() => {
  registerMigrateTakeover(null)
  unsubPanel?.()
  unsubLocale?.()
  unsubCloseRequest?.()
  unsubReturnToDashboardRequest?.()
  unsubAppUpdatePromptRestart?.()
  unsubAppUpdateUserActionFailed?.()
  // Strip the overlay-mode class so HMR / view reload / host teardown
  // while the drawer is open doesn't leak transparency past unmount.
  document.body.classList.remove('panel-overlay-mode')
  sessionStore.dispose()
  // Release the E2E binding so a stale closure can't keep driving the
  // progress chain on a detached PanelApp instance after a panel swap.
  if (params.get('e2e') === '1') bindE2EPanelHooks(null)
})
</script>

<template>
  <div class="panel-shell">
    <main class="panel-content">
      <!-- `showPanelBody` — chooser when main/IPC says first-use is done;
           hidden while the first-use takeover is mounted (no chooser
           bleed-through during BrandTakeoverLayout's fade-in). Flow
           takeovers keep the chooser mounted underneath by design. -->
      <div v-if="showPanelBody" class="panel-body">
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
    <!-- Tier 3 takeover slot. ProgressModal renders as the universal
         brand loader for every show-progress op (delete, install,
         update, copy, migrate, snapshot, launch) — the legacy Tier 2
         ModalShell branch was removed in the same phase. -->
    <template v-if="currentOverlay?.kind === 'takeover'">
      <ProgressModal
        v-if="currentOverlay.component === 'update'"
        ref="progressRef"
        :installation-id="currentOverlay.installationId ?? ''"
        @close="handleProgressClose"
      />
      <InstallWizardModal
        v-else-if="currentOverlay.component === 'new-install'"
        ref="newInstallRef"
        :hide-back-to-dashboard="chainingFirstUseToNewInstall"
        @close="handleNewInstallTakeoverClose"
        @navigate-list="handleNewInstallTakeoverClose"
        @show-progress="handleShowProgress"
        @back-to-local-branch="handleNewInstallBackToLocalBranch"
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

<!-- Brand-redesigned "View All Downloads" surface. Mounts only
         when main flips us into `'downloads-v2'` mode (from the title-
         bar downloads popup's footer link). `v-if` mirrors the rest of
         this file's overlay convention — keeps the store init + body
         scroll lock out of every PanelApp mount that doesn't open the
         modal. Dismiss routes back through `closeCurrentPanel()`. -->
    <DownloadsModal
      v-if="activePanel === 'downloads-v2'"
      open
      @close="closeDownloadsV2"
    />

    <FeedbackModal :open="feedbackOpen" :url="feedbackUrl" @close="closeFeedback" />

    <ModalDialog />
    <MigrateConfirmTakeover ref="migrateTakeoverRef" />
  </div>
</template>

<!-- Non-scoped: targets `body` and overrides main.css's `body { background:
     var(--bg) }` only while the drawer is open. Specificity
     (`body.panel-overlay-mode` vs `body`) wins regardless of CSS load
     order. -->
<style>
body.panel-overlay-mode {
  background: transparent;
}
body.panel-overlay-mode .panel-shell {
  background: transparent;
}
</style>

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

/* The gated body wrapper must transparently inherit the panel-content
 * flex behaviour so the chooser / lifecycle branches keep filling the
 * shell. Without `min-height: 0` the chooser grid overflows the host. */
.panel-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
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
