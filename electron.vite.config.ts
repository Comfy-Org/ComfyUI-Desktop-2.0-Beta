import { createRequire } from 'module'
import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

const require = createRequire(import.meta.url)
const { resolveDatadogReleaseVersion } = require('./scripts/datadog-release-version.cjs') as {
  resolveDatadogReleaseVersion: (env?: NodeJS.ProcessEnv) => string
}

if (!process.env.VITE_DATADOG_RUM_VERSION) {
  process.env.VITE_DATADOG_RUM_VERSION = resolveDatadogReleaseVersion(process.env)
}

export default defineConfig({
  main: {
    build: {
      sourcemap: 'hidden',
    },
  },
  preload: {
    build: {
      sourcemap: 'hidden',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          comfyPreload: resolve(__dirname, 'src/preload/comfyPreload.ts'),
          comfyTitleBarPreload: resolve(__dirname, 'src/preload/comfyTitleBarPreload.ts'),
          comfyTitlePopupPreload: resolve(__dirname, 'src/preload/comfyTitlePopupPreload.ts'),
          comfyTitleTooltipPreload: resolve(__dirname, 'src/preload/comfyTitleTooltipPreload.ts'),
          comfySystemModalPreload: resolve(__dirname, 'src/preload/comfySystemModalPreload.ts'),
        },
      },
    },
  },
  renderer: {
    build: {
      sourcemap: 'hidden',
      rollupOptions: {
        input: {
          panel: resolve(__dirname, 'src/renderer/panel.html'),
          comfyTitleBar: resolve(__dirname, 'src/renderer/comfyTitleBar.html'),
          comfyTitlePopup: resolve(__dirname, 'src/renderer/comfyTitlePopup.html'),
          comfyTitleTooltip: resolve(__dirname, 'src/renderer/comfyTitleTooltip.html'),
          comfySystemModal: resolve(__dirname, 'src/renderer/comfySystemModal.html'),
        },
      },
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [vue(), tailwindcss()]
  }
})
