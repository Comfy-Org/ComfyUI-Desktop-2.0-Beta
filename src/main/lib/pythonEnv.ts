import fs from 'fs'
import path from 'path'
import type { InstallationRecord } from '../installations'

export function getUvPath(installPath: string): string {
  if (process.platform === 'win32') {
    return path.join(installPath, 'standalone-env', 'uv.exe')
  }
  return path.join(installPath, 'standalone-env', 'bin', 'uv')
}

export function getVenvDir(installPath: string): string {
  return path.join(installPath, 'ComfyUI', '.venv')
}

export function getVenvPythonPath(installPath: string): string {
  const venvDir = getVenvDir(installPath)
  if (process.platform === 'win32') {
    return path.join(venvDir, 'Scripts', 'python.exe')
  }
  return path.join(venvDir, 'bin', 'python3')
}

/** In-venv uv that Legacy Desktop pip-installs; adopted installs reuse it (no standalone-env). */
export function getLegacyVenvUvPath(basePath: string): string {
  return process.platform === 'win32'
    ? path.join(basePath, '.venv', 'Scripts', 'uv.exe')
    : path.join(basePath, '.venv', 'bin', 'uv')
}

/**
 * Python the launcher should drive. Adopted installs use the Legacy-Desktop venv at
 * `adoptedBaseDir/.venv` (persisted as `adoptedPythonPath`); managed installs use `ComfyUI/.venv`.
 */
export function getActivePythonPath(installation: InstallationRecord): string | null {
  if (installation.adopted === true) {
    const adoptedPython = installation.adoptedPythonPath as string | undefined
    if (adoptedPython && fs.existsSync(adoptedPython)) return adoptedPython
    return null
  }
  const pythonPath = getVenvPythonPath(installation.installPath)
  if (fs.existsSync(pythonPath)) return pythonPath
  // Fallback: legacy envs/default/ layout (pre-migration)
  const legacyPath = process.platform === 'win32'
    ? path.join(installation.installPath, 'envs', 'default', 'Scripts', 'python.exe')
    : path.join(installation.installPath, 'envs', 'default', 'bin', 'python3')
  if (fs.existsSync(legacyPath)) return legacyPath
  return null
}

/** uv binary to drive. Adopted installs use the legacy `.venv` uv; managed use `standalone-env`. */
export function getActiveUvPath(installation: InstallationRecord): string {
  if (installation.adopted === true) {
    const baseDir = installation.adoptedBaseDir as string | undefined
    if (baseDir) return getLegacyVenvUvPath(baseDir)
  }
  return getUvPath(installation.installPath)
}

/** Active venv dir, used for site-packages discovery. Adopted: `<adoptedBaseDir>/.venv`; managed: `<installPath>/ComfyUI/.venv`. */
export function getActiveVenvDir(installation: InstallationRecord): string {
  if (installation.adopted === true) {
    const baseDir = installation.adoptedBaseDir as string | undefined
    if (baseDir) return path.join(baseDir, '.venv')
  }
  return getVenvDir(installation.installPath)
}
