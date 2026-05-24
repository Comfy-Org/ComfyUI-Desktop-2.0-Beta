import { createTestingPinia } from '@pinia/testing'
import { setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref, type Ref } from 'vue'
import { mount } from '@vue/test-utils'
import type { FieldOption, Source } from '../types/ipc'
import { useFirstUseChain, type FirstUseChainApi } from './useFirstUseChain'

/**
 * `useFirstUseChain` integration tests focused on the Express Install
 * path. Express skips the Configure (`InstallWizardModal`) screen and
 * runs Standalone + recommended defaults straight through to the
 * install-progress takeover. The other chain branches (Cloud auto-
 * launch, migrate, file-menu skip) are exercised indirectly by
 * PanelApp's integration tests.
 */

const standaloneSource: Source = {
  id: 'standalone',
  label: 'Standalone',
  fields: [
    { id: 'release', label: 'Release', type: 'select' },
    { id: 'variant', label: 'Variant', type: 'select' },
  ],
}

const recommendedRelease: FieldOption = {
  value: 'v1.0.0',
  label: 'v1.0.0',
  recommended: true,
}
const fallbackRelease: FieldOption = { value: 'v0.9.0', label: 'v0.9.0' }
const recommendedVariant: FieldOption = {
  value: 'nvidia',
  label: 'NVIDIA',
  recommended: true,
  data: { variantId: 'nvidia-cuda' },
}

interface TestApi {
  validateHardware: ReturnType<typeof vi.fn>
  getDefaultInstallDir: ReturnType<typeof vi.fn>
  getSources: ReturnType<typeof vi.fn>
  getFieldOptions: ReturnType<typeof vi.fn>
  buildInstallation: ReturnType<typeof vi.fn>
  getUniqueName: ReturnType<typeof vi.fn>
  addInstallation: ReturnType<typeof vi.fn>
  installInstance: ReturnType<typeof vi.fn>
  setFirstUseMode: ReturnType<typeof vi.fn>
  setSetting: ReturnType<typeof vi.fn>
  getSetting: ReturnType<typeof vi.fn>
  getInstallations: ReturnType<typeof vi.fn>
  onInstallationsChanged: ReturnType<typeof vi.fn>
  onInstallationsVersionsUpdated: ReturnType<typeof vi.fn>
  onFirstUseSkip: ReturnType<typeof vi.fn>
  onErrorDetail: ReturnType<typeof vi.fn>
  onInstallProgress: ReturnType<typeof vi.fn>
  onComfyOutput: ReturnType<typeof vi.fn>
}

function buildApi(overrides: Partial<TestApi> = {}): TestApi {
  return {
    validateHardware: vi.fn().mockResolvedValue({ supported: true }),
    getDefaultInstallDir: vi.fn().mockResolvedValue('/Users/test/ComfyUI'),
    getSources: vi.fn().mockResolvedValue([standaloneSource]),
    getFieldOptions: vi.fn().mockImplementation((_sourceId: string, fieldId: string) => {
      if (fieldId === 'release') return Promise.resolve([recommendedRelease, fallbackRelease])
      if (fieldId === 'variant') return Promise.resolve([recommendedVariant])
      return Promise.resolve([])
    }),
    buildInstallation: vi.fn().mockResolvedValue({ sourceId: 'standalone', sourceCategory: 'local' }),
    getUniqueName: vi.fn().mockResolvedValue('ComfyUI'),
    addInstallation: vi.fn().mockResolvedValue({ ok: true, entry: { id: 'inst-express-1' } }),
    installInstance: vi.fn().mockResolvedValue(undefined),
    setFirstUseMode: vi.fn(),
    setSetting: vi.fn().mockResolvedValue(undefined),
    getSetting: vi.fn().mockResolvedValue(undefined),
    getInstallations: vi.fn().mockResolvedValue([]),
    onInstallationsChanged: vi.fn(),
    onInstallationsVersionsUpdated: vi.fn(),
    onFirstUseSkip: vi.fn().mockReturnValue(() => {}),
    onErrorDetail: vi.fn().mockReturnValue(() => {}),
    onInstallProgress: vi.fn().mockReturnValue(() => {}),
    onComfyOutput: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  }
}

interface MountedChain {
  api: FirstUseChainApi | null
  handleShowProgress: ReturnType<typeof vi.fn>
  switchPanel: ReturnType<typeof vi.fn>
  dismissTakeoverDirect: ReturnType<typeof vi.fn>
  performChooserLaunch: ReturnType<typeof vi.fn>
  openFirstUseTakeover: ReturnType<typeof vi.fn>
}

function mountChain(): MountedChain {
  const handleShowProgress = vi.fn().mockResolvedValue(undefined)
  const switchPanel = vi.fn().mockResolvedValue(undefined)
  const dismissTakeoverDirect = vi.fn()
  const performChooserLaunch = vi.fn().mockResolvedValue('launched')
  const openFirstUseTakeover = vi.fn().mockResolvedValue(undefined)

  const apiRef: Ref<FirstUseChainApi | null> = ref(null)

  const TestHost = defineComponent({
    setup() {
      apiRef.value = useFirstUseChain({
        handleShowProgress,
        switchPanel,
        dismissTakeoverDirect,
        performChooserLaunch,
        openFirstUseTakeover,
      })
      return () => h('div')
    },
  })

  mount(TestHost)

  return {
    api: apiRef.value,
    handleShowProgress,
    switchPanel,
    dismissTakeoverDirect,
    performChooserLaunch,
    openFirstUseTakeover,
  }
}

describe('useFirstUseChain — Express Install', () => {
  let testApi: TestApi

  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }))
    testApi = buildApi()
    vi.stubGlobal('window', { ...window, api: testApi })
    vi.clearAllMocks()
  })

  it('skips Configure when `express: true` — runs buildInstallation/addInstallation/handleShowProgress', async () => {
    const chain = mountChain()
    await chain.api!.handleFirstUseChainLocal({ express: true })

    expect(testApi.validateHardware).toHaveBeenCalledTimes(1)
    expect(testApi.getSources).toHaveBeenCalledTimes(1)
    expect(testApi.buildInstallation).toHaveBeenCalledWith(
      'standalone',
      expect.objectContaining({
        release: recommendedRelease,
        variant: recommendedVariant,
      }),
    )
    expect(testApi.addInstallation).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'ComfyUI',
        installPath: '/Users/test/ComfyUI',
        sourceId: 'standalone',
      }),
    )
    expect(chain.handleShowProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: 'inst-express-1',
        autoLaunchOnFinish: true,
        opKind: 'install',
      }),
    )
    // Did NOT delegate to Configure when express succeeded.
    expect(chain.switchPanel).not.toHaveBeenCalled()
  })

  it('picks the `recommended` option for each non-text field', async () => {
    const chain = mountChain()
    await chain.api!.handleFirstUseChainLocal({ express: true })

    const call = testApi.buildInstallation.mock.calls[0]
    expect(call).toBeDefined()
    const selections = call![1] as Record<string, FieldOption>
    expect(selections.release).toEqual(recommendedRelease)
    expect(selections.variant).toEqual(recommendedVariant)
  })

  it('falls back to Configure when hardware validation reports unsupported', async () => {
    testApi.validateHardware = vi
      .fn()
      .mockResolvedValue({ supported: false, error: 'No GPU' })
    vi.stubGlobal('window', { ...window, api: testApi })

    const chain = mountChain()
    await chain.api!.handleFirstUseChainLocal({ express: true })

    expect(testApi.buildInstallation).not.toHaveBeenCalled()
    expect(chain.handleShowProgress).not.toHaveBeenCalled()
    expect(chain.switchPanel).toHaveBeenCalledWith('new-install', 'first_use')
  })

  it('falls back to Configure when addInstallation rejects', async () => {
    testApi.addInstallation = vi
      .fn()
      .mockResolvedValue({ ok: false, message: 'path conflict' })
    vi.stubGlobal('window', { ...window, api: testApi })

    const chain = mountChain()
    await chain.api!.handleFirstUseChainLocal({ express: true })

    expect(chain.handleShowProgress).not.toHaveBeenCalled()
    expect(chain.switchPanel).toHaveBeenCalledWith('new-install', 'first_use')
  })

  it('opens Configure when `express` is omitted (legacy chain-local behaviour)', async () => {
    const chain = mountChain()
    await chain.api!.handleFirstUseChainLocal()

    expect(chain.switchPanel).toHaveBeenCalledWith('new-install', 'first_use')
    expect(testApi.buildInstallation).not.toHaveBeenCalled()
    expect(chain.handleShowProgress).not.toHaveBeenCalled()
  })

  it('opens Configure when `express: false`', async () => {
    const chain = mountChain()
    await chain.api!.handleFirstUseChainLocal({ express: false })

    expect(chain.switchPanel).toHaveBeenCalledWith('new-install', 'first_use')
    expect(testApi.buildInstallation).not.toHaveBeenCalled()
  })
})
