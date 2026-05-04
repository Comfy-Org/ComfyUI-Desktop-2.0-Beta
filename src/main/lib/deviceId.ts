/**
 * Persistent per-installation device identifier.
 *
 * Read or create exactly once per process; both the IPC handler exposed to
 * the renderer (`get-device-id`) and the main-process telemetry init must
 * call this so they always agree.
 *
 * Uses exclusive-create (`wx`) to avoid TOCTOU races when two startup paths
 * race to create the file on first run.
 */
import { randomUUID } from 'crypto'
import path from 'path'
import fs from 'fs'
import { configDir } from './paths'

let cached: string | null = null

function deviceIdPath(): string {
  return path.join(configDir(), 'device-id.txt')
}

export function getDeviceId(): string {
  if (cached) return cached

  const filePath = deviceIdPath()
  try {
    const existing = fs.readFileSync(filePath, 'utf-8').trim()
    if (existing) {
      cached = existing
      return existing
    }
  } catch {
    // file doesn't exist yet; fall through and create it
  }

  const id = randomUUID()
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, id, { flag: 'wx' })
    cached = id
    return id
  } catch (err) {
    // Either the directory wasn't writable, or another process won the
    // exclusive-create race. Re-read; the winning value is canonical.
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      try {
        const existing = fs.readFileSync(filePath, 'utf-8').trim()
        if (existing) {
          cached = existing
          return existing
        }
      } catch {
        // ignore
      }
    }
    // As a last resort, use the in-memory id without persisting it. The
    // caller will end up with a session-scoped id, which is degraded but
    // still functional for telemetry.
    cached = id
    return id
  }
}
