import { afterEach, describe, expect, it } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import BasePrompt from './BasePrompt.vue'

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      modal: { ok: 'OK' },
      common: { cancel: 'Cancel', name: 'Name', close: 'Close' }
    }
  },
  missingWarn: false,
  fallbackWarn: false
})

const wrappers: VueWrapper[] = []

function mountPrompt(props: Record<string, unknown> = {}) {
  const wrapper = mount(BasePrompt, {
    props: {
      open: true,
      title: 'Name this thing',
      message: 'Pick a label.',
      defaultValue: 'My snapshot',
      ...props
    },
    global: {
      plugins: [i18n],
      stubs: { Teleport: { template: '<div><slot /></div>' } }
    }
  })
  wrappers.push(wrapper)
  return wrapper
}

afterEach(() => {
  while (wrappers.length) wrappers.pop()?.unmount()
})

describe('BasePrompt', () => {
  it('renders title, message, and input prefilled with defaultValue', async () => {
    const wrapper = mountPrompt()
    await flushPromises()
    expect(wrapper.find('.base-prompt-title').text()).toBe('Name this thing')
    expect(wrapper.find('.base-prompt-message').text()).toBe('Pick a label.')
    expect(wrapper.find<HTMLInputElement>('.base-prompt-input').element.value).toBe('My snapshot')
  })

  it('emits `submit` with the trimmed input value when the primary action fires', async () => {
    const wrapper = mountPrompt()
    await flushPromises()
    const input = wrapper.find<HTMLInputElement>('.base-prompt-input')
    await input.setValue('  Edited name  ')
    await wrapper.find('[data-testid="base-prompt-action"]').trigger('click')
    expect(wrapper.emitted('submit')).toEqual([['Edited name']])
  })

  it('emits `submit` on Enter inside the input', async () => {
    const wrapper = mountPrompt({ defaultValue: '' })
    await flushPromises()
    const input = wrapper.find<HTMLInputElement>('.base-prompt-input')
    await input.setValue('typed')
    await input.trigger('keydown.enter')
    expect(wrapper.emitted('submit')).toEqual([['typed']])
  })

  it('shows the default error and suppresses `submit` when required and empty', async () => {
    const wrapper = mountPrompt({ defaultValue: '', required: true })
    await flushPromises()
    await wrapper.find('[data-testid="base-prompt-action"]').trigger('click')
    expect(wrapper.find('.base-prompt-error').text()).toBe('This field is required')
    expect(wrapper.emitted('submit')).toBeUndefined()
  })

  it('uses a custom required error string when `required` is a string', async () => {
    const wrapper = mountPrompt({ defaultValue: '', required: 'Pick a name first.' })
    await flushPromises()
    await wrapper.find('[data-testid="base-prompt-action"]').trigger('click')
    expect(wrapper.find('.base-prompt-error').text()).toBe('Pick a name first.')
  })

  it('emits `cancel` when the cancel button is clicked', async () => {
    const wrapper = mountPrompt()
    await flushPromises()
    await wrapper.find('[data-testid="base-prompt-cancel"]').trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    expect(wrapper.emitted('submit')).toBeUndefined()
  })

  it('emits `update:open` false on submit so v-model:open consumers close', async () => {
    const wrapper = mountPrompt()
    await flushPromises()
    await wrapper.find('[data-testid="base-prompt-action"]').trigger('click')
    expect(wrapper.emitted('update:open')).toEqual([[false]])
  })

  it('emits `update:open` false on cancel', async () => {
    const wrapper = mountPrompt()
    await flushPromises()
    await wrapper.find('[data-testid="base-prompt-cancel"]').trigger('click')
    expect(wrapper.emitted('update:open')).toEqual([[false]])
  })

  it('renders messageDetails groups in recessed sub-blocks', async () => {
    const wrapper = mountPrompt({
      messageDetails: [{ label: 'Release notes', items: ['Line A', 'Line B'] }]
    })
    await flushPromises()
    expect(wrapper.find('.base-prompt-detail-label').text()).toBe('Release notes')
    const items = wrapper.findAll('.base-prompt-detail-item')
    expect(items).toHaveLength(2)
    expect(items[0].text()).toBe('Line A')
    expect(items[1].text()).toBe('Line B')
  })

  it('renders nothing when open is false', () => {
    const wrapper = mountPrompt({ open: false })
    expect(wrapper.find('.base-prompt-title').exists()).toBe(false)
  })

  it('uses a custom confirmLabel + cancelLabel when provided', async () => {
    const wrapper = mountPrompt({ confirmLabel: 'Copy and Update', cancelLabel: 'Back' })
    await flushPromises()
    expect(wrapper.find('[data-testid="base-prompt-action"]').text()).toBe('Copy and Update')
    expect(wrapper.find('[data-testid="base-prompt-cancel"]').text()).toBe('Back')
  })
})
