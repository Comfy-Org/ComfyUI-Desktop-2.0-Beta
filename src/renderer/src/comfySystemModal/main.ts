// Pull in the same Inter font + design tokens as the launcher / panel /
// title-bar / title-popup renderers so the system-modal surface is
// visually consistent with the rest of Comfy Desktop.
import '../assets/main.css'
import { loadProprietaryFonts } from '../assets/proprietaryFonts'

import { createApp } from 'vue'
import SystemModalApp from './SystemModalApp.vue'

// The system-modal popup is a transient WebContentsView that opens for
// the duration of a confirm dialog. Bootstrapping Datadog RUM / PostHog
// here would mint a brand-new session per open, so capture happens
// main-side and forwards to the title-bar Datadog RUM session via the
// relay-target registry in `lib/telemetry.ts`.
//
// Default to dark — the modal overrides background/text inline from the
// theme passed in by main, but `data-theme` still drives any fallback
// CSS variables that haven't been overridden.
document.documentElement.setAttribute('data-theme', 'dark')

// No vue-i18n here — main composes localized strings (title / message /
// button labels) and pushes them with the modal spec, so the renderer
// stays a dumb display layer.
loadProprietaryFonts()

createApp(SystemModalApp).mount('#app')
