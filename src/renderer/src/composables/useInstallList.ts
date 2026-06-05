import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  type ComputedRef,
  type Ref,
} from 'vue'
import { useI18n } from 'vue-i18n'
import { scoreName } from '../utils/fuzzyMatch'
import type { Installation } from '../types/ipc'

// `local` also covers Legacy Desktop installs (which report
// `sourceCategory === 'local'`); they have no dedicated chip.
export type FilterKey = 'all' | 'local' | 'cloud' | 'remote'

export interface FilterChip {
  key: FilterKey
  labelKey: string
}

// Single-source chip set (render order) shared across surfaces.
export const FILTER_CHIPS: readonly FilterChip[] = [
  { key: 'all', labelKey: 'chooser.filterAll' },
  { key: 'local', labelKey: 'chooser.filterLocal' },
  { key: 'cloud', labelKey: 'chooser.filterCloud' },
  { key: 'remote', labelKey: 'chooser.filterRemote' },
]

export interface UseInstallListOpts {
  /** Source-of-truth install array (store list or pushed snapshot). */
  installations: Ref<Installation[]>
}

export interface UseInstallListApi {
  searchQuery: Ref<string>
  activeFilter: Ref<FilterKey>
  cloudInstall: ComputedRef<Installation | null>
  nonCloudInstalls: ComputedRef<Installation[]>
  visibleInstalls: ComputedRef<Installation[]>
  showCloudCard: ComputedRef<boolean>
  showEmptyHint: ComputedRef<boolean>
  matchesQuery: (name: string) => boolean
  lastLaunchedLabel: (inst: Installation) => string
  /** Compact recency for tight picker rows — `3h ago`, not `Launched 3h ago`. */
  lastLaunchedShortLabel: (inst: Installation) => string
}

// Shared install-list state for the dashboard and the instance picker.
// Pure-data (no IPC/Pinia/DOM); Cloud is always split out as its own surface.
// Owns a 60s `now` tick so relative time labels stay fresh.
export function useInstallList(opts: UseInstallListOpts): UseInstallListApi {
  const { t } = useI18n()
  const { installations } = opts

  const searchQuery = ref('')
  const activeFilter = ref<FilterKey>('all')

  function matchesQuery(name: string): boolean {
    const q = searchQuery.value.trim().toLowerCase()
    if (!q) return true
    return scoreName(q, name.toLowerCase()) > 0
  }

  const cloudInstall = computed<Installation | null>(
    () => installations.value.find((i) => i.sourceCategory === 'cloud') ?? null,
  )

  const nonCloudInstalls = computed<Installation[]>(() =>
    installations.value.filter((i) => i.sourceCategory !== 'cloud'),
  )

  function sortByRecency(a: Installation, b: Installation): number {
    const ta = typeof a.lastLaunchedAt === 'number' ? a.lastLaunchedAt : -Infinity
    const tb = typeof b.lastLaunchedAt === 'number' ? b.lastLaunchedAt : -Infinity
    return tb - ta
  }

  const visibleInstalls = computed<Installation[]>(() => {
    const sorted = [...nonCloudInstalls.value].sort(sortByRecency)
    const byCategory = (() => {
      switch (activeFilter.value) {
        case 'all':
          return sorted
        case 'local':
          return sorted.filter((i) => i.sourceCategory === 'local')
        case 'remote':
          return sorted.filter((i) => i.sourceCategory === 'remote')
        case 'cloud':
          // Cloud installs only appear in the dedicated Cloud surface.
          return []
        default:
          return sorted
      }
    })()
    return byCategory.filter((i) => matchesQuery(i.name))
  })

  const showCloudCard = computed<boolean>(() => {
    const inCategory = activeFilter.value === 'all' || activeFilter.value === 'cloud'
    if (!inCategory) return false
    // When a real cloud install exists, gate visibility on the query —
    // the generic Try-Cloud CTA tile stays visible until the user types
    // anything.
    if (cloudInstall.value) return matchesQuery(cloudInstall.value.name)
    return !searchQuery.value.trim()
  })

  const showEmptyHint = computed<boolean>(
    () =>
      !!searchQuery.value.trim() &&
      visibleInstalls.value.length === 0 &&
      !showCloudCard.value,
  )

  // 60-second tick so "Nm ago" / "Nh ago" labels stay fresh.
  const now = ref(Date.now())
  let nowTimer: ReturnType<typeof setInterval> | null = null
  onMounted(() => {
    nowTimer = setInterval(() => {
      now.value = Date.now()
    }, 60_000)
  })
  onBeforeUnmount(() => {
    if (nowTimer) clearInterval(nowTimer)
  })

  function timeAgo(timestamp: number): string {
    const diff = now.value - timestamp
    const minutes = Math.floor(diff / 60_000)
    if (minutes < 1) return 'Just now'
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    return `${days}d ago`
  }

  function lastLaunchedLabel(inst: Installation): string {
    return typeof inst.lastLaunchedAt === 'number'
      ? t('dashboard.launchedAgo', { time: timeAgo(inst.lastLaunchedAt) })
      : t('dashboard.neverLaunched')
  }

  function lastLaunchedShortLabel(inst: Installation): string {
    return typeof inst.lastLaunchedAt === 'number'
      ? timeAgo(inst.lastLaunchedAt)
      : ''
  }

  return {
    searchQuery,
    activeFilter,
    cloudInstall,
    nonCloudInstalls,
    visibleInstalls,
    showCloudCard,
    showEmptyHint,
    matchesQuery,
    lastLaunchedLabel,
    lastLaunchedShortLabel,
  }
}
