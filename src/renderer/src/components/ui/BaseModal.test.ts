import { afterEach, describe, expect, it } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import BaseModal from './BaseModal.vue'

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: { common: { close: 'Close' } } },
  missingWarn: false,
  fallbackWarn: false,
})

// Tracked so `afterEach` can tear them down — otherwise a leaked
// `document.keydown` listener's `stopImmediatePropagation()` would block
// later ESC tests.
const wrappers: VueWrapper[] = []

function mountModal(props: Record<string, unknown> = {}) {
  const wrapper = mount(BaseModal, {
    props: {
      open: true,
      ariaLabel: 'Test dialog',
      ...props,
    },
    slots: { default: '<p class="body-content">Hello</p>' },
    global: {
      plugins: [i18n],
      // Stub `<Teleport>` so the panel renders inside the wrapper for assertions.
      stubs: { Teleport: { template: '<div><slot /></div>' } },
    },
  })
  wrappers.push(wrapper)
  return wrapper
}

afterEach(() => {
  while (wrappers.length) wrappers.pop()?.unmount()
})

describe('BaseModal', () => {
  it('renders the dialog with role + aria-modal + aria-label and the slot body', () => {
    const wrapper = mountModal()
    const overlay = wrapper.find('.base-modal-overlay')
    expect(overlay.exists()).toBe(true)
    expect(overlay.attributes('role')).toBe('dialog')
    expect(overlay.attributes('aria-modal')).toBe('true')
    expect(overlay.attributes('aria-label')).toBe('Test dialog')
    expect(wrapper.find('.body-content').text()).toBe('Hello')
  })

  it('renders the close button by default and emits `close` when clicked', async () => {
    const wrapper = mountModal()
    const closeBtn = wrapper.find('[data-testid="base-modal-close"]')
    expect(closeBtn.exists()).toBe(true)
    await closeBtn.trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('hides the close button when show-close-button=false', () => {
    const wrapper = mountModal({ showCloseButton: false })
    expect(wrapper.find('[data-testid="base-modal-close"]').exists()).toBe(false)
  })

  it('emits `close` on ESC when dismissOnEscape is true (the default)', async () => {
    const wrapper = mountModal()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('does NOT emit `close` on ESC when dismissOnEscape is false', async () => {
    const wrapper = mountModal({ dismissOnEscape: false })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('locks body scroll while open and restores the prior value on close', async () => {
    document.body.style.overflow = 'auto'
    const wrapper = mountModal()
    // `watch(..., { immediate: true })` fires synchronously on mount.
    expect(document.body.style.overflow).toBe('hidden')
    await wrapper.setProps({ open: false })
    expect(document.body.style.overflow).toBe('auto')
  })

  it('skips body scroll lock when preventScroll=false', () => {
    document.body.style.overflow = 'visible'
    mountModal({ preventScroll: false })
    expect(document.body.style.overflow).toBe('visible')
  })

  it('renders nothing in the overlay when `open` is false', () => {
    const wrapper = mountModal({ open: false })
    expect(wrapper.find('.base-modal-overlay').exists()).toBe(false)
  })

  it('applies the size class to the panel', () => {
    const wrapper = mountModal({ size: 'xl' })
    expect(wrapper.find('.base-modal-panel').classes()).toContain('is-size-xl')
  })
})
