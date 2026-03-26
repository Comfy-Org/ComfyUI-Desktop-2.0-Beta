import { createTestingPinia } from '@pinia/testing'
import { mount, flushPromises } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import { nextTick } from 'vue'

import type { Installation } from '../types/ipc'

// Stub window.api before any component import (progressStore accesses it at setup time)
vi.stubGlobal('window', {
  ...window,
  api: {
    onErrorDetail: vi.fn(() => vi.fn()),
    runAction: vi.fn().mockResolvedValue({}),
  },
})

vi.mock('../composables/useMigrateAction', () => ({
  useMigrateAction: () => ({
    confirmMigration: vi.fn().mockResolvedValue(null),
  }),
}))

import MigrationBanner from './MigrationBanner.vue'
import { useProgressStore } from '../stores/progressStore'

const messages = {
  en: {
    dashboard: {
      migrateBannerTitle: 'Migrate to Standalone',
      migrateBannerDesc: 'Your Legacy Desktop installation was detected.',
      migrateBannerAction: 'Migrate Now',
      migrateBannerSkip: 'New Install Without Migrating',
      telemetryNotice: 'Anonymous telemetry is collected.',
      telemetrySettings: 'Manage in Settings',
    },
    desktop: { migrating: 'Migrating' },
    progress: { starting: 'Starting…' },
    list: { viewProgress: 'View Progress' },
  },
}

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'en',
    messages,
    missingWarn: false,
    fallbackWarn: false,
  })
}

const stubInstallation: Installation = {
  id: 'test-desktop-1',
  name: 'Legacy Desktop',
  sourceLabel: 'Desktop',
  sourceCategory: 'local',
  sourceId: 'desktop',
}

function mountBanner(pinia = createTestingPinia()) {
  return mount(MigrationBanner, {
    global: { plugins: [createTestI18n(), pinia] },
    props: { installation: stubInstallation },
  })
}

function findButtonByText(wrapper: ReturnType<typeof mount>, text: string) {
  return wrapper.findAll('button').find((b) => b.text().includes(text))
}

describe('MigrationBanner', () => {
  describe('default state (no active operation)', () => {
    it('renders the migrate title and description', () => {
      const wrapper = mountBanner()
      expect(wrapper.text()).toContain('Migrate to Standalone')
      expect(wrapper.text()).toContain('Your Legacy Desktop installation was detected.')
    })

    it('renders the Migrate Now button as primary', () => {
      const wrapper = mountBanner()
      const btn = wrapper.find('button.primary.dashboard-cta-btn')
      expect(btn.exists()).toBe(true)
      expect(btn.text()).toContain('Migrate Now')
    })

    it('renders the New Install Without Migrating button', () => {
      const wrapper = mountBanner()
      const skipBtn = findButtonByText(wrapper, 'New Install Without Migrating')
      expect(skipBtn).toBeDefined()
    })

    it('skip button is not styled as primary', () => {
      const wrapper = mountBanner()
      const skipBtn = findButtonByText(wrapper, 'New Install Without Migrating')!
      expect(skipBtn.classes()).not.toContain('primary')
    })

    it('emits show-quick-install when skip button is clicked', async () => {
      const wrapper = mountBanner()
      const skipBtn = findButtonByText(wrapper, 'New Install Without Migrating')!
      ;(skipBtn.element as HTMLButtonElement).click()
      await nextTick()
      expect(wrapper.emitted('show-quick-install')).toHaveLength(1)
    })

    it('does not emit show-quick-install when Migrate Now is clicked', async () => {
      const wrapper = mountBanner()
      const migrateBtn = findButtonByText(wrapper, 'Migrate Now')!
      ;(migrateBtn.element as HTMLButtonElement).click()
      await flushPromises()
      expect(wrapper.emitted('show-quick-install')).toBeUndefined()
    })

    it('emits show-settings when telemetry link is clicked', async () => {
      const wrapper = mountBanner()
      const link = findButtonByText(wrapper, 'Manage in Settings')!
      ;(link.element as HTMLButtonElement).click()
      await nextTick()
      expect(wrapper.emitted('show-settings')).toHaveLength(1)
    })
  })

  describe('in-progress state', () => {
    function mountWithActiveOp() {
      const pinia = createTestingPinia()
      const wrapper = mount(MigrationBanner, {
        global: { plugins: [createTestI18n(), pinia] },
        props: { installation: stubInstallation },
      })
      // Set the operation directly on the store's reactive Map
      const store = useProgressStore(pinia)
      store.operations.set('test-desktop-1', {
        finished: false,
        error: null,
        output: [],
        progress: null,
        unsubProgress: null,
        unsubOutput: null,
      } as never)
      return { wrapper, pinia }
    }

    it('shows progress UI when an active operation exists', async () => {
      const { wrapper } = mountWithActiveOp()
      await nextTick()
      expect(wrapper.text()).toContain('Migrating')
      expect(wrapper.text()).toContain('View Progress')
    })

    it('hides skip button during migration', async () => {
      const { wrapper } = mountWithActiveOp()
      await nextTick()
      expect(wrapper.text()).not.toContain('New Install Without Migrating')
    })

    it('hides Migrate Now button during migration', async () => {
      const { wrapper } = mountWithActiveOp()
      await nextTick()
      expect(wrapper.text()).not.toContain('Migrate Now')
    })

    it('emits show-progress when View Progress is clicked', async () => {
      const { wrapper } = mountWithActiveOp()
      await nextTick()
      const btn = findButtonByText(wrapper, 'View Progress')!
      ;(btn.element as HTMLButtonElement).click()
      await nextTick()
      expect(wrapper.emitted('show-progress')).toHaveLength(1)
    })
  })
})
