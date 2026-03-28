import fs from 'fs'
import path from 'path'
import type { InstallationRecord } from '../installations'

export const ENVS_DIR = 'envs'
export const DEFAULT_ENV = 'default'

export function getUvPath(installPath: string): string {
  if (process.platform === 'win32') {
    return path.join(installPath, 'standalone-env', 'uv.exe')
  }
  return path.join(installPath, 'standalone-env', 'bin', 'uv')
}

export function getEnvPythonPath(installPath: string, envName: string): string {
  const envDir = path.join(installPath, ENVS_DIR, envName)
  if (process.platform === 'win32') {
    return path.join(envDir, 'Scripts', 'python.exe')
  }
  return path.join(envDir, 'bin', 'python3')
}

export function listEnvs(installPath: string): string[] {
  const envsPath = path.join(installPath, ENVS_DIR)
  if (!fs.existsSync(envsPath)) return []
  try {
    return fs.readdirSync(envsPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
}

export function resolveActiveEnv(installation: InstallationRecord): string | null {
  const preferred = (installation.activeEnv as string | undefined) || DEFAULT_ENV
  const envs = listEnvs(installation.installPath)
  if (envs.includes(preferred)) return preferred
  return envs.length > 0 ? envs[0]! : null
}

export function getActivePythonPath(installation: InstallationRecord): string | null {
  const env = resolveActiveEnv(installation)
  if (!env) return null
  const envPython = getEnvPythonPath(installation.installPath, env)
  if (fs.existsSync(envPython)) return envPython
  return null
}
