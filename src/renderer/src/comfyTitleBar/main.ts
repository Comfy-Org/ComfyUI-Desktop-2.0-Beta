// Same font + design tokens as the other renderers, for visual consistency.
import '../assets/main.css'
import { loadProprietaryFonts } from '../assets/proprietaryFonts'

import { createApp } from 'vue'
import TitleBarApp from './TitleBarApp.vue'
import { initializeRendererBootstrap } from '../lib/rendererBootstrap'
import { createAppI18n } from '../lib/i18nFactory'

// The title bar survives mode flips (unlike the panel renderer), so bootstrapping
// telemetry here is what makes RUM/PostHog see steady-state ComfyUI sessions. Main
// also relays its own events to this renderer so they reach RUM too.
initializeRendererBootstrap('title-bar')

// Default to dark before mount so design tokens resolve immediately; only matters for
// the brief moment before main's first theme push.
document.documentElement.setAttribute('data-theme', 'dark')

// webContents are isolated JS contexts, so each renderer needs its own vue-i18n
// instance; the shared factory keeps them on the same en catalog.
loadProprietaryFonts()

createApp(TitleBarApp).use(createAppI18n()).mount('#app')
