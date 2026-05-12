// Pull in the same Inter font + design tokens (--surface, --border,
// --text-muted, etc.) as the launcher / panel / title-bar renderers so the
// tooltip is visually consistent with the rest of Desktop 2.0.
import '../assets/main.css'

import { createApp } from 'vue'
import TitleTooltipApp from './TitleTooltipApp.vue'

// The title-tooltip popup is a transient surface that shows on hover
// and hides on leave. Initialising Datadog RUM / PostHog Browser here
// would mint a brand-new session every time the user grazes a button —
// high churn, zero telemetry value. So the popup intentionally skips
// renderer bootstrap (matches the title-menu popup's reasoning).
//
// Default to dark — the popup overrides background/text/border inline
// from the theme passed in by main, but `data-theme` still drives any
// fallback CSS variables that haven't been overridden.
document.documentElement.setAttribute('data-theme', 'dark')

createApp(TitleTooltipApp).mount('#app')
