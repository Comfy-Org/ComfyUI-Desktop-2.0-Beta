import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, ref } from 'vue'
import { createI18n } from 'vue-i18n'

import { useInstallList } from './useInstallList'
import type { Installation } from '../types/ipc'

const messages = {
  en: {
    dashboard: {
      launchedAgo: 'Launched {time}',
      neverLaunched: 'Not launched yet',
    },
  },
}

function makeInstall(overrides: Partial<Installation>): Installation {
  return {
    id: 'inst-x',
    name: 'X',
    sourceLabel: 'Standalone',
    sourceCategory: 'local',
    ...overrides,
  } as unknown as Installation
}

describe('useInstallList', () => {
  // Re-use a single i18n instance across tests — useI18n() needs an
  // installed plugin in the active Vue scope.
  let i18n: ReturnType<typeof createI18n>

  beforeEach(() => {
    i18n = createI18n({ legacy: false, locale: 'en', messages })
    // Activate i18n globally so useI18n() resolves outside of a
    // component's setup. vue-i18n's composition mode reads from the
    // injected scope; mimicking with createApp + use is the canonical
    // workaround for testing composables that depend on it.
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('cloud vs non-cloud split', () => {
    it('separates the single cloud install from the non-cloud list', () => {
      const installations = ref<Installation[]>([
        makeInstall({ id: 'a', name: 'Local A', sourceCategory: 'local' }),
        makeInstall({ id: 'c', name: 'Cloud', sourceCategory: 'cloud' }),
        makeInstall({ id: 'r', name: 'Remote', sourceCategory: 'remote' }),
      ])
      const list = withI18nScope(i18n, () => useInstallList({ installations }))

      expect(list.cloudInstall.value?.id).toBe('c')
      expect(list.nonCloudInstalls.value.map((i) => i.id)).toEqual(['a', 'r'])
    })

    it('reports null cloudInstall when none present', () => {
      const installations = ref<Installation[]>([
        makeInstall({ id: 'a', sourceCategory: 'local' }),
      ])
      const list = withI18nScope(i18n, () => useInstallList({ installations }))

      expect(list.cloudInstall.value).toBeNull()
    })
  })

  describe('recency sort', () => {
    it('orders by lastLaunchedAt desc with never-launched at the end', () => {
      const installations = ref<Installation[]>([
        makeInstall({ id: 'old', name: 'Old', lastLaunchedAt: 100 }),
        makeInstall({ id: 'new', name: 'New', lastLaunchedAt: 500 }),
        makeInstall({ id: 'never', name: 'Never' }),
        makeInstall({ id: 'mid', name: 'Mid', lastLaunchedAt: 300 }),
      ])
      const list = withI18nScope(i18n, () => useInstallList({ installations }))

      expect(list.visibleInstalls.value.map((i) => i.id)).toEqual([
        'new',
        'mid',
        'old',
        'never',
      ])
    })
  })

  describe('filter chips', () => {
    it('local filter includes both local and desktop sourceCategory', () => {
      const installations = ref<Installation[]>([
        makeInstall({ id: 'l', sourceCategory: 'local' }),
        makeInstall({ id: 'd', sourceCategory: 'desktop' }),
        makeInstall({ id: 'r', sourceCategory: 'remote' }),
      ])
      const list = withI18nScope(i18n, () => useInstallList({ installations }))

      list.activeFilter.value = 'local'
      expect(list.visibleInstalls.value.map((i) => i.id).sort()).toEqual(['d', 'l'])
    })

    it('remote filter keeps only remote', () => {
      const installations = ref<Installation[]>([
        makeInstall({ id: 'l', sourceCategory: 'local' }),
        makeInstall({ id: 'r', sourceCategory: 'remote' }),
      ])
      const list = withI18nScope(i18n, () => useInstallList({ installations }))

      list.activeFilter.value = 'remote'
      expect(list.visibleInstalls.value.map((i) => i.id)).toEqual(['r'])
    })

    it('cloud filter empties visibleInstalls (Cloud is rendered separately)', () => {
      const installations = ref<Installation[]>([
        makeInstall({ id: 'l', sourceCategory: 'local' }),
        makeInstall({ id: 'c', sourceCategory: 'cloud' }),
      ])
      const list = withI18nScope(i18n, () => useInstallList({ installations }))

      list.activeFilter.value = 'cloud'
      expect(list.visibleInstalls.value).toEqual([])
    })

    it('all filter shows every non-cloud install', () => {
      const installations = ref<Installation[]>([
        makeInstall({ id: 'l', sourceCategory: 'local' }),
        makeInstall({ id: 'r', sourceCategory: 'remote' }),
        makeInstall({ id: 'd', sourceCategory: 'desktop' }),
        makeInstall({ id: 'c', sourceCategory: 'cloud' }),
      ])
      const list = withI18nScope(i18n, () => useInstallList({ installations }))

      // 'all' is the default.
      expect(list.visibleInstalls.value.map((i) => i.id).sort()).toEqual(['d', 'l', 'r'])
    })
  })

  describe('search query', () => {
    it('returns all entries when query is empty', () => {
      const installations = ref<Installation[]>([
        makeInstall({ id: 'a', name: 'Alpha' }),
        makeInstall({ id: 'b', name: 'Beta' }),
      ])
      const list = withI18nScope(i18n, () => useInstallList({ installations }))

      expect(list.visibleInstalls.value.length).toBe(2)
    })

    it('filters visibleInstalls by fuzzy name match', () => {
      const installations = ref<Installation[]>([
        makeInstall({ id: 'a', name: 'Alpha' }),
        makeInstall({ id: 'b', name: 'Bravo' }),
      ])
      const list = withI18nScope(i18n, () => useInstallList({ installations }))

      list.searchQuery.value = 'alph'
      expect(list.visibleInstalls.value.map((i) => i.id)).toEqual(['a'])
    })

    it('matchesQuery is case-insensitive', () => {
      const installations = ref<Installation[]>([])
      const list = withI18nScope(i18n, () => useInstallList({ installations }))

      list.searchQuery.value = 'COMFY'
      expect(list.matchesQuery('Comfy UI')).toBe(true)
      expect(list.matchesQuery('totally unrelated')).toBe(false)
    })

    it('treats whitespace-only queries as empty', () => {
      const installations = ref<Installation[]>([
        makeInstall({ id: 'a', name: 'Alpha' }),
      ])
      const list = withI18nScope(i18n, () => useInstallList({ installations }))

      list.searchQuery.value = '   '
      expect(list.matchesQuery('xyz')).toBe(true)
      expect(list.visibleInstalls.value.length).toBe(1)
    })
  })

  describe('showCloudCard', () => {
    it('shows the cloud CTA when no cloud install exists and no query', () => {
      const installations = ref<Installation[]>([])
      const list = withI18nScope(i18n, () => useInstallList({ installations }))

      expect(list.showCloudCard.value).toBe(true)
    })

    it('hides the cloud CTA once the user starts typing (when no cloud install exists)', () => {
      const installations = ref<Installation[]>([])
      const list = withI18nScope(i18n, () => useInstallList({ installations }))

      list.searchQuery.value = 'foo'
      expect(list.showCloudCard.value).toBe(false)
    })

    it('keeps the cloud card visible when a real cloud install matches the query', () => {
      const installations = ref<Installation[]>([
        makeInstall({ id: 'c', name: 'My Cloud', sourceCategory: 'cloud' }),
      ])
      const list = withI18nScope(i18n, () => useInstallList({ installations }))

      list.searchQuery.value = 'cloud'
      expect(list.showCloudCard.value).toBe(true)
    })

    it('hides the cloud card when a real cloud install does NOT match the query', () => {
      const installations = ref<Installation[]>([
        makeInstall({ id: 'c', name: 'My Cloud', sourceCategory: 'cloud' }),
      ])
      const list = withI18nScope(i18n, () => useInstallList({ installations }))

      list.searchQuery.value = 'zzzzzzz'
      expect(list.showCloudCard.value).toBe(false)
    })

    it('hides the cloud card when the active filter excludes cloud', () => {
      const installations = ref<Installation[]>([
        makeInstall({ id: 'c', sourceCategory: 'cloud' }),
      ])
      const list = withI18nScope(i18n, () => useInstallList({ installations }))

      list.activeFilter.value = 'local'
      expect(list.showCloudCard.value).toBe(false)
    })
  })

  describe('showEmptyHint', () => {
    it('hides when the user has not typed anything', () => {
      const installations = ref<Installation[]>([])
      const list = withI18nScope(i18n, () => useInstallList({ installations }))

      expect(list.showEmptyHint.value).toBe(false)
    })

    it('shows when query is non-empty AND no installs match AND cloud card is hidden', () => {
      const installations = ref<Installation[]>([
        makeInstall({ id: 'a', name: 'Alpha' }),
      ])
      const list = withI18nScope(i18n, () => useInstallList({ installations }))

      list.searchQuery.value = 'zzzz'
      expect(list.showEmptyHint.value).toBe(true)
    })

    it('hides when the cloud card is still visible (its match counts as a result)', () => {
      const installations = ref<Installation[]>([
        makeInstall({ id: 'c', name: 'Comfy Cloud', sourceCategory: 'cloud' }),
      ])
      const list = withI18nScope(i18n, () => useInstallList({ installations }))

      list.searchQuery.value = 'cloud'
      expect(list.showEmptyHint.value).toBe(false)
    })
  })

  describe('lastLaunchedLabel', () => {
    it('returns the neverLaunched string when lastLaunchedAt is undefined', () => {
      const installations = ref<Installation[]>([])
      const list = withI18nScope(i18n, () => useInstallList({ installations }))

      const inst = makeInstall({ id: 'a' })
      expect(list.lastLaunchedLabel(inst)).toBe('Not launched yet')
    })

    it('formats sub-minute timestamps as "just now"', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-05-18T12:00:00Z'))
      const installations = ref<Installation[]>([])
      const list = withI18nScope(i18n, () => useInstallList({ installations }))

      const inst = makeInstall({ id: 'a', lastLaunchedAt: Date.now() - 30_000 })
      expect(list.lastLaunchedLabel(inst)).toBe('Launched just now')
    })

    it('formats sub-hour timestamps as "Nm ago"', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-05-18T12:00:00Z'))
      const installations = ref<Installation[]>([])
      const list = withI18nScope(i18n, () => useInstallList({ installations }))

      const inst = makeInstall({ id: 'a', lastLaunchedAt: Date.now() - 17 * 60_000 })
      expect(list.lastLaunchedLabel(inst)).toBe('Launched 17m ago')
    })

    it('formats sub-day timestamps as "Nh ago"', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-05-18T12:00:00Z'))
      const installations = ref<Installation[]>([])
      const list = withI18nScope(i18n, () => useInstallList({ installations }))

      const inst = makeInstall({ id: 'a', lastLaunchedAt: Date.now() - 3 * 3_600_000 })
      expect(list.lastLaunchedLabel(inst)).toBe('Launched 3h ago')
    })

    it('formats older timestamps as "Nd ago"', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-05-18T12:00:00Z'))
      const installations = ref<Installation[]>([])
      const list = withI18nScope(i18n, () => useInstallList({ installations }))

      const inst = makeInstall({ id: 'a', lastLaunchedAt: Date.now() - 5 * 86_400_000 })
      expect(list.lastLaunchedLabel(inst)).toBe('Launched 5d ago')
    })
  })

  describe('reactivity', () => {
    it('updates visibleInstalls when the input installations ref changes', () => {
      const installations = ref<Installation[]>([
        makeInstall({ id: 'a', sourceCategory: 'local' }),
      ])
      const list = withI18nScope(i18n, () => useInstallList({ installations }))

      expect(list.visibleInstalls.value.length).toBe(1)
      installations.value = [
        makeInstall({ id: 'a', sourceCategory: 'local' }),
        makeInstall({ id: 'b', sourceCategory: 'local' }),
      ]
      expect(list.visibleInstalls.value.length).toBe(2)
    })

    it('keeps cloud install reactive to input changes', () => {
      const installations = ref<Installation[]>([])
      const list = withI18nScope(i18n, () => useInstallList({ installations }))

      expect(list.cloudInstall.value).toBeNull()
      installations.value = [makeInstall({ id: 'c', sourceCategory: 'cloud' })]
      expect(list.cloudInstall.value?.id).toBe('c')
    })
  })
})

/**
 * vue-i18n's composition mode needs an active app scope to install its
 * provide / inject pair. For composables that only call `useI18n()` for
 * `t()`, the minimal shim is to install the plugin into a transient
 * effectScope-equivalent by running the composable through a stub Vue app.
 * `createApp(...).runWithContext(fn)` would be ideal but vitest's jsdom
 * env makes `mount`-style helpers heavier than needed. Instead we install
 * a stub component that captures the composable's return value.
 */
function withI18nScope<T>(
  i18n: ReturnType<typeof createI18n>,
  fn: () => T,
): T {
  let captured!: T
  const App = defineComponent({
    setup() {
      captured = fn()
      return () => h('div')
    },
  })
  const app = createApp(App)
  app.use(i18n)
  // jsdom provides a document.body; mount + immediately unmount.
  const host = document.createElement('div')
  app.mount(host)
  app.unmount()
  return captured
}
