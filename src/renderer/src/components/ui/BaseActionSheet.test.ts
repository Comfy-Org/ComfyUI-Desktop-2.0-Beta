import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import BaseActionSheet, { type ActionSheetItem } from './BaseActionSheet.vue'

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

const defaultItems: ActionSheetItem[] = [
  { value: 'proceed', label: 'Launch anyway' },
  { value: 'replace', label: 'Replace running instance', description: 'Stops the other one first', tone: 'danger' }
]

function mountSheet(props: Record<string, unknown> = {}) {
  const wrapper = mount(BaseActionSheet, {
    props: {
      open: true,
      title: 'Instance already running',
      message: 'Another instance is active.',
      items: defaultItems,
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

describe('BaseActionSheet', () => {
  it('renders title, message, and one button per item', () => {
    const wrapper = mountSheet()
    expect(wrapper.find('.base-action-sheet-title').text()).toBe('Instance already running')
    expect(wrapper.find('.base-action-sheet-message').text()).toBe('Another instance is active.')
    expect(wrapper.findAll('.base-action-sheet-item')).toHaveLength(2)
  })

  it('renders item description when present', () => {
    const wrapper = mountSheet()
    const descs = wrapper.findAll('.base-action-sheet-item-desc')
    expect(descs).toHaveLength(1)
    expect(descs[0].text()).toBe('Stops the other one first')
  })

  it('applies the danger class when item.tone === "danger"', () => {
    const wrapper = mountSheet()
    const items = wrapper.findAll('.base-action-sheet-item')
    expect(items[0].classes()).not.toContain('base-action-sheet-item--danger')
    expect(items[1].classes()).toContain('base-action-sheet-item--danger')
  })

  it('emits `select` with item.value on click', async () => {
    const wrapper = mountSheet()
    await wrapper.find('[data-testid="base-action-sheet-item-replace"]').trigger('click')
    expect(wrapper.emitted('select')).toEqual([['replace']])
  })

  it('emits `update:open` false on item click so v-model:open consumers close', async () => {
    const wrapper = mountSheet()
    await wrapper.find('[data-testid="base-action-sheet-item-proceed"]').trigger('click')
    expect(wrapper.emitted('update:open')).toEqual([[false]])
  })

  it('emits `cancel` when the cancel button is clicked', async () => {
    const wrapper = mountSheet()
    await wrapper.find('[data-testid="base-action-sheet-cancel"]').trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    expect(wrapper.emitted('select')).toBeUndefined()
  })

  it('emits `update:open` false on cancel', async () => {
    const wrapper = mountSheet()
    await wrapper.find('[data-testid="base-action-sheet-cancel"]').trigger('click')
    expect(wrapper.emitted('update:open')).toEqual([[false]])
  })

  it('renders nothing when open is false', () => {
    const wrapper = mountSheet({ open: false })
    expect(wrapper.find('.base-action-sheet-title').exists()).toBe(false)
  })

  it('uses a custom cancel label when provided', () => {
    const wrapper = mountSheet({ cancelLabel: 'Not now' })
    expect(wrapper.find('[data-testid="base-action-sheet-cancel"]').text()).toBe('Not now')
  })

  it('hides the message block when message is empty', () => {
    const wrapper = mountSheet({ message: '' })
    expect(wrapper.find('.base-action-sheet-message').exists()).toBe(false)
  })
})
