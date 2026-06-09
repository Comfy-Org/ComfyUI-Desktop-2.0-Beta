import fs from 'fs'
import path from 'path'
import { readGitHead, rollbackComfySource } from './git'

// Sentinel written to the install dir while an update/restore is moving ComfyUI's
// git source. Cleared once the operation finishes consistently. If it survives to
// the next launch, the operation was interrupted by a hard process kill (no
// finally/cleanup ran), so we roll the source back to the pre-operation commit.
const MARKER_NAME = '.comfyui-op-in-progress.json'

export interface OpMarker {
  op: 'update' | 'restore'
  /** Full git SHA of ComfyUI's HEAD before the operation moved the source. */
  preHead: string
  startedAt: number
}

function markerPath(installPath: string): string {
  return path.join(installPath, MARKER_NAME)
}

export async function writeOpMarker(installPath: string, marker: OpMarker): Promise<void> {
  try {
    await fs.promises.writeFile(markerPath(installPath), JSON.stringify(marker), 'utf-8')
  } catch (err) {
    console.warn('Failed to write op-in-progress marker:', err)
  }
}

export function readOpMarker(installPath: string): OpMarker | null {
  try {
    const m = JSON.parse(fs.readFileSync(markerPath(installPath), 'utf-8')) as OpMarker
    if ((m.op === 'update' || m.op === 'restore') && typeof m.preHead === 'string' && m.preHead) {
      return m
    }
  } catch { /* missing or malformed — nothing to recover */ }
  return null
}

export async function clearOpMarker(installPath: string): Promise<void> {
  try { await fs.promises.unlink(markerPath(installPath)) } catch { /* already gone */ }
}

/**
 * Roll ComfyUI's source back if a previous update/restore was interrupted by a
 * hard process kill (the marker survived because no in-process cleanup ran).
 * Idempotent — a no-op when HEAD already matches the recorded pre-operation
 * commit (the common case: the op concluded but the marker lingered). Returns
 * true when a marker was found and consumed.
 */
export async function recoverInterruptedComfyOp(
  installPath: string,
  sendOutput?: (text: string) => void,
): Promise<boolean> {
  const marker = readOpMarker(installPath)
  if (!marker) return false

  const comfyuiDir = path.join(installPath, 'ComfyUI')
  if (readGitHead(comfyuiDir) !== marker.preHead) {
    sendOutput?.(`\nDetected an interrupted ${marker.op}; rolling ComfyUI source back to keep it consistent…\n`)
    await rollbackComfySource(comfyuiDir, marker.preHead, sendOutput)
  }
  await clearOpMarker(installPath)
  return true
}
