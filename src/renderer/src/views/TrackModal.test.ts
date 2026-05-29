import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'

import TrackModal from './TrackModal.vue'
import type { ProbeResult } from '../types/ipc'

/**
 * Regression harness for #726 — pasting/typing a path into the Install
 * Directory field must auto-probe and enable the "Track Install" button.
 * Previously `probe()` was wired only to the Browse button, so a pasted
 * path left `selectedProbe` null and the primary button stayed disabled.
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
      grandTitle: 'Track Existing Install',
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

describe('TrackModal — pasted-path probing (#726)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    installMockApi()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('probes and enables Track Install when a path is pasted into the field', async () => {
    const api = installMockApi()
    const wrapper = mountTrack()
    ;(wrapper.vm as unknown as { open: () => void }).open()
    await flushPromises()

    expect(trackButton(wrapper).attributes('disabled')).toBeDefined()

    // Simulate a paste: v-model updates trackPath via the input event.
    await wrapper.get('#track-path').setValue('/Users/jo/ComfyUI')

    // Debounced — no probe before the timer fires.
    expect(api.probeInstallation).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()

    expect(api.probeInstallation).toHaveBeenCalledWith('/Users/jo/ComfyUI')
    expect(trackButton(wrapper).attributes('disabled')).toBeUndefined()
  })

  it('trims trailing whitespace from a pasted path before probing', async () => {
    const api = installMockApi()
    const wrapper = mountTrack()
    ;(wrapper.vm as unknown as { open: () => void }).open()
    await flushPromises()

    await wrapper.get('#track-path').setValue('  /Users/jo/ComfyUI  ')
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()

    expect(api.probeInstallation).toHaveBeenCalledWith('/Users/jo/ComfyUI')
    expect(trackButton(wrapper).attributes('disabled')).toBeUndefined()
  })

  it('keeps the button disabled and clears results when the path is emptied', async () => {
    const api = installMockApi()
    const wrapper = mountTrack()
    ;(wrapper.vm as unknown as { open: () => void }).open()
    await flushPromises()

    await wrapper.get('#track-path').setValue('/Users/jo/ComfyUI')
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    expect(trackButton(wrapper).attributes('disabled')).toBeUndefined()

    await wrapper.get('#track-path').setValue('')
    await flushPromises()
    expect(trackButton(wrapper).attributes('disabled')).toBeDefined()

    // No probe should be queued for an empty value.
    api.probeInstallation.mockClear()
    await vi.advanceTimersByTimeAsync(300)
    expect(api.probeInstallation).not.toHaveBeenCalled()
  })

  it('does not enable the button when no install is detected at the path', async () => {
    const api = installMockApi({ probeInstallation: vi.fn().mockResolvedValue([]) })
    const wrapper = mountTrack()
    ;(wrapper.vm as unknown as { open: () => void }).open()
    await flushPromises()

    await wrapper.get('#track-path').setValue('/tmp/not-comfy')
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()

    expect(api.probeInstallation).toHaveBeenCalledWith('/tmp/not-comfy')
    expect(trackButton(wrapper).attributes('disabled')).toBeDefined()
  })
})
