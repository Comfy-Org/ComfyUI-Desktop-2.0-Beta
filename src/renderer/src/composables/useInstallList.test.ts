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
  let i18n: ReturnType<typeof createI18n>

  beforeEach(() => {
    i18n = createI18n({ legacy: false, locale: 'en', messages })
  })

  afterEach(() => {
    vi.useRealTimers()
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

    // Regression: cloud must not jump above an older local install — recency
    // is the only thing that decides order. Before the unpin refactor, cloud
    // lived in its own surface (dashboard) or was tie-break-pinned (picker),
    // both of which broke straight recency ordering.
    it('places a cloud install below a more-recent local install (no cloud pinning)', () => {
      const installations = ref<Installation[]>([
        makeInstall({
          id: 'recent-local',
          name: 'RecentLocal',
          sourceCategory: 'local',
          lastLaunchedAt: 1_000,
        }),
        makeInstall({
          id: 'old-cloud',
          name: 'OldCloud',
          sourceCategory: 'cloud',
          lastLaunchedAt: 100,
        }),
      ])
      const list = withI18nScope(i18n, () => useInstallList({ installations }))

      expect(list.visibleInstalls.value.map((i) => i.id)).toEqual([
        'recent-local',
        'old-cloud',
      ])
    })

    // Tie-break sanity: with equal recency, cloud is no longer pinned ahead
    // of local — order falls back to whatever sort() lands on, which for a
    // stable timsort is input order. The contract is "cloud isn't special",
    // so we just assert both are present and neither got dropped.
    it('does not pin cloud ahead of a same-recency local install', () => {
      const installations = ref<Installation[]>([
        makeInstall({
          id: 'local-tie',
          name: 'LocalTie',
          sourceCategory: 'local',
          lastLaunchedAt: 500,
        }),
        makeInstall({
          id: 'cloud-tie',
          name: 'CloudTie',
          sourceCategory: 'cloud',
          lastLaunchedAt: 500,
        }),
      ])
      const list = withI18nScope(i18n, () => useInstallList({ installations }))

      const ids = list.visibleInstalls.value.map((i) => i.id)
      // Stable sort on a tie keeps the input order; the test guards against
      // a regression that explicitly re-orders cloud to the top.
      expect(ids).toEqual(['local-tie', 'cloud-tie'])
    })
  })

  describe('filter chips', () => {
    it('local filter includes standalone and Legacy Desktop installs (both report category local)', () => {
      const installations = ref<Installation[]>([
        makeInstall({ id: 'l', sourceCategory: 'local' }),
        // Legacy Desktop reports category `local`; sourceId is the marker.
        makeInstall({ id: 'd', sourceCategory: 'local', sourceId: 'desktop' } as Partial<Installation>),
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

    it('cloud filter keeps only cloud installs', () => {
      const installations = ref<Installation[]>([
        makeInstall({ id: 'l', sourceCategory: 'local' }),
        makeInstall({ id: 'c', sourceCategory: 'cloud' }),
      ])
      const list = withI18nScope(i18n, () => useInstallList({ installations }))

      list.activeFilter.value = 'cloud'
      expect(list.visibleInstalls.value.map((i) => i.id)).toEqual(['c'])
    })

    it('all filter shows every install including cloud', () => {
      const installations = ref<Installation[]>([
        makeInstall({ id: 'l', sourceCategory: 'local' }),
        makeInstall({ id: 'r', sourceCategory: 'remote' }),
        // Legacy Desktop reports category `local`; sourceId is the marker.
        makeInstall({ id: 'd', sourceCategory: 'local', sourceId: 'desktop' }),
        makeInstall({ id: 'c', sourceCategory: 'cloud' }),
      ])
      const list = withI18nScope(i18n, () => useInstallList({ installations }))

      // 'all' is the default; cloud is no longer split out of the list.
      expect(list.visibleInstalls.value.map((i) => i.id).sort()).toEqual([
        'c',
        'd',
        'l',
        'r',
      ])
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

    it('search reaches cloud installs too (cloud is in the same list)', () => {
      const installations = ref<Installation[]>([
        makeInstall({ id: 'c', name: 'Comfy Cloud', sourceCategory: 'cloud' }),
        makeInstall({ id: 'l', name: 'Local Box', sourceCategory: 'local' }),
      ])
      const list = withI18nScope(i18n, () => useInstallList({ installations }))

      list.searchQuery.value = 'cloud'
      expect(list.visibleInstalls.value.map((i) => i.id)).toEqual(['c'])
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

  describe('showEmptyHint', () => {
    it('hides when the user has not typed anything', () => {
      const installations = ref<Installation[]>([])
      const list = withI18nScope(i18n, () => useInstallList({ installations }))

      expect(list.showEmptyHint.value).toBe(false)
    })

    it('shows when query is non-empty AND no installs match', () => {
      const installations = ref<Installation[]>([
        makeInstall({ id: 'a', name: 'Alpha' }),
      ])
      const list = withI18nScope(i18n, () => useInstallList({ installations }))

      list.searchQuery.value = 'zzzz'
      expect(list.showEmptyHint.value).toBe(true)
    })

    it('hides when a cloud install matches the query (it counts as a result now)', () => {
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
      expect(list.lastLaunchedLabel(inst)).toBe('Launched Just now')
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

  describe('lastLaunchedShortLabel', () => {
    it('returns an empty string when lastLaunchedAt is undefined', () => {
      const installations = ref<Installation[]>([])
      const list = withI18nScope(i18n, () => useInstallList({ installations }))

      const inst = makeInstall({ id: 'a' })
      expect(list.lastLaunchedShortLabel(inst)).toBe('')
    })

    it('returns only the relative time without the Launched prefix', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-05-18T12:00:00Z'))
      const installations = ref<Installation[]>([])
      const list = withI18nScope(i18n, () => useInstallList({ installations }))

      const inst = makeInstall({ id: 'a', lastLaunchedAt: Date.now() - 3 * 3_600_000 })
      expect(list.lastLaunchedShortLabel(inst)).toBe('3h ago')
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

    it('adds a newly-added cloud install to the same list', () => {
      const installations = ref<Installation[]>([])
      const list = withI18nScope(i18n, () => useInstallList({ installations }))

      expect(list.visibleInstalls.value).toEqual([])
      installations.value = [makeInstall({ id: 'c', sourceCategory: 'cloud' })]
      expect(list.visibleInstalls.value.map((i) => i.id)).toEqual(['c'])
    })
  })
})

/** Runs `fn` inside a stub Vue app with i18n installed, so `useI18n()`
 *  resolves; captures and returns the composable's value. */
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
