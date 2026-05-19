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

/**
 * Category-filter key. `local` covers both standalone local installs
 * and Legacy Desktop installs (`sourceCategory === 'desktop'`) —
 * Legacy Desktop is the pre-2.0 install kind, conceptually the same
 * family as Local from the user's POV. There is no dedicated Desktop
 * chip so the filter row stays compact.
 */
export type FilterKey = 'all' | 'local' | 'cloud' | 'remote'

export interface FilterChip {
  key: FilterKey
  /** vue-i18n key — resolved by each consuming surface against its
   *  own catalog. Both ChooserView and the title-bar instance picker
   *  share the `chooser.*` keys (see `lib/i18nMessages.ts`). */
  labelKey: string
}

/**
 * Single-source filter chip set. Used by both the ChooserView's
 * (currently hidden) chip row and the title-bar instance picker's
 * chip row, so the two surfaces cannot drift. Order is the order
 * chips render left-to-right.
 */
export const FILTER_CHIPS: readonly FilterChip[] = [
  { key: 'all', labelKey: 'chooser.filterAll' },
  { key: 'local', labelKey: 'chooser.filterLocal' },
  { key: 'cloud', labelKey: 'chooser.filterCloud' },
  { key: 'remote', labelKey: 'chooser.filterRemote' },
]

export interface UseInstallListOpts {
  /** The source-of-truth install array. Pass the panel's
   *  `installationStore.installations` from ChooserView, or the
   *  snapshot pushed from main from the instance-picker popover. */
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
}

/**
 * Shared install-list state for the chooser dashboard AND the title-bar
 * instance picker popover. Pure-data composable — no IPC, no Pinia, no
 * DOM. Takes the installation array as a reactive input so the caller
 * controls where the data comes from (Pinia store in the panel, IPC-
 * pushed snapshot in the popover).
 *
 * Owns:
 *   - `searchQuery` + fuzzy `matchesQuery` (shared `scoreName` ranking)
 *   - `activeFilter` (`'all' | 'local' | 'cloud' | 'remote'`) + the
 *     local-includes-desktop grouping rule
 *   - `cloudInstall` vs `nonCloudInstalls` split (Cloud is always
 *     rendered as its own surface, never mixed into the recents list)
 *   - `visibleInstalls` — non-cloud sorted by `lastLaunchedAt` desc
 *     (never-launched at the end), then category-filtered, then
 *     query-filtered
 *   - `showCloudCard` / `showEmptyHint` derived flags
 *   - `lastLaunchedLabel(inst)` formatted via a 1-minute-tick `now`
 *     ref so labels stay fresh while the surface is mounted
 *
 * The 60-second `now` tick is owned here so callers don't each have to
 * manage their own interval; mounting two consumers in parallel is
 * cheap (each owns its own interval, no shared module state) and keeps
 * the composable side-effect-free between mounts.
 */
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
          return sorted.filter(
            (i) => i.sourceCategory === 'local' || i.sourceCategory === 'desktop',
          )
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
    if (minutes < 1) return 'just now'
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
  }
}
