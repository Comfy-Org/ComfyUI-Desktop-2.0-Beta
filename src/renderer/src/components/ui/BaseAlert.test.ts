import { afterEach, describe, expect, it } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import BaseAlert from './BaseAlert.vue'

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: { modal: { ok: 'OK' }, common: { cancel: 'Cancel', close: 'Close' } }
  },
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

  it('applies primary tone class by default', () => {
    const wrapper = mountAlert({ showCancel: true })
    const action = wrapper.find('[data-testid="base-alert-action"]')
    expect(action.classes()).toContain('primary')
    expect(action.classes()).not.toContain('danger-solid')
  })

  it('applies danger tone class when tone="danger"', () => {
    const wrapper = mountAlert({ showCancel: true, tone: 'danger' })
    const action = wrapper.find('[data-testid="base-alert-action"]')
    expect(action.classes()).toContain('danger-solid')
    expect(action.classes()).not.toContain('primary')
  })

  it('renders a secondary button between Cancel and Primary when secondaryLabel is set', () => {
    const wrapper = mountAlert({
      showCancel: true,
      secondaryLabel: 'Close & Launch',
      buttonLabel: 'Launch'
    })
    const cancel = wrapper.find('[data-testid="base-alert-cancel"]')
    const secondary = wrapper.find('[data-testid="base-alert-secondary"]')
    const primary = wrapper.find('[data-testid="base-alert-action"]')
    expect(cancel.exists()).toBe(true)
    expect(secondary.text()).toBe('Close & Launch')
    expect(primary.text()).toBe('Launch')
  })

  it('emits `secondary` when the secondary button is clicked', async () => {
    const wrapper = mountAlert({
      secondaryLabel: 'Close & Launch',
      showCancel: false
    })
    await wrapper.find('[data-testid="base-alert-secondary"]').trigger('click')
    expect(wrapper.emitted('secondary')).toHaveLength(1)
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(wrapper.emitted('cancel')).toBeUndefined()
  })

  it('applies danger tone to the secondary button when secondaryTone="danger"', () => {
    const wrapper = mountAlert({
      secondaryLabel: 'Close & Launch',
      secondaryTone: 'danger',
      showCancel: false
    })
    const secondary = wrapper.find('[data-testid="base-alert-secondary"]')
    expect(secondary.classes()).toContain('danger-solid')
  })

  it('renders the header close icon when showCloseIcon is true', () => {
    const wrapper = mountAlert({ showCloseIcon: true, showCancel: false })
    expect(wrapper.find('[data-testid="base-alert-close-icon"]').exists()).toBe(true)
  })

  it('emits `cancel` when the header close icon is clicked', async () => {
    const wrapper = mountAlert({ showCloseIcon: true, showCancel: false })
    await wrapper.find('[data-testid="base-alert-close-icon"]').trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })

  it('does NOT render the header close icon by default', () => {
    const wrapper = mountAlert()
    expect(wrapper.find('[data-testid="base-alert-close-icon"]').exists()).toBe(false)
  })

  it('emits `cancel` on ESC when showCloseIcon is true (close icon is a cancel affordance)', async () => {
    const wrapper = mountAlert({ showCloseIcon: true, showCancel: false })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('renders messageDetails groups in recessed sub-blocks', () => {
    const wrapper = mountAlert({
      messageDetails: [{ label: 'Changes when restoring', items: ['+1 custom node', '-2 pip pkgs'] }]
    })
    expect(wrapper.find('.base-alert-detail-label').text()).toBe('Changes when restoring')
    const items = wrapper.findAll('.base-alert-detail-item')
    expect(items).toHaveLength(2)
    expect(items.at(0)?.text()).toBe('+1 custom node')
    expect(items.at(1)?.text()).toBe('-2 pip pkgs')
  })

  it('applies the rich-variant panel modifier when messageDetails is non-empty', () => {
    const wrapper = mountAlert({
      messageDetails: [{ label: 'Notes', items: ['x'] }]
    })
    expect(wrapper.find('.base-alert-panel--rich').exists()).toBe(true)
  })

  it('keeps the panel narrow when messageDetails is empty', () => {
    const wrapper = mountAlert()
    expect(wrapper.find('.base-alert-panel--rich').exists()).toBe(false)
  })
})
