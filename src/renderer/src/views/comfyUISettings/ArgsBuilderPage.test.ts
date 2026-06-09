import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import ArgsBuilderPage from './ArgsBuilderPage.vue'
import type { ComfyArgDef } from '../../types/ipc'

// Pins the "Choose one" contract: the exclusive group renders as an inline
// radio list (every member visible at a glance) with a leading "None" radio
// that clears the group, covering pick → clear → re-pick with siblings
// cleaned up each time.
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
  ;(window as unknown as { api: unknown }).api = {
    getComfyArgs: vi.fn().mockResolvedValue({ args: SCHEMA }),
  }
}

const wrappers: VueWrapper[] = []

async function mountPage(initialValue = ''): Promise<VueWrapper> {
  const wrapper = mount(ArgsBuilderPage, {
    props: { installationId: 'inst-1', initialValue },
    global: { plugins: [i18n] },
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

function radioRows(wrapper: VueWrapper) {
  return wrapper.findAll('.args-page-radio-row')
}

async function pickRadio(wrapper: VueWrapper, labelText: string): Promise<void> {
  const target = radioRows(wrapper).find((r) => r.text().includes(labelText))
  if (!target) throw new Error(`Radio not found: ${labelText}`)
  await target.get('input[type="radio"]').setValue(true)
  await flushPromises()
}

function isChecked(wrapper: VueWrapper, labelText: string): boolean {
  const row = radioRows(wrapper).find((r) => r.text().includes(labelText))
  if (!row) throw new Error(`Radio not found: ${labelText}`)
  return (row.get('input[type="radio"]').element as HTMLInputElement).checked
}

beforeEach(() => {
  stubElectronApi()
})

afterEach(() => {
  while (wrappers.length) wrappers.pop()?.unmount()
  delete (window as unknown as { api?: unknown }).api
  vi.restoreAllMocks()
})

describe('ArgsBuilderPage — exclusive group radio list', () => {
  it('renders a radiogroup with a leading "None" option + every member', async () => {
    const wrapper = await mountPage()
    expect(wrapper.find('[role="radiogroup"]').exists()).toBe(true)

    const texts = radioRows(wrapper).map((r) => r.text())
    expect(texts[0]).toContain('None (default)')
    expect(texts.some((t) => t.includes('--cpu'))).toBe(true)
    expect(texts.some((t) => t.includes('--gpu-only'))).toBe(true)
    expect(texts.some((t) => t.includes('--lowvram'))).toBe(true)
  })

  it("shows each member's help text inline", async () => {
    const wrapper = await mountPage()
    const cpuRow = radioRows(wrapper).find((r) => r.text().includes('--cpu'))
    expect(cpuRow?.text()).toContain('Run on CPU only.')
  })

  it('checks the active member when a value is pre-set', async () => {
    const wrapper = await mountPage('--lowvram')
    expect(isChecked(wrapper, '--lowvram')).toBe(true)
    expect(isChecked(wrapper, 'None (default)')).toBe(false)
  })

  it('checks "None" by default when nothing in the group is set', async () => {
    const wrapper = await mountPage()
    expect(isChecked(wrapper, 'None (default)')).toBe(true)
  })

  it('emits the picked flag and replaces siblings on selection', async () => {
    const wrapper = await mountPage('--lowvram')
    await pickRadio(wrapper, '--cpu')
    // No `--lowvram` survives — the parent commits a single-flag string.
    expect(lastUpdate(wrapper)).toBe('--cpu')
  })

  it('clears the whole group when "None" is picked', async () => {
    const wrapper = await mountPage('--lowvram')
    await pickRadio(wrapper, 'None (default)')
    expect(lastUpdate(wrapper)).toBe('')
  })

  it('round-trips: pick → clear → pick — siblings get cleaned up each time', async () => {
    const wrapper = await mountPage('')
    await pickRadio(wrapper, '--lowvram')
    expect(lastUpdate(wrapper)).toBe('--lowvram')

    await pickRadio(wrapper, '--cpu')
    expect(lastUpdate(wrapper)).toBe('--cpu')

    await pickRadio(wrapper, 'None (default)')
    expect(lastUpdate(wrapper)).toBe('')

    await pickRadio(wrapper, '--gpu-only')
    expect(lastUpdate(wrapper)).toBe('--gpu-only')
  })

  it('keeps unrelated flags intact when clearing the exclusive group', async () => {
    const wrapper = await mountPage('--port 8188 --lowvram')
    await pickRadio(wrapper, 'None (default)')
    // Only the cluster member is removed; `--port 8188` survives.
    const result = lastUpdate(wrapper)
    expect(result).toContain('--port')
    expect(result).toContain('8188')
    expect(result).not.toContain('--lowvram')
  })

  it('exposes the cluster purpose to assistive tech via aria-label', async () => {
    const wrapper = await mountPage()
    expect(wrapper.find('[role="radiogroup"]').attributes('aria-label')).toBe('Choose one')
  })
})
