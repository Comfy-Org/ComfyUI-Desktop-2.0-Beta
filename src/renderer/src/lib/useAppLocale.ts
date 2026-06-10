import { onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'

type Messages = Record<string, unknown>

/**
 * Where a renderer pulls locale from. Panel/title-bar use `window.api`;
 * the popup uses its own bridge. `subscribe` is optional — surfaces that
 * can't receive live `locale-changed` (the popup) just omit it.
 */
export interface LocaleSource {
  getLocale(): Promise<string>
  getMessages(): Promise<Messages>
  subscribe?(cb: (payload: { locale: string; messages: Messages }) => void): () => void
}

/**
 * Mirror main's active locale into this renderer's vue-i18n. Main ships the
 * locale already deep-merged onto en, so merging under the real locale key
 * (not always 'en') keeps plural/format rules correct; the bundled en catalog
 * stays as fallbackLocale for untranslated keys.
 *
 * Returns `syncLocale()` so the caller controls timing (the panel parallelises
 * it with store init); live `locale-changed` updates are wired automatically.
 */
export function useAppLocale(source: LocaleSource): { syncLocale: () => Promise<void> } {
  // Global scope so locale/message changes re-render the whole app — a
  // component-scoped composer only updates its own subtree, which is why a
  // language switch appeared to need a restart.
  const { locale, mergeLocaleMessage } = useI18n({ useScope: 'global' })

  function apply(next: string, messages: Messages): void {
    mergeLocaleMessage(next, messages)
    locale.value = next
  }

  const unsubscribe = source.subscribe?.(({ locale: next, messages }) => apply(next, messages))
  onUnmounted(() => unsubscribe?.())

  async function syncLocale(): Promise<void> {
    const [activeLocale, messages] = await Promise.all([
      source.getLocale(),
      source.getMessages()
    ])
    apply(activeLocale, messages)
  }

  return { syncLocale }
}

/**
 * Locale source backed by the standard `window.api` bridge (panel, title bar).
 * Degrades to the bundled en catalog if the bridge is absent (e.g. unit tests),
 * so a missing api never breaks component mount.
 */
export function windowApiLocaleSource(): LocaleSource {
  const api = window.api as Partial<typeof window.api> | undefined
  return {
    getLocale: () => api?.getLocale?.() ?? Promise.resolve('en'),
    getMessages: () => api?.getLocaleMessages?.() ?? Promise.resolve({}),
    subscribe: (cb) => api?.onLocaleChanged?.(cb) ?? (() => {})
  }
}
