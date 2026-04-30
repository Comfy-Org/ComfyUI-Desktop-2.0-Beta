import { createTestingPinia } from '@pinia/testing'
import { mount } from '@vue/test-utils'
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

function findButtonByText(wrapper: ReturnType<typeof mount>, text: string) {
  return wrapper.findAll('button').find((b) => b.text().includes(text))
}

describe('MigrationBanner', () => {
  // The default-state UI (Migrate / Skip / telemetry-link) was moved into
  // OnboardingView. The banner now only renders when a migration is actively
  // in progress for this install.

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
