import { config } from '@vue/test-utils'
import { createAppI18n } from './src/renderer/src/lib/i18nFactory'

/**
 * Global vue-i18n plugin for every component mount in unit tests.
 * Mirrors the per-renderer setup in `comfyTitleBar/main.ts`,
 * `comfyTitlePopup/main.ts`, etc. so components that call `useI18n()`
 * resolve keys identically in tests and at runtime — without each
 * test having to thread `global.plugins` through `mount()`.
 */
config.global.plugins = [...(config.global.plugins ?? []), createAppI18n()]
