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

/** uv binary that Legacy Desktop pip-installs into its venv. Adopted
 *  installs reuse this in-venv uv since they have no standalone-env. */
export function getLegacyVenvUvPath(basePath: string): string {
  return process.platform === 'win32'
    ? path.join(basePath, '.venv', 'Scripts', 'uv.exe')
    : path.join(basePath, '.venv', 'bin', 'uv')
}

/**
 * Python the launcher should drive for a given installation.
 *
 * Adopted-from-legacy installs don't have a local `standalone-env`
 * or `ComfyUI/.venv` — the venv lives at `adoptedBaseDir/.venv` and
 * was provisioned by Legacy Desktop. We persist the resolved path
 * once on the record (`adoptedPythonPath`) so all downstream code
 * (launch, snapshot restore, update, dependency installs) can stay
 * unaware of the adopted/managed distinction.
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

/**
 * uv binary to drive for a given installation. Mirrors
 * `getActivePythonPath`: adopted installs use the uv pip-installed
 * into the legacy `.venv`; managed installs use `standalone-env`.
 */
export function getActiveUvPath(installation: InstallationRecord): string {
  if (installation.adopted === true) {
    const baseDir = installation.adoptedBaseDir as string | undefined
    if (baseDir) return getLegacyVenvUvPath(baseDir)
  }
  return getUvPath(installation.installPath)
}

/**
 * Active venv directory (the dir containing `pyvenv.cfg`, `Scripts/`
 * or `bin/`, `Lib/` / `lib/`). Used for site-packages discovery in
 * snapshot/restore flows. Adopted installs point at
 * `<adoptedBaseDir>/.venv`; managed installs at
 * `<installPath>/ComfyUI/.venv`.
 */
export function getActiveVenvDir(installation: InstallationRecord): string {
  if (installation.adopted === true) {
    const baseDir = installation.adoptedBaseDir as string | undefined
    if (baseDir) return path.join(baseDir, '.venv')
  }
  return getVenvDir(installation.installPath)
}
