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
  visibleInstalls: ComputedRef<Installation[]>
  showEmptyHint: ComputedRef<boolean>
  matchesQuery: (name: string) => boolean
  lastLaunchedLabel: (inst: Installation) => string
  /** Compact recency for tight picker rows — `3h ago`, not `Launched 3h ago`. */
  lastLaunchedShortLabel: (inst: Installation) => string
}

// Shared install-list state for the dashboard and the instance picker.
// Pure-data (no Pinia/DOM); cloud is folded into the same recency-sorted
// list as every other install. Owns a 60s `now` tick so relative time
// labels stay fresh.
//
// The `hideCloudFromPicker` setting is read on mount and refreshed on
// any settings broadcast — toggling Global Settings filters cloud out
// without requiring a window reopen.
export function useInstallList(opts: UseInstallListOpts): UseInstallListApi {
  const { t } = useI18n()
  const { installations } = opts

  const searchQuery = ref('')
  const activeFilter = ref<FilterKey>('all')
  // Mirrors the `hideCloudFromPicker` setting. Starts `false` so cloud
  // renders by default while the initial IPC fetch is in flight and in
  // test/preload environments where the bridge isn't available.
  const hideCloudFromPicker = ref<boolean>(false)

  function matchesQuery(name: string): boolean {
    const q = searchQuery.value.trim().toLowerCase()
    if (!q) return true
    return scoreName(q, name.toLowerCase()) > 0
  }

  function sortByRecency(a: Installation, b: Installation): number {
    const ta = typeof a.lastLaunchedAt === 'number' ? a.lastLaunchedAt : -Infinity
    const tb = typeof b.lastLaunchedAt === 'number' ? b.lastLaunchedAt : -Infinity
    return tb - ta
  }

  const effectiveInstalls = computed<Installation[]>(() =>
    hideCloudFromPicker.value
      ? installations.value.filter((i) => i.sourceCategory !== 'cloud')
      : installations.value,
  )

  const visibleInstalls = computed<Installation[]>(() => {
    const sorted = [...effectiveInstalls.value].sort(sortByRecency)
    const byCategory = (() => {
      switch (activeFilter.value) {
        case 'all':
          return sorted
        case 'local':
          return sorted.filter((i) => i.sourceCategory === 'local')
        case 'remote':
          return sorted.filter((i) => i.sourceCategory === 'remote')
        case 'cloud':
          return sorted.filter((i) => i.sourceCategory === 'cloud')
        default:
          return sorted
      }
    })()
    return byCategory.filter((i) => matchesQuery(i.name))
  })

  const showEmptyHint = computed<boolean>(
    () =>
      !!searchQuery.value.trim() &&
      visibleInstalls.value.length === 0,
  )

  // 60-second tick so "Nm ago" / "Nh ago" labels stay fresh.
  const now = ref(Date.now())
  let nowTimer: ReturnType<typeof setInterval> | null = null
  // Live updates: any setting change on main broadcasts here, so the
  // dashboard re-fetches `hideCloudFromPicker` without the user having to
  // close + reopen the window after toggling in Global Settings.
  let unsubSettingsChanged: (() => void) | null = null

  const refetchHideCloud = async (): Promise<void> => {
    try {
      const value = await window.api.getSetting('hideCloudFromPicker')
      hideCloudFromPicker.value = value === true
    } catch {
      hideCloudFromPicker.value = false
    }
  }

  onMounted(() => {
    nowTimer = setInterval(() => {
      now.value = Date.now()
    }, 60_000)
    // Best-effort initial read. Failures resolve to `false` so Cloud
    // renders by default — never silently hide on a missing IPC bridge
    // (e.g. tests or pre-attach mounts).
    void refetchHideCloud()
    // Re-read on any settings broadcast keyed to hideCloudFromPicker so
    // toggling the Global Settings opt-out takes effect immediately on
    // the live dashboard (no close + reopen required).
    try {
      unsubSettingsChanged = window.api.onSettingsChanged((data) => {
        if (data?.key === 'hideCloudFromPicker') void refetchHideCloud()
      })
    } catch {
      // tests / older preloads without the listener: fall back to mount-only
    }
  })
  onBeforeUnmount(() => {
    if (nowTimer) clearInterval(nowTimer)
    if (unsubSettingsChanged) unsubSettingsChanged()
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
    visibleInstalls,
    showEmptyHint,
    matchesQuery,
    lastLaunchedLabel,
    lastLaunchedShortLabel,
  }
}
