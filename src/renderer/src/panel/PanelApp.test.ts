import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../main', () => ({
  i18n: {
    global: { t: (key: string) => key },
  },
}))

vi.mock('../composables/useTheme', () => ({ useTheme: () => ({ theme: 'dark' }) }))
vi.mock('../composables/useModal', () => ({
  useModal: () => ({ alert: vi.fn(), confirm: vi.fn(), close: vi.fn() }),
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
    // Phase 3 §17 dropped the `inline` prop — DetailModal renders one
    // way and the parent owns the close behaviour.
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
vi.mock('../components/UpdateBanner.vue', () => ({
  default: {
    name: 'UpdateBanner',
    template: '<div data-testid="update-banner" />',
  },
}))
vi.mock('../components/AppUpdatePopover.vue', () => ({
  default: {
    name: 'AppUpdatePopover',
    emits: ['close'],
    template: '<div data-testid="app-update-popover" />',
  },
}))
vi.mock('../components/DownloadsTrayPopover.vue', () => ({
  default: {
    name: 'DownloadsTrayPopover',
    emits: ['close'],
    template: '<div data-testid="downloads-tray-popover" />',
  },
}))

import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'
import PanelApp from './PanelApp.vue'
import { __resetLauncherPrefsForTest } from '../composables/useLauncherPrefs'
import { useOverlay } from '../composables/useOverlay'

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

interface MockApiState {
  panelSwitchCallbacks: ((data: { panel: string; installationId?: string }) => void)[]
  panelTriggerOverlayCallbacks: ((data: {
    kind: 'app-update' | 'install-update' | 'downloads'
    installationId?: string
  }) => void)[]
  installationsChangedCallbacks: (() => void)[]
  /** Modal-unification (Track M-2.2) — file-menu Skip Onboarding
   *  callbacks. Main fires this when the user clicks the entry in the
   *  waffle popup; tests can simulate the click by invoking each
   *  callback. */
  firstUseSkipCallbacks: (() => void)[]
  installations: InstallationLike[]
  getInstallations: ReturnType<typeof vi.fn>
  /** Per-key getSetting values. Tests that need first-use takeover to
   *  auto-mount can flip `firstUseCompleted` to false here. Default is
   *  `true` so existing tests don't trip the takeover. */
  settings: Record<string, unknown>
}

function installMockApi(initial?: {
  installations?: InstallationLike[]
  settings?: Record<string, unknown>
}): MockApiState {
  const installations: InstallationLike[] = initial?.installations ?? []
  const state: MockApiState = {
    panelSwitchCallbacks: [],
    panelTriggerOverlayCallbacks: [],
    installationsChangedCallbacks: [],
    firstUseSkipCallbacks: [],
    installations,
    getInstallations: vi.fn(async () => state.installations),
    settings: { firstUseCompleted: true, ...initial?.settings },
  }
  const api = {
    getLocaleMessages: vi.fn().mockResolvedValue(messages.en),
    getLocale: vi.fn().mockResolvedValue('en'),
    onLocaleChanged: vi.fn(() => () => {}),
    onPanelSwitch: vi.fn((cb: (d: { panel: string; installationId?: string }) => void) => {
      state.panelSwitchCallbacks.push(cb)
      return () => {}
    }),
    onPanelTriggerOverlay: vi.fn(
      (
        cb: (d: {
          kind: 'app-update' | 'install-update' | 'downloads'
          installationId?: string
        }) => void,
      ) => {
        state.panelTriggerOverlayCallbacks.push(cb)
        return () => {}
      },
    ),
    setFirstUseMode: vi.fn(),
    onFirstUseSkip: vi.fn((cb: () => void) => {
      state.firstUseSkipCallbacks.push(cb)
      return () => {}
    }),
    onSettingsChanged: vi.fn(() => () => {}),
    // Step 5 §16 — main consults the panel renderer before tearing
    // down the host window. PanelApp subscribes on mount; the test
    // suite never fires the consult so the mock is a no-op pair.
    onCloseRequest: vi.fn(() => () => {}),
    respondCloseRequest: vi.fn(),
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
    // Post-Phase-3 polish: PanelApp's first-use takeover host fetches
    // the categorised install state to decide whether to skip the
    // cloud-vs-local pick step. Default mock is "fresh user" — no
    // prior installs, no legacy desktop — so the takeover advances
    // through every step exactly as it did before.
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
    mockState = installMockApi({ installations: [SAMPLE_INSTALL] })
    // Default URL — individual tests override.
    window.history.replaceState({}, '', '/?installationId=test-id')
  })

  it('renders the comfy-lifecycle body by default for install-backed hosts', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('[data-testid="comfy-lifecycle"]').exists()).toBe(true)
    // Page modals (settings / directories) only mount when explicitly opened.
    expect(wrapper.find('[data-testid="settings-view"]').exists()).toBe(false)
  })

  it('opens install-settings as a manage overlay in response to onPanelSwitch', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('[data-testid="detail-modal"]').exists()).toBe(false)

    expect(mockState.panelSwitchCallbacks.length).toBeGreaterThan(0)
    mockState.panelSwitchCallbacks.forEach((cb) => cb({ panel: 'install-settings' }))
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

  it('renders the install-settings DetailModal for the URL installationId', async () => {
    window.history.replaceState({}, '', '/?installationId=test-id&panel=install-settings')
    const wrapper = mountPanel()
    await flushPromises()
    const detail = wrapper.find('[data-testid="detail-modal"]')
    expect(detail.exists()).toBe(true)
    expect(detail.attributes('data-installation-id')).toBe('test-id')
  })

  it('refetches the installation when onInstallationsChanged fires', async () => {
    window.history.replaceState({}, '', '/?installationId=test-id&panel=install-settings')
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

  it('does not open install-settings as an overlay when the installationId does not match', async () => {
    window.history.replaceState({}, '', '/?installationId=missing-id&panel=install-settings')
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('[data-testid="detail-modal"]').exists()).toBe(false)
  })

  it('renders the comfy-lifecycle view when initialised with that panel', async () => {
    // Main initialises panel.html with `panel=comfy-lifecycle` when the
    // Comfy tab body needs to show the lifecycle UI (instance not running).
    window.history.replaceState({}, '', '/?installationId=test-id&panel=comfy-lifecycle')
    const wrapper = mountPanel()
    await flushPromises()
    const lifecycle = wrapper.find('[data-testid="comfy-lifecycle"]')
    expect(lifecycle.exists()).toBe(true)
    expect(lifecycle.attributes('data-installation-id')).toBe('test-id')
  })

  it('renders the directories view when initialised with panel=directories', async () => {
    window.history.replaceState({}, '', '/?installationId=test-id&panel=directories')
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('[data-testid="directories-view"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="settings-view"]').exists()).toBe(false)
  })

  it('opens the directories overlay in response to a panel-switch IPC event', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('[data-testid="directories-view"]').exists()).toBe(false)

    mockState.panelSwitchCallbacks.forEach((cb) => cb({ panel: 'directories' }))
    await flushPromises()
    expect(wrapper.find('[data-testid="directories-view"]').exists()).toBe(true)
    // Body underneath stays on the default lifecycle view.
    expect(wrapper.find('[data-testid="comfy-lifecycle"]').exists()).toBe(true)
  })

  it('opens the new-install takeover above the chooser body when show-new-install fires', async () => {
    // Phase 3 §17 — flow modals migrated from panel-body to Tier 3
    // takeover overlays. The chooser stays mounted underneath the
    // takeover, so dismissing the takeover drops the user back into
    // the chooser tile they came from with no navigation churn.
    window.history.replaceState({}, '', '/?panel=chooser')
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
    window.history.replaceState({}, '', '/?panel=new-install')
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
    window.history.replaceState({}, '', '/?panel=track')
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('[data-testid="track-modal"]').exists()).toBe(true)
  })

  it('renders the load-snapshot takeover when initialised with panel=load-snapshot', async () => {
    window.history.replaceState({}, '', '/?panel=load-snapshot')
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('[data-testid="load-snapshot-modal"]').exists()).toBe(true)
  })

  it('renders the quick-install takeover when initialised with panel=quick-install', async () => {
    window.history.replaceState({}, '', '/?panel=quick-install')
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('[data-testid="quick-install-modal"]').exists()).toBe(true)
  })

  it('does NOT auto-mount the first-use takeover when firstUseCompleted is true', async () => {
    // Default mock state has firstUseCompleted: true; the takeover
    // should never enter the overlay slot.
    window.history.replaceState({}, '', '/?panel=chooser')
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('[data-testid="first-use-takeover"]').exists()).toBe(false)
  })

  it('auto-mounts the first-use takeover above the chooser body when firstUseCompleted is false', async () => {
    mockState.settings.firstUseCompleted = false
    window.history.replaceState({}, '', '/?panel=chooser')
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('[data-testid="chooser-view"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="first-use-takeover"]').exists()).toBe(true)
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
    // Modal-unification (Track M-2.2) — main routes the file-menu
    // Skip Onboarding click into the panel renderer via the
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

  // Post-Phase-3 polish: the first-use takeover dropped its in-app
  // ✕ close button (first-use is a binding flow). Mid-flow dismissal
  // now only happens via OS-chrome window close, which routes through
  // `onCloseRequest` → `closeOverlay` (a renderer-internal direct
  // mutation that doesn't go through any FirstUseTakeover emit). The
  // "doesn't mark firstUseCompleted on mid-flow exit" guarantee is
  // preserved because no code path between mount and the explicit
  // Cloud / Local picks calls `markFirstUseCompleted` — the cloud /
  // chain-local tests above already assert that ordering by checking
  // `setSetting` hasn't been called with `firstUseCompleted` until the
  // user makes the explicit pick.

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
    // Phase 3 §18 — the title-bar install-update pill click is
    // forwarded by main as an `onPanelTriggerOverlay` event with
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

  it('mounts the AppUpdatePopover when a panel-trigger-overlay app-update event arrives', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('[data-testid="app-update-popover"]').exists()).toBe(false)

    mockState.panelTriggerOverlayCallbacks.forEach((cb) => cb({ kind: 'app-update' }))
    await flushPromises()
    expect(wrapper.find('[data-testid="app-update-popover"]').exists()).toBe(true)
  })

  it('mounts the DownloadsTrayPopover when a panel-trigger-overlay downloads event arrives (Track F)', async () => {
    // Track F — the title-bar downloads tray click routes through
    // `panel-trigger-overlay { kind: 'downloads' }`. PanelApp opens
    // the popover at Tier 1 (same tier as AppUpdatePopover).
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('[data-testid="downloads-tray-popover"]').exists()).toBe(false)

    mockState.panelTriggerOverlayCallbacks.forEach((cb) => cb({ kind: 'downloads' }))
    await flushPromises()
    expect(wrapper.find('[data-testid="downloads-tray-popover"]').exists()).toBe(true)
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
})
