import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { h } from 'vue'

import BrandFinishedSurface from './BrandFinishedSurface.vue'

const messages = {
  en: {
    common: { copy: 'Copy' },
    launch: { viewLogs: 'View logs' },
  },
}

function createTestI18n() {
  return createI18n({ legacy: false, locale: 'en', messages })
}

// Stub BrandTakeoverLayout's Teleport + focus-trap so assertions can
// query the rendered tree inline. Mirrors the pattern used in
// ComfyLifecycleView.test.ts.
const brandTakeoverStub = {
  name: 'BrandTakeoverLayout',
  props: ['theme', 'vignette', 'ariaLabel'],
  template: '<div class="brand-takeover-stub"><slot /><slot name="footer" /></div>',
}

function mountSurface(props: Record<string, unknown>, slots: Record<string, unknown> = {}) {
  return mount(BrandFinishedSurface, {
    props,
    slots,
    global: {
      plugins: [createTestI18n()],
      stubs: { BrandTakeoverLayout: brandTakeoverStub },
    },
  })
}

describe('BrandFinishedSurface', () => {
  it('renders the title in the error banner', () => {
    const wrapper = mountSurface({ title: 'It blew up' })
    const banner = wrapper.find('.brand-progress__banner')
    expect(banner.exists()).toBe(true)
    expect(banner.classes()).toContain('brand-progress__banner--error')
    expect(banner.text()).toContain('It blew up')
  })

  describe('message row', () => {
    it('renders the message + copy button when message is provided', () => {
      const wrapper = mountSurface({ title: 'Crashed', message: 'Exit code 137' })
      const row = wrapper.find('.brand-progress__error-row')
      expect(row.exists()).toBe(true)
      expect(row.text()).toContain('Exit code 137')
      expect(wrapper.find('.brand-progress__error-copy').exists()).toBe(true)
    })

    it('omits the message row entirely when no message is provided', () => {
      const wrapper = mountSurface({ title: 'Crashed' })
      expect(wrapper.find('.brand-progress__error-row').exists()).toBe(false)
    })
  })

  describe('logs accordion', () => {
    it('omits the accordion + toggle when no logs prop is set', () => {
      const wrapper = mountSurface({ title: 'Crashed' })
      expect(wrapper.find('.brand-progress__logs').exists()).toBe(false)
      expect(wrapper.find('.brand-progress__logs-toggle').exists()).toBe(false)
    })

    it('renders the logs content when the logs prop is set', () => {
      const wrapper = mountSurface({
        title: 'Crashed',
        logs: 'Traceback (most recent call last):\n  File "...", line 42',
      })
      const logs = wrapper.find('.brand-progress__logs')
      expect(logs.exists()).toBe(true)
      expect(logs.text()).toContain('Traceback')
      expect(logs.text()).toContain('line 42')
    })

    it('toggles the logs panel via the accordion button', async () => {
      const wrapper = mountSurface({ title: 'Crashed', logs: 'stderr' })
      const toggle = wrapper.find('.brand-progress__logs-toggle')
      expect(toggle.attributes('aria-expanded')).toBe('false')

      await toggle.trigger('click')
      expect(toggle.attributes('aria-expanded')).toBe('true')

      await toggle.trigger('click')
      expect(toggle.attributes('aria-expanded')).toBe('false')
    })

    it('wires aria-controls to the same unique id the logs panel uses', () => {
      const wrapper = mountSurface({ title: 'Crashed', logs: 'stderr' })
      const toggle = wrapper.find('.brand-progress__logs-toggle')
      const logs = wrapper.find('.brand-progress__logs')
      const id = toggle.attributes('aria-controls')
      expect(id).toBeTruthy()
      expect(logs.attributes('id')).toBe(id)
    })

    it('gives each instance a unique logs id so two surfaces cannot collide', () => {
      // Both surfaces must mount under the same Vue app for the test
      // to reflect production reality — `useId()`'s counter is per-app,
      // so two separate `mount()` calls would each restart at v-0 and
      // collide regardless of whether the implementation is correct.
      const parent = {
        components: { BrandFinishedSurface },
        template: `
          <div>
            <BrandFinishedSurface title="A" logs="a-stderr" />
            <BrandFinishedSurface title="B" logs="b-stderr" />
          </div>
        `,
      }
      const wrapper = mount(parent, {
        global: {
          plugins: [createTestI18n()],
          stubs: { BrandTakeoverLayout: brandTakeoverStub },
        },
      })
      const toggles = wrapper.findAll('.brand-progress__logs-toggle')
      expect(toggles).toHaveLength(2)
      const idA = toggles[0]!.attributes('aria-controls')
      const idB = toggles[1]!.attributes('aria-controls')
      expect(idA).not.toBe(idB)
    })

    it('honours a custom logsLabel for the accordion title + toggle button', () => {
      const wrapper = mountSurface({
        title: 'Crashed',
        logs: 'stderr',
        logsLabel: 'Show stderr',
      })
      expect(wrapper.text()).toContain('Show stderr')
      expect(wrapper.text()).not.toContain('View logs')
    })
  })

  describe('actions slot', () => {
    it('renders actions inside the hero-stack error-actions row, not the footer bar', () => {
      const wrapper = mountSurface(
        { title: 'Crashed', message: 'Exit code 137' },
        {
          actions: () => [
            h(
              'button',
              { class: 'brand-ghost brand-progress__footer-btn', type: 'button' },
              'Back',
            ),
            h(
              'button',
              { class: 'brand-primary brand-progress__footer-btn', type: 'button' },
              'Restart',
            ),
          ],
        },
      )
      const row = wrapper.find('.brand-progress__error-actions')
      expect(row.exists()).toBe(true)
      const buttons = row.findAll('button')
      expect(buttons).toHaveLength(2)
      expect(buttons[0]!.text()).toBe('Back')
      expect(buttons[1]!.text()).toBe('Restart')
    })

    it('omits the actions row entirely when no actions slot is provided', () => {
      const wrapper = mountSurface({ title: 'Crashed' })
      expect(wrapper.find('.brand-progress__error-actions').exists()).toBe(false)
    })
  })

  it('forwards ariaLabel to the BrandTakeoverLayout chrome', () => {
    const wrapper = mountSurface({ title: 'Crashed', ariaLabel: 'ComfyUI crashed' })
    const layout = wrapper.findComponent({ name: 'BrandTakeoverLayout' })
    expect(layout.exists()).toBe(true)
    expect(layout.props('ariaLabel')).toBe('ComfyUI crashed')
  })
})
