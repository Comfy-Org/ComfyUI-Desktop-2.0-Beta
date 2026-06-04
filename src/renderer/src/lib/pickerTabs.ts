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

/** Coerce an untrusted tab id to a known picker tab, or `fallback`. */
export function resolvePickerTab(
  tab: string | null | undefined,
  fallback: PickerTab,
): PickerTab {
  return isPickerTab(tab) ? tab : fallback
}
