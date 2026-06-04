// Same font + design tokens as the other renderers, for visual consistency.
import '../assets/main.css'
import { loadProprietaryFonts } from '../assets/proprietaryFonts'

import { createApp } from 'vue'
import SystemModalApp from './SystemModalApp.vue'

// This transient popup would mint a fresh telemetry session per open, so capture
// happens main-side. Default to dark; `data-theme` drives fallback CSS variables not
// overridden by the inline theme main pushes.
document.documentElement.setAttribute('data-theme', 'dark')

// No vue-i18n: main composes the localized strings and pushes them with the spec.
loadProprietaryFonts()

createApp(SystemModalApp).mount('#app')
