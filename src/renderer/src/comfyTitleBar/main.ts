// Pull in the same Inter font + design tokens (--surface, --border,
// --text-muted, etc.) as the launcher and panel renderers so the title bar
// is visually consistent with the rest of Comfy Desktop instead of falling
// back to system fonts and ad-hoc hex values.
import '../assets/main.css'
import { loadProprietaryFonts } from '../assets/proprietaryFonts'

import { createApp } from 'vue'
import TitleBarApp from './TitleBarApp.vue'
import { initializeRendererBootstrap } from '../lib/rendererBootstrap'
import { createAppI18n } from '../lib/i18nFactory'

// The title bar is loaded for every host window and survives mode flips
// (it lives in `createHostWindow()`), unlike the panel renderer which
// only mounts in chooser / lifecycle modes. Initialising the telemetry
// bootstrap here is what makes Datadog RUM and PostHog Browser see
// steady-state ComfyUI sessions — without this, the panel-only init
// caused most user-time to emit zero telemetry events.
//
// Main also broadcasts its own events to the title-bar renderer (via the
// telemetry-relay-target registry in `main/lib/telemetry.ts`) so
// main-emitted events reach Datadog RUM through this entry-point too.
initializeRendererBootstrap('title-bar')

// Apply the resolved theme as a data-theme attribute on <html> before mount
// so the design-token CSS variables resolve immediately. Default to dark
// since the title bar's background gets overwritten by the comfy theme
// report anyway — this only affects the brief moment before the first
// theme push from main arrives.
document.documentElement.setAttribute('data-theme', 'dark')

// Per-renderer vue-i18n instance — webContents are isolated JS contexts
// so the launcher's i18n instance can't be reused here. The shared
// factory (`lib/i18nFactory.ts`) ensures every renderer resolves keys
// from the same en-locale catalog.
loadProprietaryFonts()

createApp(TitleBarApp).use(createAppI18n()).mount('#app')
