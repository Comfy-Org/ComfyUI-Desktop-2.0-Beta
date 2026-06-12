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
  revealPathCalls: string[]
  browseFolderReturn: string | null
}

function installMockBridge(): BridgeState {
  const state: BridgeState = {
    updateFieldCalls: [],
    setModelsDirsCalls: [],
    openPathCalls: [],
    revealPathCalls: [],
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
    globalSettingsRevealPath: (path: string) => {
      state.revealPathCalls.push(path)
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
      { path: '/home/u/ComfyUI/models', isPrimary: true },
      { path: '/mnt/extra/models', isPrimary: false },
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
    },
    global: { plugins: [makeI18n()] },
    attachTo: document.body,
  })
}

// Per-install storage section with shared-models toggled off and a per-instance
// model-dirs list, exercising the StoragePane's own ModelsDirList wiring.
// `installModelsDir` is the locked install-own row; `modelDirsPrimary` selects
// which external dir (if any) is primary.
function makeStorageSections(
  modelDirs: string[],
  opts: { sharedOn?: boolean; primary?: string | null; own?: string } = {}
) {
  return [
    {
      fields: [
        { id: 'useSharedModels', label: 'Use Shared Models', value: opts.sharedOn ?? false, editable: true, editType: 'boolean' },
        { id: 'modelDirs', label: 'Model Directories', value: modelDirs, editable: true, editType: 'model-dirs' },
        { id: 'modelDirsPrimary', label: 'modelDirsPrimary', value: opts.primary ?? null, editable: true, editType: 'hidden' },
        { id: 'installModelsDir', label: 'installModelsDir', value: opts.own ?? '/own/models', editable: false, editType: 'hidden' },
      ],
    },
  ]
}

// Per-install section with shared input/output off, for the readonly path rows.
function makeIoSections(opts: { inputDir?: string; outputDir?: string } = {}) {
  return [
    {
      fields: [
        { id: 'useSharedInputOutput', label: 'Use Shared Input/Output Folders', value: false, editable: true, editType: 'boolean' },
        { id: 'inputDir', label: 'Input Folder', value: opts.inputDir ?? '', editable: true, editType: 'path' },
        { id: 'outputDir', label: 'Output Folder', value: opts.outputDir ?? '', editable: true, editType: 'path' },
        { id: 'inputDirDefault', label: 'Input Folder', value: '/own/input', editable: false, editType: 'hidden' },
        { id: 'outputDirDefault', label: 'Output Folder', value: '/own/output', editable: false, editType: 'hidden' },
      ],
    },
  ]
}

function mountPaneWithSections(
  sections: Array<{ fields: Array<Record<string, unknown>> }>,
  snapshot: StorageSnapshot = makeSnapshot()
) {
  return mount(StoragePane, {
    props: {
      installation: { id: 'inst-1' } as never,
      snapshot,
      sections: sections as never,
      pendingRestartFieldIds: new Set<string>(),
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

  it('browses and re-points the dir through the bridge when the browse icon is clicked', async () => {
    const bridge = installMockBridge()
    bridge.browseFolderReturn = '/mnt/new/models'
    const wrapper = mountPane()
    await nextTick()
    const browseBtns = wrapper.findAll('.models-dir-row .models-dir-action')
    await browseBtns[0]!.trigger('click')
    await flushPromises()
    expect(bridge.setModelsDirsCalls).toEqual([
      ['/mnt/new/models', '/mnt/extra/models'],
    ])
  })

  it('leaves dirs unchanged when the browse picker is canceled', async () => {
    const bridge = installMockBridge()
    bridge.browseFolderReturn = null
    const wrapper = mountPane()
    await nextTick()
    const browseBtns = wrapper.findAll('.models-dir-row .models-dir-action')
    await browseBtns[0]!.trigger('click')
    await flushPromises()
    expect(bridge.setModelsDirsCalls).toEqual([])
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

  it('flips the storage note to the warning state after browsing to a new dir', async () => {
    const bridge = installMockBridge()
    bridge.browseFolderReturn = '/mnt/new/models'
    const wrapper = mountPane()
    await nextTick()
    expect(wrapper.find('.storage-note.is-warning').exists()).toBe(false)
    await wrapper.findAll('.models-dir-row .models-dir-action')[0]!.trigger('click')
    await flushPromises()
    expect(wrapper.find('.storage-note.is-warning').exists()).toBe(true)
  })

  describe('per-instance model directories (shared models off)', () => {
    it('renders the locked install-own row first (primary) plus extras', async () => {
      installMockBridge()
      const wrapper = mountPaneWithSections(makeStorageSections(['/a/models', '/b/models']))
      await nextTick()
      // install-own row + 2 extras = 3 rows. Row 0 is the install-own primary.
      const rows = wrapper.findAll('.models-dir-row')
      expect(rows).toHaveLength(3)
      expect(rows[0]!.find('.models-dir-name').text()).toBe('/own/models')
      expect(rows[0]!.find('.tag-primary').exists()).toBe(true)
      expect(rows[1]!.find('.tag-primary').exists()).toBe(false)
      // The install-own row is locked: no browse button, no menu (undeletable),
      // and carries the "Instance only" pill.
      expect(rows[0]!.find('.models-dir-action').exists()).toBe(false)
      expect(rows[0]!.find('.models-dir-menu-wrap').exists()).toBe(false)
      expect(rows[0]!.find('.tag-local').exists()).toBe(true)
    })

    it('promotes an external dir by persisting modelDirsPrimary (no reordering)', async () => {
      installMockBridge()
      const wrapper = mountPaneWithSections(makeStorageSections(['/a/models', '/b/models']))
      await nextTick()
      // First menu belongs to the first extra (/a/models), since row 0 is locked.
      await wrapper.find('.models-dir-menu-wrap > button').trigger('click')
      await nextTick()
      await flushPromises()
      await wrapper.find('.models-dir-menu button[role="menuitem"]').trigger('click')
      await flushPromises()
      const emitted = wrapper.emitted('update-field')
      expect(emitted).toBeTruthy()
      const [field, value] = emitted![0] as [{ id: string }, unknown]
      expect(field.id).toBe('modelDirsPrimary')
      expect(value).toBe('/a/models')
    })

    it('puts the promoted external dir (primary) on top and sinks install-own to the bottom', async () => {
      installMockBridge()
      const wrapper = mountPaneWithSections(
        makeStorageSections(['/a/models', '/b/models'], { primary: '/a/models' })
      )
      await nextTick()
      const rows = wrapper.findAll('.models-dir-row')
      // Primary on top: /a/models leads; the locked install-own row is last.
      expect(rows[0]!.find('.models-dir-name').text()).toBe('/a/models')
      expect(rows[0]!.find('.tag-primary').exists()).toBe(true)
      expect(rows[2]!.find('.models-dir-name').text()).toBe('/own/models')
      expect(rows[2]!.find('.tag-primary').exists()).toBe(false)
    })

    it('demotes back to install-own by clearing modelDirsPrimary', async () => {
      installMockBridge()
      const wrapper = mountPaneWithSections(
        makeStorageSections(['/a/models'], { primary: '/a/models' })
      )
      await nextTick()
      // Install-own row (locked, not the download target) exposes only "Use for Model Downloads".
      await wrapper.find('.models-dir-menu-wrap > button').trigger('click')
      await nextTick()
      await flushPromises()
      await wrapper.find('.models-dir-menu button[role="menuitem"]').trigger('click')
      await flushPromises()
      const emitted = wrapper.emitted('update-field')!
      const [field, value] = emitted[0] as [{ id: string }, unknown]
      expect(field.id).toBe('modelDirsPrimary')
      expect(value).toBe(null)
    })

    it('locked install-own row offers no Remove action even when not primary', async () => {
      installMockBridge()
      const wrapper = mountPaneWithSections(
        makeStorageSections(['/a/models'], { primary: '/a/models' })
      )
      await nextTick()
      const rows = wrapper.findAll('.models-dir-row')
      // The locked install-own row sits last (it's not primary); open its menu
      // and assert it offers only "Use for Model Downloads" (no Remove).
      const ownRow = rows[rows.length - 1]!
      expect(ownRow.find('.models-dir-name').text()).toBe('/own/models')
      await ownRow.find('.models-dir-menu-wrap > button').trigger('click')
      await nextTick()
      await flushPromises()
      const items = ownRow.findAll('.models-dir-menu button[role="menuitem"]')
      expect(items).toHaveLength(1)
      expect(items[0]!.text()).toContain('Use for Model Downloads')
    })

    it('emits update-field with the appended dir when adding', async () => {
      const bridge = installMockBridge()
      bridge.browseFolderReturn = '/c/models'
      const wrapper = mountPaneWithSections(makeStorageSections(['/a/models', '/b/models']))
      await nextTick()
      await wrapper.find('.models-dir-add').trigger('click')
      await flushPromises()
      const emitted = wrapper.emitted('update-field')
      expect(emitted).toBeTruthy()
      const [field, value] = emitted![0] as [{ id: string }, string[]]
      expect(field.id).toBe('modelDirs')
      expect(value).toEqual(['/a/models', '/b/models', '/c/models'])
    })

    it('opens the folder when a model path is clicked', async () => {
      const bridge = installMockBridge()
      const wrapper = mountPaneWithSections(makeStorageSections(['/a/models']))
      await nextTick()
      const rows = wrapper.findAll('.models-dir-row')
      await rows[1]!.find('.models-dir-name').trigger('click')
      expect(bridge.openPathCalls).toEqual(['/a/models'])
    })

    it('shows the global shared list (primary on top) with the locked install-own row last when shared models is on', async () => {
      installMockBridge()
      const wrapper = mountPaneWithSections(makeStorageSections(['/a/models'], { sharedOn: true }))
      await nextTick()
      // 2 global shared dirs from the snapshot + install-own locked row at the bottom.
      const rows = wrapper.findAll('.models-dir-row')
      expect(rows).toHaveLength(3)
      // The global primary stays on the first shared dir.
      expect(rows[0]!.find('.tag-primary').exists()).toBe(true)
      // The install-own row is last, locked: no primary tag, no browse, no menu.
      const ownRow = rows[2]!
      expect(ownRow.find('.models-dir-name').text()).toBe('/own/models')
      expect(ownRow.find('.tag-primary').exists()).toBe(false)
      expect(ownRow.find('.models-dir-action').exists()).toBe(false)
      expect(ownRow.find('.models-dir-menu-wrap').exists()).toBe(false)
      expect(wrapper.text()).toContain('Shared Models')
      // Shared dirs carry the shared badge; the per-instance install-own row doesn't.
      expect(rows[0]!.find('.storage-item-icon.is-shared').exists()).toBe(true)
      expect(ownRow.find('.storage-item-icon.is-shared').exists()).toBe(false)
    })

    it('shows no shared badge on per-instance dirs when shared models is off', async () => {
      installMockBridge()
      const wrapper = mountPaneWithSections(makeStorageSections(['/a/models', '/b/models']))
      await nextTick()
      const rows = wrapper.findAll('.models-dir-row')
      expect(rows.every((r) => !r.find('.storage-item-icon.is-shared').exists())).toBe(true)
    })

    it('make-primary on a shared dir reorders the global list past the locked row', async () => {
      const bridge = installMockBridge()
      const wrapper = mountPaneWithSections(makeStorageSections(['/x'], { sharedOn: true }))
      await nextTick()
      // Row 0 is the locked install-own row; the only menu belongs to the
      // non-primary shared dir (row 2 = /mnt/extra/models).
      const toggles = wrapper.findAll('.models-dir-menu-wrap > button')
      expect(toggles).toHaveLength(1)
      await toggles[0]!.trigger('click')
      await nextTick()
      await flushPromises()
      await wrapper.find('.models-dir-menu button[role="menuitem"]').trigger('click')
      await flushPromises()
      expect(bridge.setModelsDirsCalls).toEqual([
        ['/mnt/extra/models', '/home/u/ComfyUI/models'],
      ])
    })
  })

  describe('per-instance input/output (shared I/O off)', () => {
    it('shows the computed defaults with a "default" tag when unset', async () => {
      installMockBridge()
      const wrapper = mountPaneWithSections(makeIoSections())
      await nextTick()
      const rows = wrapper.findAll('.storage-dir-row')
      expect(rows).toHaveLength(2)
      expect(rows[0]!.find('.storage-dir-name').text()).toBe('/own/input')
      expect(rows[1]!.find('.storage-dir-name').text()).toBe('/own/output')
      expect(rows[0]!.find('.storage-dir-tag').exists()).toBe(true)
      // Per-instance dirs are private: no shared badge.
      expect(rows[0]!.find('.storage-item-icon.is-shared').exists()).toBe(false)
    })

    it('shows the stored override (no default tag) when set', async () => {
      installMockBridge()
      const wrapper = mountPaneWithSections(makeIoSections({ inputDir: '/ext/in' }))
      await nextTick()
      const rows = wrapper.findAll('.storage-dir-row')
      expect(rows[0]!.find('.storage-dir-name').text()).toBe('/ext/in')
      expect(rows[0]!.find('.storage-dir-tag').exists()).toBe(false)
    })

    it('persists empty when the browsed dir equals the computed default (clone-safe)', async () => {
      const bridge = installMockBridge()
      bridge.browseFolderReturn = '/own/input'
      const wrapper = mountPaneWithSections(makeIoSections())
      await nextTick()
      await wrapper.findAll('.storage-dir-row')[0]!.find('.storage-dir-action').trigger('click')
      await flushPromises()
      const [field, value] = wrapper.emitted('update-field')![0] as [{ id: string }, unknown]
      expect(field.id).toBe('inputDir')
      expect(value).toBe('')
    })

    it('persists the override when the browsed dir differs from the default', async () => {
      const bridge = installMockBridge()
      bridge.browseFolderReturn = '/ext/in'
      const wrapper = mountPaneWithSections(makeIoSections())
      await nextTick()
      await wrapper.findAll('.storage-dir-row')[0]!.find('.storage-dir-action').trigger('click')
      await flushPromises()
      const [field, value] = wrapper.emitted('update-field')![0] as [{ id: string }, unknown]
      expect(field.id).toBe('inputDir')
      expect(value).toBe('/ext/in')
    })

    it('opens the effective input folder when its path is clicked', async () => {
      const bridge = installMockBridge()
      const wrapper = mountPaneWithSections(makeIoSections({ inputDir: '/ext/in' }))
      await nextTick()
      await wrapper.findAll('.storage-dir-row')[0]!.find('.storage-dir-name').trigger('click')
      expect(bridge.openPathCalls).toEqual(['/ext/in'])
    })
  })

  describe('shared input/output (shared I/O on)', () => {
    function makeSharedIoSnapshot(): StorageSnapshot {
      return {
        ...makeSnapshot(),
        sharedDirectoriesFields: [
          { id: 'inputDir', label: 'Shared Input', value: '/shared/in', type: 'path' },
          { id: 'outputDir', label: 'Shared Output', value: '/shared/out', type: 'path' },
        ] as never,
      }
    }

    function sharedOnSections() {
      return [
        {
          fields: [
            {
              id: 'useSharedInputOutput',
              label: 'Use Shared Input/Output Folders',
              value: true,
              editable: true,
              editType: 'boolean',
            },
          ],
        },
      ]
    }

    it('renders the shared dirs as readonly path rows', async () => {
      installMockBridge()
      const wrapper = mountPaneWithSections(sharedOnSections(), makeSharedIoSnapshot())
      await nextTick()
      const rows = wrapper.findAll('.storage-dir-row')
      expect(rows).toHaveLength(2)
      expect(rows[0]!.find('.storage-dir-name').text()).toBe('/shared/in')
      expect(rows[1]!.find('.storage-dir-name').text()).toBe('/shared/out')
      // Shared dirs are global, not per-instance overrides: no "default" tag.
      expect(rows[0]!.find('.storage-dir-tag').exists()).toBe(false)
      // Shared I/O dirs carry the shared badge for consistency with shared models.
      expect(rows[0]!.find('.storage-item-icon.is-shared').exists()).toBe(true)
      expect(rows[1]!.find('.storage-item-icon.is-shared').exists()).toBe(true)
    })

    it('opens a shared dir when its path is clicked', async () => {
      const bridge = installMockBridge()
      const wrapper = mountPaneWithSections(sharedOnSections(), makeSharedIoSnapshot())
      await nextTick()
      await wrapper.findAll('.storage-dir-row')[0]!.find('.storage-dir-name').trigger('click')
      expect(bridge.openPathCalls).toEqual(['/shared/in'])
    })

    it('updates the shared dir via the global bridge when browsed', async () => {
      const bridge = installMockBridge()
      bridge.browseFolderReturn = '/picked/in'
      const wrapper = mountPaneWithSections(sharedOnSections(), makeSharedIoSnapshot())
      await nextTick()
      await wrapper.findAll('.storage-dir-row')[0]!.find('.storage-dir-action').trigger('click')
      await flushPromises()
      expect(bridge.updateFieldCalls).toEqual([{ id: 'inputDir', value: '/picked/in' }])
    })
  })

  // The install's extra_model_paths.yaml is one row in the models list (YAML
  // pill), and clicking it opens a detail modal listing every section's
  // per-type dirs plus a link to the .yaml file.
  describe('custom model paths (extra_model_paths.yaml)', () => {
    function makeExtraSection() {
      return {
        name: 'my_external',
        basePath: '/ext/base',
        basePathExists: true,
        isDefault: false,
        dirs: [
          { type: 'checkpoints', rawType: 'checkpoints', dir: '/ext/base/checkpoints', dirExists: true },
          { type: 'controlnet', rawType: 'controlnet', dir: '/ext/base/t2i_adapter', dirExists: false },
        ],
      }
    }

    function sectionsWithExtra(view: unknown) {
      return [
        {
          fields: [
            { id: 'useSharedModels', label: 'Use Shared Models', value: false, editable: true, editType: 'boolean' },
            { id: 'modelDirs', label: 'Model Directories', value: [], editable: true, editType: 'model-dirs' },
            { id: 'modelDirsPrimary', label: 'modelDirsPrimary', value: null, editable: true, editType: 'hidden' },
            { id: 'installModelsDir', label: 'installModelsDir', value: '/own/models', editable: false, editType: 'hidden' },
            { id: 'extraModelPaths', label: 'extraModelPaths', value: view, editable: false, editType: 'hidden' },
          ],
        },
      ]
    }

    function extraView() {
      return { yamlPath: '/own/extra_model_paths.yaml', exists: true, sections: [makeExtraSection()] }
    }

    function findExtraRow(wrapper: ReturnType<typeof mountPaneWithSections>) {
      return wrapper
        .findAll('.models-dir-row')
        .find((r) => r.text().includes('/own/extra_model_paths.yaml'))!
    }

    it('renders the yaml file as a single read-only row with the YAML pill', async () => {
      installMockBridge()
      const wrapper = mountPaneWithSections(sectionsWithExtra(extraView()))
      await nextTick()
      const extraRow = findExtraRow(wrapper)
      expect(extraRow).toBeTruthy()
      const pill = extraRow.find('.tag-local')
      expect(pill.exists()).toBe(true)
      expect(pill.text()).toContain('YAML')
      // The missing-dir count is intentionally not surfaced in the list.
      expect(extraRow.find('.tag-missing').exists()).toBe(false)
      // Read-only: no browse / make-primary affordance on extra rows.
      expect(extraRow.find('.tag-primary').exists()).toBe(false)
      // The yaml file is per-instance, not shared: no shared badge.
      expect(extraRow.find('.storage-item-icon.is-shared').exists()).toBe(false)
    })

    it('opens the detail modal listing per-type dirs when the row is clicked', async () => {
      installMockBridge()
      const wrapper = mountPaneWithSections(sectionsWithExtra(extraView()))
      await nextTick()
      await findExtraRow(wrapper).find('.models-dir-name').trigger('click')
      await nextTick()
      expect(document.body.textContent).toContain('/ext/base/checkpoints')
      expect(document.body.textContent).toContain('/ext/base/t2i_adapter')
    })

    it('collapses a multi-section yaml into one row, all sections in the modal', async () => {
      installMockBridge()
      const view = {
        yamlPath: '/own/extra_model_paths.yaml',
        exists: true,
        sections: [
          makeExtraSection(),
          {
            name: 'nas',
            basePath: '/nas/models',
            basePathExists: true,
            isDefault: true,
            dirs: [{ type: 'loras', rawType: 'loras', dir: '/nas/models/loras', dirExists: true }],
          },
        ],
      }
      const wrapper = mountPaneWithSections(sectionsWithExtra(view))
      await nextTick()
      // Two sections, but only one row in the list.
      expect(
        wrapper.findAll('.models-dir-row').filter((r) => r.text().includes('extra_model_paths.yaml'))
      ).toHaveLength(1)
      await findExtraRow(wrapper).find('.models-dir-name').trigger('click')
      await nextTick()
      // Both sections' dirs show in the modal.
      expect(document.body.textContent).toContain('/ext/base/checkpoints')
      expect(document.body.textContent).toContain('/nas/models/loras')
      // The default tag appears for the section that declares it.
      expect(document.querySelector('.empm-tag')).toBeTruthy()
    })

    it('reveals the yaml file in its folder from the modal footer', async () => {
      const bridge = installMockBridge()
      const wrapper = mountPaneWithSections(sectionsWithExtra(extraView()))
      await nextTick()
      await findExtraRow(wrapper).find('.models-dir-name').trigger('click')
      await nextTick()
      const actions = Array.from(document.querySelectorAll('.empm-action')) as HTMLButtonElement[]
      const yamlBtn = actions.find((b) => b.textContent?.includes('.yaml'))!
      yamlBtn.click()
      // Reveal-in-folder, not open-in-default-app.
      expect(bridge.revealPathCalls).toContain('/own/extra_model_paths.yaml')
      expect(bridge.openPathCalls).not.toContain('/own/extra_model_paths.yaml')
    })

    it('opens a per-type dir from the modal when its path is clicked', async () => {
      const bridge = installMockBridge()
      const wrapper = mountPaneWithSections(sectionsWithExtra(extraView()))
      await nextTick()
      await findExtraRow(wrapper).find('.models-dir-name').trigger('click')
      await nextTick()
      const dirBtns = Array.from(document.querySelectorAll('.empm-dir-path')) as HTMLButtonElement[]
      dirBtns.find((b) => b.textContent === '/ext/base/checkpoints')!.click()
      expect(bridge.openPathCalls).toContain('/ext/base/checkpoints')
    })

    it('marks a missing per-type dir red (is-missing) instead of a badge', async () => {
      installMockBridge()
      const wrapper = mountPaneWithSections(sectionsWithExtra(extraView()))
      await nextTick()
      await findExtraRow(wrapper).find('.models-dir-name').trigger('click')
      await nextTick()
      const dirBtns = Array.from(document.querySelectorAll('.empm-dir-path')) as HTMLButtonElement[]
      const present = dirBtns.find((b) => b.textContent === '/ext/base/checkpoints')!
      const missing = dirBtns.find((b) => b.textContent === '/ext/base/t2i_adapter')!
      expect(present.classList.contains('is-missing')).toBe(false)
      expect(missing.classList.contains('is-missing')).toBe(true)
    })

    it('emits refresh when the modal refresh button is clicked', async () => {
      installMockBridge()
      const wrapper = mountPaneWithSections(sectionsWithExtra(extraView()))
      await nextTick()
      await findExtraRow(wrapper).find('.models-dir-name').trigger('click')
      await nextTick()
      ;(document.querySelector('.empm-refresh') as HTMLButtonElement).click()
      expect(wrapper.emitted('refresh')).toHaveLength(1)
    })
  })
})
