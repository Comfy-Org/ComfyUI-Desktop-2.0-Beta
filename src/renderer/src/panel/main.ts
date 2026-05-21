import '../assets/main.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import PanelApp from './PanelApp.vue'
import { i18n } from '../i18n'
import { initializeRendererBootstrap } from '../lib/rendererBootstrap'

const app = createApp(PanelApp)
app.use(createPinia())
app.use(i18n)
app.mount('#app')

document.getElementById('panel-boot-splash')?.remove()

// Telemetry providers + lifecycle subscriptions are not needed for the
// first paint — defer until after Vue mounts so chooser/takeover paint ASAP.
queueMicrotask(() => initializeRendererBootstrap('panel'))
