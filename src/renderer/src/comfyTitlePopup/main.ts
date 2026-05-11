// Pull in the same Inter font + design tokens (--surface, --border,
// --text-muted, etc.) as the launcher / panel / title-bar renderers so
// the popup is visually consistent with the rest of Desktop 2.0.
import '../assets/main.css'

import { createApp } from 'vue'
import TitlePopupApp from './TitlePopupApp.vue'
import { createAppI18n } from '../lib/i18nFactory'

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

// Per-renderer vue-i18n instance — every webContents needs its own.
// The shared factory (`lib/i18nFactory.ts`) keeps the keyset identical
// across the launcher / panel / title-bar / title-popup renderers.
createApp(TitlePopupApp).use(createAppI18n()).mount('#app')
