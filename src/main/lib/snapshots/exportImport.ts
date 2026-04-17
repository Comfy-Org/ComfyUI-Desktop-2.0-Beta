import fs from 'fs'
import path from 'path'
import { isSafePathComponent } from '../cnr'
import { snapshotsDir, formatTimestamp } from './store'
import type { Snapshot, SnapshotEntry, SnapshotExportEnvelope } from './types'

export function buildExportEnvelope(installationName: string, entries: SnapshotEntry[]): SnapshotExportEnvelope {
  return {
    type: 'comfyui-desktop-2-snapshot',
    version: 1,
    exportedAt: new Date().toISOString(),
    installationName,
    snapshots: entries.map((e) => e.snapshot),
  }
}

const VALID_TRIGGERS = new Set(['boot', 'restart', 'manual', 'pre-update', 'post-update', 'post-restore'])

// PyPI package names: letters, digits, dots, hyphens, underscores (PEP 508).
// Must not start with '-' to avoid argument injection when passed to uv pip.
const VALID_PIP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function isValidCustomNode(n: unknown): boolean {
  if (!n || typeof n !== 'object') return false
  const node = n as Record<string, unknown>
  if (typeof node.dirName !== 'string' || !isSafePathComponent(node.dirName)) return false
  if (typeof node.id !== 'string' || !node.id) return false
  if (typeof node.type !== 'string' || !['cnr', 'git', 'file'].includes(node.type)) return false
  return true
}

function isValidSnapshot(s: unknown): s is Snapshot {
  if (!s || typeof s !== 'object') return false
  const obj = s as Record<string, unknown>
  if (obj.version !== 1) return false
  if (typeof obj.createdAt !== 'string' || isNaN(Date.parse(obj.createdAt))) return false
  if (typeof obj.trigger !== 'string' || !VALID_TRIGGERS.has(obj.trigger)) return false
  if (obj.comfyui == null || typeof obj.comfyui !== 'object') return false
  if (!Array.isArray(obj.customNodes)) return false
  if (obj.pipPackages == null || typeof obj.pipPackages !== 'object') return false

  // Validate custom node entries
  for (const node of obj.customNodes) {
    if (!isValidCustomNode(node)) return false
  }

  // Validate pip package names
  const pips = obj.pipPackages as Record<string, unknown>
  for (const name of Object.keys(pips)) {
    if (!VALID_PIP_NAME.test(name)) return false
    if (typeof pips[name] !== 'string') return false
  }

  return true
}

export function validateExportEnvelope(data: unknown): SnapshotExportEnvelope {
  if (!data || typeof data !== 'object') throw new Error('Invalid file: not a JSON object')
  const obj = data as Record<string, unknown>
  if (obj.type !== 'comfyui-desktop-2-snapshot') throw new Error('Invalid file: not a ComfyUI Desktop 2.0 snapshot export')
  if (obj.version !== 1) throw new Error(`Unsupported snapshot version: ${obj.version}`)
  if (!Array.isArray(obj.snapshots) || obj.snapshots.length === 0) throw new Error('File contains no snapshots')
  for (let i = 0; i < obj.snapshots.length; i++) {
    if (!isValidSnapshot(obj.snapshots[i])) throw new Error(`Invalid snapshot at index ${i}`)
  }
  return obj as unknown as SnapshotExportEnvelope
}

export async function importSnapshots(
  installPath: string,
  envelope: SnapshotExportEnvelope
): Promise<{ imported: number; filenames: string[] }> {
  const dir = snapshotsDir(installPath)
  await fs.promises.mkdir(dir, { recursive: true })

  const filenames: string[] = []
  // Each imported snapshot gets a fresh timestamp so it lands at the top of the
  // timeline.  Offset by 1ms per snapshot to preserve ordering within the import.
  const baseTime = Date.now()

  for (let i = 0; i < envelope.snapshots.length; i++) {
    const snapshot = envelope.snapshots[i]!
    const now = new Date(baseTime + i)
    const stamped = { ...snapshot, createdAt: now.toISOString() }
    const suffix = Math.random().toString(16).slice(2, 8)
    const filename = `${formatTimestamp(now)}-${snapshot.trigger}-${suffix}.json`
    const filePath = path.join(dir, filename)
    const tmpPath = `${filePath}.${suffix}.tmp`
    await fs.promises.writeFile(tmpPath, JSON.stringify(stamped, null, 2))
    await fs.promises.rename(tmpPath, filePath)
    filenames.push(filename)
  }

  return { imported: filenames.length, filenames }
}
