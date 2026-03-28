import type { ScannedNode } from '../nodes'

export interface Snapshot {
  version: 1
  createdAt: string
  trigger: 'boot' | 'restart' | 'manual' | 'pre-update' | 'post-update' | 'post-restore'
  label: string | null
  comfyui: {
    ref: string
    commit: string | null
    releaseTag: string
    variant: string
    baseTag?: string
    commitsAhead?: number
  }
  customNodes: ScannedNode[]
  pipPackages: Record<string, string>
  /** When true, pip packages are recorded for informational purposes only and
   *  will NOT be force-synced during restore. Node dependencies are still
   *  installed via each node's requirements.txt / install.py. */
  skipPipSync?: boolean
  pythonVersion?: string
  updateChannel?: string
}

export interface SnapshotEntry {
  filename: string
  snapshot: Snapshot
}

export interface SnapshotExportEnvelope {
  type: 'comfyui-desktop-2-snapshot'
  version: 1
  exportedAt: string
  installationName: string
  snapshots: Snapshot[]
}

export interface SnapshotDiff {
  comfyuiChanged: boolean
  comfyui?: {
    from: { ref: string; commit: string | null; baseTag?: string; commitsAhead?: number; formattedVersion: string }
    to: { ref: string; commit: string | null; baseTag?: string; commitsAhead?: number; formattedVersion: string }
  }
  updateChannelChanged: boolean
  updateChannel?: { from: string; to: string }
  nodesAdded: ScannedNode[]
  nodesRemoved: ScannedNode[]
  nodesChanged: Array<{
    id: string
    type: string
    from: { version?: string; commit?: string; enabled: boolean }
    to: { version?: string; commit?: string; enabled: boolean }
  }>
  pipsAdded: Array<{ name: string; version: string }>
  pipsRemoved: Array<{ name: string; version: string }>
  pipsChanged: Array<{ name: string; from: string; to: string }>
}

export interface SnapshotDiffSummary {
  nodesAdded: number
  nodesRemoved: number
  nodesChanged: number
  pipsAdded: number
  pipsRemoved: number
  pipsChanged: number
  comfyuiChanged: boolean
  updateChannelChanged: boolean
}

export interface SnapshotSummary {
  filename: string
  createdAt: string
  trigger: 'boot' | 'restart' | 'manual' | 'pre-update' | 'post-update' | 'post-restore'
  label: string | null
  comfyuiVersion: string
  nodeCount: number
  pipPackageCount: number
  diffVsPrevious?: SnapshotDiffSummary
}

export interface SnapshotDetailData {
  filename: string
  createdAt: string
  trigger: string
  label: string | null
  comfyuiVersion: string
  comfyui: {
    ref: string
    commit: string | null
    releaseTag: string
    variant: string
  }
  pythonVersion?: string
  updateChannel?: string
  customNodes: ScannedNode[]
  pipPackageCount: number
  pipPackages: Record<string, string>
}

export interface SnapshotDiffData {
  mode: 'previous' | 'current'
  baseLabel: string
  diff: SnapshotDiff
  empty: boolean
}

export interface RestoreResult {
  installed: string[]
  removed: string[]
  changed: Array<{ name: string; from: string; to: string }>
  protectedSkipped: string[]
  failed: string[]
  errors: string[]
}

export interface NodeRestoreResult {
  installed: string[]
  switched: string[]
  enabled: string[]
  disabled: string[]
  removed: string[]
  skipped: string[]
  failed: Array<{ id: string; error: string }>
  unreportable: string[]
}
