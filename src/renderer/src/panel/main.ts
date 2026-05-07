import '../assets/main.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import PanelApp from './PanelApp.vue'
import { i18n } from '../i18n'
import { initializeRendererBootstrap } from '../lib/rendererBootstrap'

// Phase 3 — the panel renderer is the primary renderer entry-point now
// that the launcher window is retired. Run the renderer-side telemetry
// / error-reporting bootstrap here so the chooser host (and any other
// host window that mounts panel.html) wires up Datadog / PostHog / the
// renderer-side error hooks the launcher window's main.ts used to.
initializeRendererBootstrap()

const app = createApp(PanelApp)
app.use(createPinia())
app.use(i18n)
app.mount('#app')
