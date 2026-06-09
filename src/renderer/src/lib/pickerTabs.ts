export type PickerTab =
  | 'config'
  | 'status'
  | 'update'
  | 'snapshots'
  | 'storage'
  | 'console'

/** Narrowing of `DetailSection.tab`. Uses 'settings' where PickerTab uses 'config'. */
export type SectionTab =
  | 'settings'
  | 'status'
  | 'update'
  | 'snapshots'
  | 'storage'
  | 'console'

const PICKER_TABS: ReadonlySet<PickerTab> = new Set([
  'config',
  'status',
  'update',
  'snapshots',
  'storage',
  'console',
])

export function isPickerTab(tab: string | null | undefined): tab is PickerTab {
  return tab != null && PICKER_TABS.has(tab as PickerTab)
}

/** Instance source categories (mirrors `category` in `src/main/sources/*.ts`). */
export type InstanceCategory = 'local' | 'cloud' | 'remote'

/**
 * Tabs each instance category cannot surface, regardless of backend sections.
 * The Console tab is a live PTY view, so it only makes sense where a local
 * process runs — cloud and remote attach to no shell. This is the single table
 * to scan to see what each instance type shows.
 *
 * Note: cloud also relabels the `config` tab to "Storage" — that's a label
 * swap, not a visibility gate, so it stays local to the component.
 */
const HIDDEN_TABS_BY_CATEGORY: Record<InstanceCategory, ReadonlySet<PickerTab>> = {
  local: new Set(),
  cloud: new Set(['console']),
  remote: new Set(['console']),
}

/** Whether `tab` is permitted for an instance of `category`. Unknown categories
 *  allow everything — backend section-gating still applies downstream. */
export function isTabAllowedForCategory(
  tab: PickerTab,
  category: string | undefined,
): boolean {
  const hidden = HIDDEN_TABS_BY_CATEGORY[category as InstanceCategory]
  return hidden ? !hidden.has(tab) : true
}

/** Coerce an untrusted tab id to a known picker tab, or `fallback`. */
export function resolvePickerTab(
  tab: string | null | undefined,
  fallback: PickerTab,
): PickerTab {
  return isPickerTab(tab) ? tab : fallback
}
