import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { MODEL_FOLDER_TYPES } from './models'

export interface DesktopInstallInfo {
  configDir: string
  basePath: string
  executablePath: string | null
  hasVenv: boolean
}

function getDesktopConfigDir(): string | null {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (!appData) return null
    return path.join(appData, 'ComfyUI')
  }
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', 'ComfyUI')
  }
  return null
}

export function findDesktopExecutable(): string | null {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    if (!localAppData) return null
    const candidate = path.join(localAppData, 'Programs', 'ComfyUI', 'ComfyUI.exe')
    if (fs.existsSync(candidate)) return candidate
    return null
  }
  if (process.platform === 'darwin') {
    const candidate = '/Applications/ComfyUI.app'
    if (fs.existsSync(candidate)) return candidate
    return null
  }
  return null
}

export function detectDesktopInstall(): DesktopInstallInfo | null {
  const configDir = getDesktopConfigDir()
  if (!configDir) return null

  const configPath = path.join(configDir, 'config.json')
  let basePath: string
  try {
    const raw = fs.readFileSync(configPath, 'utf-8')
    const config = JSON.parse(raw) as Record<string, unknown>
    if (typeof config.basePath !== 'string' || !config.basePath) return null
    basePath = config.basePath
  } catch {
    return null
  }

  if (!fs.existsSync(basePath)) return null

  const hasModels = fs.existsSync(path.join(basePath, 'models'))
  const hasUser = fs.existsSync(path.join(basePath, 'user'))
  if (!hasModels || !hasUser) return null

  return {
    configDir,
    basePath,
    executablePath: findDesktopExecutable(),
    hasVenv: fs.existsSync(path.join(basePath, '.venv')),
  }
}

const LAUNCHER_KEY_PREFIX = 'comfyui_launcher_'

/**
 * Inject the Launcher's shared model directories into Desktop's
 * extra_models_config.yaml so Desktop's ComfyUI instance can find them.
 */
export function syncSharedModelPaths(configDir: string, modelsDirs: string[]): void {
  const configPath = path.join(configDir, 'extra_models_config.yaml')

  // Read existing config, preserving Desktop's own sections
  const lines: string[] = []
  try {
    const existing = fs.readFileSync(configPath, 'utf-8')
    // Keep all lines that don't belong to comfyui_launcher_* sections
    let inLauncherSection = false
    for (const line of existing.split(/\r?\n/)) {
      if (/^\S/.test(line)) {
        // Top-level key — check if it's one of ours
        inLauncherSection = line.startsWith(LAUNCHER_KEY_PREFIX)
      }
      if (!inLauncherSection) {
        lines.push(line)
      }
    }
    // Remove trailing blank lines left from stripping
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') {
      lines.pop()
    }
  } catch {
    // Config doesn't exist yet — Desktop may not have run. Start fresh.
    lines.push(`# ComfyUI extra_models_config.yaml`)
  }

  // Append Launcher shared model sections
  if (modelsDirs.length > 0) {
    lines.push('')
    for (let i = 0; i < modelsDirs.length; i++) {
      const escaped = path.resolve(modelsDirs[i]!).replace(/'/g, "''")
      lines.push(`${LAUNCHER_KEY_PREFIX}${i}:`)
      lines.push(`  base_path: '${escaped}'`)
      for (const folder of MODEL_FOLDER_TYPES) {
        lines.push(`  ${folder}: ${folder}/`)
      }
      lines.push('')
    }
  }

  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(configPath, lines.join('\n'), 'utf-8')
}
