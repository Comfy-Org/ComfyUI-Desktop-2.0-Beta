/**
 * Shared snapshot helpers used across snapshot-related components and views.
 */

/** Localised trigger label (requires the `t` function from `useI18n`). */
export function triggerLabel(trigger: string, t: (key: string) => string): string {
  switch (trigger) {
    case 'boot': return t('snapshots.triggerBoot')
    case 'restart': return t('snapshots.triggerRestart')
    case 'manual': return t('snapshots.triggerManual')
    case 'pre-update': return t('snapshots.triggerPreUpdate')
    case 'post-update': return t('snapshots.triggerPostUpdate')
    case 'post-restore': return t('snapshots.triggerPostRestore')
    default: return trigger
  }
}

/** Format an ISO date string for display. */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString()
}

/** Display a node version, falling back to short commit hash or em-dash. */
export function formatNodeVersion(node: { version?: string; commit?: string }): string {
  if (node.version) return node.version
  if (node.commit) return node.commit.slice(0, 7)
  return '—'
}
