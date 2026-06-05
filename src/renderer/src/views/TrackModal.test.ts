import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'

import TrackModal from './TrackModal.vue'
import type { ProbeResult } from '../types/ipc'

/**
 * The Install Directory field is browse-only: typing/pasting must not
 * change it. The only way to populate it is the Browse button, which
 * runs the probe and enables the "Track Install" button when an
 * existing install is detected.
 */

// Minimal catalog covering the keys the template reads. Missing keys fall
// back to the dotted path, which would surface in a failed assertion.
const messages = {
  en: {
    common: {
      name: 'Name',
      browse: 'Browse',
      namePlaceholder: 'e.g. ComfyUI Main',
      backToDashboard: 'Back to Dashboard',
    },
    git: { venv: 'Virtual Environment', venvNotFound: 'Not found' },
    track: {
      grandTitle: 'Add Existing Install',
      grandSubtitle: 'Add an existing local ComfyUI checkout.',
      installDir: 'Install Directory',
      selectDir: 'Select a directory',
      detectedType: 'Detected Type',
      browseDirFirst: 'Browse to a directory first',
      detecting: 'Detecting',
      noDetected: 'No known install detected',
      trackInstallation: 'Track Install',
      cannotTrack: 'Cannot Track',
      version: 'Version',
      repository: 'Repository',
      branch: 'Branch',
    },
  },
}

function createTestI18n() {
  return createI18n({ legacy: false, locale: 'en', messages })
}

interface MockApi {
  getUniqueName: ReturnType<typeof vi.fn>
  browseFolder: ReturnType<typeof vi.fn>
  probeInstallation: ReturnType<typeof vi.fn>
  trackInstallation: ReturnType<typeof vi.fn>
}

const gitProbe: ProbeResult = {
  sourceId: 'git',
  sourceLabel: 'Git',
  version: 'abcdef12',
  repo: 'https://github.com/comfyanonymous/ComfyUI.git',
  branch: 'master',
  commit: 'abcdef12',
}

function installMockApi(overrides: Partial<MockApi> = {}): MockApi {
  const api: MockApi = {
    getUniqueName: vi.fn().mockResolvedValue('ComfyUI'),
    browseFolder: vi.fn().mockResolvedValue(undefined),
    probeInstallation: vi.fn().mockResolvedValue([gitProbe]),
    trackInstallation: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  }
  ;(window as unknown as { api: MockApi }).api = api
  return api
}

function mountTrack() {
  return mount(TrackModal, {
    global: {
      plugins: [createTestI18n()],
      stubs: {
        // BrandTakeoverLayout renders the default slot so the card is in
        // the DOM; the rest are inert presentational shells.
        BrandTakeoverLayout: { template: '<div><slot /><slot name="footer-left" /></div>' },
        TakeoverBack: true,
        BaseSelect: true,
        HardDrive: true,
      },
    },
  })
}

function trackButton(wrapper: ReturnType<typeof mountTrack>) {
  return wrapper.get('button.track-save')
}

describe('TrackModal — browse-only install directory', () => {
  beforeEach(() => {
    installMockApi()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the install-directory input as readonly', async () => {
    const wrapper = mountTrack()
    ;(wrapper.vm as unknown as { open: () => void }).open()
    await flushPromises()

    const input = wrapper.get('#track-path')
    expect(input.attributes('readonly')).toBeDefined()
  })

  it('does not probe when the user attempts to type into the field', async () => {
    const api = installMockApi()
    const wrapper = mountTrack()
    ;(wrapper.vm as unknown as { open: () => void }).open()
    await flushPromises()

    // Programmatically dispatch an input event — readonly prevents real
    // keyboard input but a stray input dispatch must not reach probe().
    await wrapper.get('#track-path').trigger('input')
    await flushPromises()

    expect(api.probeInstallation).not.toHaveBeenCalled()
    expect(trackButton(wrapper).attributes('disabled')).toBeDefined()
  })

  it('probes and enables Track Install when a folder is picked via Browse', async () => {
    const api = installMockApi({
      browseFolder: vi.fn().mockResolvedValue('/Users/jo/ComfyUI'),
    })
    const wrapper = mountTrack()
    ;(wrapper.vm as unknown as { open: () => void }).open()
    await flushPromises()

    expect(trackButton(wrapper).attributes('disabled')).toBeDefined()

    await wrapper.get('button.brand-tertiary').trigger('click')
    await flushPromises()

    expect(api.probeInstallation).toHaveBeenCalledWith('/Users/jo/ComfyUI')
    expect(trackButton(wrapper).attributes('disabled')).toBeUndefined()
  })

  it('keeps Track Install disabled when no install is detected at the picked folder', async () => {
    const api = installMockApi({
      browseFolder: vi.fn().mockResolvedValue('/tmp/not-comfy'),
      probeInstallation: vi.fn().mockResolvedValue([]),
    })
    const wrapper = mountTrack()
    ;(wrapper.vm as unknown as { open: () => void }).open()
    await flushPromises()

    await wrapper.get('button.brand-tertiary').trigger('click')
    await flushPromises()

    expect(api.probeInstallation).toHaveBeenCalledWith('/tmp/not-comfy')
    expect(trackButton(wrapper).attributes('disabled')).toBeDefined()
  })
})
