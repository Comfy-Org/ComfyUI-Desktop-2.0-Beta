import { describe, expect, it, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { nextTick } from 'vue'

import { en } from '../../lib/i18nMessages.ts'
import StoragePane, { type StorageSnapshot } from './StoragePane.vue'

interface BridgeState {
  updateFieldCalls: Array<{ id: string; value: unknown }>
  setModelsDirsCalls: string[][]
  openPathCalls: string[]
  browseFolderReturn: string | null
}

function installMockBridge(): BridgeState {
  const state: BridgeState = {
    updateFieldCalls: [],
    setModelsDirsCalls: [],
    openPathCalls: [],
    browseFolderReturn: null,
  }
  const bridge = {
    globalSettingsUpdateField: async (id: string, value: unknown) => {
      state.updateFieldCalls.push({ id, value })
      return { ok: true }
    },
    globalSettingsBrowseFolder: async () => state.browseFolderReturn,
    globalSettingsOpenPath: (path: string) => {
      state.openPathCalls.push(path)
    },
    globalSettingsSetModelsDirs: async (dirs: string[]) => {
      state.setModelsDirsCalls.push([...dirs])
      return { ok: true }
    },
  }
  ;(window as unknown as { __comfyTitlePopup: typeof bridge }).__comfyTitlePopup = bridge
  return state
}

function makeI18n() {
  return createI18n({ legacy: false, locale: 'en', messages: { en } })
}

function makeSnapshot(): StorageSnapshot {
  return {
    sharedDirectoriesFields: [],
    modelsDirs: [
      { path: '/home/u/ComfyUI/models', isPrimary: true, isDefault: true },
      { path: '/mnt/extra/models', isPrimary: false, isDefault: false },
    ],
    modelsSystemDefault: '/home/u/ComfyUI/models',
  }
}

function mountPane(snapshot: StorageSnapshot = makeSnapshot()) {
  return mount(StoragePane, {
    props: {
      installation: null,
      snapshot,
      sections: [],
      pendingRestartFieldIds: new Set<string>(),
      fieldErrorMessages: new Map<string, string>(),
      runningActionIds: new Set<string>(),
    },
    global: { plugins: [makeI18n()] },
    attachTo: document.body,
  })
}

describe('StoragePane', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('renders the models-dir list from the snapshot prop', async () => {
    installMockBridge()
    const wrapper = mountPane()
    await nextTick()
    const rows = wrapper.findAll('.models-dir-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.find('.tag-primary').exists()).toBe(true)
    expect(rows[1]!.find('.tag-primary').exists()).toBe(false)
  })

  // The global default install location is intentionally NOT shown in the
  // per-instance Storage tab — it only belongs in Global Desktop Settings.
  it('does not render the global Install Location section', async () => {
    installMockBridge()
    const wrapper = mountPane()
    await nextTick()
    expect(wrapper.text()).not.toContain('Install Location')
  })

  it('writes reordered dirs through the bridge when make-primary is invoked', async () => {
    const bridge = installMockBridge()
    const wrapper = mountPane()
    await nextTick()
    const toggles = wrapper.findAll('.models-dir-menu-wrap > button')
    expect(toggles).toHaveLength(1)
    await toggles[0]!.trigger('click')
    await nextTick()
    await flushPromises()
    const makePrimary = wrapper.find('.models-dir-menu button[role="menuitem"]')
    await makePrimary.trigger('click')
    await flushPromises()
    expect(bridge.setModelsDirsCalls).toEqual([
      ['/mnt/extra/models', '/home/u/ComfyUI/models'],
    ])
  })

  it('closes the dir menu on Escape and restores focus to the toggle', async () => {
    installMockBridge()
    const wrapper = mountPane()
    await nextTick()
    const toggle = wrapper.find<HTMLButtonElement>('.models-dir-menu-wrap > button')
    await toggle.trigger('click')
    await nextTick()
    await flushPromises()
    expect(wrapper.find('.models-dir-menu').exists()).toBe(true)
    await wrapper.find('.models-dir-menu').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('.models-dir-menu').exists()).toBe(false)
    expect(document.activeElement).toBe(toggle.element)
  })

  it('opens a models dir through the bridge when the open icon is clicked', async () => {
    const bridge = installMockBridge()
    const wrapper = mountPane()
    await nextTick()
    const openBtns = wrapper.findAll('.models-dir-row .models-dir-action')
    await openBtns[0]!.trigger('click')
    expect(bridge.openPathCalls).toEqual(['/home/u/ComfyUI/models'])
  })

  // make-primary is a "touched" action; the note bar must flip to the
  // warning color. Open is read-only and must not flip the bar.
  it('flips the storage note to the warning state after make-primary', async () => {
    installMockBridge()
    const wrapper = mountPane()
    await nextTick()
    expect(wrapper.find('.storage-note.is-warning').exists()).toBe(false)
    await wrapper.find('.models-dir-menu-wrap > button').trigger('click')
    await nextTick()
    await flushPromises()
    await wrapper.find('.models-dir-menu button[role="menuitem"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('.storage-note.is-warning').exists()).toBe(true)
  })

  it('does not flip the storage note when only opening a dir', async () => {
    installMockBridge()
    const wrapper = mountPane()
    await nextTick()
    await wrapper.findAll('.models-dir-row .models-dir-action')[0]!.trigger('click')
    await flushPromises()
    expect(wrapper.find('.storage-note.is-warning').exists()).toBe(false)
  })
})
