import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import ArgsBuilderPage from './ArgsBuilderPage.vue'
import type { ComfyArgDef } from '../../types/ipc'

// Pins the deselectable "Choose one" contract: the exclusive group renders as
// a compact BaseSelect with a synthetic "None" option so it can clear, the
// label previews every member, and an active group is promoted to the top
// "Active" section as the same dropdown.
const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: {} },
  missingWarn: false,
  fallbackWarn: false,
})

const SCHEMA: ComfyArgDef[] = [
  {
    name: 'cpu',
    flag: '--cpu',
    help: 'Run on CPU only.',
    type: 'boolean',
    exclusiveGroup: 'group_0',
    category: 'GPU & VRAM',
  },
  {
    name: 'gpu-only',
    flag: '--gpu-only',
    help: 'Force GPU usage.',
    type: 'boolean',
    exclusiveGroup: 'group_0',
    category: 'GPU & VRAM',
  },
  {
    name: 'lowvram',
    flag: '--lowvram',
    help: 'Reduce VRAM usage.',
    type: 'boolean',
    exclusiveGroup: 'group_0',
    category: 'GPU & VRAM',
  },
  {
    name: 'port',
    flag: '--port',
    help: 'Server port.',
    type: 'value',
    metavar: 'PORT',
    category: 'Network',
  },
]

function stubElectronApi(): void {
  // Attach to the real window so jsdom listeners survive teardown
  // (swapping the whole window object breaks BaseSelect's resize/scroll cleanup).
  ;(window as unknown as { api: unknown }).api = {
    getComfyArgs: vi.fn().mockResolvedValue({ args: SCHEMA }),
  }
}

const wrappers: VueWrapper[] = []

async function mountPage(initialValue = '', pendingRestart = false): Promise<VueWrapper> {
  const wrapper = mount(ArgsBuilderPage, {
    props: { installationId: 'inst-1', initialValue, pendingRestart },
    global: {
      plugins: [i18n],
      // BaseSelect teleports its popover to <body>; render it in-tree
      // so we can query options through the wrapper.
      stubs: { Teleport: { template: '<div><slot /></div>' } },
    },
    attachTo: document.body,
  })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

function lastUpdate(wrapper: VueWrapper): string {
  const events = wrapper.emitted('update') ?? []
  return (events.at(-1)?.[0] as string | undefined) ?? ''
}

// An active group renders the same dropdown twice (Active section + category),
// so target the first combobox; both share the group's state.
async function openSelect(wrapper: VueWrapper, index = 0): Promise<void> {
  const triggers = wrapper.findAll('[role="combobox"]')
  const trigger = triggers[index]
  if (!trigger) throw new Error(`No combobox at index ${index}`)
  await trigger.trigger('click')
  await flushPromises()
}

async function pickOption(wrapper: VueWrapper, labelText: string, index = 0): Promise<void> {
  await openSelect(wrapper, index)
  const opts = wrapper.findAll('[role="option"]')
  const target = opts.find((o) => o.text().includes(labelText))
  if (!target) throw new Error(`Option not found: ${labelText}`)
  await target.trigger('click')
  await flushPromises()
}

function activeSection(wrapper: VueWrapper) {
  return wrapper
    .findAll('.args-page-category')
    .find((s) => s.find('.args-page-category-title').text() === 'Active')
}

beforeEach(() => {
  stubElectronApi()
})

afterEach(() => {
  while (wrappers.length) wrappers.pop()?.unmount()
  delete (window as unknown as { api?: unknown }).api
  vi.restoreAllMocks()
})

describe('ArgsBuilderPage — exclusive group dropdown', () => {
  it('renders a BaseSelect for the cluster with a leading "None" option + every member', async () => {
    const wrapper = await mountPage()
    expect(wrapper.find('[role="combobox"]').exists()).toBe(true)

    await openSelect(wrapper)
    const optionTexts = wrapper.findAll('[role="option"]').map((o) => o.text())
    expect(optionTexts[0]).toContain('None (default)')
    expect(optionTexts.some((t) => t.includes('--cpu'))).toBe(true)
    expect(optionTexts.some((t) => t.includes('--gpu-only'))).toBe(true)
    expect(optionTexts.some((t) => t.includes('--lowvram'))).toBe(true)
  })

  it('lists every member flag in the cluster label so the choices show before opening', async () => {
    const wrapper = await mountPage()
    const label = wrapper.find('.args-page-cluster-label')
    expect(label.exists()).toBe(true)
    expect(label.text()).toContain('--cpu')
    expect(label.text()).toContain('--gpu-only')
    expect(label.text()).toContain('--lowvram')
  })

  it("shows each member's help text as the option description", async () => {
    const wrapper = await mountPage()
    await openSelect(wrapper)
    const cpuOption = wrapper.findAll('[role="option"]').find((o) => o.text().includes('--cpu'))
    expect(cpuOption?.text()).toContain('Run on CPU only.')
  })

  it('reflects the active member in the closed trigger when value is pre-set', async () => {
    const wrapper = await mountPage('--lowvram')
    const trigger = wrapper.findAll('[role="combobox"]')[0]
    expect(trigger?.text()).toContain('--lowvram')
  })

  it('shows the selected member full help below the dropdown (no reopen needed)', async () => {
    const wrapper = await mountPage('--lowvram')
    const help = wrapper.findAll('.args-page-cluster-help')
    expect(help.length).toBeGreaterThan(0)
    expect(help[0]!.text()).toBe('Reduce VRAM usage.')
  })

  it('shows no cluster help until a member is selected', async () => {
    const wrapper = await mountPage()
    expect(wrapper.find('.args-page-cluster-help').exists()).toBe(false)
  })

  it('promotes an active exclusive group to the Active section as the same dropdown', async () => {
    const wrapper = await mountPage('--lowvram')
    const section = activeSection(wrapper)
    expect(section, 'expected an Active section').toBeTruthy()
    const trigger = section!.find('[role="combobox"]')
    expect(trigger.exists()).toBe(true)
    expect(trigger.text()).toContain('--lowvram')
  })

  it('emits the picked flag and replaces siblings on selection', async () => {
    const wrapper = await mountPage('--lowvram')
    await pickOption(wrapper, '--cpu')
    // No `--lowvram` survives — the parent commits a single-flag string.
    expect(lastUpdate(wrapper)).toBe('--cpu')
  })

  it('clears the whole group when "None" is picked — the affordance the radio version lost', async () => {
    const wrapper = await mountPage('--lowvram')
    await pickOption(wrapper, 'None (default)')
    expect(lastUpdate(wrapper)).toBe('')
  })

  it('round-trips: pick → clear → pick — siblings get cleaned up each time', async () => {
    const wrapper = await mountPage('')
    await pickOption(wrapper, '--lowvram')
    expect(lastUpdate(wrapper)).toBe('--lowvram')

    await pickOption(wrapper, '--cpu')
    expect(lastUpdate(wrapper)).toBe('--cpu')

    await pickOption(wrapper, 'None (default)')
    expect(lastUpdate(wrapper)).toBe('')

    await pickOption(wrapper, '--gpu-only')
    expect(lastUpdate(wrapper)).toBe('--gpu-only')
  })

  it('keeps unrelated flags intact when toggling the exclusive group', async () => {
    const wrapper = await mountPage('--port 8188 --lowvram')
    await pickOption(wrapper, 'None (default)')
    // Only the cluster member is removed; `--port 8188` survives.
    const result = lastUpdate(wrapper)
    expect(result).toContain('--port')
    expect(result).toContain('8188')
    expect(result).not.toContain('--lowvram')
  })

  it('exposes the cluster purpose to assistive tech via aria-label', async () => {
    const wrapper = await mountPage()
    const trigger = wrapper.find('[role="combobox"]')
    expect(trigger.attributes('aria-label')).toContain('Choose one')
  })

  it('previews cluster members space-separated, without bullet separators', async () => {
    const wrapper = await mountPage()
    const options = wrapper.find('.args-page-cluster-options')
    expect(options.exists()).toBe(true)
    expect(options.text()).not.toContain('·')
    expect(options.text()).toContain('--cpu --gpu-only')
  })
})

describe('ArgsBuilderPage — restart-to-apply tag', () => {
  it('hides the restart tag by default', async () => {
    const wrapper = await mountPage('--cpu')
    expect(wrapper.find('.args-page-restart-tag').exists()).toBe(false)
  })

  it('shows the restart tag when args are pending a restart', async () => {
    const wrapper = await mountPage('--cpu', true)
    const tag = wrapper.find('.args-page-restart-tag')
    expect(tag.exists()).toBe(true)
    expect(tag.text()).toContain('Restart to apply')
  })
})

describe('ArgsBuilderPage — raw-args validation', () => {
  it('shows no validation warnings for a valid arg string', async () => {
    const wrapper = await mountPage('--cpu --port 8188')
    expect(wrapper.find('.args-raw-validation-error').exists()).toBe(false)
    expect(wrapper.find('.args-raw-validation-warn').exists()).toBe(false)
    expect(wrapper.find('.args-raw-tokens').exists()).toBe(false)
  })

  it('flags an unsupported flag and marks the raw input invalid', async () => {
    const wrapper = await mountPage('--bogus')
    const err = wrapper.find('.args-raw-validation-error')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('--bogus')
    // BaseInput surfaces the invalid state via aria-invalid.
    expect(wrapper.find('input[aria-invalid="true"]').exists()).toBe(true)
  })

  it('flags a missing value when a value flag is followed by another flag', async () => {
    const wrapper = await mountPage('--port --cpu')
    const warn = wrapper.find('.args-raw-validation-warn')
    expect(warn.exists()).toBe(true)
    expect(warn.text()).toContain('--port')
  })

  it('treats a trailing value flag as an info hint, not an error', async () => {
    const wrapper = await mountPage('--cpu --port')
    expect(wrapper.find('.args-raw-validation-error').exists()).toBe(false)
    expect(wrapper.find('.args-raw-validation-warn').exists()).toBe(false)
    expect(wrapper.find('.args-raw-validation-info').text()).toContain('--port')
    expect(wrapper.find('input[aria-invalid="true"]').exists()).toBe(false)
  })

  it('flags an unexpected positional token', async () => {
    const wrapper = await mountPage('foo --cpu')
    const err = wrapper.find('.args-raw-validation-error')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('foo')
  })

  it('holds off flagging the trailing flag while the raw input is focused', async () => {
    const wrapper = await mountPage('--po')
    // Unfocused: the partial is flagged as unsupported.
    expect(wrapper.find('.args-raw-validation-error').exists()).toBe(true)

    // Focused: the trailing flag being typed is no longer flagged.
    await wrapper.find('.args-raw-input').trigger('focusin')
    await flushPromises()
    expect(wrapper.find('.args-raw-validation-error').exists()).toBe(false)
    expect(wrapper.find('input[aria-invalid="true"]').exists()).toBe(false)

    // Blur: validation applies again.
    await wrapper.find('.args-raw-input').trigger('focusout')
    await flushPromises()
    expect(wrapper.find('.args-raw-validation-error').exists()).toBe(true)
  })
})
