import { afterEach, describe, expect, it } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import BaseAlert from './BaseAlert.vue'

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: { modal: { ok: 'OK' }, common: { cancel: 'Cancel' } } },
  missingWarn: false,
  fallbackWarn: false
})

const wrappers: VueWrapper[] = []

function mountAlert(props: Record<string, unknown> = {}) {
  const wrapper = mount(BaseAlert, {
    props: {
      open: true,
      title: 'Test alert',
      message: 'Something happened.',
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

describe('BaseAlert', () => {
  it('renders alertdialog with aria-modal, aria-labelledby, title, and message', () => {
    const wrapper = mountAlert()
    const overlay = wrapper.find('.base-alert-overlay')
    expect(overlay.exists()).toBe(true)
    expect(overlay.attributes('role')).toBe('alertdialog')
    expect(overlay.attributes('aria-modal')).toBe('true')
    expect(overlay.attributes('aria-labelledby')).toBe('base-alert-title')
    expect(wrapper.find('.base-alert-title').text()).toBe('Test alert')
    expect(wrapper.find('.base-alert-message').text()).toBe('Something happened.')
  })

  it('renders the default OK action and emits `close` when clicked', async () => {
    const wrapper = mountAlert()
    const action = wrapper.find('[data-testid="base-alert-action"]')
    expect(action.text()).toBe('OK')
    await action.trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('uses a custom button label when provided', () => {
    const wrapper = mountAlert({ buttonLabel: 'Got it' })
    expect(wrapper.find('[data-testid="base-alert-action"]').text()).toBe('Got it')
  })

  it('emits `close` on ESC when dismissOnEscape is true (the default)', async () => {
    const wrapper = mountAlert()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('does NOT emit `close` on ESC when dismissOnEscape is false', async () => {
    const wrapper = mountAlert({ dismissOnEscape: false })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('locks body scroll while open and restores the prior value on close', async () => {
    document.body.style.overflow = 'auto'
    const wrapper = mountAlert()
    expect(document.body.style.overflow).toBe('hidden')
    await wrapper.setProps({ open: false })
    expect(document.body.style.overflow).toBe('auto')
  })

  it('skips body scroll lock when preventScroll=false', () => {
    document.body.style.overflow = 'visible'
    mountAlert({ preventScroll: false })
    expect(document.body.style.overflow).toBe('visible')
  })

  it('renders nothing when `open` is false', () => {
    const wrapper = mountAlert({ open: false })
    expect(wrapper.find('.base-alert-overlay').exists()).toBe(false)
  })

  it('prefers aria-label over aria-labelledby when aria-label is set', () => {
    const wrapper = mountAlert({ ariaLabel: 'Custom name' })
    const overlay = wrapper.find('.base-alert-overlay')
    expect(overlay.attributes('aria-label')).toBe('Custom name')
    expect(overlay.attributes('aria-labelledby')).toBeUndefined()
  })

  it('renders cancel + primary when showCancel is true', () => {
    const wrapper = mountAlert({ showCancel: true })
    expect(wrapper.find('[data-testid="base-alert-cancel"]').text()).toBe('Cancel')
    expect(wrapper.find('[data-testid="base-alert-action"]').text()).toBe('OK')
  })

  it('emits `cancel` when the cancel button is clicked', async () => {
    const wrapper = mountAlert({ showCancel: true })
    await wrapper.find('[data-testid="base-alert-cancel"]').trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('emits `cancel` on ESC when showCancel is true', async () => {
    const wrapper = mountAlert({ showCancel: true })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    expect(wrapper.emitted('close')).toBeUndefined()
  })
})
