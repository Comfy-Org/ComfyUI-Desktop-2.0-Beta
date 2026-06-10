/**
 * The en catalog, re-exported from `locales/en.json` so renderers seed
 * vue-i18n synchronously at first paint (the popup can't reach main's loader
 * yet). One English source — main reads the same file and layers zh on top.
 */
import en from '@locales/en.json'

export { en }
export type AppLocale = typeof en
