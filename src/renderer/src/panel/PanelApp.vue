<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
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
import { useOverlay, type FlowComponent } from '../composables/useOverlay'
import type { ActionResult, Installation, ShowProgressOpts } from '../types/ipc'

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
 * `open()` reset. Phase 3 §17 — these no longer mount as panel-body
 * branches; they mount in the host's takeover overlay slot (Tier 3)
 * via `useOverlay`. The set is still keyed on PanelKey because main
 * still addresses these as "panel switch" requests (URL `?panel=…`
 * and the `panel-switch` IPC) — `switchPanel` diverts them into
 * `openOverlay({ kind: 'takeover', component })` instead of assigning
 * `activePanel`.
 *
 * Each entry has a matching `*Ref` template ref so we can call the
 * imperative `open()` reset after the takeover mounts (form state
 * carries over otherwise — same reason the pre-§17 panel-body
 * branches needed the post-mount `open()`).
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
/**
 * The default body panel for this host — the surface that sits
 * underneath any takeover overlay. Install-backed hosts default to
 * launcher-settings (matches the pre-Phase-3 title-bar Launcher
 * Settings pill behaviour), install-less hosts default to the chooser.
 * Used both for the initial mount (when the URL doesn't request a
 * specific panel) AND as the underlying body when the initial URL
 * panel is a flow-takeover (`?panel=new-install` etc.).
 */
function defaultBodyPanel(): PanelKey {
  return installationId ? 'launcher-settings' : 'chooser'
}
const initialPanel: PanelKey = ((): PanelKey => {
  const raw = params.get('panel')
  if (raw && VALID_PANELS.has(raw as PanelKey)) return raw as PanelKey
  return defaultBodyPanel()
})()

// `activePanel` is the underlying body. Flow keys are never assigned
// here — they mount in the takeover overlay slot instead (see
// `openFlowTakeover` and the post-mount `switchPanel(initialPanel)`
// in `onMounted` which routes `?panel=new-install` etc. through the
// overlay path).
const activePanel = ref<PanelKey>(
  FLOW_PANELS.has(initialPanel) ? defaultBodyPanel() : initialPanel,
)
const settingsRef = ref<InstanceType<typeof SettingsView> | null>(null)
const progressRef = ref<InstanceType<typeof ProgressModal> | null>(null)
const newInstallRef = ref<InstanceType<typeof NewInstallModal> | null>(null)
const trackRef = ref<InstanceType<typeof TrackModal> | null>(null)
const loadSnapshotRef = ref<InstanceType<typeof LoadSnapshotModal> | null>(null)
const quickInstallRef = ref<InstanceType<typeof QuickInstallModal> | null>(null)

const sessionStore = useSessionStore()
const installationStore = useInstallationStore()
const progressStore = useProgressStore()
const launcherPrefs = useLauncherPrefs()

/**
 * Host-level overlay slot (Phase 3 §17). Owns the in-flight progress
 * (`progress` kind) and Tier 3 takeovers (`takeover` kind — the four
 * flow modals plus the future first-use flow). Manage / Tier 1
 * overlays driven by ChooserView mount in ChooserView's own slot —
 * see `useOverlay` for the tier-collision rules. The `current` ref is
 * destructured to a top-level binding so the template can read it via
 * Vue's auto-unwrap.
 *
 * `tier` drives the title-bar inert flag — when a Tier 3 takeover is
 * mounted the title bar disables its file menu, install pill and
 * back/forward arrows so the user can't dismiss the takeover via
 * those affordances. See the watcher below.
 */
const { current: currentOverlay, tier, openOverlay, closeOverlay } = useOverlay()

watch(tier, (newTier, oldTier) => {
  // Only signal main on transitions into/out of the takeover tier —
  // shifting between Tier 1 ↔ Tier 2 doesn't change the title-bar
  // state, so we skip the redundant IPC.
  const wasTakeover = oldTier === 3
  const isTakeover = newTier === 3
  if (wasTakeover === isTakeover) return
  window.api.setTitleBarInert(isTakeover)
})

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

/**
 * `show-progress` from any panel body (DetailModal, ChooserView,
 * NewInstallModal, …). Routes through the host's overlay slot so the
 * Tier 2 collision rules apply — replacing one in-flight progress op
 * with another prompts the user to cancel via the standardised copy.
 *
 * Re-show of an already-running op is a no-op `openOverlay` to the
 * same `progress` slot followed by `showOperation` on the modal ref;
 * the slot already has the right kind+id, so the `current` swap is
 * idempotent.
 */
async function handleShowProgress(opts: ShowProgressOpts): Promise<void> {
  // Manage→Progress restoration relies on the title carrying the
  // operation name (e.g. `"Updating ComfyUI — Local install"`); strip
  // the install suffix for the cancel-prompt copy so the prompt reads
  // `Cancel "Updating ComfyUI"?` instead of leaking the install name.
  const operationName = opts.title.split(' — ')[0] || opts.title
  const ok = await openOverlay({
    kind: 'progress',
    installationId: opts.installationId,
    operationName,
  })
  if (!ok) return
  await nextTick()
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
  // Direct close (✕ on a finished op, or auto-close via the
  // window-mode launch watcher) — bypass `openOverlay`'s cancel
  // prompt because the op has already finished. Cancellation of an
  // in-flight op flows through `progressStore.cancelOperation`.
  currentOverlay.value = null
}

/**
 * Phase 3 §17 — open one of the four flow modals as a Tier 3 takeover
 * overlay (full-window body sitting above the underlying panel). The
 * imperative `open()` reset on each *Modal ref runs after the takeover
 * mounts so form state always starts fresh, the same way the pre-§17
 * panel-body branches reset on (re)entry.
 *
 * Returns silently if `openOverlay` was rejected (the user dismissed
 * the cancel-prompt that fires when an in-flight Tier 2 progress op
 * is being pre-empted — see `useOverlay`'s tier-collision rules).
 */
async function openFlowTakeover(component: FlowComponent): Promise<void> {
  const ok = await openOverlay({ kind: 'takeover', component })
  if (!ok) return
  // Wait for the v-if branch in the takeover slot to mount the
  // component before reaching for its ref.
  await nextTick()
  if (component === 'new-install') await newInstallRef.value?.open()
  else if (component === 'track') trackRef.value?.open()
  else if (component === 'load-snapshot') loadSnapshotRef.value?.open()
  else if (component === 'quick-install') await quickInstallRef.value?.open()
}

/**
 * Switch the underlying panel body. Flow keys (`new-install` / `track`
 * / `load-snapshot` / `quick-install`) divert into the Tier 3
 * takeover overlay slot instead of swapping the body — see
 * `openFlowTakeover` for why.
 *
 * For non-flow keys: the assignment is idempotent — re-selecting the
 * already-active panel is a no-op, matching what the user perceives
 * (the title-bar pill click is just "go to this page", with no reset
 * semantics needed for tab-style views like Settings / Directories).
 */
async function switchPanel(panel: PanelKey): Promise<void> {
  if (FLOW_PANELS.has(panel)) {
    await openFlowTakeover(panel as FlowComponent)
    return
  }
  activePanel.value = panel
}

function handleUpdateInstallation(inst: Installation): void {
  // Optimistic local update for snappier UX while the broadcast-driven
  // refetch is in flight (e.g. rename via the editable title).
  const idx = installationStore.installations.findIndex((i) => i.id === inst.id)
  if (idx >= 0) installationStore.installations.splice(idx, 1, inst)
}

/** DetailModal close (✕) when mounted as the install-settings panel
 *  body. Phase 3 §17 dropped DetailModal's `inline` prop; the parent
 *  decides what `close` means. For install-settings we ask main to
 *  reset the host window's panel-history stack so the body returns
 *  to the comfy/chooser root, matching the pre-§17 inline behaviour. */
function handleInstallSettingsClose(): void {
  window.api.closeCurrentPanel()
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
  // Empty-state CTA from the chooser — opens the new-install flow as
  // a Tier 3 takeover above the chooser body. Same install-less host
  // window; the user perceives a wizard step rather than a navigation
  // jump, and dismissing the takeover drops them right back into the
  // chooser tile they came from.
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
          @close="handleInstallSettingsClose"
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
          @show-progress="handleShowProgress"
        />
      </div>

    </main>

    <!-- Host-level overlay slot (Phase 3 §17). One DOM node at a
         time, owned by `useOverlay`. Mounts either the in-flight
         progress modal (Tier 2 — non-app-ending ops) or one of the
         Tier 3 takeovers (the four flow modals; Step 4 will add the
         first-use takeover here too). The two branches are mutually
         exclusive because `useOverlay` only ever holds one overlay
         in `current.value`. -->
    <div
      v-if="currentOverlay?.kind === 'progress'"
      class="view-modal active"
      data-overlay-key="progress"
    >
      <ProgressModal
        ref="progressRef"
        :installation-id="currentOverlay.installationId"
        @close="handleProgressClose"
      />
    </div>

    <!-- Tier 3 takeover slot. The four flow modals share the same
         shell — the underlying panel body (chooser / launcher-settings)
         stays mounted underneath, so `closeOverlay` returns the user
         to wherever they came from without us having to remember it. -->
    <div
      v-else-if="currentOverlay?.kind === 'takeover'"
      class="view-modal active"
      data-overlay-key="takeover"
    >
      <NewInstallModal
        v-if="currentOverlay.component === 'new-install'"
        ref="newInstallRef"
        @close="closeOverlay"
        @navigate-list="closeOverlay"
        @show-progress="handleShowProgress"
      />
      <TrackModal
        v-else-if="currentOverlay.component === 'track'"
        ref="trackRef"
        @close="closeOverlay"
        @navigate-list="closeOverlay"
      />
      <LoadSnapshotModal
        v-else-if="currentOverlay.component === 'load-snapshot'"
        ref="loadSnapshotRef"
        @close="closeOverlay"
        @show-progress="handleShowProgress"
      />
      <QuickInstallModal
        v-else-if="currentOverlay.component === 'quick-install'"
        ref="quickInstallRef"
        @close="closeOverlay"
        @show-progress="handleShowProgress"
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
 * panel-content gutter for those branches. The chooser owns its own
 * filter / grid padding and needs the full panel height so its grid
 * can scroll vertically. */
.panel-content:has(.panel-install-settings),
.panel-content:has(.panel-comfy-lifecycle),
.panel-content:has(.panel-chooser) {
  padding: 0;
}

.panel-install-settings,
.panel-comfy-lifecycle,
.panel-chooser {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* Tier 3 takeover slot (Phase 3 §17). The four flow modals reuse the
 * launcher window's modal components (`*Modal.vue` with a
 * `.view-modal-content` root). When mounted as a takeover they should
 * fill the panel area instead of floating with a max-width dialog
 * box, so neutralize the modal sizing and chrome — same shape as the
 * pre-§17 `.panel-flow` :deep override that lived alongside the
 * panel-body branches. The `data-overlay-key` selector keeps this
 * scoped to the takeover slot only; the progress-overlay slot still
 * renders its ProgressModal as a centred dialog. */
[data-overlay-key="takeover"] :deep(.view-modal-content) {
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
