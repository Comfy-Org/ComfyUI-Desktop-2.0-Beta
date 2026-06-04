import { listSnapshots, loadSnapshot } from './store'
import { diffSnapshots, resolveSnapshotVersion, resolveDiffVersions, summarizeDiff } from './diff'
import type { SnapshotSummary, SnapshotDetailData, SnapshotDiffData } from './types'

export async function getSnapshotListData(installPath: string): Promise<{ snapshots: SnapshotSummary[]; totalCount: number }> {
  const entries = await listSnapshots(installPath)
  const versionPromises = entries.map((entry) =>
    resolveSnapshotVersion(installPath, entry.snapshot.comfyui, 'short')
  )
  const resolvedVersions = await Promise.all(versionPromises)
  const summaries: SnapshotSummary[] = entries.map((entry, i) => {
    const s = entry.snapshot
    const summary: SnapshotSummary = {
      filename: entry.filename,
      createdAt: s.createdAt,
      trigger: s.trigger,
      label: s.label,
      comfyuiVersion: resolvedVersions[i]!,
      nodeCount: s.customNodes.length,
      pipPackageCount: Object.keys(s.pipPackages).length,
    }
    // Entries are sorted newest-first, so the next entry is the previous snapshot.
    if (i < entries.length - 1) {
      const prev = entries[i + 1]!.snapshot
      const diff = diffSnapshots(prev, s)
      const ds = summarizeDiff(diff)
      if (ds.comfyuiChanged || ds.updateChannelChanged || ds.nodesAdded || ds.nodesRemoved || ds.nodesChanged ||
          ds.pipsAdded || ds.pipsRemoved || ds.pipsChanged) {
        summary.diffVsPrevious = ds
      }
    }
    return summary
  })
  return { snapshots: summaries, totalCount: entries.length }
}

export async function getSnapshotDetailData(installPath: string, filename: string): Promise<SnapshotDetailData> {
  const snapshot = await loadSnapshot(installPath, filename)
  return {
    filename,
    createdAt: snapshot.createdAt,
    trigger: snapshot.trigger,
    label: snapshot.label,
    comfyuiVersion: await resolveSnapshotVersion(installPath, snapshot.comfyui, 'detail'),
    comfyui: snapshot.comfyui,
    pythonVersion: snapshot.pythonVersion,
    updateChannel: snapshot.updateChannel,
    customNodes: snapshot.customNodes,
    pipPackageCount: Object.keys(snapshot.pipPackages).length,
    pipPackages: snapshot.pipPackages,
  }
}

export async function getSnapshotDiffVsPrevious(installPath: string, filename: string): Promise<SnapshotDiffData> {
  const entries = await listSnapshots(installPath)
  const idx = entries.findIndex((e) => e.filename === filename)
  if (idx < 0) throw new Error(`Snapshot not found: ${filename}`)
  if (idx >= entries.length - 1) {
    // Oldest snapshot — no previous to diff against.
    return {
      mode: 'previous',
      baseLabel: '',
      diff: { comfyuiChanged: false, updateChannelChanged: false, nodesAdded: [], nodesRemoved: [], nodesChanged: [], pipsAdded: [], pipsRemoved: [], pipsChanged: [] },
      empty: true,
    }
  }
  const current = entries[idx]!.snapshot
  const prev = entries[idx + 1]!.snapshot
  const diff = diffSnapshots(prev, current)
  await resolveDiffVersions(installPath, diff)
  const prevDate = new Date(prev.createdAt).toLocaleString()
  return {
    mode: 'previous',
    baseLabel: prevDate,
    diff,
    empty: !diff.comfyuiChanged && !diff.updateChannelChanged && diff.nodesAdded.length === 0 && diff.nodesRemoved.length === 0 &&
           diff.nodesChanged.length === 0 && diff.pipsAdded.length === 0 && diff.pipsRemoved.length === 0 &&
           diff.pipsChanged.length === 0,
  }
}
