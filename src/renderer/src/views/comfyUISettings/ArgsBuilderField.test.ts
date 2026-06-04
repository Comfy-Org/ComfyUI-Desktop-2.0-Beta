import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import ArgsBuilderField from './ArgsBuilderField.vue'
import type { ComfyArgDef, DetailField } from '../../types/ipc'

// Tests that the args-field autocomplete appears, narrows on typing, and commits the picked flag via `update`.

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: {} },
  missingWarn: false,
  fallbackWarn: false,
})

const SCHEMA: ComfyArgDef[] = [
  { name: 'cpu', flag: '--cpu', help: 'Run on CPU only.', type: 'boolean', category: 'GPU & VRAM' },
  { name: 'lowvram', flag: '--lowvram', help: 'Reduce VRAM.', type: 'boolean', category: 'GPU & VRAM' },
  { name: 'novram', flag: '--novram', help: 'No VRAM.', type: 'boolean', category: 'GPU & VRAM' },
  { name: 'port', flag: '--port', help: 'Server port.', type: 'value', metavar: 'PORT', category: 'Network' },
]

const FIELD: DetailField = {
  id: 'launchArgs',
  label: 'Startup Arguments',
  editType: 'args-builder',
  value: '',
} as DetailField

function stubElectronApi(): void {
  ;(window as unknown as { api: unknown }).api = {
    getComfyArgs: vi.fn().mockResolvedValue({ args: SCHEMA }),
  }
}

const wrappers: VueWrapper[] = []

async function mountField(
  props: { field?: DetailField; installationId?: string | null } = {},
): Promise<VueWrapper> {
  const installationId = 'installationId' in props ? props.installationId : 'inst-1'
  const wrapper = mount(ArgsBuilderField, {
    props: {
      field: { ...FIELD, ...(props.field ?? {}) },
      ...(installationId == null ? {} : { installationId }),
    },
    global: { plugins: [i18n] },
    attachTo: document.body,
  })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

beforeEach(() => stubElectronApi())
afterEach(() => {
  while (wrappers.length) wrappers.pop()?.unmount()
  delete (window as unknown as { api?: unknown }).api
  vi.restoreAllMocks()
})

describe('ArgsBuilderField — inline autocomplete', () => {
  it('does not render the popover when the input is empty', async () => {
    const wrapper = await mountField()
    expect(wrapper.find('.args-raw-input-ac').exists()).toBe(false)
  })

  it('renders matching suggestions while the user types a partial flag', async () => {
    const wrapper = await mountField()
    const input = wrapper.get('input')
    await input.trigger('focusin')
    await input.setValue('--lo')
    await flushPromises()

    const popover = wrapper.find('.args-raw-input-ac')
    expect(popover.exists()).toBe(true)
    const names = popover.findAll('.args-raw-input-ac-flag').map((n) => n.text())
    expect(names).toContain('--lowvram')
    // `--cpu` doesn't match "lo" so it shouldn't surface.
    expect(names).not.toContain('--cpu')
  })

  it('shows help text per suggestion', async () => {
    const wrapper = await mountField()
    const input = wrapper.get('input')
    await input.trigger('focusin')
    await input.setValue('--lo')
    await flushPromises()
    expect(wrapper.find('.args-raw-input-ac').text()).toContain('Reduce VRAM')
  })

  it("emits `update` with the spliced flag when a suggestion is clicked", async () => {
    const wrapper = await mountField()
    const input = wrapper.get('input')
    await input.trigger('focusin')
    await input.setValue('--lo')
    await flushPromises()

    const lowvramOption = wrapper
      .findAll('.args-raw-input-ac-item')
      .find((o) => o.text().includes('--lowvram'))
    await lowvramOption?.trigger('mousedown')
    await flushPromises()

    const events = wrapper.emitted('update') ?? []
    expect(events.length).toBeGreaterThan(0)
    const lastValue = events.at(-1)?.[1] as string
    expect(lastValue).toBe('--lowvram ')
  })

  it('hides the popover on Escape but reopens on the next keystroke', async () => {
    const wrapper = await mountField()
    const input = wrapper.get('input')
    await input.trigger('focusin')
    await input.setValue('--lo')
    await flushPromises()
    expect(wrapper.find('.args-raw-input-ac').exists()).toBe(true)

    await input.trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(wrapper.find('.args-raw-input-ac').exists()).toBe(false)

    await input.setValue('--low')
    await flushPromises()
    expect(wrapper.find('.args-raw-input-ac').exists()).toBe(true)
  })

  it('suppresses suggestions while filling a value-typed flag', async () => {
    const wrapper = await mountField()
    const input = wrapper.get('input')
    await input.trigger('focusin')
    // `--port` is a value-type flag — after the space the user is
    // typing the PORT value, not a flag name, so no dropdown.
    await input.setValue('--port 81')
    await flushPromises()
    expect(wrapper.find('.args-raw-input-ac').exists()).toBe(false)
  })

  it('still works as a plain text input when no installationId is provided', async () => {
    const wrapper = await mountField({ installationId: null })
    expect(wrapper.find('input').exists()).toBe(true)
    expect((window as unknown as { api: { getComfyArgs: ReturnType<typeof vi.fn> } }).api.getComfyArgs).not.toHaveBeenCalled()
    expect(wrapper.find('.args-raw-input-ac').exists()).toBe(false)
  })
})
