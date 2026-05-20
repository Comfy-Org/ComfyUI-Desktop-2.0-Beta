import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../main', () => ({
  i18n: {
    global: { t: (key: string) => key },
  },
}))

vi.mock('../composables/useTheme', () => ({ useTheme: () => ({ theme: 'dark' }) }))
/** Test-controllable `useModal` mock. Each call returns the same
 *  shared singleton so tests can stub return values per case via
 *  `mockModal.confirm.mockResolvedValueOnce(true)` etc. */
const mockModal = {
  alert: vi.fn(),
  confirm: vi.fn(),
  close: vi.fn(),
}
vi.mock('../composables/useModal', () => ({
  useModal: () => mockModal,
}))

// Stub the heavy children so we can assert which sub-panel is rendered.
vi.mock('../views/SettingsView.vue', () => ({
  default: {
    name: 'SettingsView',
    template: '<div data-testid="settings-view" />',
    methods: { loadSettings: vi.fn() },
  },
}))
vi.mock('../views/DetailModal.vue', () => ({
  default: {
    name: 'DetailModal',
    // DetailModal has no `inline` prop — it renders one way and the
    // parent owns the close behaviour.
    props: ['installation', 'initialTab', 'autoAction'],
    template:
      '<div data-testid="detail-modal" :data-installation-id="installation?.id" />',
  },
}))
vi.mock('../views/ProgressModal.vue', () => ({
  default: {
    name: 'ProgressModal',
    props: ['installationId'],
    template: '<div data-testid="progress-modal" />',
    methods: { startOperation: vi.fn(), showOperation: vi.fn() },
  },
}))
vi.mock('../components/ModalDialog.vue', () => ({
  default: { name: 'ModalDialog', template: '<div />' },
}))
// Modal teleports its slot to <body>; replace with a transparent
// pass-through so wrapper.find() can still see the slotted children.
vi.mock('../components/Modal.vue', () => ({
  default: {
    name: 'Modal',
    props: ['binding', 'opacity', 'width', 'contentClass', 'inline'],
    template: '<div data-testid="modal-stub"><slot /></div>',
  },
}))
vi.mock('./ComfyLifecycleView.vue', () => ({
  default: {
    name: 'ComfyLifecycleView',
    props: ['installation', 'installationId'],
    template:
      '<div data-testid="comfy-lifecycle" :data-installation-id="installationId" />',
  },
}))
vi.mock('../views/DirectoriesView.vue', () => ({
  default: {
    name: 'DirectoriesView',
    template: '<div data-testid="directories-view" />',
    methods: { loadAll: vi.fn(), loadModels: vi.fn(), loadMedia: vi.fn() },
  },
}))
vi.mock('../views/ChooserView.vue', () => ({
  default: {
    name: 'ChooserView',
    emits: ['pick', 'show-new-install'],
    template:
      '<div data-testid="chooser-view"><button data-testid="chooser-new-install" @click="$emit(\'show-new-install\')">New</button></div>',
  },
}))
vi.mock('../views/NewInstallModal.vue', () => ({
  default: {
    name: 'NewInstallModal',
    emits: ['close', 'navigate-list', 'show-progress'],
    template: '<div data-testid="new-install-modal" />',
    methods: { open: vi.fn() },
  },
}))
vi.mock('../views/TrackModal.vue', () => ({
  default: {
    name: 'TrackModal',
    emits: ['close', 'navigate-list'],
    template: '<div data-testid="track-modal" />',
    methods: { open: vi.fn() },
  },
}))
vi.mock('../views/LoadSnapshotModal.vue', () => ({
  default: {
    name: 'LoadSnapshotModal',
    emits: ['close', 'show-progress'],
    template: '<div data-testid="load-snapshot-modal" />',
    methods: { open: vi.fn() },
  },
}))
vi.mock('../views/QuickInstallModal.vue', () => ({
  default: {
    name: 'QuickInstallModal',
    emits: ['close', 'show-progress'],
    template: '<div data-testid="quick-install-modal" />',
    methods: { open: vi.fn() },
  },
}))
vi.mock('../views/FirstUseTakeover.vue', () => ({
  default: {
    name: 'FirstUseTakeover',
    emits: ['close', 'complete-cloud', 'complete-skip', 'chain-local', 'chain-migrate'],
    // Stub does NOT auto-call window.api.getLocale on mount — the host
    // exercises the imperative open() reset post-mount, which is what
    // we mock + assert on.
    template:
      '<div data-testid="first-use-takeover">' +
      '<button data-testid="first-use-cloud" @click="$emit(\'complete-cloud\')">Cloud</button>' +
      '<button data-testid="first-use-skip" @click="$emit(\'complete-skip\')">Skip</button>' +
      '<button data-testid="first-use-local" @click="$emit(\'chain-local\')">Local</button>' +
      '<button data-testid="first-use-close" @click="$emit(\'close\')">Close</button>' +
      '</div>',
    methods: { open: vi.fn() },
  },
}))
// ManageInstallModal is the active `kind: 'settings'` renderer.
// Wraps BaseModal + DetailModal (embedded). Tests assert on
// `data-testid="manage-install-modal"` for the modal root and the
// nested `data-testid="detail-modal"` for the per-install body —
// mirrors how the runtime nests them.
vi.mock('../views/ManageInstallModal.vue', () => ({
  default: {
    name: 'ManageInstallModal',
    props: ['installation', 'initialTab', 'autoAction'],
    emits: ['close', 'show-progress', 'update:installation', 'navigate-list'],
    template:
      '<div data-testid="manage-install-modal" :data-installation-id="installation?.id">' +
      '<div v-if="installation" data-testid="detail-modal" :data-installation-id="installation.id" :data-initial-tab="initialTab" />' +
      '</div>',
  },
}))
vi.mock('../views/ComfyUISettingsPanel.vue', () => ({
  default: {
    name: 'ComfyUISettingsPanel',
    props: ['open', 'installation'],
    emits: ['close', 'show-progress', 'navigate-list'],
    template: '<div data-testid="comfyui-settings-panel" />',
    methods: { requestClose: vi.fn() },
  },
}))
vi.mock('../components/DownloadsModal.vue', () => ({
  default: {
    name: 'DownloadsModal',
    props: ['open'],
    emits: ['close'],
    template: '<div data-testid="downloads-modal" />',
  },
}))
vi.mock('../views/MigrateConfirmTakeover.vue', () => ({
  default: {
    name: 'MigrateConfirmTakeover',
    emits: ['close'],
    template: '<div data-testid="migrate-confirm-takeover" />',
    methods: { open: vi.fn() },
  },
}))
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'
import PanelApp from './PanelApp.vue'
import { __resetLauncherPrefsForTest } from '../composables/useLauncherPrefs'
import { useOverlay } from '../composables/useOverlay'
import {
  TELEMETRY_ACTION_EVENT_NAME,
  type TelemetryActionEventDetail,
} from '../lib/telemetry'

const messages = {
  en: {
    titleBar: {
      panelComfy: 'ComfyUI',
      panelInstallSettings: 'Install Settings',
      panelLauncherSettings: 'Launcher Settings',
      installSettingsComingSoon: 'Coming soon',
      installationLabel: 'Installation',
    },
    common: {
      loading: 'Loading…',
    },
  },
}

function createTestI18n() {
  return createI18n({ legacy: false, locale: 'en', messages })
}

interface InstallationLike {
  id: string
  name: string
  sourceLabel: string
  sourceCategory: string
}

type PanelTriggerPayload = {
  kind:
    | 'install-update'
    | 'app-update-restart-prompt'
    | 'app-update-download-prompt'
  installationId?: string
  version?: string | null
}

interface MockApiState {
  panelSwitchCallbacks: ((data: { panel: string; installationId?: string }) => void)[]
  panelTriggerOverlayCallbacks: ((data: PanelTriggerPayload) => void)[]
  appUpdatePromptRestartCallbacks: ((data: { version: string }) => void)[]
  appUpdateUserActionFailedCallbacks: ((data: { message: string }) => void)[]
  installationsChangedCallbacks: (() => void)[]
  /** File-menu Skip Onboarding callbacks. Main fires this when the
   *  user clicks the entry in the waffle popup; tests can simulate
   *  the click by invoking each callback. */
  firstUseSkipCallbacks: (() => void)[]
  /** Feedback callbacks. Main fires this when the user clicks the
   *  title-bar Send Feedback button or the file-menu "Send Feedback"
   *  entry; tests can simulate the click by invoking each callback
   *  with the originating `source`. */
  openFeedbackCallbacks: ((data: { source: 'titlebar' | 'menu' }) => void)[]
  installations: InstallationLike[]
  getInstallations: ReturnType<typeof vi.fn>
  openExternal: ReturnType<typeof vi.fn>
  getAppVersion: ReturnType<typeof vi.fn>
  /** Per-key getSetting values. Tests that need first-use takeover to
   *  auto-mount can flip `firstUseCompleted` to false here. Default is
   *  `true` so existing tests don't trip the takeover. */
  settings: Record<string, unknown>
  installUpdate: ReturnType<typeof vi.fn>
  downloadUpdate: ReturnType<typeof vi.fn>
}

function installMockApi(initial?: {
  installations?: InstallationLike[]
  settings?: Record<string, unknown>
}): MockApiState {
  const installations: InstallationLike[] = initial?.installations ?? []
  const state: MockApiState = {
    panelSwitchCallbacks: [],
    panelTriggerOverlayCallbacks: [],
    appUpdatePromptRestartCallbacks: [],
    appUpdateUserActionFailedCallbacks: [],
    installationsChangedCallbacks: [],
    firstUseSkipCallbacks: [],
    openFeedbackCallbacks: [],
    installations,
    getInstallations: vi.fn(async () => state.installations),
    openExternal: vi.fn(async () => {}),
    getAppVersion: vi.fn(async () => '0.5.0'),
    settings: { firstUseCompleted: true, ...initial?.settings },
    installUpdate: vi.fn(async () => {}),
    downloadUpdate: vi.fn(async () => {}),
  }
  const api = {
    getLocaleMessages: vi.fn().mockResolvedValue(messages.en),
    getLocale: vi.fn().mockResolvedValue('en'),
    onLocaleChanged: vi.fn(() => () => {}),
    onPanelSwitch: vi.fn((cb: (d: { panel: string; installationId?: string }) => void) => {
      state.panelSwitchCallbacks.push(cb)
      return () => {}
    }),
    onPanelTriggerOverlay: vi.fn((cb: (d: PanelTriggerPayload) => void) => {
      state.panelTriggerOverlayCallbacks.push(cb)
      return () => {}
    }),
    onAppUpdatePromptRestart: vi.fn((cb: (d: { version: string }) => void) => {
      state.appUpdatePromptRestartCallbacks.push(cb)
      return () => {}
    }),
    onAppUpdateUserActionFailed: vi.fn((cb: (d: { message: string }) => void) => {
      state.appUpdateUserActionFailedCallbacks.push(cb)
      return () => {}
    }),
    installUpdate: state.installUpdate,
    downloadUpdate: state.downloadUpdate,
    setFirstUseMode: vi.fn(),
    closeCurrentPanel: vi.fn(),
    onFirstUseSkip: vi.fn((cb: () => void) => {
      state.firstUseSkipCallbacks.push(cb)
      return () => {}
    }),
    onOpenFeedback: vi.fn((cb: (data: { source: 'titlebar' | 'menu' }) => void) => {
      state.openFeedbackCallbacks.push(cb)
      return () => {}
    }),
    openExternal: state.openExternal,
    getAppVersion: state.getAppVersion,
    onSettingsChanged: vi.fn(() => () => {}),
    // Main consults the panel renderer before tearing down the host
    // window. PanelApp subscribes on mount; the test suite never
    // fires the consult so the mock is a no-op pair.
    onCloseRequest: vi.fn(() => () => {}),
    respondCloseRequest: vi.fn(),
    ackCloseRequest: vi.fn(),
    // Title-bar Settings icon → main routes a drawer-close request here
    // so the ComfyUISettingsPanel can play its leave animation before
    // closeCurrentPanel collapses the panelView. The test suite never
    // fires it; mock is a no-op.
    onRequestCloseDrawer: vi.fn(() => () => {}),
    onInstallationsChanged: vi.fn((cb: () => void) => {
      state.installationsChangedCallbacks.push(cb)
      return () => {}
    }),
    onInstallationsVersionsUpdated: vi.fn(() => () => {}),
    getInstallations: state.getInstallations,
    getRunningInstances: vi.fn().mockResolvedValue([]),
    onInstanceLaunching: vi.fn(() => () => {}),
    onInstanceLaunchFailed: vi.fn(() => () => {}),
    onInstanceStarted: vi.fn(() => () => {}),
    onInstanceStopped: vi.fn(() => () => {}),
    onInstanceStopping: vi.fn(() => () => {}),
    onComfyOutput: vi.fn(() => () => {}),
    onComfyExited: vi.fn(() => () => {}),
    onErrorDetail: vi.fn(() => () => {}),
    getSetting: vi.fn(async (key: string) => state.settings[key]),
    setSetting: vi.fn(async (key: string, value: unknown) => {
      state.settings[key] = value
    }),
    // PanelApp's first-use takeover host fetches the categorised
    // install state to decide whether to skip the cloud-vs-local
    // pick step. Default mock is "fresh user" — no prior installs,
    // no legacy desktop — so the takeover advances through every
    // step.
    getFirstUseState: vi.fn(async () => ({ skipPick: false, hasLegacyDesktop: false })),
    // Cloud-pick auto-launch fans out into the chooser-launch pipeline:
    // claim the host for in-place attach, look up the install's launch
    // action, then execute it. Mocking the IPC surface lets the new
    // `complete-skip` test assert these are NEVER called (returning
    // users must NOT be teleported into Cloud they didn't pick) while
    // the existing `complete-cloud` test continues to dismiss cleanly
    // when no cloud install is present in the store.
    claimAttachHost: vi.fn(async () => true),
    transferHostBoundsToInstall: vi.fn(async () => {}),
    closeHostWindow: vi.fn(async () => {}),
    focusComfyWindow: vi.fn(async () => {}),
    getListActions: vi.fn(async () => []),
    openGlobalSettings: vi.fn(),
  }
  ;(window as unknown as { api: typeof api }).api = api
  return state
}

function mountPanel() {
  return mount(PanelApp, {
    global: { plugins: [createTestI18n(), createPinia()] },
  })
}

const SAMPLE_INSTALL: InstallationLike = {
  id: 'test-id',
  name: 'Test Install',
  sourceLabel: 'Standalone',
  sourceCategory: 'local',
}

describe('PanelApp', () => {
  let mockState: MockApiState

  beforeEach(() => {
    setActivePinia(createPinia())
    // useLauncherPrefs has module-level shared state + memoized load
    // promise — reset both so each test sees a fresh load against the
    // current mock settings (in particular `firstUseCompleted`).
    __resetLauncherPrefsForTest()
    // useOverlay's slot is also a module-level singleton — clear it
    // so test order doesn't leak overlays between cases.
    useOverlay().current.value = null
    mockModal.alert.mockReset()
    mockModal.confirm.mockReset()
    mockModal.close.mockReset()
    mockState = installMockApi({ installations: [SAMPLE_INSTALL] })
    // Default URL — individual tests override.
    // `firstUseCompleted=true` short-circuits `seedLauncherPrefsFromUrl`
    // so `showPanelBody` returns synchronously on mount (without waiting
    // for the async `getSetting` IPC). Tests asserting the first-use
    // gating path (where the takeover should mount) override the URL
    // back to one without this param and flip `mockState.settings.firstUseCompleted`.
    window.history.replaceState({}, '', '/?installationId=test-id&firstUseCompleted=true')
  })

  it('renders the comfy-lifecycle body by default for install-backed hosts', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('[data-testid="comfy-lifecycle"]').exists()).toBe(true)
    // Page modals (settings / directories) only mount when explicitly opened.
    expect(wrapper.find('[data-testid="settings-view"]').exists()).toBe(false)
  })

  it('opens the unified Settings modal in response to onPanelSwitch', async () => {
    // The unified Settings modal defaults to the ComfyUI Settings tab
    // for install-backed hosts, which embeds the DetailModal body —
    // assert via the DetailModal stub's testid.
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('[data-testid="detail-modal"]').exists()).toBe(false)

    expect(mockState.panelSwitchCallbacks.length).toBeGreaterThan(0)
    mockState.panelSwitchCallbacks.forEach((cb) => cb({ panel: 'settings' }))
    await flushPromises()
    expect(wrapper.find('[data-testid="detail-modal"]').exists()).toBe(true)
    // Body underneath stays on the default lifecycle view.
    expect(wrapper.find('[data-testid="comfy-lifecycle"]').exists()).toBe(true)
  })

  it('ignores unknown panel keys from onPanelSwitch', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('[data-testid="comfy-lifecycle"]').exists()).toBe(true)

    mockState.panelSwitchCallbacks.forEach((cb) => cb({ panel: 'not-a-real-panel' }))
    await flushPromises()
    expect(wrapper.find('[data-testid="comfy-lifecycle"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="settings-view"]').exists()).toBe(false)
  })

  it('renders the unified Settings modal (ComfyUI Settings tab) for the URL installationId', async () => {
    window.history.replaceState({}, '', '/?installationId=test-id&panel=settings&firstUseCompleted=true')
    const wrapper = mountPanel()
    await flushPromises()
    const detail = wrapper.find('[data-testid="detail-modal"]')
    expect(detail.exists()).toBe(true)
    expect(detail.attributes('data-installation-id')).toBe('test-id')
  })

  it('refetches the installation when onInstallationsChanged fires', async () => {
    window.history.replaceState({}, '', '/?installationId=test-id&panel=settings&firstUseCompleted=true')
    const wrapper = mountPanel()
    await flushPromises()
    expect(mockState.getInstallations).toHaveBeenCalledTimes(1)

    // Mutate the underlying list, then fire the broadcast.
    mockState.installations = [{ ...SAMPLE_INSTALL, name: 'Renamed Install' }]
    expect(mockState.installationsChangedCallbacks.length).toBeGreaterThan(0)
    mockState.installationsChangedCallbacks.forEach((cb) => cb())
    await flushPromises()

    expect(mockState.getInstallations).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="detail-modal"]').exists()).toBe(true)
  })

  it('does not open the ComfyUI Settings tab when the installationId does not match', async () => {
    // The unified Settings modal still mounts on `panel=settings`, but
    // with no matching installation it falls through to the Global
    // Settings tab — DetailModal isn't embedded.
    window.history.replaceState({}, '', '/?installationId=missing-id&panel=settings&firstUseCompleted=true')
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('[data-testid="detail-modal"]').exists()).toBe(false)
  })

  it('renders the comfy-lifecycle view when initialised with that panel', async () => {
    // Main initialises panel.html with `panel=comfy-lifecycle` when the
    // Comfy tab body needs to show the lifecycle UI (instance not running).
    window.history.replaceState({}, '', '/?installationId=test-id&panel=comfy-lifecycle&firstUseCompleted=true')
    const wrapper = mountPanel()
    await flushPromises()
    const lifecycle = wrapper.find('[data-testid="comfy-lifecycle"]')
    expect(lifecycle.exists()).toBe(true)
    expect(lifecycle.attributes('data-installation-id')).toBe('test-id')
  })

  it('opens the unified Settings modal on Global Settings for install-less hosts', async () => {
    // Install-less (chooser) hosts now delegate to main via
    // window.api.openGlobalSettings() — no in-panel modal opens.
    window.history.replaceState({}, '', '/?panel=settings&firstUseCompleted=true')
    mountPanel()
    await flushPromises()
    const api = (window as unknown as { api: { openGlobalSettings: ReturnType<typeof vi.fn> } }).api
    expect(api.openGlobalSettings).toHaveBeenCalledTimes(1)
  })

  it('opens the new-install takeover above the chooser body when show-new-install fires', async () => {
    // Flow modals are Tier 3 takeover overlays. The chooser stays
    // mounted underneath the takeover, so dismissing the takeover
    // drops the user back into the chooser tile they came from with
    // no navigation churn.
    window.history.replaceState({}, '', '/?panel=chooser&firstUseCompleted=true')
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('[data-testid="chooser-view"]').exists()).toBe(true)
    await wrapper.find('[data-testid="chooser-new-install"]').trigger('click')
    await flushPromises()
    // Both visible — takeover sits ABOVE the chooser body.
    expect(wrapper.find('[data-testid="chooser-view"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="new-install-modal"]').exists()).toBe(true)
  })

  it('returns to the underlying body when a takeover emits close', async () => {
    window.history.replaceState({}, '', '/?panel=new-install&firstUseCompleted=true')
    const wrapper = mountPanel()
    await flushPromises()
    // The URL-driven flow panel mounts as a takeover above the default
    // body (chooser, since there's no installationId).
    expect(wrapper.find('[data-testid="new-install-modal"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="chooser-view"]').exists()).toBe(true)
    await wrapper.findComponent({ name: 'NewInstallModal' }).vm.$emit('close')
    await flushPromises()
    expect(wrapper.find('[data-testid="new-install-modal"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="chooser-view"]').exists()).toBe(true)
  })

  it('renders the track takeover when initialised with panel=track', async () => {
    window.history.replaceState({}, '', '/?panel=track&firstUseCompleted=true')
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('[data-testid="track-modal"]').exists()).toBe(true)
  })

  it('renders the load-snapshot takeover when initialised with panel=load-snapshot', async () => {
    window.history.replaceState({}, '', '/?panel=load-snapshot&firstUseCompleted=true')
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('[data-testid="load-snapshot-modal"]').exists()).toBe(true)
  })

  it('renders the quick-install takeover when initialised with panel=quick-install', async () => {
    window.history.replaceState({}, '', '/?panel=quick-install&firstUseCompleted=true')
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('[data-testid="quick-install-modal"]').exists()).toBe(true)
  })

  it.each([
    { panel: 'track', selector: '[data-testid="track-modal"]', name: 'TrackModal' },
    { panel: 'load-snapshot', selector: '[data-testid="load-snapshot-modal"]', name: 'LoadSnapshotModal' },
    { panel: 'quick-install', selector: '[data-testid="quick-install-modal"]', name: 'QuickInstallModal' },
    { panel: 'new-install', selector: '[data-testid="new-install-modal"]', name: 'NewInstallModal' },
  ])('IPCs closeCurrentPanel when the $panel takeover dismisses, so main\'s activePanel resets and the file menu can re-open it', async ({ panel, selector, name }) => {
    // Without this IPC, main's `entry.activePanel` stays stuck on the
    // wizard key after the renderer-side dismiss; the next file-menu
    // pick of the same item hits `setActivePanel`'s same-panel
    // early-return and the modal silently fails to reopen
    // (Comfy-Org/ComfyUI-Desktop-2.0-Beta#486).
    window.history.replaceState({}, '', `/?panel=${panel}&firstUseCompleted=true`)
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find(selector).exists()).toBe(true)

    const closeCurrentPanel = (window as unknown as {
      api: { closeCurrentPanel: ReturnType<typeof vi.fn> }
    }).api.closeCurrentPanel
    expect(closeCurrentPanel).not.toHaveBeenCalled()

    await wrapper.findComponent({ name }).vm.$emit('close')
    await flushPromises()

    expect(closeCurrentPanel).toHaveBeenCalledTimes(1)
    expect(wrapper.find(selector).exists()).toBe(false)
  })

  it('does NOT auto-mount the first-use takeover when firstUseCompleted is true', async () => {
    // Default mock state has firstUseCompleted: true; the takeover
    // should never enter the overlay slot.
    window.history.replaceState({}, '', '/?panel=chooser&firstUseCompleted=true')
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('[data-testid="first-use-takeover"]').exists()).toBe(false)
  })

  it('auto-mounts the first-use takeover and suppresses the chooser body when firstUseCompleted is false', async () => {
    // Body is gated out while a Tier 3 takeover owns the overlay slot —
    // BrandTakeoverLayout has a 240ms opacity fade-in, so rendering the
    // chooser behind it would bleed through during the entrance. The
    // dismiss tests below assert the body reveals when the takeover
    // clears (see "marks firstUseCompleted=true and closes the takeover
    // on Cloud-branch pick").
    mockState.settings.firstUseCompleted = false
    window.history.replaceState({}, '', '/?panel=chooser')
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('[data-testid="first-use-takeover"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="chooser-view"]').exists()).toBe(false)
  })

  it('marks firstUseCompleted=true and closes the takeover on Cloud-branch pick', async () => {
    mockState.settings.firstUseCompleted = false
    // Seed a cloud install so the auto-launch path can resolve a
    // target — the host pulls launch actions for it via the chooser
    // launch pipeline. We assert getListActions IS called here so the
    // returning-user `complete-skip` test below can credibly assert
    // the opposite.
    mockState.installations = [
      { id: 'cloud-id', name: 'Comfy Cloud', sourceLabel: 'Cloud', sourceCategory: 'cloud' },
    ]
    window.history.replaceState({}, '', '/?panel=chooser')
    const wrapper = mountPanel()
    await flushPromises()
    const api = (window as unknown as {
      api: {
        setSetting: ReturnType<typeof vi.fn>
        getListActions: ReturnType<typeof vi.fn>
      }
    }).api
    expect(api.setSetting).not.toHaveBeenCalledWith('firstUseCompleted', true)

    await wrapper.find('[data-testid="first-use-cloud"]').trigger('click')
    await flushPromises()

    expect(api.setSetting).toHaveBeenCalledWith('firstUseCompleted', true)
    expect(wrapper.find('[data-testid="first-use-takeover"]').exists()).toBe(false)
    // Chooser body underneath remains mounted.
    expect(wrapper.find('[data-testid="chooser-view"]').exists()).toBe(true)
    // Cloud auto-launch ran — getListActions resolves the launch
    // action for the seeded cloud install.
    expect(api.getListActions).toHaveBeenCalledWith('cloud-id')
  })

  it('marks firstUseCompleted=true on returning-user complete-skip WITHOUT auto-launching cloud', async () => {
    // Issue #476 — when `skipPick` is true (returning user with prior
    // local installs), accepting consent emits `complete-skip` rather
    // than `complete-cloud`. The host must mark completion and dismiss,
    // but MUST NOT launch the seeded cloud install: the user never
    // picked Cloud (the fork was suppressed), so auto-launching it
    // would hijack their existing local install.
    mockState.settings.firstUseCompleted = false
    mockState.installations = [
      { id: 'cloud-id', name: 'Comfy Cloud', sourceLabel: 'Cloud', sourceCategory: 'cloud' },
      SAMPLE_INSTALL,
    ]
    window.history.replaceState({}, '', '/?panel=chooser')
    const wrapper = mountPanel()
    await flushPromises()
    const api = (window as unknown as {
      api: {
        setSetting: ReturnType<typeof vi.fn>
        getListActions: ReturnType<typeof vi.fn>
      }
    }).api
    expect(api.setSetting).not.toHaveBeenCalledWith('firstUseCompleted', true)

    await wrapper.find('[data-testid="first-use-skip"]').trigger('click')
    await flushPromises()

    expect(api.setSetting).toHaveBeenCalledWith('firstUseCompleted', true)
    expect(wrapper.find('[data-testid="first-use-takeover"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="chooser-view"]').exists()).toBe(true)
    // Critical guarantee — no implicit cloud launch happened.
    expect(api.getListActions).not.toHaveBeenCalled()
  })

  it('chains into the new-install takeover on Local-branch pick and marks completion when new-install closes', async () => {
    mockState.settings.firstUseCompleted = false
    window.history.replaceState({}, '', '/?panel=chooser')
    const wrapper = mountPanel()
    await flushPromises()

    await wrapper.find('[data-testid="first-use-local"]').trigger('click')
    await flushPromises()

    // Tier 3 → Tier 3 swap: first-use unmounts, new-install mounts.
    expect(wrapper.find('[data-testid="first-use-takeover"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="new-install-modal"]').exists()).toBe(true)

    const setSetting = (window as unknown as {
      api: { setSetting: ReturnType<typeof vi.fn> }
    }).api.setSetting
    expect(setSetting).not.toHaveBeenCalledWith('firstUseCompleted', true)

    // New-install close (success or cancel) flips the persisted gate.
    await wrapper.findComponent({ name: 'NewInstallModal' }).vm.$emit('close')
    await flushPromises()
    expect(setSetting).toHaveBeenCalledWith('firstUseCompleted', true)
  })

  it('marks firstUseCompleted=true and closes the takeover when main fires the file-menu Skip Onboarding event', async () => {
    // Main routes the file-menu Skip Onboarding click into the
    // panel renderer via the
    // `comfy-panel:first-use-skip` IPC. PanelApp's listener should
    // run the same `markFirstUseCompleted` + dismiss-takeover
    // sequence the Cloud-branch pick uses, so the takeover
    // disappears and the chooser body underneath is the landing
    // surface (matching the Cloud-pick test above).
    mockState.settings.firstUseCompleted = false
    window.history.replaceState({}, '', '/?panel=chooser')
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('[data-testid="first-use-takeover"]').exists()).toBe(true)

    const setSetting = (window as unknown as {
      api: { setSetting: ReturnType<typeof vi.fn> }
    }).api.setSetting
    expect(setSetting).not.toHaveBeenCalledWith('firstUseCompleted', true)

    // Simulate the main → renderer Skip Onboarding push.
    expect(mockState.firstUseSkipCallbacks.length).toBeGreaterThan(0)
    mockState.firstUseSkipCallbacks.forEach((cb) => cb())
    await flushPromises()

    expect(setSetting).toHaveBeenCalledWith('firstUseCompleted', true)
    expect(wrapper.find('[data-testid="first-use-takeover"]').exists()).toBe(false)
    // Chooser body underneath remains mounted, same as Cloud-pick.
    expect(wrapper.find('[data-testid="chooser-view"]').exists()).toBe(true)
  })

  it('emits desktop2.feedback.opened with the originating source and opens the support URL', async () => {
    // Both the title-bar feedback button and the file-menu "Send
    // Feedback" entry route through main's `comfy-panel:open-feedback`
    // IPC. The panel renderer is the natural home for the click side-
    // effects because `buildSupportUrl()` reads `navigator.userAgent`
    // and the telemetry helper lives renderer-side. Verify the listener
    // (a) emits the telemetry action with `source` baked into the
    // context so we can tell the two affordances apart, and
    // (b) opens the typeform URL with the cached app version in `ver`.
    mountPanel()
    await flushPromises()

    interface TelemetryEvent {
      actionName: string
      context?: { source?: string }
    }
    const telemetryEvents: TelemetryEvent[] = []
    const listener = (e: Event): void => {
      telemetryEvents.push((e as CustomEvent<TelemetryEvent>).detail)
    }
    window.addEventListener('launcher-telemetry-action', listener)

    expect(mockState.openFeedbackCallbacks.length).toBeGreaterThan(0)
    // Title-bar button click.
    mockState.openFeedbackCallbacks.forEach((cb) => cb({ source: 'titlebar' }))
    await flushPromises()
    // File-menu entry click.
    mockState.openFeedbackCallbacks.forEach((cb) => cb({ source: 'menu' }))
    await flushPromises()

    window.removeEventListener('launcher-telemetry-action', listener)

    const feedbackTelemetry = telemetryEvents.filter(
      (e) => e.actionName === 'desktop2.feedback.opened',
    )
    expect(feedbackTelemetry.map((e) => e.context?.source)).toEqual(['titlebar', 'menu'])
    expect(mockState.openExternal).toHaveBeenCalledTimes(2)
    const url = (mockState.openExternal.mock.calls[0]?.[0] ?? '') as string
    expect(url).toContain('form.typeform.com/to/VhOXmuaL')
    expect(url).toContain('ver=0.5.0')
    expect(url).toMatch(/[?&]platform=/)
  })

  // The first-use takeover has no in-app ✕ close button (first-use
  // is a binding flow). Mid-flow dismissal happens via OS-chrome
  // window close, which routes through `onCloseRequest` →
  // `closeOverlay` (a renderer-internal direct mutation that doesn't
  // go through any FirstUseTakeover emit). The "doesn't mark
  // firstUseCompleted on mid-flow exit" guarantee holds because no
  // code path between mount and the explicit Cloud / Local picks
  // calls `markFirstUseCompleted` — the cloud / chain-local tests
  // above already assert that ordering by checking `setSetting`
  // hasn't been called with `firstUseCompleted` until the user makes
  // the explicit pick.

  it('keeps the comfy-lifecycle body when a panel-switch IPC event re-confirms it', async () => {
    // The default body for an install-backed host is already comfy-lifecycle;
    // a redundant panel-switch must leave it intact.
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('[data-testid="comfy-lifecycle"]').exists()).toBe(true)

    mockState.panelSwitchCallbacks.forEach((cb) => cb({ panel: 'comfy-lifecycle' }))
    await flushPromises()
    expect(wrapper.find('[data-testid="comfy-lifecycle"]').exists()).toBe(true)
  })

  it('mounts the manage overlay (DetailModal) when a panel-trigger-overlay install-update event arrives', async () => {
    // The title-bar install-update pill click is forwarded by main
    // as an `onPanelTriggerOverlay` event with
    // `kind: 'install-update'` and the host's installationId. The
    // panel renderer routes that into a Tier 1 manage overlay with
    // initialTab='update' so the DetailModal opens directly on the
    // update tab.
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('[data-testid="detail-modal"]').exists()).toBe(false)

    mockState.panelTriggerOverlayCallbacks.forEach((cb) =>
      cb({ kind: 'install-update', installationId: 'test-id' }),
    )
    await flushPromises()
    const detail = wrapper.find('[data-testid="detail-modal"]')
    expect(detail.exists()).toBe(true)
    expect(detail.attributes('data-installation-id')).toBe('test-id')
  })

  it('shows the "Desktop Update Ready" confirm modal when a restart-prompt event arrives, and installs on confirm', async () => {
    // Issue #488 — auto-on click on the 'ready' pill (or the auto
    // restart-prompt that fires on user-initiated download
    // completion) routes through `app-update-restart-prompt`. The
    // panel renderer pops a confirm modal; clicking Restart calls
    // `installUpdate()`.
    mockModal.confirm.mockResolvedValueOnce(true)
    mountPanel()
    await flushPromises()

    mockState.panelTriggerOverlayCallbacks.forEach((cb) =>
      cb({ kind: 'app-update-restart-prompt', version: '1.2.3' }),
    )
    await flushPromises()

    expect(mockModal.confirm).toHaveBeenCalledTimes(1)
    expect(mockModal.confirm.mock.calls[0]?.[0]).toMatchObject({
      title: 'appUpdate.readyTitle',
      confirmLabel: 'appUpdate.restartNow',
    })
    expect(mockState.installUpdate).toHaveBeenCalledTimes(1)
  })

  it('does not install when the restart-prompt confirm modal is cancelled', async () => {
    mockModal.confirm.mockResolvedValueOnce(false)
    mountPanel()
    await flushPromises()

    mockState.panelTriggerOverlayCallbacks.forEach((cb) =>
      cb({ kind: 'app-update-restart-prompt', version: '1.2.3' }),
    )
    await flushPromises()

    expect(mockModal.confirm).toHaveBeenCalledTimes(1)
    expect(mockState.installUpdate).not.toHaveBeenCalled()
  })

  it('shows the "Desktop Update Available" confirm modal when a download-prompt event arrives, and downloads on confirm', async () => {
    // Issue #488 — auto-off click on the 'available' pill routes
    // through `app-update-download-prompt`. Clicking Download calls
    // `downloadUpdate()`; the auto restart-prompt fires later (covered
    // by `onAppUpdatePromptRestart`).
    mockModal.confirm.mockResolvedValueOnce(true)
    mountPanel()
    await flushPromises()

    mockState.panelTriggerOverlayCallbacks.forEach((cb) =>
      cb({ kind: 'app-update-download-prompt', version: '1.2.3' }),
    )
    await flushPromises()

    expect(mockModal.confirm).toHaveBeenCalledTimes(1)
    expect(mockModal.confirm.mock.calls[0]?.[0]).toMatchObject({
      title: 'appUpdate.availableTitle',
      confirmLabel: 'appUpdate.download',
    })
    expect(mockState.downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it('auto-shows the restart prompt when onAppUpdatePromptRestart fires (auto-off post-download)', async () => {
    // Closes the loop on the auto-off "Download → wait → Restart"
    // single-gesture flow described in issue #488.
    mockModal.confirm.mockResolvedValueOnce(true)
    mountPanel()
    await flushPromises()

    mockState.appUpdatePromptRestartCallbacks.forEach((cb) => cb({ version: '1.2.3' }))
    await flushPromises()

    expect(mockModal.confirm).toHaveBeenCalledTimes(1)
    expect(mockModal.confirm.mock.calls[0]?.[0]).toMatchObject({
      title: 'appUpdate.readyTitle',
    })
    expect(mockState.installUpdate).toHaveBeenCalledTimes(1)
  })

  it('shows an alert modal when onAppUpdateUserActionFailed fires', async () => {
    mountPanel()
    await flushPromises()

    mockState.appUpdateUserActionFailedCallbacks.forEach((cb) =>
      cb({ message: 'network down' }),
    )
    await flushPromises()

    expect(mockModal.alert).toHaveBeenCalledTimes(1)
    expect(mockModal.alert.mock.calls[0]?.[0]).toMatchObject({
      title: 'appUpdate.errorTitle',
      message: 'network down',
    })
  })

  it('ignores install-update events whose installationId does not match the host', async () => {
    // Defensive — main scopes the install-update broadcast to the
    // matching host's panelView, but the renderer also re-validates.
    const wrapper = mountPanel()
    await flushPromises()
    mockState.panelTriggerOverlayCallbacks.forEach((cb) =>
      cb({ kind: 'install-update', installationId: 'someone-else' }),
    )
    await flushPromises()
    expect(wrapper.find('[data-testid="detail-modal"]').exists()).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // Telemetry (issue #485) — verify `desktop2.install.flow.opened`
  // and `desktop2.view.opened` fire from PanelApp's
  // `openFlowTakeover` / `switchPanel`.
  //
  // Captures CustomEvents on the `window` (the same channel
  // `emitTelemetryAction` uses to bridge into the providers) so the test
  // doesn't have to mock the Datadog / PostHog modules.
  // ---------------------------------------------------------------------------
  describe('telemetry', () => {
    function captureTelemetry(): TelemetryActionEventDetail[] {
      const events: TelemetryActionEventDetail[] = []
      window.addEventListener(TELEMETRY_ACTION_EVENT_NAME, (event) => {
        events.push((event as CustomEvent<TelemetryActionEventDetail>).detail)
      })
      return events
    }

    it('fires desktop2.install.flow.opened with entrypoint=chooser when chooser empty-state CTA fires', async () => {
      window.history.replaceState({}, '', '/?panel=chooser&firstUseCompleted=true')
      const wrapper = mountPanel()
      await flushPromises()
      const events = captureTelemetry()
      await wrapper.find('[data-testid="chooser-new-install"]').trigger('click')
      await flushPromises()
      const flowEvents = events.filter((e) => e.actionName === 'desktop2.install.flow.opened')
      expect(flowEvents).toHaveLength(1)
      expect(flowEvents[0].context).toMatchObject({
        flow: 'new_install',
        entrypoint: 'chooser',
      })
    })

    it('fires desktop2.install.flow.opened with entrypoint=titlebar for a panel-switch IPC', async () => {
      window.history.replaceState({}, '', '/?panel=chooser&firstUseCompleted=true')
      mountPanel()
      await flushPromises()
      const events = captureTelemetry()
      mockState.panelSwitchCallbacks.forEach((cb) => cb({ panel: 'quick-install' }))
      await flushPromises()
      const flowEvents = events.filter((e) => e.actionName === 'desktop2.install.flow.opened')
      expect(flowEvents).toHaveLength(1)
      expect(flowEvents[0].context).toMatchObject({
        flow: 'quick_install',
        entrypoint: 'titlebar',
      })
    })

    it('maps each FlowComponent to its legacy flow string', async () => {
      window.history.replaceState({}, '', '/?panel=chooser&firstUseCompleted=true')
      mountPanel()
      await flushPromises()
      const events = captureTelemetry()
      const cases: { panel: string; flow: string }[] = [
        { panel: 'new-install', flow: 'new_install' },
        { panel: 'track', flow: 'track_existing' },
        { panel: 'load-snapshot', flow: 'load_snapshot' },
        { panel: 'quick-install', flow: 'quick_install' },
      ]
      for (const { panel } of cases) {
        mockState.panelSwitchCallbacks.forEach((cb) => cb({ panel }))
        await flushPromises()
        // The takeover slot only holds one component; emit close so the
        // next case can open. Each *Modal stub emits 'close'.
        const open = events.filter((e) => e.actionName === 'desktop2.install.flow.opened').pop()
        // Dismiss whatever takeover is currently mounted.
        useOverlay().current.value = null
        await flushPromises()
        expect(open?.context?.flow, `panel=${panel}`).toBe(
          cases.find((c) => c.panel === panel)?.flow,
        )
      }
    })

    it('fires desktop2.install.flow.opened with entrypoint=url when the URL initial panel is a flow', async () => {
      // Captures must be installed BEFORE mount because the URL-driven
      // initial-panel branch fires from inside `onMounted`.
      const events = captureTelemetry()
      window.history.replaceState({}, '', '/?panel=load-snapshot&firstUseCompleted=true')
      mountPanel()
      await flushPromises()
      const flowEvents = events.filter((e) => e.actionName === 'desktop2.install.flow.opened')
      expect(flowEvents).toHaveLength(1)
      expect(flowEvents[0].context).toMatchObject({
        flow: 'load_snapshot',
        entrypoint: 'url',
      })
    })

    it('fires desktop2.install.flow.opened with entrypoint=first_use on the first-use Local-branch chain', async () => {
      mockState.settings.firstUseCompleted = false
      window.history.replaceState({}, '', '/?panel=chooser')
      const wrapper = mountPanel()
      await flushPromises()
      const events = captureTelemetry()
      await wrapper.find('[data-testid="first-use-local"]').trigger('click')
      await flushPromises()
      const flowEvents = events.filter((e) => e.actionName === 'desktop2.install.flow.opened')
      expect(flowEvents).toHaveLength(1)
      expect(flowEvents[0].context).toMatchObject({
        flow: 'new_install',
        entrypoint: 'first_use',
      })
    })

    it('fires desktop2.view.opened with the previous panel as from_view when opening unified settings', async () => {
      // Default install-backed host → comfy-lifecycle is the underlying body.
      // switchPanel('settings') is the one telemetry-emitting overlay
      // opener for the file menu.
      mountPanel()
      await flushPromises()
      const events = captureTelemetry()
      mockState.panelSwitchCallbacks.forEach((cb) => cb({ panel: 'settings' }))
      await flushPromises()
      const viewEvents = events.filter((e) => e.actionName === 'desktop2.view.opened')
      expect(viewEvents).toHaveLength(1)
      expect(viewEvents[0].context).toMatchObject({
        view: 'settings',
        from_view: 'comfy-lifecycle',
      })
    })

    it('does NOT fire desktop2.view.opened when a panel-switch IPC re-confirms the active body panel', async () => {
      mountPanel()
      await flushPromises()
      const events = captureTelemetry()
      // Default body is comfy-lifecycle; re-confirming it is a no-op.
      mockState.panelSwitchCallbacks.forEach((cb) => cb({ panel: 'comfy-lifecycle' }))
      await flushPromises()
      expect(events.filter((e) => e.actionName === 'desktop2.view.opened')).toHaveLength(0)
    })

    it('does NOT fire desktop2.install.flow.opened when openFlowTakeover is rejected by an in-flight Tier 2 op', async () => {
      // useOverlay's tier-collision rules can reject a Tier 3 open if a
      // Tier 2 progress op is in flight and the user cancels the
      // confirm-prompt. The renderer must not fire the telemetry event
      // when the takeover never actually mounted. Simulate by pre-
      // populating the overlay slot with a progress op (Tier 2) and
      // routing a flow open through panel-switch — useOverlay will
      // request confirmation via window.api which our mock leaves
      // unresolved, so openOverlay returns false.
      window.history.replaceState({}, '', '/?panel=chooser&firstUseCompleted=true')
      mountPanel()
      await flushPromises()
      // Pre-populate Tier 2 progress overlay.
      useOverlay().current.value = {
        kind: 'progress',
        installationId: 'test-id',
        operationName: 'install',
        onCancel: () => {},
      }
      const events = captureTelemetry()
      // Trigger the flow open. The collision logic in useOverlay will
      // either prompt (default-deny in tests since no confirm handler is
      // wired) or silently reject — either way openFlowTakeover should
      // bail before emitting telemetry.
      mockState.panelSwitchCallbacks.forEach((cb) => cb({ panel: 'new-install' }))
      await flushPromises()
      expect(events.filter((e) => e.actionName === 'desktop2.install.flow.opened')).toHaveLength(0)
    })
  })
})
