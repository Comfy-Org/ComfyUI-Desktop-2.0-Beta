// Pull in the same Inter font + design tokens (--surface, --border,
// --text-muted, etc.) as the launcher / panel / title-bar renderers so
// the popup is visually consistent with the rest of Comfy Desktop.
import '../assets/main.css'
import { loadProprietaryFonts } from '../assets/proprietaryFonts'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import TitlePopupApp from './TitlePopupApp.vue'
import { createAppI18n } from '../lib/i18nFactory'
import { installPickerSettingsApiShim } from './pickerSettingsApiShim'

// The title-bar dropdown popup is a transient WebContentsView that
// opens for a fraction of a second per user click. Bootstrapping
// Datadog RUM / PostHog Browser here would mint a brand-new session
// per open, so capture happens main-side and forwards to the title-bar
// Datadog RUM session via the relay-target registry in
// `lib/telemetry.ts`.
//
// Default to dark — the popup overrides background/text inline from the
// theme passed in by main, but `data-theme` still drives any fallback CSS
// variables that haven't been overridden.
document.documentElement.setAttribute('data-theme', 'dark')

// Install the picker-settings `window.api` shim BEFORE Vue mounts so
// any module that captures `window.api` at import time (e.g. the
// shared `useComfyUISettings` composable inside `ComfyUISettingsContent`)
// sees the shim populated.
installPickerSettingsApiShim()

// Pinia — the per-install settings UI's `useComfyUISettings` reads
// `useSessionStore.isRunning()` to swap the synthetic Launch→Restart
// action. The popup doesn't subscribe to the full session-lifecycle
// IPC fan-out (no `init()`); instead the picker view hydrates the
// store's `runningInstances` map from the snapshot's
// `runningInstallationIds` whenever a fresh snapshot arrives.
const pinia = createPinia()

// Per-renderer vue-i18n instance — every webContents needs its own.
// The shared factory (`lib/i18nFactory.ts`) keeps the keyset identical
// across the launcher / panel / title-bar / title-popup renderers.
loadProprietaryFonts()

createApp(TitlePopupApp).use(pinia).use(createAppI18n()).mount('#app')
