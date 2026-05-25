import '../assets/main.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import PanelApp from './PanelApp.vue'
import { i18n } from '../i18n'
import { initializeRendererBootstrap } from '../lib/rendererBootstrap'
import { registerE2ERendererHooks } from './e2eRendererHooks'

// Renderer-side E2E hooks. The helpers expose UI-driving primitives
// (inject a finished failed op, etc.) test code can call via
// `panel.evaluate('window.__e2eRenderer.foo(...)')`. The surface is
// opt-in — production code never references __e2eRenderer, so leaving
// it on the global is a no-op outside the test runner. PanelApp wires
// the helpers to its overlay + progress chain during setup via
// `bindE2EPanelHooks(...)`.
registerE2ERendererHooks()

const app = createApp(PanelApp)
app.use(createPinia())
app.use(i18n)
app.mount('#app')

document.getElementById('panel-boot-splash')?.remove()

// Telemetry providers + lifecycle subscriptions are not needed for the
// first paint — defer until after Vue mounts so chooser/takeover paint ASAP.
queueMicrotask(() => initializeRendererBootstrap('panel'))
