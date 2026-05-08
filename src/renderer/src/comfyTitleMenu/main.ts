// Pull in the same Inter font + design tokens (--surface, --border,
// --text-muted, etc.) as the launcher / panel / title-bar renderers so the
// popup is visually consistent with the rest of Desktop 2.0.
import '../assets/main.css'

import { createApp } from 'vue'
import TitleMenuApp from './TitleMenuApp.vue'

// The title-menu popup is a transient frameless child BrowserWindow that
// opens for a fraction of a second per user click and closes on item
// selection or dismiss. Initialising Datadog RUM / PostHog Browser here
// would mint a brand-new session for every popup open — high session
// churn, low telemetry value. Menu selections still reach telemetry via
// the main-process IPC handlers they invoke (which capture through
// PostHog Node and forward to Datadog RUM via the title-bar relay
// target), so the popup itself doesn't need its own bootstrap.
//
// Default to dark — the popup overrides background/text inline from the
// theme passed in by main, but `data-theme` still drives any fallback CSS
// variables that haven't been overridden.
document.documentElement.setAttribute('data-theme', 'dark')

createApp(TitleMenuApp).mount('#app')
