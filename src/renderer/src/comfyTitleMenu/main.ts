// Pull in the same Inter font + design tokens (--surface, --border,
// --text-muted, etc.) as the launcher / panel / title-bar renderers so the
// popup is visually consistent with the rest of Desktop 2.0.
import '../assets/main.css'

import { createApp } from 'vue'
import TitleMenuApp from './TitleMenuApp.vue'

// Default to dark — the popup overrides background/text inline from the
// theme passed in by main, but `data-theme` still drives any fallback CSS
// variables that haven't been overridden.
document.documentElement.setAttribute('data-theme', 'dark')

createApp(TitleMenuApp).mount('#app')
