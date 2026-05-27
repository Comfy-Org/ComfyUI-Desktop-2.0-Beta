/** Tabs valid for `openInstancePicker` expanded mode and
 *  `ComfyUISettingsContent`. */
export type PickerTab = 'config' | 'status' | 'update' | 'snapshots' | 'storage'

/** Tab ids that main-emitted `DetailSection.tab` values are bucketed
 *  into for the per-install settings UI. Distinct namespace from
 *  `PickerTab` (which uses `'config'` where sections use `'settings'`)
 *  — they overlap on `'storage'`. Renderer-only literal narrowing of
 *  the upstream `DetailSection.tab: string`. */
export type SectionTab = 'settings' | 'status' | 'update' | 'snapshots' | 'storage'

const PICKER_TABS: ReadonlySet<PickerTab> = new Set([
  'config',
  'status',
  'update',
  'snapshots',
  'storage',
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
