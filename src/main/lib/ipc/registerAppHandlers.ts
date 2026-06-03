import {
  ipcMain,
  dialog,
  shell,
  BrowserWindow,
  fs,
  path,
  os,
  sources,
  installations,
  settings,
  defaultInstallDir,
  getDiskSpace,
  getDirectorySize,
  validateInstallPath,
  detectGPU,
  validateHardware,
  checkNvidiaDriver,
  sourceMap,
  getAppVersion,
  openPath,
  listSnapshots,
  diffSnapshots
} from './shared'
import si from 'systeminformation'
import type { FieldOption } from './shared'
import { getGpuPromise, setGpuPromise } from './shared'
import * as mainTelemetry from '../telemetry'
import { getDeviceId } from '../deviceId'
import { getCloudCapacityStatusAsync } from '../cloudCapacity'
import { getUserTierAsync } from '../userTier'

export function registerAppHandlers(): void {
  // App version
  ipcMain.handle('get-app-version', () => getAppVersion())

  // Capacity-protection switch for Cloud entry points. Resolved from the
  // `desktop-cloud-capacity` PostHog flag via the experiments cache; safe
  // default is `'normal'` (no UI change). See `cloudCapacity.ts` for the
  // boot-time / consent caveats.
  ipcMain.handle('get-cloud-capacity', () => getCloudCapacityStatusAsync())

  // Signed-in user's Comfy Cloud subscription tier ('free' | 'paid' |
  // 'unknown'). Used by the capacity gate to let paying users through
  // `disabled`. Hydrated from a persisted file at boot and refreshed on
  // every cloud webContents `dom-ready`. See `userTier.ts`.
  ipcMain.handle('get-cloud-user-tier', () => getUserTierAsync())

  // Sources
  ipcMain.handle('get-sources', () =>
    sources
      .filter((s) => s.category !== 'cloud' && !s.hidden)
      .filter((s) => !s.platforms || s.platforms.includes(process.platform))
      .map((s) => ({
        id: s.id,
        label: s.label,
        category: s.category,
        description: s.description,
        fields: s.fields,
        skipInstall: !!s.skipInstall,
        hideInstallPath: !!s.skipInstall
      }))
  )

  ipcMain.handle(
    'get-field-options',
    async (
      _event,
      sourceId: string,
      fieldId: string,
      selections: Record<string, unknown>,
      extraContext?: Record<string, unknown>
    ) => {
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
        { gpu: gpu && gpu.id, ...extraContext }
      )
      return options
    }
  )

  ipcMain.handle('detect-gpu', async () => {
    let gpuPromise = getGpuPromise()
    if (!gpuPromise) {
      gpuPromise = detectGPU().catch(() => null)
      setGpuPromise(gpuPromise)
    }
    return gpuPromise
  })

  ipcMain.handle('validate-hardware', async () => {
    const result = await validateHardware()
    // Emit a single event whether hardware passes or fails so we can build
    // funnels like "% of users who hit hardware-not-supported during install".
    mainTelemetry.emit('comfy.desktop.install.validation', {
      passed: result.supported,
      platform: process.platform,
      arch: process.arch,
      reason: result.supported ? null : (result.error ?? 'unsupported')
    })
    return result
  })
  ipcMain.handle('check-nvidia-driver', () => checkNvidiaDriver())

  ipcMain.handle(
    'build-installation',
    (_event, sourceId: string, selections: Record<string, unknown>) => {
      const source = sourceMap[sourceId]
      if (!source) return null
      return {
        sourceId: source.id,
        sourceLabel: source.label,
        ...source.buildInstallation(selections as Record<string, FieldOption | undefined>)
      }
    }
  )

  // Paths
  ipcMain.handle('get-default-install-dir', () => defaultInstallDir())

  ipcMain.handle('browse-folder', async (_event, defaultPath?: string) => {
    const win = BrowserWindow.fromWebContents(_event.sender)
    if (!win) return null
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      defaultPath: defaultPath || defaultInstallDir(),
      properties: ['openDirectory', 'createDirectory']
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
  ipcMain.handle('validate-install-path', (_event, targetPath: string) =>
    validateInstallPath(targetPath)
  )
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

  ipcMain.handle('get-system-info', async () => {
    let gpuPromise = getGpuPromise()
    if (!gpuPromise) {
      gpuPromise = detectGPU().catch(() => null)
      setGpuPromise(gpuPromise)
    }
    const gpu = await gpuPromise
    const nvidiaCheck = gpu?.id === 'nvidia' ? await checkNvidiaDriver() : null
    const cpus = os.cpus()
    const allInstalls = await installations.list()

    let osDistro: string | null = null
    let osRelease: string | null = null
    let osArch: string | null = null
    let cpuManufacturer: string | null = null
    let cpuPhysicalCores: number | null = null
    let cpuSpeedGhz: number | null = null
    let allGpus: Array<{
      vendor: string
      model: string
      vram_mb: number | null
      driver_version: string | null
    }> = []
    const [osResult, cpuResult, gpuResult] = await Promise.allSettled([
      si.osInfo(),
      si.cpu(),
      si.graphics()
    ])
    if (osResult.status === 'fulfilled') {
      osDistro = osResult.value.distro || null
      osRelease = osResult.value.release || null
      osArch = osResult.value.arch || null
    }
    if (cpuResult.status === 'fulfilled') {
      cpuManufacturer = cpuResult.value.manufacturer || null
      cpuPhysicalCores = cpuResult.value.physicalCores ?? null
      cpuSpeedGhz = cpuResult.value.speed ?? null
    }
    if (gpuResult.status === 'fulfilled') {
      allGpus = gpuResult.value.controllers.map((ctrl) => ({
        vendor: ctrl.vendor || '',
        model: ctrl.model || '',
        vram_mb: ctrl.vram ?? null,
        driver_version: ctrl.driverVersion?.trim() || null
      }))
    }

    return {
      gpu_vendor: gpu?.id ?? null,
      gpu_label: gpu?.label ?? null,
      gpu_model: gpu?.model ?? null,
      gpus: allGpus,
      nvidia_driver_version: nvidiaCheck?.driverVersion ?? null,
      nvidia_driver_supported: nvidiaCheck?.supported ?? null,
      platform: process.platform,
      arch: process.arch,
      os_version: os.release(),
      os_distro: osDistro,
      os_release: osRelease,
      os_arch: osArch,
      electron_version: process.versions.electron,
      chrome_version: process.versions.chrome,
      total_memory_gb: Math.round(os.totalmem() / 1073741824),
      cpu_model: cpus[0]?.model ?? 'unknown',
      cpu_cores: cpus.length,
      cpu_physical_cores: cpuPhysicalCores,
      cpu_speed_ghz: cpuSpeedGhz,
      cpu_manufacturer: cpuManufacturer,
      app_version: getAppVersion(),
      // Issue #488 — repurposed to reflect the new `autoInstallUpdates`
      // toggle (silent install vs prompt). The auto-check loop is no
      // longer user-disablable, so this property captures what the
      // remaining toggle actually controls.
      auto_update: settings.get('autoInstallUpdates') !== false,
      locale: settings.get('language') || 'en',
      installation_count: allInstalls.length,
      installations: allInstalls.map((inst) => ({
        source_id: (inst.sourceId as string) || '',
        variant: (inst.variant as string) || '',
        update_channel: (inst.updateChannel as string) || 'stable',
        status: (inst.status as string) || 'ready'
      }))
    }
  })

  // Per-session boot census of every persisted installation, sorted
  // most-recently-launched first. Powers `comfy.desktop.session.installs_inventory`
  // so dashboards can see the user's full install footprint without
  // having to wait for them to launch each one. Capped to 200 KB total
  // (Datadog RUM hard-caps action context at ~256 KB; 200 KB matches the
  // existing single-install `get-installation-dd-context` budget so the
  // event reliably ships).
  ipcMain.handle('get-installs-inventory', async () => {
    const MAX_TOTAL_BYTES = 200 * 1024
    const MAX_PER_INSTALL_BYTES = 50 * 1024
    const all = await installations.list()
    // `installing` entries are mid-install transient — exclude them
    // (they'll show up on the next boot once they settle).
    const visible = all.filter((i) => i.status !== 'installing')
    // Most-recently-launched first; never-launched (`undefined`) sort
    // to the end with `?? 0`.
    visible.sort(
      (a, b) =>
        ((b.lastLaunchedAt as number | undefined) ?? 0) -
        ((a.lastLaunchedAt as number | undefined) ?? 0)
    )

    const result = {
      total_install_count: visible.length,
      included_install_count: 0,
      truncated: false,
      installs: [] as Array<Record<string, unknown>>
    }
    let runningSize = JSON.stringify(result).length

    for (const inst of visible) {
      const entries = inst.installPath ? await listSnapshots(inst.installPath).catch(() => []) : []
      const latest = entries.length > 0 ? entries[0]!.snapshot : null

      const entry: Record<string, unknown> = {
        installation_id: inst.id,
        source_id: (inst.sourceId as string) || '',
        variant: (inst.variant as string) || '',
        update_channel: (inst.updateChannel as string) || 'stable',
        comfyui_version: (inst.comfyuiVersion as string) || '',
        snapshot_count: entries.length,
        last_launched_at: (inst.lastLaunchedAt as number | undefined) ?? null,
        latest_snapshot: latest
          ? {
              createdAt: latest.createdAt,
              trigger: latest.trigger,
              // User-typed snapshot labels can carry PII / paths /
              // model names — the inventory event bypasses the
              // renderer-side `scrubAll` pass (it goes via `addAction`
              // directly to RUM with arrays of objects), so we
              // collapse the label to a presence boolean instead of
              // shipping the raw string.
              has_label: !!latest.label,
              comfyui: {
                ref: latest.comfyui.ref,
                commit: latest.comfyui.commit,
                releaseTag: latest.comfyui.releaseTag
              },
              custom_nodes_count: latest.customNodes.length,
              pip_packages_count: Object.keys(latest.pipPackages).length
            }
          : null,
        snapshot_diffs: [] as Array<Record<string, unknown>>
      }

      // Pack as many diffs (newest → oldest) as fit under the
      // per-install cap; truncation is tolerated silently to leave
      // room for the next install in the inventory.
      let perInstallSize = JSON.stringify(entry).length
      for (let i = 0; i < entries.length - 1; i++) {
        const newer = entries[i]!.snapshot
        const older = entries[i + 1]!.snapshot
        const d = diffSnapshots(older, newer)
        const diffEntry: Record<string, unknown> = {
          createdAt: newer.createdAt,
          trigger: newer.trigger,
          // Same PII reasoning as `latest_snapshot.has_label` above.
          has_label: !!newer.label,
          nodesAdded: d.nodesAdded.length,
          nodesRemoved: d.nodesRemoved.length,
          nodesChanged: d.nodesChanged.length,
          pipsAdded: d.pipsAdded.length,
          pipsRemoved: d.pipsRemoved.length,
          pipsChanged: d.pipsChanged.length,
          comfyuiChanged: d.comfyuiChanged,
          updateChannelChanged: d.updateChannelChanged
        }
        const diffSize = JSON.stringify(diffEntry).length + 1
        if (perInstallSize + diffSize > MAX_PER_INSTALL_BYTES) break
        ;(entry.snapshot_diffs as Array<Record<string, unknown>>).push(diffEntry)
        perInstallSize += diffSize
      }

      const entrySize = JSON.stringify(entry).length + 1
      if (runningSize + entrySize > MAX_TOTAL_BYTES) {
        result.truncated = true
        break
      }
      result.installs.push(entry)
      result.included_install_count += 1
      runningSize += entrySize
    }

    return result
  })

  ipcMain.handle('get-installation-dd-context', async (_event, installationId: string) => {
    const MAX_CONTEXT_BYTES = 200 * 1024
    const inst = await installations.get(installationId)
    if (!inst || !inst.installPath) return null

    const entries = await listSnapshots(inst.installPath)
    const latest = entries.length > 0 ? entries[0]!.snapshot : null

    const copiedFrom = inst.copiedFrom as string | undefined
    const copyReason = inst.copyReason as string | undefined

    let diskFreeGb: number | null = null
    let diskTotalGb: number | null = null
    try {
      const disk = await getDiskSpace(inst.installPath)
      diskFreeGb = Math.round(disk.free / 1073741824)
      diskTotalGb = Math.round(disk.total / 1073741824)
    } catch {}

    const result = {
      installation_id: inst.id,
      variant: (inst.variant as string) || '',
      source_id: (inst.sourceId as string) || '',
      update_channel: (inst.updateChannel as string) || 'stable',
      comfyui_version: (inst.comfyuiVersion as string) || '',
      ...(copiedFrom ? { copied_from: copiedFrom } : {}),
      ...(copyReason ? { copy_reason: copyReason } : {}),
      snapshot_count: entries.length,
      disk_free_gb: diskFreeGb,
      disk_total_gb: diskTotalGb,
      latest_snapshot: latest
        ? {
            createdAt: latest.createdAt,
            trigger: latest.trigger,
            label: latest.label,
            comfyui: {
              ref: latest.comfyui.ref,
              commit: latest.comfyui.commit,
              releaseTag: latest.comfyui.releaseTag,
              variant: latest.comfyui.variant
            },
            customNodes: latest.customNodes.map((n) => ({
              id: n.id,
              type: n.type,
              dirName: n.dirName,
              enabled: n.enabled,
              version: n.version,
              commit: n.commit
            })),
            pipPackages: latest.pipPackages,
            pythonVersion: latest.pythonVersion,
            updateChannel: latest.updateChannel
          }
        : null,
      snapshot_diffs: [] as Array<Record<string, unknown>>
    }

    let runningSize = JSON.stringify(result).length
    for (let i = 0; i < entries.length - 1; i++) {
      const newer = entries[i]!.snapshot
      const older = entries[i + 1]!.snapshot
      const diff = diffSnapshots(older, newer)
      const entry: Record<string, unknown> = {
        createdAt: newer.createdAt,
        trigger: newer.trigger,
        label: newer.label,
        nodesAdded: diff.nodesAdded.map((n) => ({
          id: n.id,
          type: n.type,
          dirName: n.dirName,
          enabled: n.enabled,
          version: n.version,
          commit: n.commit
        })),
        nodesRemoved: diff.nodesRemoved.map((n) => ({
          id: n.id,
          type: n.type,
          dirName: n.dirName,
          enabled: n.enabled,
          version: n.version,
          commit: n.commit
        })),
        nodesChanged: diff.nodesChanged.map((n) => ({ id: n.id, from: n.from, to: n.to })),
        pipsAdded: diff.pipsAdded,
        pipsRemoved: diff.pipsRemoved,
        pipsChanged: diff.pipsChanged,
        comfyuiChanged: diff.comfyuiChanged,
        updateChannelChanged: diff.updateChannelChanged
      }
      if (diff.comfyui) {
        entry.comfyui = {
          from: { ref: diff.comfyui.from.ref, commit: diff.comfyui.from.commit },
          to: { ref: diff.comfyui.to.ref, commit: diff.comfyui.to.commit }
        }
      }
      if (diff.updateChannel) {
        entry.updateChannel = diff.updateChannel
      }
      const entrySize = JSON.stringify(entry).length + 1
      if (runningSize + entrySize > MAX_CONTEXT_BYTES) break
      result.snapshot_diffs.push(entry)
      runningSize += entrySize
    }

    return result
  })

  ipcMain.handle('get-device-id', () => getDeviceId())
}
