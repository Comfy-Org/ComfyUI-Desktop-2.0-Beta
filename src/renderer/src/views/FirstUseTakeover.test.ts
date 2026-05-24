/**
 * Start-screen behaviour tests for FirstUseTakeover (merged T&C +
 * Cloud-vs-Local picker).
 *
 * Scope:
 *   - Continue button stays disabled until the Terms checkbox is
 *     checked (legally required affirmative-assent gate).
 *   - The two inline links on the Terms row route to the right docs
 *     (`'eula'` and `'tos'`), and the telemetry Learn-more routes to
 *     `'privacy'`. If routing is crossed the user sees the wrong doc
 *     for the link they clicked.
 *
 * Heavy children (BrandTakeoverLayout, ModalShell, TermsModal,
 * WhyTryCloudModal, etc.) are stubbed so the test can focus on the
 * start-step DOM without dragging in their dependencies.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'

vi.mock('../lib/telemetry', () => ({
  emitTelemetryAction: vi.fn(),
}))

vi.mock('../components/TakeoverHeader.vue', () => ({
  default: { template: '<div data-testid="stub-takeover-header"><slot /></div>' },
}))
vi.mock('../components/ModalShell.vue', () => ({
  default: { template: '<div data-testid="stub-modal-shell"><slot /></div>' },
}))
vi.mock('../components/ChoiceCard.vue', () => ({
  default: {
    template:
      '<div data-testid="stub-choice-card"><slot name="label-trailing" /><slot /></div>',
  },
}))
vi.mock('../components/WhyTryCloudModal.vue', () => ({
  default: { template: '<div data-testid="stub-why-cloud" />' },
}))
vi.mock('../components/TooltipWrap.vue', () => ({
  default: {
    name: 'TooltipWrap',
    props: ['text'],
    template:
      '<span data-testid="stub-tooltip-wrap" :data-text="text"><slot /></span>',
  },
}))
vi.mock('../components/TermsModal.vue', () => ({
  default: {
    props: ['doc'],
    template: '<div data-testid="stub-terms-modal" :data-doc="doc" />',
  },
}))
vi.mock('../components/BrandTakeoverLayout.vue', () => ({
  default: {
    template: '<div data-testid="stub-brand-layout"><slot /></div>',
  },
}))
vi.mock('../components/icons/ComfyWordmark.vue', () => ({
  default: { template: '<svg data-testid="stub-wordmark" />' },
}))

import FirstUseTakeover from './FirstUseTakeover.vue'

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: {} },
  missingWarn: false,
  fallbackWarn: false,
})

beforeEach(() => {
  window.api = {
    setSetting: vi.fn().mockResolvedValue(undefined),
    getSetting: vi.fn().mockResolvedValue(true),
    getLocale: vi.fn().mockResolvedValue('en'),
    setFirstUseMode: vi.fn(),
    closeHostWindow: vi.fn().mockResolvedValue(undefined),
  } as unknown as typeof window.api
})

function mountTakeover() {
  return mount(FirstUseTakeover, {
    global: { plugins: [i18n] },
  })
}

describe('FirstUseTakeover start step', () => {
  it('Continue is disabled until the Terms checkbox is checked', async () => {
    const wrapper = mountTakeover()
    const accept = wrapper.find('[data-testid="first-use-continue"]')
    expect(accept.exists()).toBe(true)
    // Initial state: terms unchecked → button disabled.
    expect(accept.attributes('disabled')).toBeDefined()

    // Tick the Terms checkbox.
    const tosCheckbox = wrapper.find(
      '[data-testid="first-use-consent-tos"] input[type="checkbox"]',
    )
    await tosCheckbox.setValue(true)
    expect(accept.attributes('disabled')).toBeUndefined()
  })

  it('clicking the EULA inline link opens the modal with doc="eula"', async () => {
    const wrapper = mountTakeover()
    await wrapper.find('[data-testid="first-use-eula-link"]').trigger('click')
    const modal = wrapper.find('[data-testid="stub-terms-modal"]')
    expect(modal.exists()).toBe(true)
    expect(modal.attributes('data-doc')).toBe('eula')
  })

  it('clicking the Terms of Service inline link opens the modal with doc="tos"', async () => {
    const wrapper = mountTakeover()
    await wrapper.find('[data-testid="first-use-tos-link"]').trigger('click')
    const modal = wrapper.find('[data-testid="stub-terms-modal"]')
    expect(modal.attributes('data-doc')).toBe('tos')
  })

  it('clicking the telemetry Learn-more opens the modal with doc="privacy"', async () => {
    const wrapper = mountTakeover()
    await wrapper.find('[data-testid="first-use-telemetry-learn-more"]').trigger('click')
    const modal = wrapper.find('[data-testid="stub-terms-modal"]')
    expect(modal.attributes('data-doc')).toBe('privacy')
  })

  it('Cloud (i) icon is wrapped in TooltipWrap carrying the whyTryCloud copy', () => {
    const wrapper = mountTakeover()
    const infoBtn = wrapper.find('[data-testid="first-use-why-cloud"]')
    expect(infoBtn.exists()).toBe(true)
    const tooltip = infoBtn.element.closest(
      '[data-testid="stub-tooltip-wrap"]',
    ) as HTMLElement | null
    expect(tooltip).not.toBeNull()
    expect(tooltip?.getAttribute('data-text')).toBe('firstUse.whyTryCloud')
  })

  it('closing the terms modal clears termsDoc (modal unmounts)', async () => {
    const wrapper = mountTakeover()
    await wrapper.find('[data-testid="first-use-eula-link"]').trigger('click')
    const stub = wrapper.findComponent('[data-testid="stub-terms-modal"]')
    expect(stub.exists()).toBe(true)

    // The parent listens for the TermsModal's `close` emit and clears
    // termsDoc to null, which unmounts the v-if-gated modal.
    await stub.vm.$emit('close')
    expect(wrapper.find('[data-testid="stub-terms-modal"]').exists()).toBe(false)
  })
})
