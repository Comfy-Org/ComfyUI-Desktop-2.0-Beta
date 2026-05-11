import { createAppI18n } from './lib/i18nFactory'

/** Launcher renderer's vue-i18n instance. The title-bar and
 *  title-popup webContents create their own instances via the same
 *  factory so the resolved messages stay consistent across renderers. */
export const i18n = createAppI18n()
