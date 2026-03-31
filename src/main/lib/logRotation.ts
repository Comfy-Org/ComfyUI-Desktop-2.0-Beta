import fs from 'fs'
import path from 'path'

export function getLogDir(installPath: string): string {
  return path.join(installPath, 'logs')
}

export async function rotateLogFiles(logDir: string, baseName: string, maxFiles = 50): Promise<void> {
  const currentLogPath = path.join(logDir, baseName)
  try {
    await fs.promises.access(logDir, fs.constants.R_OK | fs.constants.W_OK)
    await fs.promises.access(currentLogPath)
  } catch {
    return
  }

  if (maxFiles > 0) {
    const files = await fs.promises.readdir(logDir, { withFileTypes: true })
    const names: string[] = []
    const logFileRegex = new RegExp(`^${baseName}_\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z\\.log$`)
    for (const file of files) {
      if (file.isFile() && logFileRegex.test(file.name)) names.push(file.name)
    }
    if (names.length > maxFiles) {
      names.sort()
      try { await fs.promises.unlink(path.join(logDir, names[0]!)) } catch {}
    }
  }

  const timestamp = new Date().toISOString().replaceAll(/[.:]/g, '-')
  const newLogPath = path.join(logDir, `${baseName}_${timestamp}.log`)
  try { await fs.promises.rename(currentLogPath, newLogPath) } catch {}
}
