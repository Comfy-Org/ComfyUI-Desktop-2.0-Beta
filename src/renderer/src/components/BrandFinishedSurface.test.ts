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
// query the rendered tree inline. Declares its props so test assertions
// can read `props('ariaLabel')` off the stub via `findComponent`.
// Mirrors the pattern used in ComfyLifecycleView.test.ts.
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
  describe('variants', () => {
    it('renders the success banner with the success modifier class', () => {
      const wrapper = mountSurface({ variant: 'success', title: 'Operation complete' })
      const banner = wrapper.find('.brand-progress__banner')
      expect(banner.exists()).toBe(true)
      expect(banner.classes()).toContain('brand-progress__banner--success')
      expect(banner.text()).toContain('Operation complete')
    })

    it('renders the error banner with the error modifier class', () => {
      const wrapper = mountSurface({ variant: 'error', title: 'It blew up' })
      const banner = wrapper.find('.brand-progress__banner')
      expect(banner.classes()).toContain('brand-progress__banner--error')
      expect(banner.text()).toContain('It blew up')
    })

    it('renders the cancelled banner with the cancelled modifier class', () => {
      const wrapper = mountSurface({ variant: 'cancelled', title: 'Stopped' })
      const banner = wrapper.find('.brand-progress__banner')
      expect(banner.classes()).toContain('brand-progress__banner--cancelled')
      expect(banner.text()).toContain('Stopped')
    })
  })

  describe('message row', () => {
    it('renders the message + copy button when message is provided', () => {
      const wrapper = mountSurface({
        variant: 'error',
        title: 'Crashed',
        message: 'Exit code 137',
      })
      const row = wrapper.find('.brand-progress__error-row')
      expect(row.exists()).toBe(true)
      expect(row.text()).toContain('Exit code 137')
      // The inline Copy button is the only `.brand-progress__error-copy`
      // node on the surface — its presence proves the BaseCopyButton
      // was wired with the message value.
      expect(wrapper.find('.brand-progress__error-copy').exists()).toBe(true)
    })

    it('omits the message row entirely when no message is provided', () => {
      const wrapper = mountSurface({ variant: 'cancelled', title: 'Stopped' })
      expect(wrapper.find('.brand-progress__error-row').exists()).toBe(false)
    })
  })

  describe('logs accordion', () => {
    it('omits the accordion + toggle when no logs prop is set', () => {
      const wrapper = mountSurface({ variant: 'cancelled', title: 'Stopped' })
      expect(wrapper.find('.brand-progress__logs').exists()).toBe(false)
      expect(wrapper.find('.brand-progress__logs-toggle').exists()).toBe(false)
    })

    it('renders the logs content when the logs prop is set', () => {
      const wrapper = mountSurface({
        variant: 'error',
        title: 'Crashed',
        logs: 'Traceback (most recent call last):\n  File "...", line 42',
      })
      const logs = wrapper.find('.brand-progress__logs')
      expect(logs.exists()).toBe(true)
      expect(logs.text()).toContain('Traceback')
    })

    it('toggles the logs panel open + flips aria-expanded when the toggle is clicked', async () => {
      const wrapper = mountSurface({
        variant: 'error',
        title: 'Crashed',
        logs: 'stderr output',
      })
      const toggle = wrapper.find('.brand-progress__logs-toggle')
      expect(toggle.attributes('aria-expanded')).toBe('false')
      // The chevron rotates via the `is-open` class — start closed.
      expect(wrapper.find('.brand-progress__logs-chevron').classes()).not.toContain('is-open')

      await toggle.trigger('click')
      expect(toggle.attributes('aria-expanded')).toBe('true')
      expect(wrapper.find('.brand-progress__logs-chevron').classes()).toContain('is-open')

      await toggle.trigger('click')
      expect(toggle.attributes('aria-expanded')).toBe('false')
    })

    it('wires aria-controls to the same unique id the logs panel uses', () => {
      const wrapper = mountSurface({
        variant: 'error',
        title: 'Crashed',
        logs: 'stderr',
      })
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
            <BrandFinishedSurface variant="error" title="A" logs="a-stderr" />
            <BrandFinishedSurface variant="error" title="B" logs="b-stderr" />
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
      expect(idA).toBeTruthy()
      expect(idB).toBeTruthy()
      expect(idA).not.toBe(idB)
    })

    it('honours a custom logsLabel for the accordion title + toggle button', () => {
      const wrapper = mountSurface({
        variant: 'error',
        title: 'Crashed',
        logs: 'stderr',
        logsLabel: 'Show stderr',
      })
      // Both the accordion panel header and the toggle button use the
      // override; bare-string `.text()` on the surface catches both.
      expect(wrapper.text()).toContain('Show stderr')
      expect(wrapper.text()).not.toContain('View logs')
    })
  })

  describe('actions slot', () => {
    it('renders content passed via the actions slot inside the footer-left band', () => {
      const wrapper = mountSurface(
        { variant: 'cancelled', title: 'Stopped' },
        {
          actions: () =>
            h(
              'button',
              { class: 'brand-primary brand-progress__footer-btn', type: 'button' },
              'Start',
            ),
        },
      )
      const footerLeft = wrapper.find('.brand-progress__footer-left')
      expect(footerLeft.exists()).toBe(true)
      const action = footerLeft.find('button.brand-primary')
      expect(action.exists()).toBe(true)
      expect(action.text()).toBe('Start')
    })

    it('centers the footer bar when no logs and no actions are provided', () => {
      const wrapper = mountSurface({ variant: 'cancelled', title: 'Stopped' })
      const bar = wrapper.find('.brand-progress__footer-bar')
      expect(bar.exists()).toBe(true)
      // Empty footer collapses to centered layout via the `is-centered`
      // modifier — same convention ProgressModal's finished branch uses
      // when there are no terminal actions to render.
      expect(bar.classes()).toContain('is-centered')
    })

    it('does not center the footer bar when actions are provided', () => {
      const wrapper = mountSurface(
        { variant: 'cancelled', title: 'Stopped' },
        { actions: () => h('button', { type: 'button' }, 'Start') },
      )
      const bar = wrapper.find('.brand-progress__footer-bar')
      expect(bar.classes()).not.toContain('is-centered')
    })
  })

  it('forwards ariaLabel to the BrandTakeoverLayout chrome', () => {
    const wrapper = mountSurface({
      variant: 'error',
      title: 'Crashed',
      ariaLabel: 'ComfyUI crashed',
    })
    const layout = wrapper.findComponent({ name: 'BrandTakeoverLayout' })
    expect(layout.exists()).toBe(true)
    expect(layout.props('ariaLabel')).toBe('ComfyUI crashed')
  })
})
