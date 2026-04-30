import { createTestingPinia } from '@pinia/testing'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import { nextTick, ref } from 'vue'

// --- Stubs ----------------------------------------------------------------

// Stub telemetry: it touches `window.dispatchEvent`, which doesn't survive
// `vi.stubGlobal('window', ...)` in happy-dom. Component tests don't assert
// on telemetry payloads — covered separately.
vi.mock('../lib/telemetry', () => ({
  emitTelemetryAction: vi.fn(),
}))

// Stub the migrate composable; pickMigrate uses confirmMigration which would
// otherwise need the full migrate IPC surface.
vi.mock('../composables/useMigrateAction', () => ({
  useMigrateAction: () => ({
    confirmMigration: vi.fn().mockResolvedValue(null),
  }),
}))

// Stub the modal composable — pickCloud-bail and form errors call modal.alert
// indirectly. Returning a noop is enough for these tests.
vi.mock('../composables/useModal', () => ({
  useModal: () => ({
    alert: vi.fn().mockResolvedValue(undefined),
    confirm: vi.fn().mockResolvedValue(false),
    close: vi.fn(),
    updateConfirm: vi.fn(),
    state: { selectedVariant: null },
    getLastCheckboxValues: () => ({}),
  }),
}))

// Stub the onboarding prefs composable so each test can seed initial state.
// We use refs so the component's reactivity still works against them.
const mockPrefsState = {
  completed: ref(false),
  eulaAccepted: ref(false),
  eulaAcceptedAt: ref<number | null>(null),
  telemetryEnabled: ref(true),
  lastUsedMode: ref<'cloud' | 'local' | null>(null),
  loaded: ref(true),
}
const mockPrefsMethods = {
  loadPrefs: vi.fn().mockResolvedValue(undefined),
  setTelemetry: vi.fn(async (v: boolean) => { mockPrefsState.telemetryEnabled.value = v }),
  setEulaAccepted: vi.fn(async (v: boolean) => { mockPrefsState.eulaAccepted.value = v }),
  setLastUsedMode: vi.fn(async (m: 'cloud' | 'local') => { mockPrefsState.lastUsedMode.value = m }),
  complete: vi.fn(async () => { mockPrefsState.completed.value = true }),
}
vi.mock('../composables/useOnboardingPrefs', () => ({
  useOnboardingPrefs: () => ({ ...mockPrefsState, ...mockPrefsMethods }),
}))

// Stub progress store actions referenced by startInstall — full pinia store
// would still work but we don't drive the install path in these tests.
vi.mock('../stores/progressStore', () => ({
  useProgressStore: () => ({
    operations: new Map(),
    startOperation: vi.fn(),
  }),
}))

// Stub installation store with controllable installations list.
// Pinia auto-unwraps refs when you access store.foo; our mock has to do the
// same so the component's `installationStore.installations.find(...)` works
// without `.value`. Use a getter that reads through the underlying ref.
const mockInstallations = ref<Array<Record<string, unknown>>>([])
vi.mock('../stores/installationStore', () => ({
  useInstallationStore: () => ({
    get installations() { return mockInstallations.value },
    fetchInstallations: vi.fn().mockResolvedValue(undefined),
  }),
}))

// --- window.api fake ------------------------------------------------------
// Tracks calls so tests can assert outcomes without spinning up real IPC.

interface ApiCalls {
  runAction: Array<{ id: string; action: string }>
  hideLauncherWindow: number
  focusComfyWindow: string[]
  setSetting: Array<{ key: string; value: unknown }>
}
let apiCalls: ApiCalls
let runActionImpl: () => Promise<unknown>

function setupApi(): void {
  apiCalls = { runAction: [], hideLauncherWindow: 0, focusComfyWindow: [], setSetting: [] }
  runActionImpl = async () => ({ ok: true })

  // Don't replace `window` wholesale — vi.stubGlobal('window', {...window, ...})
  // breaks happy-dom's event constructors (MouseEvent etc.) which @vue/test-utils
  // needs for trigger(). Just install `window.api` directly.
  ;(window as unknown as { api: unknown }).api = {
    runAction: vi.fn(async (id: string, action: string) => {
      apiCalls.runAction.push({ id, action })
      return await runActionImpl()
    }),
    hideLauncherWindow: vi.fn(async () => { apiCalls.hideLauncherWindow++ }),
    focusComfyWindow: vi.fn((id: string) => { apiCalls.focusComfyWindow.push(id) }),
    setSetting: vi.fn(async (key: string, value: unknown) => {
      apiCalls.setSetting.push({ key, value })
    }),
    getSetting: vi.fn(async () => undefined),
    openExternal: vi.fn(),
    cancelLaunch: vi.fn().mockResolvedValue(undefined),
    onErrorDetail: vi.fn(() => vi.fn()),
  }
}

beforeEach(() => {
  setupApi()
  // Reset mock prefs to defaults
  mockPrefsState.completed.value = false
  mockPrefsState.eulaAccepted.value = false
  mockPrefsState.eulaAcceptedAt.value = null
  mockPrefsState.telemetryEnabled.value = true
  mockPrefsState.lastUsedMode.value = null
  mockInstallations.value = []
  vi.clearAllMocks()
})

afterEach(() => {
  // Clean up the api shim we installed in setupApi
  delete (window as unknown as { api?: unknown }).api
})

// --- Test helpers ---------------------------------------------------------

const messages = {
  en: {
    onboarding: {
      welcomeTitle: 'Welcome to ComfyUI Desktop',
      welcomeSubtitle: 'Set up your studio in two minutes.',
      telemetryLabel: 'Send anonymous usage data',
      telemetryHint: 'Helps us see which features people use.',
      eulaLabel: 'I accept the End User License Agreement',
      eulaHint: 'Required to use ComfyUI Desktop.',
      eulaViewLink: 'View license',
      continue: 'Continue',
      continueDisabledTooltip: 'Accept the license to continue',
      modeTitle: 'Where do you want to run ComfyUI?',
      modeSubtitle: 'You can change this later in Settings.',
      cloudCardTitle: 'Comfy Cloud',
      cloudCardDesc: 'Run on managed GPUs.',
      cloudCardCta: 'Connect',
      localCardTitle: 'On this machine',
      localCardDesc: 'Run ComfyUI locally.',
      localCardCta: 'Install locally',
      legacyDetectedTitle: 'We found a Legacy Desktop install',
      migrateCardTitle: 'Migrate from Legacy Desktop',
      migrateCardDesc: 'Bring your workflows.',
      migrateCardCta: 'Migrate now',
      startFreshCardTitle: 'Start fresh',
      startFreshCardDesc: 'Begin a new install.',
      startFreshCardCta: 'New install',
      back: 'Back',
      preparing: 'Preparing your install…',
      installFormTitle: 'Where should ComfyUI live?',
      installFormSubtitle: 'Pick a folder and a version.',
      formLoading: 'Detecting your hardware…',
      installPathLabel: 'Install location',
      installPathHint: 'ComfyUI lives here.',
      browse: 'Browse',
      versionLabel: 'ComfyUI version',
      detectedGpu: 'Detected: {gpu}',
      installCta: 'Install ComfyUI',
      installingFor: 'Installing for',
      installingTitle: 'Setting up your studio',
      installFlavor1: 'Warming up…',
      installFlavor2: 'Downloading…',
      installFlavor3: 'Installing…',
      installFlavor4: 'Almost there…',
      installFlavor5: 'Polishing…',
      installFailedFlavor: 'Failed.',
      elapsed: 'Elapsed {time}',
      cloudConnectingMeta: 'COMFY CLOUD',
      cloudConnectingTitle: 'Opening Comfy Cloud',
      cloudConnectingFlavor: 'Connecting…',
      cloudConnectingStatus: 'Reaching cloud.comfy.org…',
      cloudConnectingTimeout: 'Still connecting…',
      cloudConnectError: "Couldn't reach Comfy Cloud.",
      doneTitle: 'Your studio is ready',
      doneSubtitle: 'Opening ComfyUI…',
    },
    progress: { starting: 'Starting…' },
    desktop: { migrating: 'Migrating' },
    newInstall: {
      installing: 'Installing',
      unsupportedHardwareTitle: 'Unsupported',
      noOptions: 'No options',
    },
    errors: { installFailed: 'Install failed', cannotAdd: 'Cannot add' },
  },
}

function createTestI18n() {
  return createI18n({ legacy: false, locale: 'en', messages, missingWarn: false, fallbackWarn: false })
}

async function mountView() {
  // Importing inside the helper makes the module pick up the current vi.mock
  // shapes (vitest hoists vi.mock to the top of the file, so this is purely
  // for IDE clarity).
  const OnboardingView = (await import('./OnboardingView.vue')).default
  return mount(OnboardingView, {
    global: { plugins: [createTestI18n(), createTestingPinia()] },
  })
}

function findButtonByText(wrapper: ReturnType<typeof mount>, text: string) {
  return wrapper.findAll('button').find((b) => b.text().includes(text))
}

// --- Tests ----------------------------------------------------------------

describe('OnboardingView', () => {
  describe('initial render', () => {
    it('starts on the consent screen when EULA has not been accepted', async () => {
      const wrapper = await mountView()
      await nextTick()
      expect(wrapper.text()).toContain('Welcome to ComfyUI Desktop')
      expect(wrapper.text()).toContain('I accept the End User License Agreement')
    })

    it('starts on the mode screen when EULA was already accepted (returning user)', async () => {
      mockPrefsState.eulaAccepted.value = true
      const wrapper = await mountView()
      await nextTick()
      expect(wrapper.text()).toContain('Where do you want to run ComfyUI?')
      expect(wrapper.text()).not.toContain('Welcome to ComfyUI Desktop')
    })
  })

  describe('Continue button gating', () => {
    it('is disabled until the EULA checkbox is checked', async () => {
      const wrapper = await mountView()
      await nextTick()
      const btn = findButtonByText(wrapper, 'Continue')!
      expect(btn.attributes('disabled')).toBeDefined()
    })

    it('enables once EULA is checked and advances to the mode screen on click', async () => {
      const wrapper = await mountView()
      await nextTick()

      // Find the EULA checkbox (second consent row) and check it
      const checkboxes = wrapper.findAll('input[type="checkbox"]')
      expect(checkboxes).toHaveLength(2)
      const eulaCheckbox = checkboxes[1]!
      await eulaCheckbox.setValue(true)
      await nextTick()

      const btn = findButtonByText(wrapper, 'Continue')!
      expect(btn.attributes('disabled')).toBeUndefined()

      await btn.trigger('click')
      await nextTick()

      expect(wrapper.text()).toContain('Where do you want to run ComfyUI?')
      expect(wrapper.text()).not.toContain('I accept the End User License Agreement')
    })
  })

  describe('cloud picker', () => {
    it('surfaces an error in the mode picker when the cloud entry is missing', async () => {
      // No cloud install seeded → pickCloud bails to complete + emit
      mockPrefsState.eulaAccepted.value = true
      mockInstallations.value = [] // no cloud
      const wrapper = await mountView()
      await nextTick()

      const cloudCard = wrapper.findAll('button').find((b) => b.text().includes('Comfy Cloud'))!
      await cloudCard.trigger('click')
      await nextTick()

      // The complete event should be emitted (no cloud → bail path)
      expect(wrapper.emitted('complete')).toBeTruthy()
      // No runAction call should have been issued
      expect(apiCalls.runAction).toHaveLength(0)
    })

    it('shows cloudError in mode picker when cloud connect fails (does not advance to done)', async () => {
      mockPrefsState.eulaAccepted.value = true
      mockInstallations.value = [
        { id: 'cloud-1', sourceCategory: 'cloud', sourceId: 'cloud', remoteUrl: 'https://cloud.comfy.org/' },
      ]
      // Force runAction to throw so the failure path runs
      runActionImpl = async () => { throw new Error('Network down') }

      const wrapper = await mountView()
      await nextTick()

      const cloudCard = wrapper.findAll('button').find((b) => b.text().includes('Comfy Cloud'))!
      await cloudCard.trigger('click')
      // Allow microtasks (the connecting-cloud → mode-on-failure transition)
      await new Promise((r) => setTimeout(r, 50))
      await nextTick()

      // Should NOT have completed, NOT have set lastUsedMode, NOT have hidden launcher
      expect(mockPrefsMethods.complete).not.toHaveBeenCalled()
      expect(mockPrefsMethods.setLastUsedMode).not.toHaveBeenCalled()
      expect(apiCalls.hideLauncherWindow).toBe(0)
      // Should be back in the mode picker with the error visible
      expect(wrapper.text()).toContain('Where do you want to run ComfyUI?')
      expect(wrapper.text()).toContain("Couldn't reach Comfy Cloud.")
    })
  })
})
