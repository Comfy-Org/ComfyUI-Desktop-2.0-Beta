// Start-screen tests for FirstUseTakeover. Heavy children are stubbed to focus on the start-step DOM.
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
vi.mock('../components/ui/Tooltip.vue', () => ({
  default: {
    name: 'Tooltip',
    props: ['text', 'side', 'align', 'delayMs', 'disabled'],
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
    detectGPU: vi.fn().mockResolvedValue(null),
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
  it('Continue triggers a nudge shake on the ToS row when terms are not accepted', async () => {
    const wrapper = mountTakeover()
    const tosRow = wrapper.find('[data-testid="first-use-consent-tos"]')
    expect(tosRow.classes()).not.toContain('start-consent-row--nudge')

    await wrapper.find('[data-testid="first-use-continue"]').trigger('click')
    expect(tosRow.classes()).toContain('start-consent-row--nudge')

    // No emit should fire — the click was blocked by the ToS gate.
    expect(wrapper.emitted('complete-cloud')).toBeFalsy()
    expect(wrapper.emitted('chain-local')).toBeFalsy()
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

  it('Express-install checkbox is visible on the default Local pick and hides only when Cloud is picked', async () => {
    const wrapper = mountTakeover()
    // The row stays mounted (reserved layout space, no jump on swap)
    // but is visually + a11y hidden whenever Cloud is the active pick.
    const express = () => wrapper.find('[data-testid="first-use-express-install"]')
    expect(express().exists()).toBe(true)
    expect(express().classes()).not.toContain('start-express--hidden')
    expect(express().attributes('aria-hidden')).toBe('false')

    await wrapper.find('[data-testid="first-use-pick-cloud"]').trigger('click')
    expect(express().classes()).toContain('start-express--hidden')
    expect(express().attributes('aria-hidden')).toBe('true')

    await wrapper.find('[data-testid="first-use-pick-local"]').trigger('click')
    expect(express().classes()).not.toContain('start-express--hidden')
    expect(express().attributes('aria-hidden')).toBe('false')
  })

  it('emits `chain-local` with `express: true` when Local is picked with Express on (no legacy desktop)', async () => {
    const wrapper = mountTakeover()
    // Accept T&C (Continue is gated on it), pick Local, leave Express
    // checked (default), press Continue.
    await wrapper
      .find('[data-testid="first-use-consent-tos"] input[type="checkbox"]')
      .setValue(true)
    await wrapper.find('[data-testid="first-use-pick-local"]').trigger('click')
    await wrapper.find('[data-testid="first-use-continue"]').trigger('click')

    const emitted = wrapper.emitted('chain-local')
    expect(emitted).toBeTruthy()
    expect(emitted![0]).toEqual([{ express: true }])
  })

  it('emits `chain-local` with `express: false` when Express is unticked', async () => {
    const wrapper = mountTakeover()
    await wrapper
      .find('[data-testid="first-use-consent-tos"] input[type="checkbox"]')
      .setValue(true)
    await wrapper.find('[data-testid="first-use-pick-local"]').trigger('click')
    await wrapper
      .find('[data-testid="first-use-express-install"] input[type="checkbox"]')
      .setValue(false)
    await wrapper.find('[data-testid="first-use-continue"]').trigger('click')

    const emitted = wrapper.emitted('chain-local')
    expect(emitted).toBeTruthy()
    expect(emitted![0]).toEqual([{ express: false }])
  })

  it('hasLegacyDesktop + Express OFF + migrate OFF routes to the localBranch sub-step', async () => {
    const wrapper = mountTakeover()
    await (wrapper.vm as unknown as { open: (opts: { hasLegacyDesktop: boolean }) => Promise<void> }).open({
      hasLegacyDesktop: true,
    })
    await wrapper
      .find('[data-testid="first-use-consent-tos"] input[type="checkbox"]')
      .setValue(true)
    await wrapper.find('[data-testid="first-use-pick-local"]').trigger('click')
    await wrapper
      .find('[data-testid="first-use-express-install"] input[type="checkbox"]')
      .setValue(false)
    // Migrate is pre-ticked when legacy is detected; the localBranch
    // fork is only reachable when the user explicitly opts out of
    // BOTH express and migrate-existing.
    await wrapper
      .find('[data-testid="first-use-migrate-existing"] input[type="checkbox"]')
      .setValue(false)
    await wrapper.find('[data-testid="first-use-continue"]').trigger('click')

    // No chain-local fires — the user lands on the localBranch sub-step
    // to make the migrate-vs-fresh decision manually.
    expect(wrapper.emitted('chain-local')).toBeFalsy()
    expect(wrapper.find('[data-testid="first-use-local-migrate"]').exists()).toBe(true)
  })

  it('renders the "Migrate existing install" checkbox only when hasLegacyDesktop is true', async () => {
    const wrapper = mountTakeover()
    // Default open() has hasLegacyDesktop = false — the row is not in
    // the DOM at all (v-if), so no test-id should resolve. With no
    // legacy install detected, no migrate-related affordance is shown
    // anywhere on the start screen.
    expect(wrapper.find('[data-testid="first-use-migrate-existing"]').exists()).toBe(false)
    // After the host plumbs the detected legacy install in, the
    // checkbox mounts as a peer of Express. Visibility is then driven
    // by the Local pick via the hidden-class pattern.
    await (wrapper.vm as unknown as { open: (opts: { hasLegacyDesktop: boolean }) => Promise<void> }).open({
      hasLegacyDesktop: true,
    })
    expect(wrapper.find('[data-testid="first-use-migrate-existing"]').exists()).toBe(true)
  })

  it('routes Local + migrate-existing + Express to `chain-migrate` with express: true', async () => {
    const wrapper = mountTakeover()
    await (wrapper.vm as unknown as { open: (opts: { hasLegacyDesktop: boolean }) => Promise<void> }).open({
      hasLegacyDesktop: true,
    })
    await wrapper
      .find('[data-testid="first-use-consent-tos"] input[type="checkbox"]')
      .setValue(true)
    await wrapper.find('[data-testid="first-use-pick-local"]').trigger('click')
    // Migrate AND Express are both pre-ticked on the legacy-desktop
    // path — just press Continue. The host uses the `express: true`
    // payload to skip the migrate confirm surface and run preview +
    // auto-pick + run straight through.
    await wrapper.find('[data-testid="first-use-continue"]').trigger('click')

    const emitted = wrapper.emitted('chain-migrate')
    expect(emitted).toBeTruthy()
    expect(emitted![0]).toEqual([{ express: true }])
    expect(wrapper.emitted('chain-local')).toBeFalsy()
    expect(wrapper.emitted('complete-cloud')).toBeFalsy()
    expect(wrapper.find('[data-testid="first-use-local-migrate"]').exists()).toBe(false)
  })

  it('routes Local + migrate-existing + Express OFF to `chain-migrate` with express: false (confirm surface still shown by host)', async () => {
    const wrapper = mountTakeover()
    await (wrapper.vm as unknown as { open: (opts: { hasLegacyDesktop: boolean }) => Promise<void> }).open({
      hasLegacyDesktop: true,
    })
    await wrapper
      .find('[data-testid="first-use-consent-tos"] input[type="checkbox"]')
      .setValue(true)
    await wrapper.find('[data-testid="first-use-pick-local"]').trigger('click')
    // Untick Express but leave Migrate on: the user wants migration
    // but with the confirm surface (not the express-skip path).
    await wrapper
      .find('[data-testid="first-use-express-install"] input[type="checkbox"]')
      .setValue(false)
    await wrapper.find('[data-testid="first-use-continue"]').trigger('click')

    const emitted = wrapper.emitted('chain-migrate')
    expect(emitted).toBeTruthy()
    expect(emitted![0]).toEqual([{ express: false }])
  })

  it('routes Local + Express + migrate-existing OFF to `chain-local` (fresh express install)', async () => {
    const wrapper = mountTakeover()
    await (wrapper.vm as unknown as { open: (opts: { hasLegacyDesktop: boolean }) => Promise<void> }).open({
      hasLegacyDesktop: true,
    })
    await wrapper
      .find('[data-testid="first-use-consent-tos"] input[type="checkbox"]')
      .setValue(true)
    await wrapper.find('[data-testid="first-use-pick-local"]').trigger('click')
    // Untick the migrate checkbox: returning user explicitly opts out
    // and wants a clean Standalone install instead.
    await wrapper
      .find('[data-testid="first-use-migrate-existing"] input[type="checkbox"]')
      .setValue(false)
    await wrapper.find('[data-testid="first-use-continue"]').trigger('click')

    expect(wrapper.emitted('chain-migrate')).toBeFalsy()
    const emitted = wrapper.emitted('chain-local')
    expect(emitted).toBeTruthy()
    expect(emitted![0]).toEqual([{ express: true }])
  })

  it('emits `complete-cloud` (not `chain-local`) when the user flips to Cloud and presses Continue', async () => {
    const wrapper = mountTakeover()
    await wrapper
      .find('[data-testid="first-use-consent-tos"] input[type="checkbox"]')
      .setValue(true)
    // Local is the default — flip to Cloud, then Continue.
    await wrapper.find('[data-testid="first-use-pick-cloud"]').trigger('click')
    await wrapper.find('[data-testid="first-use-continue"]').trigger('click')

    expect(wrapper.emitted('complete-cloud')).toBeTruthy()
    expect(wrapper.emitted('chain-local')).toBeFalsy()
  })

  it('Continue button switches to the loading copy + becomes disabled while Continue is in flight', async () => {
    const wrapper = mountTakeover()
    await wrapper
      .find('[data-testid="first-use-consent-tos"] input[type="checkbox"]')
      .setValue(true)
    const btn = wrapper.find('[data-testid="first-use-continue"]')
    expect(btn.text()).toBe('firstUse.startContinue')
    // Click — the express path's emit unmounts in real PanelApp, but in
    // the isolated test we stay mounted, so the busy copy persists.
    await btn.trigger('click')
    expect(btn.text()).toBe('firstUse.startContinueBusy')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.attributes('aria-busy')).toBe('true')
  })

  it('open() resets the Continue spinner so the cancel-and-return path lands on a fresh CTA', async () => {
    // Reproduces the start → uncheck express → Continue → cancel
    // mid-chain → open() again loop. `onContinue()` keeps the spinner
    // flag true past `routePostStart()` (the chain handlers normally
    // unmount), so on a cancel-and-return the host re-invokes open()
    // on the still-mounted instance with a stale `isContinuing=true`
    // — open() must reset it.
    const wrapper = mountTakeover()
    await wrapper
      .find('[data-testid="first-use-consent-tos"] input[type="checkbox"]')
      .setValue(true)
    await wrapper.find('[data-testid="first-use-continue"]').trigger('click')
    // Sanity-check: the Continue button IS in the spinner state right
    // after click (the chain hasn't unmounted in the isolated test).
    const btnBusy = wrapper.find('[data-testid="first-use-continue"]')
    expect(btnBusy.text()).toBe('firstUse.startContinueBusy')
    expect(btnBusy.attributes('disabled')).toBeDefined()

    await (wrapper.vm as unknown as { open: () => Promise<void> }).open()

    const btnFresh = wrapper.find('[data-testid="first-use-continue"]')
    expect(btnFresh.text()).toBe('firstUse.startContinue')
    expect(btnFresh.attributes('disabled')).toBeUndefined()
    expect(btnFresh.attributes('aria-busy')).toBe('false')
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

  it('Continue without touching the picker routes to chain-local (Local is the default)', async () => {
    const wrapper = mountTakeover()
    await wrapper
      .find('[data-testid="first-use-consent-tos"] input[type="checkbox"]')
      .setValue(true)
    await wrapper.find('[data-testid="first-use-continue"]').trigger('click')

    expect(wrapper.emitted('chain-local')).toBeTruthy()
    expect(wrapper.emitted('complete-cloud')).toBeFalsy()
  })
})
