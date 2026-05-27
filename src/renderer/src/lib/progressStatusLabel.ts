import type { ComposerTranslation } from 'vue-i18n'

/**
 * Raw status strings emitted by the main process during background ops,
 * mapped to friendlier user-facing copy. Shared by the Update overlay
 * (`ComfyUISettingsContent.vue`) and the Snapshots row status line
 * (`SnapshotsView.vue`) so the two surfaces never drift.
 */
const OP_STATUS_MAP: Record<string, string> = {
  'Fetching latest stable version': 'Checking for latest version…',
  'Fetching version tags…': 'Checking for latest version…',
  'Already up to date': 'Already up to date',
  'Up to date': 'Already up to date',
  'Stopping…': 'Stopping instance…',
  'Creating Python environment…': 'Setting up environment…',
  'Loading snapshot…': 'Loading snapshot…',
  Complete: 'Finishing up…',
}

type TLike = ComposerTranslation | ((key: string, fallback?: string) => string)

export function humanizeOpStatus(raw: string | null | undefined, t: TLike): string {
  const key = raw || ''
  if (key in OP_STATUS_MAP) return OP_STATUS_MAP[key]!
  if (key) return key
  return (t as (k: string, fb?: string) => string)('instancePicker.progressWorking', 'Working…')
}
