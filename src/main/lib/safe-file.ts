/**
 * Safe file I/O helpers.
 *
 * writeFileSafe / writeFileSafeAsync: write to .tmp, optionally back up to .bak,
 * then rename .tmp over the target — a crash can never leave the file truncated.
 *
 * readFileSafe / readFileSafeAsync: read the primary file, falling back to .bak
 * (and restoring it) if the primary is missing or corrupt.
 */

import fs from 'fs'
import path from 'path'

// ---------------------------------------------------------------------------
// Synchronous
// ---------------------------------------------------------------------------

/**
 * Atomically write `data` to `filePath`.
 * When `backup` is true (default for important state), the current file is
 * copied to `filePath.bak` before being replaced.
 */
export function writeFileSafe(filePath: string, data: string, backup: boolean = false): void {
  const tmpPath = filePath + '.tmp'
  const bakPath = filePath + '.bak'
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(tmpPath, data, 'utf-8')
  if (backup) {
    try { fs.copyFileSync(filePath, bakPath) } catch {}
  }
  try {
    fs.renameSync(tmpPath, filePath)
  } catch (err) {
    try { fs.unlinkSync(tmpPath) } catch {}
    throw err
  }
}

/**
 * Read `filePath`, falling back to `filePath.bak` if the primary is missing
 * or unreadable. If the backup is used, it is automatically restored as the
 * primary file.
 */
export function readFileSafe(filePath: string): string | null {
  const bakPath = filePath + '.bak'
  try {
    const data = fs.readFileSync(filePath, 'utf-8')
    if (data.length > 0) return data
  } catch {}

  try {
    const data = fs.readFileSync(bakPath, 'utf-8')
    if (data.length > 0) {
      try { fs.copyFileSync(bakPath, filePath) } catch {}
      return data
    }
  } catch {}

  return null
}

// ---------------------------------------------------------------------------
// Async
// ---------------------------------------------------------------------------

export async function writeFileSafeAsync(filePath: string, data: string, backup: boolean = false): Promise<void> {
  const tmpPath = filePath + '.tmp'
  const bakPath = filePath + '.bak'
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
  await fs.promises.writeFile(tmpPath, data, 'utf-8')
  if (backup) {
    try { await fs.promises.copyFile(filePath, bakPath) } catch {}
  }
  // On Windows, antivirus or indexer may briefly lock the file after a write,
  // causing EPERM on rename. Retry a few times with a short delay.
  const RENAME_RETRIES = 3
  const RENAME_DELAY_MS = 100
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(tmpPath, filePath)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if ((code === 'EPERM' || code === 'EACCES') && attempt < RENAME_RETRIES) {
        await new Promise((r) => setTimeout(r, RENAME_DELAY_MS * (attempt + 1)))
        continue
      }
      try { await fs.promises.unlink(tmpPath) } catch {}
      throw err
    }
  }
}

export async function readFileSafeAsync(filePath: string): Promise<string | null> {
  const bakPath = filePath + '.bak'
  try {
    const data = await fs.promises.readFile(filePath, 'utf-8')
    if (data.length > 0) return data
  } catch {}

  try {
    const data = await fs.promises.readFile(bakPath, 'utf-8')
    if (data.length > 0) {
      try { await fs.promises.copyFile(bakPath, filePath) } catch {}
      return data
    }
  } catch {}

  return null
}
