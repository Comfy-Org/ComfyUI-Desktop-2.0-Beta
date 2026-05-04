import '../assets/main.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import PanelApp from './PanelApp.vue'
import { i18n } from '../i18n'

const app = createApp(PanelApp)
app.use(createPinia())
app.use(i18n)
app.mount('#app')
