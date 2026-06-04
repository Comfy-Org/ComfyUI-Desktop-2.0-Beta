import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import TermsModal from './TermsModal.vue'
import { LEGAL_DOCS, type LegalDocId } from '../lib/legalDocs'

/**
 * `TermsModal` renders all four legal docs. Contract: the `doc` prop routes to
 * the matching `LEGAL_DOCS` entry, title/meta resolve from it, and `close`
 * emits on ESC / ✕ / overlay. Crossed routing = wrong doc (legal regression).
 */

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      firstUse: {
        eulaModalTitle: 'End-User License Agreement',
        tosModalTitle: 'Terms of Service',
        privacyModalTitle: 'Privacy Policy',
        noticesModalTitle: 'Third-Party Notices',
        legalDocEffective: 'Effective',
        legalDocAppliesTo: 'Applies to',
      },
      common: { close: 'Close' },
    },
  },
  missingWarn: false,
  fallbackWarn: false,
})

function mountModal(doc?: LegalDocId) {
  return mount(TermsModal, {
    props: doc ? { doc } : {},
    global: {
      plugins: [i18n],
      // Stub Teleport so content renders inside the wrapper for assertions.
      stubs: { Teleport: { template: '<div><slot /></div>' } },
    },
  })
}

describe('TermsModal', () => {
  it.each<[LegalDocId, string]>([
    ['eula', 'End-User License Agreement'],
    ['tos', 'Terms of Service'],
    ['privacy', 'Privacy Policy'],
    ['notices', 'Third-Party Notices'],
  ])('renders the correct title and meta for doc="%s"', (doc, expectedTitle) => {
    const wrapper = mountModal(doc)
    expect(wrapper.find('.terms-title').text()).toBe(expectedTitle)
    const meta = wrapper.find('.terms-meta').text()
    expect(meta).toContain(LEGAL_DOCS[doc].effectiveDate)
    expect(meta).toContain(LEGAL_DOCS[doc].appliesTo)
  })

  it('defaults to the privacy doc when no `doc` prop is supplied', () => {
    const wrapper = mountModal()
    expect(wrapper.find('.terms-title').text()).toBe('Privacy Policy')
  })

  it('emits `close` when the ✕ button is clicked', async () => {
    const wrapper = mountModal('eula')
    // ✕ now lives on the BaseModal primitive.
    await wrapper.find('[data-testid="base-modal-close"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('renders block content from the routed doc (not from a stale fallback)', () => {
    // EULA §1 is "Definitions", ToS §1 is "Acceptance" — assert each shows its own.
    const eulaText = mountModal('eula').find('.terms-body').text()
    const tosText = mountModal('tos').find('.terms-body').text()
    expect(eulaText).toContain('1. Definitions')
    expect(eulaText).not.toContain('1. Acceptance')
    expect(tosText).toContain('1. Acceptance')
    expect(tosText).not.toContain('1. Definitions')
  })
})
