import { describe, it, expect } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import InfoTooltip from './InfoTooltip.vue'

// Pins the trigger surface + forwarding; placement/flip/arrow concerns
// belong in ui/Tooltip.test.ts.
describe('InfoTooltip', () => {
  it('renders the icon', () => {
    const wrapper = mount(InfoTooltip, { props: { text: 'tip' } })
    expect(wrapper.find('.info-tooltip-icon').exists()).toBe(true)
  })

  it('does not show bubble initially', () => {
    const wrapper = mount(InfoTooltip, {
      props: { text: 'Hello tooltip' },
      attachTo: document.body,
    })
    expect(document.querySelector('.tooltip-bubble')).toBeNull()
    wrapper.unmount()
  })

  it('shows bubble with correct text on mouseenter', async () => {
    const wrapper = mount(InfoTooltip, {
      props: { text: 'Hello tooltip', delayMs: 0 } as Record<string, unknown>,
      attachTo: document.body,
    })
    await wrapper.find('.tooltip-wrap').trigger('mouseenter')
    await flushPromises()
    const bubble = document.querySelector('.tooltip-bubble')
    expect(bubble).not.toBeNull()
    expect(bubble!.textContent?.trim()).toContain('Hello tooltip')
    wrapper.unmount()
  })

  it('hides bubble on mouseleave', async () => {
    const wrapper = mount(InfoTooltip, {
      props: { text: 'tip', delayMs: 0 } as Record<string, unknown>,
      attachTo: document.body,
    })
    await wrapper.find('.tooltip-wrap').trigger('mouseenter')
    await flushPromises()
    expect(document.querySelector('.tooltip-bubble')).not.toBeNull()
    await wrapper.find('.tooltip-wrap').trigger('mouseleave')
    await flushPromises()
    expect(document.querySelector('.tooltip-bubble')).toBeNull()
    wrapper.unmount()
  })

  it('renders the bubble with a resolved `data-side` attribute', async () => {
    const wrapper = mount(InfoTooltip, {
      props: { text: 'tip', side: 'bottom', delayMs: 0 } as Record<string, unknown>,
      attachTo: document.body,
    })
    await wrapper.find('.tooltip-wrap').trigger('mouseenter')
    await flushPromises()
    const bubble = document.querySelector('.tooltip-bubble')
    // jsdom returns zero-sized rects, so the resolver may flip; accept any side.
    expect(bubble?.getAttribute('data-side')).toMatch(/^(top|bottom|left|right)$/)
    wrapper.unmount()
  })
})
