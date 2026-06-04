import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import ArgsBuilderPage from './ArgsBuilderPage.vue'
import type { ComfyArgDef } from '../../types/ipc'

// Pins the deselectable "Choose one" contract: the exclusive group
// renders as a BaseSelect with a synthetic "None" option so it can clear,
// covering pick → clear → re-pick with siblings cleaned up each time.
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

async function mountPage(initialValue = ''): Promise<VueWrapper> {
  const wrapper = mount(ArgsBuilderPage, {
    props: { installationId: 'inst-1', initialValue },
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

async function openSelect(wrapper: VueWrapper): Promise<void> {
  // BaseSelect has two root nodes (trigger button + Teleport), so the
  // page's data-testid doesn't fall through. The test only mounts one
  // BaseSelect per page so role=combobox is unambiguous.
  const trigger = wrapper.get('[role="combobox"]')
  await trigger.trigger('click')
  await flushPromises()
}

async function pickOption(wrapper: VueWrapper, labelText: string): Promise<void> {
  await openSelect(wrapper)
  const opts = wrapper.findAll('[role="option"]')
  const target = opts.find((o) => o.text().includes(labelText))
  if (!target) throw new Error(`Option not found: ${labelText}`)
  await target.trigger('click')
  await flushPromises()
}

beforeEach(() => {
  stubElectronApi()
})

afterEach(() => {
  while (wrappers.length) wrappers.pop()?.unmount()
  delete (window as unknown as { api?: unknown }).api
  vi.restoreAllMocks()
})

describe('ArgsBuilderPage — exclusive group select', () => {
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

  it('shows each member\'s help text as the option description', async () => {
    const wrapper = await mountPage()
    await openSelect(wrapper)
    const cpuOption = wrapper.findAll('[role="option"]').find((o) => o.text().includes('--cpu'))
    expect(cpuOption?.text()).toContain('Run on CPU only.')
  })

  it('reflects the active member in the closed trigger when value is pre-set', async () => {
    const wrapper = await mountPage('--lowvram')
    const trigger = wrapper.get('[role="combobox"]')
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
    const trigger = wrapper.get('[role="combobox"]')
    expect(trigger.attributes('aria-label')).toBe('Choose one')
  })
})
