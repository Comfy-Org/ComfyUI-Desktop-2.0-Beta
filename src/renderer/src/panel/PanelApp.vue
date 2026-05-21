<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import ManageInstallModal from '../views/ManageInstallModal.vue'
import ComfyUISettingsPanel from '../views/ComfyUISettingsPanel.vue'
import ProgressModal from '../views/ProgressModal.vue'
import ModalDialog from '../components/ModalDialog.vue'
import DownloadsModal from '../components/DownloadsModal.vue'
import ComfyLifecycleView from './ComfyLifecycleView.vue'
import ChooserView from '../views/ChooserView.vue'
import NewInstallModal from '../views/NewInstallModal.vue'
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
import { useSendFeedback } from '../composables/useSendFeedback'
import { useDeepLinkRouter } from '../composables/useDeepLinkRouter'
import { useInstallContextMenu } from '../composables/useInstallContextMenu'
import { registerMigrateTakeover } from '../composables/useMigrateAction'
import { isFlowPanel, isValidPanel, usePanelOverlays } from './usePanelOverlays'
import { useChooserHandoff } from './useChooserHandoff'
import { useFirstUseChain } from './useFirstUseChain'
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
useSendFeedback()

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
const newInstallRef = ref<InstanceType<typeof NewInstallModal> | null>(null)
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
  installation,
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

let unsubPanel: (() => void) | null = null
let unsubLocale: (() => void) | null = null
let unsubCloseRequest: (() => void) | null = null
let unsubAppUpdatePromptRestart: (() => void) | null = null
let unsubAppUpdateUserActionFailed: (() => void) | null = null
let unsubRequestCloseDrawer: (() => void) | null = null

// Drives the title-bar icon close path's animated dismiss (see
// `onRequestCloseDrawer` below).
const comfyUISettingsPanelRef = ref<{ requestClose: () => void } | null>(null)

// Picker More-menu dispatch lives on the panel because the install-level
// actions need `window.api.runAction` (only exposed in the panel
// renderer) and Delete routes through the panel's overlay slot via
// `handleShowProgress` (fast path) with a ManageInstallModal autoAction
// fallback. `useInstallContextMenu` is the single source of truth for
// these items — same dispatch the dashboard kebab uses.
const { triggerAction: triggerInstallAction } = useInstallContextMenu({
  onManage: (inst, manageOpts) => {
    void openOverlay({
      kind: 'settings',
      installation: inst,
      initialTab: 'comfy',
      initialDetailTab: manageOpts?.initialTab ?? 'status',
      autoAction: manageOpts?.autoAction ?? null,
      noSidebar: true,
    })
  },
  // Fast-path for Delete: skips the ManageInstallModal flash and routes
  // straight through the same handleShowProgress used by every other
  // ProgressModal entry point.
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

// Drawer's `@after-leave` fires this, so the panel is already gone
// visually by the time main flips `activePanel`.
function closeSettingsV2(): void {
  window.api.closeCurrentPanel()
}

// `'downloads-v2'` is the same overlay-mode trick the Settings drawer
// uses — main brings the panel forward, the renderer mounts the
// `DownloadsModal`, and dismiss routes back through `closeCurrentPanel`
// so the body returns to comfy/lifecycle without leaving stale state.
function closeDownloadsV2(): void {
  window.api.closeCurrentPanel()
}

// Toggles transparency rules in the non-scoped <style> block so the
// live ComfyUI canvas composites through while either overlay-mode
// panel is open (settings drawer or downloads modal).
watch(
  activePanel,
  (next) => {
    document.body.classList.toggle(
      'panel-overlay-mode',
      next === 'settings-v2' || next === 'downloads-v2',
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
      message
    })
  })

  // Title-bar close → drawer's local dismiss path (animated). Skipped
  // when the ref is null because the drawer is already gone.
  unsubRequestCloseDrawer = window.api.onRequestCloseDrawer(() => {
    comfyUISettingsPanelRef.value?.requestClose()
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
  unsubAppUpdatePromptRestart?.()
  unsubAppUpdateUserActionFailed?.()
  unsubRequestCloseDrawer?.()
  // Strip the overlay-mode class so HMR / view reload / host teardown
  // while the drawer is open doesn't leak transparency past unmount.
  document.body.classList.remove('panel-overlay-mode')
  sessionStore.dispose()
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
    <!-- Tier 1 per-install management modal. Mounted with `installation`
         carried by the overlay payload (chooser-card Manage uses the
         card's install, install-pill Manage uses the host's install).
         Install-less hosts never reach here — `switchPanel`'s 'settings'
         arm short-circuits to `window.api.openGlobalSettings()` before
         the overlay is opened, so `installation` is always non-null in
         practice. The body underneath stays on chooser / comfy-lifecycle
         so dismissing returns there.

         Maps the legacy `initialDetailTab` payload field to
         ManageInstallModal's `initialTab` prop. Tab values:
         'status' | 'update' | 'snapshots' | 'settings' (DetailModal's
         tab keys). -->
    <ManageInstallModal
      v-if="currentOverlay?.kind === 'settings'"
      :installation="currentOverlay.installation"
      :initial-tab="(currentOverlay.initialDetailTab as 'status' | 'update' | 'snapshots' | 'settings' | undefined) ?? 'status'"
      :auto-action="currentOverlay.autoAction"
      @close="dismissTakeoverDirect"
      @show-progress="handleShowProgress"
      @update:installation="handleUpdateInstallation"
      @navigate-list="handleNavigateList"
    />
    <!-- Tier 3 takeover slot. ProgressModal renders as the universal
         brand loader for every show-progress op (delete, install,
         update, copy, migrate, snapshot, launch) — the legacy Tier 2
         ModalShell branch was removed in the same phase. -->
    <template v-else-if="currentOverlay?.kind === 'takeover'">
      <ProgressModal
        v-if="currentOverlay.component === 'update'"
        ref="progressRef"
        :installation-id="currentOverlay.installationId ?? ''"
        @close="handleProgressClose"
      />
      <NewInstallModal
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

    <!-- Settings drawer (v2). Right-anchored slide-in driven by
         `activePanel === 'settings-v2'`; sits outside the overlay
         v-if chain so it doesn't break its discriminant-narrowing. -->
    <ComfyUISettingsPanel
      ref="comfyUISettingsPanelRef"
      :open="activePanel === 'settings-v2'"
      :installation="installation"
      @close="closeSettingsV2"
      @show-progress="handleShowProgress"
      @navigate-list="handleNavigateList"
    />

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
