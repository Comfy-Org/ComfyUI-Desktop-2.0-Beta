import { describe, expect, it } from 'vitest'
import {
  EULA,
  LEGAL_DOCS,
  PRIVACY_POLICY,
  THIRD_PARTY_NOTICES,
  TOS,
  type LegalDocId,
} from './legalDocs'

describe('LEGAL_DOCS', () => {
  const ids: LegalDocId[] = ['eula', 'tos', 'privacy', 'notices']

  it.each(ids)('has an entry for "%s"', (id) => {
    const doc = LEGAL_DOCS[id]
    expect(doc).toBeDefined()
    expect(doc.effectiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(doc.appliesTo).toContain('Comfy Desktop')
    expect(doc.blocks.length).toBeGreaterThan(0)
  })

  it('individual named exports are the same objects as the map entries', () => {
    expect(LEGAL_DOCS.eula).toBe(EULA)
    expect(LEGAL_DOCS.tos).toBe(TOS)
    expect(LEGAL_DOCS.privacy).toBe(PRIVACY_POLICY)
    expect(LEGAL_DOCS.notices).toBe(THIRD_PARTY_NOTICES)
  })

  it('no doc body still claims "anonymous" data collection', () => {
    // Data stops being anonymous once the user signs in to Comfy Cloud.
    for (const id of ids) {
      for (const block of LEGAL_DOCS[id].blocks) {
        const body = block.text ?? block.items?.join(' ') ?? ''
        expect(body.toLowerCase()).not.toMatch(/\banonymous\b/)
      }
    }
  })
})
