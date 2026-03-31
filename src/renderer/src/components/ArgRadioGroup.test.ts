import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ArgRadioGroup from './ArgRadioGroup.vue'
import type { ComfyArgDef } from '../../../types/ipc'

const VRAM_ARGS: ComfyArgDef[] = [
  { name: 'gpu-only', flag: '--gpu-only', help: 'Store and run everything on the GPU.', type: 'boolean', category: 'GPU & VRAM', exclusiveGroup: 'group_1' },
  { name: 'highvram', flag: '--highvram', help: 'By default models will be unloaded to CPU memory after being used.', type: 'boolean', category: 'GPU & VRAM', exclusiveGroup: 'group_1' },
  { name: 'lowvram', flag: '--lowvram', help: 'Split the unet in parts to use less vram.', type: 'boolean', category: 'GPU & VRAM', exclusiveGroup: 'group_1' },
  { name: 'novram', flag: '--novram', help: 'When lowvram is not enough.', type: 'boolean', category: 'GPU & VRAM', exclusiveGroup: 'group_1' },
  { name: 'cpu', flag: '--cpu', help: 'To use the CPU for everything (slow).', type: 'boolean', category: 'GPU & VRAM', exclusiveGroup: 'group_1' },
]

function mountGroup(activeArg: string | null = null, activeValue = '') {
  return mount(ArgRadioGroup, {
    props: { args: VRAM_ARGS, activeArg, activeValue },
  })
}

describe('ArgRadioGroup', () => {
  it('renders all args as checkbox options', () => {
    const wrapper = mountGroup()
    const checkboxes = wrapper.findAll('input[type="checkbox"]')
    expect(checkboxes.length).toBe(5)
  })

  it('checks only the active checkbox', () => {
    const wrapper = mountGroup('lowvram')
    const checkboxes = wrapper.findAll('input[type="checkbox"]')
    const checked = checkboxes.filter((r) => (r.element as HTMLInputElement).checked)
    expect(checked.length).toBe(1)
    const row = checked[0]!.element.closest('.args-row')
    expect(row?.textContent).toContain('--lowvram')
  })

  it('has no checkbox checked when activeArg is null', () => {
    const wrapper = mountGroup(null)
    const checkboxes = wrapper.findAll('input[type="checkbox"]')
    const checked = checkboxes.filter((r) => (r.element as HTMLInputElement).checked)
    expect(checked.length).toBe(0)
  })

  it('emits toggleBoolean when clicking an unselected boolean arg', async () => {
    const wrapper = mountGroup(null)
    const checkboxes = wrapper.findAll('input[type="checkbox"]')
    await checkboxes[2]!.trigger('change')
    expect(wrapper.emitted('toggleBoolean')).toBeTruthy()
    expect(wrapper.emitted('toggleBoolean')![0]).toEqual(['lowvram', VRAM_ARGS[2]])
  })

  it('emits toggleBoolean to deselect when clicking the active arg', async () => {
    const wrapper = mountGroup('highvram')
    const checkboxes = wrapper.findAll('input[type="checkbox"]')
    // Click the already-active one (highvram is index 1)
    await checkboxes[1]!.trigger('change')
    expect(wrapper.emitted('toggleBoolean')).toBeTruthy()
    expect(wrapper.emitted('toggleBoolean')![0]).toEqual(['highvram', VRAM_ARGS[1]])
  })

  it('does not show value input for boolean-only exclusive groups', () => {
    const wrapper = mountGroup('lowvram')
    expect(wrapper.find('.args-inline-input').exists()).toBe(false)
  })

  it('shows value input for an active optional-value arg', () => {
    const mixedArgs: ComfyArgDef[] = [
      { name: 'preview-a', flag: '--preview-a', help: 'Option A', type: 'boolean', category: 'Preview', exclusiveGroup: 'g2' },
      { name: 'preview-b', flag: '--preview-b', help: 'Option B with value', type: 'optional-value', metavar: 'MODE', category: 'Preview', exclusiveGroup: 'g2' },
    ]
    const wrapper = mount(ArgRadioGroup, {
      props: { args: mixedArgs, activeArg: 'preview-b', activeValue: 'fast' },
    })
    const input = wrapper.find('.args-inline-input')
    expect(input.exists()).toBe(true)
    expect((input.element as HTMLInputElement).value).toBe('fast')
  })

  it('shows select dropdown when active arg has choices', () => {
    const choiceArgs: ComfyArgDef[] = [
      { name: 'mode-a', flag: '--mode-a', help: 'A', type: 'boolean', category: 'Test', exclusiveGroup: 'g3' },
      { name: 'mode-b', flag: '--mode-b', help: 'B', type: 'optional-value', choices: ['x', 'y', 'z'], category: 'Test', exclusiveGroup: 'g3' },
    ]
    const wrapper = mount(ArgRadioGroup, {
      props: { args: choiceArgs, activeArg: 'mode-b', activeValue: 'y' },
    })
    const select = wrapper.find('select.args-inline-input')
    expect(select.exists()).toBe(true)
  })
})
