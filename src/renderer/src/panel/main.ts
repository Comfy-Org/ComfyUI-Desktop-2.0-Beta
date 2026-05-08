import '../assets/main.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import PanelApp from './PanelApp.vue'
import { i18n } from '../i18n'
import { initializeRendererBootstrap } from '../lib/rendererBootstrap'

// Run the renderer-side telemetry / error-reporting bootstrap here so the
// chooser host (and any other host window that mounts panel.html) wires up
// Datadog RUM, PostHog Browser, and the renderer-side error hooks. The
// panel role owns install-lifecycle subscriptions (`onComfyExited`,
// `onComfyBootLog`, `onInstanceStarted`) so they don't double-fire when
// the title-bar bootstrap also mounts on the same host window.
initializeRendererBootstrap('panel')

const app = createApp(PanelApp)
app.use(createPinia())
app.use(i18n)
app.mount('#app')
