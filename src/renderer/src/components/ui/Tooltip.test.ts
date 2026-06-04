import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import Tooltip from './Tooltip.vue'

const wrappers: VueWrapper[] = []

afterEach(() => {
  while (wrappers.length) wrappers.pop()?.unmount()
  vi.useRealTimers()
})

function mountTooltip(props: Record<string, unknown> = {}) {
  const wrapper = mount(Tooltip, {
    props: { text: 'Hello tooltip', delayMs: 0, ...props },
    slots: { default: '<button data-testid="trigger">trigger</button>' },
    attachTo: document.body,
  })
  wrappers.push(wrapper)
  return wrapper
}

// jsdom returns zero-sized rects, so stub them for the placement resolver.
function stubViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true })
}

function stubTriggerRect(rect: Partial<DOMRect>) {
  const original = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.matches('[data-testid="trigger"]')) {
      return {
        x: 0,
        y: 0,
        width: 20,
        height: 20,
        top: 0,
        bottom: 20,
        left: 0,
        right: 20,
        toJSON: () => ({}),
        ...rect,
      } as DOMRect
    }
    if (this.matches('.tooltip-bubble')) {
      return {
        x: 0,
        y: 0,
        width: 120,
        height: 40,
        top: 0,
        bottom: 40,
        left: 0,
        right: 120,
        toJSON: () => ({}),
      } as DOMRect
    }
    return original.call(this)
  }
  return () => {
    Element.prototype.getBoundingClientRect = original
  }
}

describe('Tooltip (ui primitive)', () => {
  it('does not render the bubble before the trigger is hovered', () => {
    mountTooltip()
    expect(document.querySelector('.tooltip-bubble')).toBeNull()
  })

  it('shows the bubble on mouseenter with the trigger text', async () => {
    const wrapper = mountTooltip()
    await wrapper.trigger('mouseenter')
    await flushPromises()
    const bubble = document.querySelector('.tooltip-bubble')
    expect(bubble).not.toBeNull()
    expect(bubble!.textContent?.trim()).toContain('Hello tooltip')
  })

  it('hides the bubble on mouseleave', async () => {
    const wrapper = mountTooltip()
    await wrapper.trigger('mouseenter')
    await flushPromises()
    expect(document.querySelector('.tooltip-bubble')).not.toBeNull()
    wrapper.element.dispatchEvent(new Event('mouseleave'))
    await flushPromises()
    expect(document.querySelector('.tooltip-bubble')).toBeNull()
  })

  it('teleports the bubble to document.body (outside any overflow:hidden parent)', async () => {
    const wrapper = mountTooltip()
    await wrapper.trigger('mouseenter')
    await flushPromises()
    const bubble = document.querySelector('.tooltip-bubble')
    expect(bubble?.parentElement).toBe(document.body)
  })

  it('does not show the bubble when `disabled` is true', async () => {
    const wrapper = mountTooltip({ disabled: true })
    await wrapper.trigger('mouseenter')
    await flushPromises()
    expect(document.querySelector('.tooltip-bubble')).toBeNull()
  })

  it('does not show the bubble when `text` is empty', async () => {
    const wrapper = mountTooltip({ text: '' })
    await wrapper.trigger('mouseenter')
    await flushPromises()
    expect(document.querySelector('.tooltip-bubble')).toBeNull()
  })

  it('flips `side="top"` to `bottom` when the trigger sits flush against the top edge', async () => {
    stubViewport(1024, 768)
    const restore = stubTriggerRect({
      top: 0,
      bottom: 20,
      left: 100,
      right: 120,
    })
    try {
      const wrapper = mountTooltip({ side: 'top' })
      await wrapper.trigger('mouseenter')
      await flushPromises()
      const bubble = document.querySelector('.tooltip-bubble')
      expect(bubble?.getAttribute('data-side')).toBe('bottom')
    } finally {
      restore()
    }
  })

  it('clamps the bubble inside the viewport when the trigger is near the right edge', async () => {
    stubViewport(800, 600)
    const restore = stubTriggerRect({
      top: 300,
      bottom: 320,
      left: 790,
      right: 800,
      width: 10,
    })
    try {
      const wrapper = mountTooltip({ side: 'top' })
      await wrapper.trigger('mouseenter')
      await flushPromises()
      const bubble = document.querySelector('.tooltip-bubble') as HTMLElement
      // Bubble is 120px wide (stub), viewport is 800, edgePadding is 8 →
      // clamp upper bound is 800 - 120 - 8 = 672. Without clamping the
      // bubble's left would be 790 + 5 - 60 = 735.
      const left = parseFloat(bubble.style.left)
      expect(left).toBeLessThanOrEqual(672)
    } finally {
      restore()
    }
  })
})
