import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import TakeoverBack from './TakeoverBack.vue'

describe('TakeoverBack', () => {
  it('renders the supplied label as visible text and as the title/aria-label', () => {
    const wrapper = mount(TakeoverBack, { props: { label: 'Back to Dashboard' } })
    const btn = wrapper.find('button.takeover-back')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('type')).toBe('button')
    expect(btn.attributes('title')).toBe('Back to Dashboard')
    expect(btn.attributes('aria-label')).toBe('Back to Dashboard')
    // The label is also rendered visibly so the chevron isn't a
    // mystery icon — chevron + label, not chevron-only.
    expect(wrapper.find('.takeover-back-label').text()).toBe('Back to Dashboard')
  })

  it('emits a `back` event on click (host modal wires this to its `close` emit)', async () => {
    const wrapper = mount(TakeoverBack, { props: { label: 'Back to Dashboard' } })
    await wrapper.find('button.takeover-back').trigger('click')
    expect(wrapper.emitted('back')).toEqual([[]])
  })
})
