/**
 * Legal documents bundled at build time from `docs/legal/*.md`. Vite's
 * `?raw` import gives us the markdown source as a string — single source
 * of truth, no TS-structured duplicate to keep in sync.
 *
 * The consent screen renders these via `MarkdownDoc.vue`; the docs
 * themselves are the canonical text users agree to.
 */

import eulaMarkdown from '../../../../docs/legal/EULA.md?raw'
import privacyMarkdown from '../../../../docs/legal/PRIVACY_POLICY.md?raw'
import noticesMarkdown from '../../../../docs/legal/THIRD_PARTY_NOTICES.md?raw'

export type LegalDocId = 'eula' | 'privacy' | 'notices'

export interface LegalDoc {
  id: LegalDocId
  /** i18n key for the tab label. */
  labelKey: string
  markdown: string
}

export const LEGAL_DOCS = [
  { id: 'eula', labelKey: 'firstUse.legalTabEula', markdown: eulaMarkdown },
  { id: 'privacy', labelKey: 'firstUse.legalTabPrivacy', markdown: privacyMarkdown },
  { id: 'notices', labelKey: 'firstUse.legalTabNotices', markdown: noticesMarkdown },
] as const satisfies readonly LegalDoc[]

/** Default tab — EULA is the document the user is affirmatively
 *  agreeing to when they click Accept, so it's the right landing page. */
export const DEFAULT_LEGAL_DOC: LegalDoc = LEGAL_DOCS[0]
