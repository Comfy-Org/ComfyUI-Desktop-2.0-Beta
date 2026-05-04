// Pull in the same Inter font + design tokens (--surface, --border,
// --text-muted, etc.) as the launcher and panel renderers so the title bar
// is visually consistent with the rest of Desktop 2.0 instead of falling
// back to system fonts and ad-hoc hex values.
import '../assets/main.css'

import { createApp } from 'vue'
import TitleBarApp from './TitleBarApp.vue'

// Apply the resolved theme as a data-theme attribute on <html> before mount
// so the design-token CSS variables resolve immediately. Default to dark
// since the title bar's background gets overwritten by the comfy theme
// report anyway — this only affects the brief moment before the first
// theme push from main arrives.
document.documentElement.setAttribute('data-theme', 'dark')

createApp(TitleBarApp).mount('#app')
