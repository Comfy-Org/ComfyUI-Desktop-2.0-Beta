import {
  ipcMain, dialog, shell, BrowserWindow,
  fs, path,
  sources, installations,
  defaultInstallDir, getDiskSpace, getDirectorySize, validateInstallPath,
  detectGPU, validateHardware, checkNvidiaDriver,
  sourceMap, getAppVersion, openPath,
} from './shared'
import type { FieldOption } from './shared'
import { getGpuPromise, setGpuPromise } from './shared'

export function registerAppHandlers(): void {
  // App version
  ipcMain.handle('get-app-version', () => getAppVersion())

  // Sources
  ipcMain.handle('get-sources', () =>
    sources
      .filter((s) => s.category !== 'cloud' && !s.hidden)
      .filter((s) => !s.platforms || s.platforms.includes(process.platform))
      .map((s) => ({ id: s.id, label: s.label, category: s.category, description: s.description, fields: s.fields, skipInstall: !!s.skipInstall, hideInstallPath: !!s.skipInstall }))
  )

  ipcMain.handle('get-field-options', async (_event, sourceId: string, fieldId: string, selections: Record<string, unknown>) => {
    const source = sourceMap[sourceId]
    if (!source) return []
    let gpuPromise = getGpuPromise()
    if (!gpuPromise) {
      gpuPromise = detectGPU().catch(() => null)
      setGpuPromise(gpuPromise)
    }
    const gpu = await gpuPromise
    if (!source.getFieldOptions) return []
    const options = await source.getFieldOptions(
      fieldId,
      selections as Record<string, FieldOption | undefined>,
      { gpu: gpu && gpu.id }
    )
    return options
  })

  ipcMain.handle('detect-gpu', async () => {
    let gpuPromise = getGpuPromise()
    if (!gpuPromise) {
      gpuPromise = detectGPU().catch(() => null)
      setGpuPromise(gpuPromise)
    }
    return gpuPromise
  })

  ipcMain.handle('validate-hardware', () => validateHardware())
  ipcMain.handle('check-nvidia-driver', () => checkNvidiaDriver())

  ipcMain.handle('build-installation', (_event, sourceId: string, selections: Record<string, unknown>) => {
    const source = sourceMap[sourceId]
    if (!source) return null
    return {
      sourceId: source.id,
      sourceLabel: source.label,
      ...source.buildInstallation(selections as Record<string, FieldOption | undefined>),
    }
  })

  // Paths
  ipcMain.handle('get-default-install-dir', () => defaultInstallDir())

  ipcMain.handle('browse-folder', async (_event, defaultPath?: string) => {
    const win = BrowserWindow.fromWebContents(_event.sender)
    if (!win) return null
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      defaultPath: defaultPath || defaultInstallDir(),
      properties: ['openDirectory', 'createDirectory'],
    })
    if (canceled || filePaths.length === 0) return null
    return filePaths[0]
  })

  ipcMain.handle('open-path', (_event, targetPath: string) => {
    if (typeof targetPath !== 'string' || !targetPath) return ''
    if (/^https?:\/\//i.test(targetPath)) return shell.openExternal(targetPath)
    const resolved = path.resolve(targetPath)
    if (!fs.existsSync(resolved)) return ''
    return openPath(resolved)
  })
  ipcMain.handle('open-external', (_event, url: string) => {
    if (typeof url !== 'string' || !url) return Promise.resolve()
    if (!/^https?:\/\//i.test(url)) return Promise.resolve()
    return shell.openExternal(url)
  })
  ipcMain.handle('get-disk-space', (_event, targetPath: string) => getDiskSpace(targetPath))
  ipcMain.handle('validate-install-path', (_event, targetPath: string) => validateInstallPath(targetPath))
  let activeSizeAc: AbortController | null = null
  let activeSizeInstId: string | null = null
  ipcMain.handle('get-installation-size', async (_event, installationId: string) => {
    if (activeSizeInstId !== installationId) activeSizeAc?.abort()
    const ac = new AbortController()
    activeSizeAc = ac
    activeSizeInstId = installationId
    try {
      const inst = await installations.get(installationId)
      if (!inst?.installPath) return { sizeBytes: 0 }
      const sizeBytes = await getDirectorySize(inst.installPath, ac.signal)
      return { sizeBytes }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return { sizeBytes: 0 }
      throw err
    } finally {
      if (activeSizeAc === ac) {
        activeSizeAc = null
        activeSizeInstId = null
      }
    }
  })
  ipcMain.handle('cancel-installation-size', () => {
    activeSizeAc?.abort()
    activeSizeAc = null
    activeSizeInstId = null
  })
}
