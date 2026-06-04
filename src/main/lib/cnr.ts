import fs from 'fs'
import path from 'path'
import os from 'os'
import { fetchJSON } from './fetch'
import { download } from './download'
import { extract } from './extract'
import * as telemetry from './telemetry'

interface CnrInstallInfo {
  downloadUrl: string
  version: string
}

const TRACKING_FILE = '.tracking'

/** Validate that a name is a safe single path component (no traversal). */
export function isSafePathComponent(name: string): boolean {
  if (!name || name !== path.basename(name)) return false
  if (name === '.' || name === '..') return false
  return true
}

function walkDir(dir: string, base: string = ''): string[] {
  const results: string[] = []
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      results.push(...walkDir(path.join(dir, entry.name), rel))
    } else if (entry.name !== TRACKING_FILE) {
      results.push(rel)
    }
  }
  return results
}

export async function getCnrInstallInfo(
  nodeId: string,
  version?: string,
): Promise<CnrInstallInfo | null> {
  try {
    let url = `https://api.comfy.org/nodes/${encodeURIComponent(nodeId)}/install`
    if (version) {
      url += `?version=${encodeURIComponent(version)}`
    }
    const data = (await fetchJSON(url)) as Record<string, unknown>
    if (!data || typeof data.downloadUrl !== 'string' || typeof data.version !== 'string') {
      return null
    }
    return { downloadUrl: data.downloadUrl as string, version: data.version as string }
  } catch {
    return null
  }
}

export async function installCnrNode(
  nodeId: string,
  version: string,
  customNodesDir: string,
  sendOutput: (text: string) => void,
): Promise<string[]> {
  const startedAt = Date.now()
  // Resolved version is unknown until the registry call returns; fall
  // back to the caller-requested string for failure paths so the event
  // still names a version.
  let resolvedVersion = version
  // Capture telemetry around the entire install — including pre-flight
  // validation and the registry lookup — so failures that happen before
  // the tmp-zip allocation still fire `node.installed` with the right
  // bucket. The actual zip download / extraction still wraps its own
  // try/finally below for tmpZip cleanup.
  try {
    if (!isSafePathComponent(nodeId)) {
      throw new Error(`Invalid node ID: ${nodeId}`)
    }

    const info = await getCnrInstallInfo(nodeId, version)
    if (!info) {
      throw new Error(`Failed to get install info for ${nodeId}@${version}`)
    }
    resolvedVersion = info.version

    const installPath = path.join(customNodesDir, nodeId)
    const tmpZip = path.join(os.tmpdir(), `cnr-${nodeId}-${version}-${Date.now()}.zip`)

    try {
      sendOutput(`Downloading ${nodeId}@${info.version}...\n`)
      await download(info.downloadUrl, tmpZip, null)

      sendOutput(`Extracting ${nodeId}@${info.version}...\n`)
      await fs.promises.mkdir(installPath, { recursive: true })
      await extract(tmpZip, installPath)

      const files = walkDir(installPath)
      await fs.promises.writeFile(path.join(installPath, TRACKING_FILE), files.join('\n') + '\n')

      sendOutput(`Installed ${nodeId}@${info.version}\n`)
      telemetry.capture('comfy.desktop.node.installed', {
        node_id: nodeId,
        version: info.version,
        action: 'install',
        result: 'success',
        duration_ms: Date.now() - startedAt,
        file_count: files.length
      })
      return files
    } finally {
      try {
        await fs.promises.unlink(tmpZip)
      } catch {}
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    telemetry.capture('comfy.desktop.node.installed', {
      node_id: nodeId,
      version: resolvedVersion,
      action: 'install',
      result: 'failure',
      duration_ms: Date.now() - startedAt,
      error_bucket: telemetry.bucketError(message),
      error_message: message.slice(0, 500)
    })
    throw err
  }
}

export async function switchCnrVersion(
  nodeId: string,
  newVersion: string,
  nodePath: string,
  sendOutput: (text: string) => void,
): Promise<string[]> {
  const startedAt = Date.now()
  let resolvedVersion = newVersion
  try {
    const info = await getCnrInstallInfo(nodeId, newVersion)
    if (!info) {
      throw new Error(`Failed to get install info for ${nodeId}@${newVersion}`)
    }
    resolvedVersion = info.version

    const trackingPath = path.join(nodePath, TRACKING_FILE)
    const oldFiles = new Set<string>()
    try {
      const content = await fs.promises.readFile(trackingPath, 'utf-8')
      for (const line of content.split('\n')) {
        const trimmed = line.trim()
        if (trimmed) oldFiles.add(trimmed)
      }
    } catch {}

    const stamp = Date.now()
    const tmpZip = path.join(os.tmpdir(), `cnr-${nodeId}-${newVersion}-${stamp}.zip`)
    const tmpExtract = path.join(os.tmpdir(), `cnr-${nodeId}-${newVersion}-${stamp}`)

    try {
      sendOutput(`Downloading ${nodeId}@${info.version}...\n`)
      await download(info.downloadUrl, tmpZip, null)

      // Extract to a temp dir first to get the true new file list; in-place
      // extraction would union old+new files and break garbage detection.
      sendOutput(`Extracting ${nodeId}@${info.version}...\n`)
      await fs.promises.mkdir(tmpExtract, { recursive: true })
      await extract(tmpZip, tmpExtract)

      const newFiles = walkDir(tmpExtract)
      const newFileSet = new Set(newFiles)

      // Copy extracted files into nodePath (overwriting existing)
      await fs.promises.mkdir(nodePath, { recursive: true })
      await fs.promises.cp(tmpExtract, nodePath, { recursive: true, force: true })

      const garbageFiles: string[] = []
      const garbageDirs = new Set<string>()
      for (const oldFile of oldFiles) {
        if (!newFileSet.has(oldFile)) {
          garbageFiles.push(oldFile)
          let dir = oldFile
          while (true) {
            const parent = dir.substring(0, dir.lastIndexOf('/'))
            if (!parent) break
            garbageDirs.add(parent)
            dir = parent
          }
        }
      }

      for (const file of garbageFiles) {
        try {
          await fs.promises.unlink(path.join(nodePath, file.split('/').join(path.sep)))
        } catch {}
      }

      const sortedDirs = [...garbageDirs].sort((a, b) => b.length - a.length)
      for (const dir of sortedDirs) {
        try {
          await fs.promises.rmdir(path.join(nodePath, dir.split('/').join(path.sep)))
        } catch {}
      }

      await fs.promises.writeFile(path.join(nodePath, TRACKING_FILE), newFiles.join('\n') + '\n')

      sendOutput(`Switched ${nodeId} to ${info.version}\n`)
      telemetry.capture('comfy.desktop.node.installed', {
        node_id: nodeId,
        version: info.version,
        action: 'switch',
        result: 'success',
        duration_ms: Date.now() - startedAt,
        file_count: newFiles.length
      })
      return newFiles
    } finally {
      try { await fs.promises.unlink(tmpZip) } catch {}
      try { await fs.promises.rm(tmpExtract, { recursive: true, force: true }) } catch {}
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    telemetry.capture('comfy.desktop.node.installed', {
      node_id: nodeId,
      version: resolvedVersion,
      action: 'switch',
      result: 'failure',
      duration_ms: Date.now() - startedAt,
      error_bucket: telemetry.bucketError(message),
      error_message: message.slice(0, 500)
    })
    throw err
  }
}
