import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { DiskSpaceInfo, PathIssue } from '../../types/ipc'
import * as settings from '../settings'
import * as installations from '../installations'

// Free and total disk space for the volume containing `targetPath`.
export async function getDiskSpace(targetPath: string): Promise<DiskSpaceInfo> {
  let dir = path.resolve(targetPath)

  while (!fs.existsSync(dir)) {
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  const stats = await fs.promises.statfs(dir)
  return {
    free: stats.bavail * stats.bsize,
    total: stats.blocks * stats.bsize,
  }
}

// Recursive directory size in bytes (0 if missing); bounded concurrency to
// avoid EMFILE on large trees.
export async function getDirectorySize(dirPath: string, signal?: AbortSignal): Promise<number> {
  const MAX_CONCURRENT = 64
  let active = 0
  let total = 0
  const queue: string[] = [dirPath]
  const waiting: Array<() => void> = []

  function release(): void {
    active--
    const next = waiting.shift()
    if (next) next()
  }

  async function acquire(): Promise<void> {
    if (active < MAX_CONCURRENT) {
      active++
      return
    }
    await new Promise<void>((resolve) => waiting.push(resolve))
    active++
  }

  async function processEntry(fullPath: string, entry: fs.Dirent): Promise<void> {
    try {
      if (entry.isSymbolicLink()) {
        const stat = await fs.promises.lstat(fullPath)
        total += stat.size
      } else if (entry.isDirectory()) {
        queue.push(fullPath)
      } else {
        const stat = await fs.promises.lstat(fullPath)
        total += stat.size
      }
    } catch {
      // Skip files/dirs that can't be read
    }
    release()
  }

  while (queue.length > 0) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const dir = queue.shift()!
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    const pending: Promise<void>[] = []
    for (const entry of entries) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      await acquire()
      pending.push(processEntry(path.join(dir, entry.name), entry))
    }
    await Promise.all(pending)
  }

  return total
}

function normalizePath(p: string): string {
  const resolved = path.resolve(p)
  // Case-insensitive on Windows and macOS.
  return process.platform === 'win32' || process.platform === 'darwin'
    ? resolved.toLowerCase()
    : resolved
}

function isPathInside(candidate: string, parent: string): boolean {
  if (candidate === parent) return true
  const relative = path.relative(parent, candidate)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

// Paths installs must not be placed inside (app bundle, updater caches, etc.).
function getRestrictedPaths(): { path: string; issue: PathIssue }[] {
  const entries: { path: string; issue: PathIssue }[] = []
  const seen = new Set<string>()

  const add = (issue: PathIssue, rawPath?: string): void => {
    if (!rawPath) return
    const normalized = normalizePath(rawPath)
    if (seen.has(normalized)) return
    seen.add(normalized)
    entries.push({ path: normalized, issue })
  }

  const exePath = app.getPath('exe')
  if (process.platform === 'darwin') {
    // Walk up to the .app bundle.
    let current = exePath
    while (current && current !== '/' && !current.endsWith('.app')) {
      const next = path.dirname(current)
      if (next === current) break
      current = next
    }
    add('insideAppBundle', current.endsWith('.app') ? current : path.dirname(exePath))
  } else {
    add('insideAppBundle', path.dirname(exePath))
  }

  add('insideAppBundle', process.resourcesPath)
  add('insideAppBundle', app.getPath('userData'))

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    if (localAppData) {
      add('insideAppBundle', path.join(localAppData, 'comfyui-desktop-2-updater'))
      add('insideAppBundle', path.join(localAppData, '@comfyorgcomfyui-desktop-2-updater'))
    }

    add('oneDrive', process.env.OneDrive)
    add('oneDrive', process.env.OneDriveCommercial)
    add('oneDrive', process.env.OneDriveConsumer)
  }

  const s = settings.getAll()
  for (const dir of s.modelsDirs) {
    add('insideSharedDir', dir)
  }
  add('insideSharedDir', s.inputDir)
  add('insideSharedDir', s.outputDir)

  return entries
}

// Issues found if `targetPath` is inside a restricted location, else empty.
export async function validateInstallPath(targetPath: string): Promise<PathIssue[]> {
  const normalized = normalizePath(targetPath)
  const issues: PathIssue[] = []
  const seen = new Set<PathIssue>()

  for (const restricted of getRestrictedPaths()) {
    if (!seen.has(restricted.issue) && isPathInside(normalized, restricted.path)) {
      issues.push(restricted.issue)
      seen.add(restricted.issue)
    }
  }

  if (!seen.has('insideExistingInstall')) {
    const existing = await installations.list()
    for (const inst of existing) {
      if (!inst.installPath) continue
      const instNorm = normalizePath(inst.installPath)
      if (isPathInside(normalized, instNorm)) {
        issues.push('insideExistingInstall')
        break
      }
    }
  }

  return issues
}
