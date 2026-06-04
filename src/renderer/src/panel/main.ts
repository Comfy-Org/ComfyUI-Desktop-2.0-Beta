import '../assets/main.css'
import { loadProprietaryFonts } from '../assets/proprietaryFonts'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import PanelApp from './PanelApp.vue'
import { i18n } from '../i18n'
import { initializeRendererBootstrap } from '../lib/rendererBootstrap'
import { registerE2ERendererHooks } from './e2eRendererHooks'

// Renderer E2E hooks, gated to the `e2e=1` URL flag propagated by main.
if (new URLSearchParams(window.location.search).get('e2e') === '1') {
  registerE2ERendererHooks()
}

loadProprietaryFonts()

const app = createApp(PanelApp)
app.use(createPinia())
app.use(i18n)
app.mount('#app')

document.getElementById('panel-boot-splash')?.remove()

// Defer telemetry bootstrap past first paint so chooser/takeover paint ASAP.
queueMicrotask(() => initializeRendererBootstrap('panel'))
