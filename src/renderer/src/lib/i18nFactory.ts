import { createI18n } from 'vue-i18n'
import { en } from './i18nMessages'

/**
 * Single-source factory for vue-i18n setup. Every renderer (launcher,
 * panel, title-bar, title-popup) calls this so the resolved keyset
 * stays identical across webContents.
 *
 * `missingWarn` / `fallbackWarn` are off because the catalog is
 * authoritative — any missing key would render its dotted path as a
 * fallback (the regression that motivated issue #531). With keys
 * present those warnings would only fire from typos in calling code.
 *
 * Return type intentionally inferred — annotating it as
 * `ReturnType<typeof createI18n>` collapses the legacy / composition-
 * mode signatures into a union that breaks callers' `useI18n().t()`
 * narrowing.
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
