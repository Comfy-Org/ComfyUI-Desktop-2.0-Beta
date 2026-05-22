/** Tabs valid for `openInstancePicker` expanded mode and
 *  `ComfyUISettingsContent`. */
export type PickerTab = 'config' | 'status' | 'update' | 'snapshots'

const PICKER_TABS: ReadonlySet<PickerTab> = new Set([
  'config',
  'status',
  'update',
  'snapshots',
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
