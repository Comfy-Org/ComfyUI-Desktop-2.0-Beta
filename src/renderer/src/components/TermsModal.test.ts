import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import TermsModal from './TermsModal.vue'
import { LEGAL_DOCS, type LegalDocId } from '../lib/legalDocs'

/**
 * `TermsModal` is the single shared component used to render all four
 * legal docs from the consent screen's Learn-more links. The contract:
 *   - the `doc` prop routes to the matching `LEGAL_DOCS` entry
 *   - the modal title resolves to the matching i18n key
 *   - the meta header shows the doc's effectiveDate and appliesTo
 *   - `close` emits on ESC / ✕ button / overlay click
 *
 * If any of these routing wires get crossed, the user sees the wrong
 * document for the link they clicked — a legal-correctness regression.
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
      // Stub `<Teleport to="body">` so the panel actually renders inside
      // the wrapper for assertions; otherwise the content lives on
      // document.body and findAll won't see it.
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
    // The EULA's §1 is "Definitions"; the ToS's §1 is "Acceptance".
    // If the doc prop routing breaks, an EULA modal would show ToS
    // content (or vice versa) — assert each shows its own §1 heading.
    const eulaText = mountModal('eula').find('.terms-body').text()
    const tosText = mountModal('tos').find('.terms-body').text()
    expect(eulaText).toContain('1. Definitions')
    expect(eulaText).not.toContain('1. Acceptance')
    expect(tosText).toContain('1. Acceptance')
    expect(tosText).not.toContain('1. Definitions')
  })
})
