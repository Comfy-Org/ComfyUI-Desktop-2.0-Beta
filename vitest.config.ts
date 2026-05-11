import { resolve } from 'path'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts', 'node_modules'],
    globals: true,
    // Installs the shared vue-i18n plugin into @vue/test-utils'
    // global mount config so components that call `useI18n()` work
    // out of the box in every test file.
    setupFiles: ['./vitest.setup.ts']
  }
})
