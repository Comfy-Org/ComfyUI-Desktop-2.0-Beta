import { createI18n } from 'vue-i18n'
import { en } from './i18nMessages'

/**
 * Single-source factory for vue-i18n setup, shared by every renderer so the keyset matches.
 * Return type is intentionally inferred — annotating it breaks callers' `useI18n().t()` narrowing.
 */
export function createAppI18n() {
  return createI18n({
    legacy: false,
    locale: 'en',
    fallbackLocale: 'en',
    messages: { en },
    missingWarn: false,
    fallbackWarn: false,
  })
}
