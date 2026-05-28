/**
 * Shared snapshot helpers used across snapshot-related components and views.
 */

import type { SnapshotDiffResult, SnapshotListData, SnapshotSummary } from '../types/ipc'

type Translator = (key: string, params?: Record<string, unknown>) => string

/**
 * Session-scoped cache of the snapshot list per installation. The Snapshots
 * tab remounts every time it's opened (it's `v-if`'d per tab), so without a
 * cache each open flashes an empty state and then shifts layout when the
 * async fetch resolves. Seeding from this cache lets a remount paint the
 * last-known list instantly while a background refresh runs. Cleared on app
 * restart; kept intentionally simple (no eviction — one small object per
 * install). */
const _snapshotListCache = new Map<string, SnapshotListData>()
export function getCachedSnapshotList(installationId: string): SnapshotListData | null {
  return _snapshotListCache.get(installationId) ?? null
}
export function setCachedSnapshotList(installationId: string, data: SnapshotListData): void {
  _snapshotListCache.set(installationId, data)
}

/**
 * "Share" a snapshot = export the install's latest (newest) snapshot via the
 * OS save dialog. This is the same operation as the per-row Export button,
 * promoted to a top-level install action so it's reachable from the dashboard
 * context menu and the IPP "More" menu without opening the Snapshots tab.
 *
 * Snapshots come back newest-first, so `[0]` is the current state. Returns a
 * discriminated result so each caller can surface the right feedback in its
 * own dialog system:
 *  - `none`  — the install has no snapshots yet (menu items are gated to
 *              installed local installs, but handle it defensively here too).
 *  - `error` — the export failed with a message (e.g. a write error).
 * A user cancelling the save dialog returns `{ ok: false }` with no message
 * from the IPC, which we treat as a successful no-op (nothing to report).
 */
export async function shareLatestSnapshot(
  installationId: string
): Promise<{ ok: true } | { ok: false; reason: 'none' | 'error'; message?: string }> {
  const list = await window.api.getSnapshots(installationId)
  const latest = list?.snapshots?.[0]?.filename
  if (!latest) return { ok: false, reason: 'none' }
  const result = await window.api.exportSnapshot(installationId, latest)
  if (result.ok) return { ok: true }
  if (result.message) return { ok: false, reason: 'error', message: result.message }
  return { ok: true }
}

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

/** CSS class suffix for a snapshot trigger badge / dot. */
export function triggerClass(trigger: string): string {
  switch (trigger) {
    case 'boot': return 'trigger-boot'
    case 'restart': return 'trigger-restart'
    case 'manual': return 'trigger-manual'
    case 'pre-update': return 'trigger-preupdate'
    case 'post-update': return 'trigger-postupdate'
    case 'post-restore': return 'trigger-postrestore'
    default: return ''
  }
}

/** Localised relative-time string (e.g. "5 minutes ago"). */
export function formatRelative(iso: string, t: Translator): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return t('snapshots.timeJustNow')
  if (mins < 60) return t('snapshots.timeMinutesAgo', { count: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t('snapshots.timeHoursAgo', { count: hours })
  const days = Math.floor(hours / 24)
  if (days < 30) return t('snapshots.timeDaysAgo', { count: days })
  return new Date(iso).toLocaleDateString()
}

/** Localised label for a copy-event reason. */
export function copyReasonLabel(reason: string, t: Translator): string {
  switch (reason) {
    case 'copy-update': return t('snapshots.copyUpdatedAs')
    case 'release-update': return t('snapshots.releaseUpdatedAs')
    default: return t('snapshots.copiedAs')
  }
}

/** Short change badges (e.g. "+2 −1 ~3 nodes") summarising a snapshot vs its predecessor. */
export function changeSummary(s: SnapshotSummary, t: Translator): string[] {
  if (!s.diffVsPrevious) return []
  const parts: string[] = []
  const d = s.diffVsPrevious
  if (d.comfyuiChanged) parts.push(t('snapshots.comfyuiUpdated'))
  if (d.updateChannelChanged) parts.push(t('snapshots.channelChanged'))
  const nodeChanges = d.nodesAdded + d.nodesRemoved + d.nodesChanged
  if (nodeChanges > 0) {
    const nodeParts: string[] = []
    if (d.nodesAdded > 0) nodeParts.push(`+${d.nodesAdded}`)
    if (d.nodesRemoved > 0) nodeParts.push(`−${d.nodesRemoved}`)
    if (d.nodesChanged > 0) nodeParts.push(`~${d.nodesChanged}`)
    parts.push(`${nodeParts.join(' ')} nodes`)
  }
  const pipChanges = d.pipsAdded + d.pipsRemoved + d.pipsChanged
  if (pipChanges > 0) {
    parts.push(`${pipChanges} pkg changes`)
  }
  return parts
}

/**
 * Convert a snapshot diff into grouped detail lines for the restore-confirm
 * modal's `messageDetails`. Mirrors what `SnapshotDiffView` renders, but as
 * plain strings the modal can show — so the "Restore this snapshot" confirm
 * shows the concrete version / node / package changes (e.g. "v0.20.1 →
 * v0.22.3") instead of the vague "ComfyUI updated · N pkg changes" summary.
 * Each list is capped so a huge diff (100+ pip changes) can't blow up the
 * modal; the full detail still lives in the expandable accordion on the row.
 */
export function diffToDetailGroups(
  diff: SnapshotDiffResult,
  t: Translator,
  cap = 12
): Array<{ label: string; items: string[] }> {
  const groups: Array<{ label: string; items: string[] }> = []
  const capList = (lines: string[]): string[] =>
    lines.length > cap ? [...lines.slice(0, cap), `… and ${lines.length - cap} more`] : lines

  if (diff.comfyuiChanged && diff.comfyui) {
    groups.push({
      label: t('snapshots.comfyuiVersion'),
      items: [`${diff.comfyui.from.formattedVersion} → ${diff.comfyui.to.formattedVersion}`]
    })
  }
  if (diff.updateChannelChanged && diff.updateChannel) {
    groups.push({
      label: t('snapshots.updateChannel'),
      items: [`${diff.updateChannel.from} → ${diff.updateChannel.to}`]
    })
  }
  if (diff.nodesAdded.length || diff.nodesRemoved.length || diff.nodesChanged.length) {
    const lines = [
      ...diff.nodesAdded.map((n) => `+ ${n.id} ${formatNodeVersion(n)}`),
      ...diff.nodesRemoved.map((n) => `− ${n.id} ${formatNodeVersion(n)}`),
      ...diff.nodesChanged.map(
        (n) => `~ ${n.id}: ${formatNodeVersion(n.from)} → ${formatNodeVersion(n.to)}`
      )
    ]
    groups.push({ label: t('snapshots.customNodes'), items: capList(lines) })
  }
  if (diff.pipsAdded.length || diff.pipsRemoved.length || diff.pipsChanged.length) {
    const lines = [
      ...diff.pipsAdded.map((p) => `+ ${p.name} ${p.version}`),
      ...diff.pipsRemoved.map((p) => `− ${p.name} ${p.version}`),
      ...diff.pipsChanged.map((p) => `~ ${p.name}: ${p.from} → ${p.to}`)
    ]
    groups.push({ label: t('snapshots.pipPackages'), items: capList(lines) })
  }
  return groups
}

/** True when the diff has any non-zero change. */
export function diffHasChanges(diff: SnapshotDiffResult): boolean {
  return (
    diff.comfyuiChanged ||
    diff.updateChannelChanged ||
    diff.nodesAdded.length > 0 ||
    diff.nodesRemoved.length > 0 ||
    diff.nodesChanged.length > 0 ||
    diff.pipsAdded.length > 0 ||
    diff.pipsRemoved.length > 0 ||
    diff.pipsChanged.length > 0
  )
}
