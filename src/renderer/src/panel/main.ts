import '../assets/main.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import PanelApp from './PanelApp.vue'
import { i18n } from '../i18n'
import { initializeRendererBootstrap } from '../lib/rendererBootstrap'
import { registerE2ERendererHooks } from './e2eRendererHooks'

// Renderer-side E2E hooks. Only register when main propagated the
// `e2e=1` URL flag (mirrors the main-side `process.env.E2E === '1'`
// gate). PanelApp's `bindE2EPanelHooks` is the matching opt-in on the
// component side.
if (new URLSearchParams(window.location.search).get('e2e') === '1') {
  registerE2ERendererHooks()
}

const app = createApp(PanelApp)
app.use(createPinia())
app.use(i18n)
app.mount('#app')

document.getElementById('panel-boot-splash')?.remove()

// Telemetry providers + lifecycle subscriptions are not needed for the
// first paint — defer until after Vue mounts so chooser/takeover paint ASAP.
queueMicrotask(() => initializeRendererBootstrap('panel'))
