<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import SettingsView from '../views/SettingsView.vue'
import DetailModal from '../views/DetailModal.vue'
import ProgressModal from '../views/ProgressModal.vue'
import ModalDialog from '../components/ModalDialog.vue'
import ComfyLifecycleView from './ComfyLifecycleView.vue'
import ChooserView from '../views/ChooserView.vue'
import DirectoriesView from '../views/DirectoriesView.vue'
import NewInstallModal from '../views/NewInstallModal.vue'
import TrackModal from '../views/TrackModal.vue'
import LoadSnapshotModal from '../views/LoadSnapshotModal.vue'
import QuickInstallModal from '../views/QuickInstallModal.vue'
import UpdateBanner from '../components/UpdateBanner.vue'
import { useTheme } from '../composables/useTheme'
import { useSessionStore } from '../stores/sessionStore'
import { useInstallationStore } from '../stores/installationStore'
import { useProgressStore } from '../stores/progressStore'
import { useLauncherPrefs } from '../composables/useLauncherPrefs'
import { useListAction } from '../composables/useListAction'
import type { ActionResult, Installation } from '../types/ipc'

/**
 * Body modes the panel WebContentsView can render. Mirrors the `BodyMode`
 * union in `src/main/index.ts` — `'comfy-lifecycle'` is the lifecycle UI
 * shown for the Comfy tab when no ComfyUI process is running, `'chooser'`
 * is the install-picker shown for the Comfy tab of an install-less host
 * window, the others are the title-bar pills that map directly to a panel.
 */
export type PanelKey =
  | 'comfy-lifecycle'
  | 'chooser'
  | 'install-settings'
  | 'launcher-settings'
  | 'directories'
  | 'new-install'
  | 'track'
  | 'load-snapshot'
  | 'quick-install'

const VALID_PANELS: ReadonlySet<PanelKey> = new Set([
  'comfy-lifecycle',
  'chooser',
  'install-settings',
  'launcher-settings',
  'directories',
  'new-install',
  'track',
  'load-snapshot',
  'quick-install',
])

/**
 * Panels that wrap a `*Modal` component which exposes an imperative
 * `open()` reset. Switching to one of these panels must call `open()`
 * after the component mounts so the form state resets cleanly each
 * time the user re-enters the flow (the launcher window's pre-Phase-3
 * App.vue did the same via useNavigation's invokeWhenReady).
 */
const FLOW_PANELS: ReadonlySet<PanelKey> = new Set([
  'new-install',
  'track',
  'load-snapshot',
  'quick-install',
])

const { setLocaleMessage, locale } = useI18n()
useTheme()

const params = new URLSearchParams(window.location.search)
const installationId = params.get('installationId') || ''
const initialPanel: PanelKey = ((): PanelKey => {
  const raw = params.get('panel')
  if (raw && VALID_PANELS.has(raw as PanelKey)) return raw as PanelKey
  // Install-less host windows (no installationId) default to the chooser;
  // install-backed panels default to launcher-settings (matches the
  // pre-Phase-3 behaviour for the title-bar Launcher Settings pill).
  return installationId ? 'launcher-settings' : 'chooser'
})()

const activePanel = ref<PanelKey>(initialPanel)
const settingsRef = ref<InstanceType<typeof SettingsView> | null>(null)
const progressRef = ref<InstanceType<typeof ProgressModal> | null>(null)
const newInstallRef = ref<InstanceType<typeof NewInstallModal> | null>(null)
const trackRef = ref<InstanceType<typeof TrackModal> | null>(null)
const loadSnapshotRef = ref<InstanceType<typeof LoadSnapshotModal> | null>(null)
const quickInstallRef = ref<InstanceType<typeof QuickInstallModal> | null>(null)

const activeProgressId = ref<string | null>(null)

const sessionStore = useSessionStore()
const installationStore = useInstallationStore()
const progressStore = useProgressStore()
const launcherPrefs = useLauncherPrefs()

// installationStore.fetchInstallations() is wired to onInstallationsChanged
// inside the store itself, so the panel just needs to read from it.
const installation = computed<Installation | null>(
  () => (installationId ? installationStore.getById(installationId) ?? null : null),
)

let unsubPanel: (() => void) | null = null
let unsubLocale: (() => void) | null = null
let unsubSettings: (() => void) | null = null

async function loadLocale(): Promise<void> {
  const messages = await window.api.getLocaleMessages()
  setLocaleMessage('en', messages)
  locale.value = 'en'
}

function handleShowProgress(opts: {
  installationId: string
  title: string
  apiCall: () => Promise<unknown>
  cancellable?: boolean
  returnTo?: string
}): void {
  activeProgressId.value = opts.installationId
  // If an in-progress operation already exists for this ID, just show it
  const existing = progressStore.operations.get(opts.installationId)
  if (existing && !existing.finished) {
    progressRef.value?.showOperation(opts.installationId)
    return
  }
  progressRef.value?.startOperation({
    installationId: opts.installationId,
    title: opts.title,
    apiCall: opts.apiCall as () => Promise<ActionResult>,
    cancellable: opts.cancellable,
    returnTo: opts.returnTo,
  })
}

function handleProgressClose(): void {
  activeProgressId.value = null
}

/**
 * Switch the panel body and run the post-mount imperative open() reset
 * for flow panels (`new-install` / `track` / `load-snapshot` /
 * `quick-install`). The launcher window's pre-Phase-3 App.vue did the
 * same via useNavigation.invokeWhenReady — without this reset the form
 * state would carry over between successive entries to the same flow.
 *
 * Idempotent: switching to the already-active panel still re-runs
 * open(), which mirrors the launcher window behaviour where re-opening
 * the modal always starts fresh.
 */
async function switchPanel(panel: PanelKey): Promise<void> {
  activePanel.value = panel
  if (!FLOW_PANELS.has(panel)) return
  // Wait for the v-else-if branch to mount the component.
  await nextTick()
  if (panel === 'new-install') await newInstallRef.value?.open()
  else if (panel === 'track') trackRef.value?.open()
  else if (panel === 'load-snapshot') loadSnapshotRef.value?.open()
  else if (panel === 'quick-install') await quickInstallRef.value?.open()
}

/**
 * Returning to chooser — what the per-flow `close` and `navigate-list`
 * emits map to inside the install-less host window. There's no launcher
 * list to navigate to anymore; the chooser IS the list, so both fold
 * into "back to chooser". Install-backed panels also use this path
 * (e.g. flows started from a future install-pill caret menu) — they'll
 * land back in their last-active install panel via setActivePanel from
 * main, but in the meantime "chooser" is a safe default that doesn't
 * leave the user on a dismissed flow panel.
 */
function handleFlowClose(): void {
  void switchPanel('chooser')
}

function handleUpdateInstallation(inst: Installation): void {
  // Optimistic local update for snappier UX while the broadcast-driven
  // refetch is in flight (e.g. rename via the editable title).
  const idx = installationStore.installations.findIndex((i) => i.id === inst.id)
  if (idx >= 0) installationStore.installations.splice(idx, 1, inst)
}

// --- Chooser handlers (install-less host window only) ---
//
// Phase 3 step 2d — chooser pick triggers the install's launch action
// directly from the panel renderer, mirroring the Dashboard "Open" button
// flow. Once the install's own ComfyUI window has opened (or it was already
// running), the install-less chooser host window closes itself.
//
// `useListAction` covers the same launch UX paths the Dashboard already
// uses: confirm modal, in-progress guard, port-conflict resolution via
// ProgressModal, telemetry, etc. Reusing it keeps the chooser pick from
// re-implementing launch semantics.
const { executeAction: executeChooserAction } = useListAction('chooser', {
  showProgress: handleShowProgress,
})

/** Pending close-on-launch subscription, so unmount can clean it up. */
let pendingPickUnsub: (() => void) | null = null

async function handleChooserPick(installation: Installation): Promise<void> {
  // Already running with an open window — focus that window and retire
  // the chooser host. No need to involve the launch action.
  if (sessionStore.isRunning(installation.id)) {
    await window.api.focusComfyWindow(installation.id)
    void window.api.closeHostWindow()
    return
  }

  // Otherwise look up the launch action (sources expose it as their
  // primary list action, e.g. 'launch' for standalone, 'connect' for
  // url-based sources) and run it through the standard pipeline.
  const actions = await window.api.getListActions(installation.id)
  const launchAction = actions.find((a) => a.id === 'launch')
    ?? actions.find((a) => a.style === 'primary')
    ?? null
  if (!launchAction) {
    // Source has no launch path (e.g. the install isn't installed yet).
    // Fall back to the new-install flow inside the host window so the
    // user can resolve the missing setup step without bouncing to the
    // launcher window (which is going away in this phase).
    void switchPanel('new-install')
    return
  }

  // Visual continuity — stamp the chooser host's current bounds onto the
  // install's saved-bounds slot BEFORE the launch, so the install's own
  // window opens exactly where the chooser was. The user perceives a
  // swap-in-place even though it's structurally close+open.
  await window.api.transferHostBoundsToInstall(installation.id)

  // Subscribe BEFORE kicking off the launch so we don't miss a
  // fast-firing instance-started broadcast. The launch action runs via
  // the ProgressModal pipeline (showProgress: true) so executeAction
  // returns immediately after kicking it off — the actual completion
  // signal is the instance-started event coming back from main.
  pendingPickUnsub?.()
  pendingPickUnsub = window.api.onInstanceStarted((data) => {
    if (data.installationId !== installation.id) return
    pendingPickUnsub?.()
    pendingPickUnsub = null
    // The install's own ComfyUI window has opened — chooser host is done.
    void window.api.closeHostWindow()
  })

  await executeChooserAction(installation, launchAction)
}

function handleChooserShowNewInstall(): void {
  // Empty-state CTA from the chooser — switch the host window's body
  // to the new-install flow panel. Same install-less host window, just
  // a different body mode; the user perceives a wizard step rather than
  // a navigation jump.
  void switchPanel('new-install')
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
    setLocaleMessage('en', messages as Record<string, unknown>)
  })

  // Main can request a panel switch (e.g. from title-bar buttons, or when
  // the install lifecycle changes — main flips us to 'comfy-lifecycle' when
  // the instance stops so the Comfy tab body shows the right transient UI).
  // Flow panels (new-install / track / load-snapshot / quick-install) need
  // the imperative open() reset to run after mount, so funnel through
  // switchPanel() rather than assigning activePanel directly.
  unsubPanel = window.api.onPanelSwitch((data) => {
    if (VALID_PANELS.has(data.panel as PanelKey)) {
      void switchPanel(data.panel as PanelKey)
    }
  })

  // Settings broadcast — refetch the launcher settings sections so panels
  // opened in multiple windows stay in sync.
  unsubSettings = window.api.onSettingsChanged(() => {
    settingsRef.value?.loadSettings()
  })

  // Initialize stores / prefs needed by the install-settings DetailModal.
  // installationStore wires its own onInstallationsChanged listener.
  await Promise.all([
    sessionStore.init(),
    installationStore.fetchInstallations(),
    launcherPrefs.loadPrefs(),
  ])

  // If the URL-driven initial panel is a flow panel, run its open()
  // reset now that the component has mounted (the script-setup branch
  // assigned activePanel before the template rendered, so the modal
  // refs weren't populated yet).
  if (FLOW_PANELS.has(initialPanel)) {
    void switchPanel(initialPanel)
  }
})

onUnmounted(() => {
  unsubPanel?.()
  unsubLocale?.()
  unsubSettings?.()
  pendingPickUnsub?.()
  sessionStore.dispose()
})
</script>

<template>
  <div class="panel-shell">
    <!-- Update banner — listens to `update-available` / `update-error`
         broadcasts from the updater module. Mirrored from the launcher
         window's App.vue so the install pill caret's "Check for Updates"
         entry has a place to surface its result inside the host window
         (Phase 3: launcher window goes away). The banner is auto-hide
         when no update info is present, so this row renders nothing in
         the steady state. -->
    <UpdateBanner />

    <main class="panel-content">
      <SettingsView v-if="activePanel === 'launcher-settings'" ref="settingsRef" />

      <DirectoriesView v-else-if="activePanel === 'directories'" />

      <div v-else-if="activePanel === 'install-settings'" class="panel-install-settings">
        <DetailModal
          v-if="installation"
          :installation="installation"
          :inline="true"
          @show-progress="handleShowProgress"
          @navigate-list="handleNavigateList"
          @update:installation="handleUpdateInstallation"
        />
        <div v-else class="panel-placeholder">
          <p v-if="installationStore.loading">{{ $t('common.loading') }}</p>
          <p v-else>
            {{ $t('titleBar.installationLabel') }}:
            <code>{{ installationId }}</code>
          </p>
        </div>
      </div>

      <div v-else-if="activePanel === 'comfy-lifecycle'" class="panel-comfy-lifecycle">
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
        />
      </div>

      <!-- Install-creation / import flow panels (Phase 3 step 2e). The
           launcher window's modal components are reused here as full-panel
           bodies; the panel-flow wrapper makes the modal-styled root fill
           the panel area instead of floating in a dim backdrop. -->
      <div v-else-if="activePanel === 'new-install'" class="panel-flow">
        <NewInstallModal
          ref="newInstallRef"
          @close="handleFlowClose"
          @navigate-list="handleFlowClose"
          @show-progress="handleShowProgress"
        />
      </div>

      <div v-else-if="activePanel === 'track'" class="panel-flow">
        <TrackModal
          ref="trackRef"
          @close="handleFlowClose"
          @navigate-list="handleFlowClose"
        />
      </div>

      <div v-else-if="activePanel === 'load-snapshot'" class="panel-flow">
        <LoadSnapshotModal
          ref="loadSnapshotRef"
          @close="handleFlowClose"
          @show-progress="handleShowProgress"
        />
      </div>

      <div v-else-if="activePanel === 'quick-install'" class="panel-flow">
        <QuickInstallModal
          ref="quickInstallRef"
          @close="handleFlowClose"
          @show-progress="handleShowProgress"
        />
      </div>
    </main>

    <!-- Progress overlay for actions kicked off from the install-settings panel. -->
    <div v-show="activeProgressId" class="view-modal active" data-overlay-key="progress">
      <ProgressModal
        ref="progressRef"
        :installation-id="activeProgressId"
        @close="handleProgressClose"
      />
    </div>

    <ModalDialog />
  </div>
</template>

<style scoped>
.panel-shell {
  /* The panel WebContentsView lives BELOW the ComfyUI window's title bar
   * (which is its own WebContentsView). The panel renderer therefore has no
   * title bar of its own — neutralize the global --titlebar-height inset so
   * overlay modals (ProgressModal etc.) span the full panel area. */
  --titlebar-height: 0px;
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

/* Install-settings hosts an inline DetailModal and the comfy-lifecycle view
 * fills its own background — both own their padding, so negate the
 * panel-content gutter for those branches. The flow panels reuse modal
 * components which set their own scrolled body padding, so they also drop
 * the outer gutter. */
.panel-content:has(.panel-install-settings),
.panel-content:has(.panel-comfy-lifecycle),
.panel-content:has(.panel-flow) {
  padding: 0;
}

.panel-install-settings,
.panel-comfy-lifecycle,
.panel-flow {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* Flow panels reuse the launcher window's modal components (`*Modal.vue`
 * with a `.view-modal-content` root). When mounted as a panel body
 * they should fill the panel area instead of floating with a max-width
 * dialog box, so neutralize the modal sizing and chrome. */
.panel-flow :deep(.view-modal-content) {
  width: 100%;
  max-width: none;
  height: 100%;
  border-radius: 0;
  box-shadow: none;
  margin: 0;
  background: var(--bg);
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
