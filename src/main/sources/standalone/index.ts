import fs from 'fs'
import path from 'path'
import { fetchJSON } from '../../lib/fetch'
import { parseArgs, extractPort } from '../../lib/util'
import { t } from '../../lib/i18n'
import { launchAction } from '../../lib/actions'
import { getLatestStableTag } from '../../lib/comfyui-releases'
import {
  PLATFORM_PREFIX, DEFAULT_LAUNCH_ARGS,
  getVariantLabel, stripPlatform, getActivePythonPath,
  getVenvDir, recommendVariant, writeComfyEnvironment,
} from './envPaths'
import { install, postInstall, probeInstallation } from './install'
import { getListPreview, getStatusTag, getDetailSections, R2_BASE_URL } from './updateSections'
import { handleAction } from './actions'
import type { InstallationRecord } from '../../installations'
import type {
  SourcePlugin,
  FieldOption,
  LaunchCommand,
} from '../../types/sources'

export { getVariantLabel } from './envPaths'

// --- R2 release types ---

interface R2Variant {
  tag: string
  comfyui_version: string
  comfyui_commit: string
  build: number
  date: string
  file: string
  size: number
  python_version: string
  torch_version: string
  torchvision_version?: string
  torchaudio_version?: string
}

/** latest.json: vendor_id → newest release */
type R2Latest = Record<string, R2Variant>

/** {vendor}/releases.json: full history for one vendor */
interface R2VendorReleases {
  releases: R2Variant[]
}

interface VariantData {
  variantId: string
  manifest: { id: string; comfyui_ref: string; python_version: string }
  downloadUrl: string
  downloadFiles: { url: string; filename: string; size: number }[]
}

export const standalone: SourcePlugin = {
  id: 'standalone',
  get label() { return t('standalone.label') },
  get description() { return t('standalone.desc') },
  category: 'local',

  get fields() {
    return [
      { id: 'release', label: t('common.release'), type: 'select' as const },
      { id: 'variant', label: t('standalone.variant'), type: 'select' as const, renderAs: 'cards' as const },
    ]
  },

  defaultLaunchArgs: DEFAULT_LAUNCH_ARGS,

  get installSteps() {
    return [
      { phase: 'download', label: t('common.download') },
      { phase: 'extract', label: t('common.extract') },
      { phase: 'setup', label: t('standalone.setupEnv') },
      { phase: 'cleanup', label: t('standalone.cleanupEnv') },
      { phase: 'update', label: t('standalone.updateToStable') },
    ]
  },

  getDefaults() {
    return { launchArgs: DEFAULT_LAUNCH_ARGS, launchMode: 'window', portConflict: 'auto' }
  },

  getListPreview,
  getStatusTag,
  getDetailSections,

  buildInstallation(selections: Record<string, FieldOption | undefined>): Record<string, unknown> {
    const vd = selections.variant?.data as (VariantData & { r2Release?: R2Variant }) | undefined
    const manifest = vd?.manifest
    const r2Release = vd?.r2Release
    const variantId = vd?.variantId || ''
    const isCpu = stripPlatform(variantId) === 'cpu' || stripPlatform(variantId).startsWith('cpu-')
    const isLatest = selections.release?.value === 'latest'
    const releaseTag = r2Release?.tag || (selections.release?.value || 'unknown')
    return {
      version: r2Release?.comfyui_version || manifest?.comfyui_ref || releaseTag,
      releaseTag,
      variant: variantId,
      downloadUrl: vd?.downloadUrl || '',
      downloadFiles: vd?.downloadFiles || [],
      pythonVersion: manifest?.python_version || '',
      // Frozen install-time fingerprint. Used to detect when a newer standalone
      // ships an incompatible Python/torch and the user should be informed they
      // can migrate to a fresh install. We store these explicitly rather than
      // derive them from releases.json so the comparison stays correct even if
      // history is pruned in the future.
      ...(r2Release?.build !== undefined ? { originalBuild: r2Release.build } : {}),
      ...(r2Release?.torch_version ? { originalTorchVersion: r2Release.torch_version } : {}),
      launchArgs: isCpu ? `${DEFAULT_LAUNCH_ARGS} --cpu` : DEFAULT_LAUNCH_ARGS,
      launchMode: 'window',
      browserPartition: 'unique',
      ...(isLatest ? { autoUpdateComfyUI: true } : {}),
    }
  },

  getLaunchCommand(installation: InstallationRecord): LaunchCommand | null {
    const pythonPath = getActivePythonPath(installation)
    if (!pythonPath || !fs.existsSync(pythonPath)) return null
    const mainPy = path.join(installation.installPath, 'ComfyUI', 'main.py')
    if (!fs.existsSync(mainPy)) return null
    const userArgs = ((installation.launchArgs as string | undefined) ?? DEFAULT_LAUNCH_ARGS).trim()
    const parsed = userArgs.length > 0 ? parseArgs(userArgs) : []
    const port = extractPort(parsed)
    // Desktop-managed feature flags (e.g. show_signin_button) are injected in
    // handleLaunch after we discover the running ComfyUI's feature-flag registry,
    // so we only set keys the install actually knows about.
    return {
      cmd: pythonPath,
      args: ['-s', path.join('ComfyUI', 'main.py'), ...parsed],
      cwd: installation.installPath,
      port,
    }
  },

  getListActions(installation: InstallationRecord): Record<string, unknown>[] {
    const installed = installation.status === 'installed'
    return [
      launchAction(installed, !installed ? t('errors.installNotReady') : undefined),
    ]
  },

  install,
  postInstall,
  probeInstallation,
  handleAction,

  async fixupCopy(srcPath: string, destPath: string): Promise<void> {
    await writeComfyEnvironment(path.join(destPath, 'ComfyUI'))

    const venvPath = getVenvDir(destPath)
    if (!fs.existsSync(venvPath)) return

    const cfgPath = path.join(venvPath, 'pyvenv.cfg')
    if (fs.existsSync(cfgPath)) {
      let content = await fs.promises.readFile(cfgPath, 'utf-8')
      content = content.replaceAll(srcPath, destPath)
      await fs.promises.writeFile(cfgPath, content, 'utf-8')
    }

    if (process.platform !== 'win32') {
      const binDir = path.join(venvPath, 'bin')
      if (fs.existsSync(binDir)) {
        const entries = await fs.promises.readdir(binDir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isFile()) continue
          const filePath = path.join(binDir, entry.name)
          try {
            let content = await fs.promises.readFile(filePath, 'utf-8')
            if (content.startsWith('#!') && content.includes(srcPath)) {
              content = content.replaceAll(srcPath, destPath)
              await fs.promises.writeFile(filePath, content, 'utf-8')
            }
          } catch {}
        }
      }
    }
  },

  async getFieldOptions(fieldId: string, selections: Record<string, FieldOption | undefined>, context: Record<string, unknown>): Promise<FieldOption[]> {
    if (fieldId === 'release') {
      const prefix = PLATFORM_PREFIX[process.platform]
      if (!prefix) return []

      // Fetch latest.json (tiny, pre-warmed on startup) to know which vendors exist
      const latest = await fetchJSON(`${R2_BASE_URL}/latest.json`) as R2Latest
      const vendorIds = Object.keys(latest).filter((id) => id.startsWith(prefix))
      if (vendorIds.length === 0) return []

      // Fetch per-vendor release history in parallel
      const vendorReleases = Object.fromEntries(
        await Promise.all(vendorIds.map(async (id) => {
          const data = await fetchJSON(`${R2_BASE_URL}/${id}/releases.json`) as R2VendorReleases
          return [id, data.releases] as const
        }))
      )

      // Collect unique release tags across all vendors for this platform
      const tagMap = new Map<string, { comfyui_version: string; date: string; tag: string }>()
      for (const releases of Object.values(vendorReleases)) {
        for (const release of releases) {
          if (!tagMap.has(release.tag) || release.date > tagMap.get(release.tag)!.date) {
            tagMap.set(release.tag, { comfyui_version: release.comfyui_version, date: release.date, tag: release.tag })
          }
        }
      }
      const tags = [...tagMap.values()].sort((a, b) => b.date.localeCompare(a.date))

      const options: FieldOption[] = []

      // Synthetic "Latest Stable" entry.  Resolve the upstream ComfyUI tag
      // (e.g. `v1.19.5`) via bootstrap pygit2 so users can see the concrete
      // version they'll be installing.  Falls back to no description when
      // the lookup fails (offline, pygit2 unavailable, etc.).
      if (tags.length > 0 && context?.includeLatestStable) {
        const latestStableTag = await getLatestStableTag()
        options.push({
          value: 'latest',
          label: t('standalone.latestVersion'),
          ...(latestStableTag ? { description: latestStableTag } : {}),
          recommended: true,
          data: { tag: tags[0]!.tag, vendorReleases } as unknown as Record<string, unknown>,
        })
      }

      for (const entry of tags) {
        const dateStr = entry.date.slice(0, 10)
        options.push({
          value: entry.tag,
          label: `${entry.tag}  —  ComfyUI ${entry.comfyui_version}  ·  ${dateStr}`,
          data: { tag: entry.tag, vendorReleases } as unknown as Record<string, unknown>,
        })
      }
      return options
    }

    if (fieldId === 'variant') {
      const releaseData = selections.release?.data as { tag: string; vendorReleases: Record<string, R2Variant[]> } | undefined
      if (!releaseData) return []
      const prefix = PLATFORM_PREFIX[process.platform]
      if (!prefix) return []

      const isLatest = selections.release?.value === 'latest'
      const gpu = context?.gpu as string | undefined

      return Object.entries(releaseData.vendorReleases)
        .filter(([vendorId]) => vendorId.startsWith(prefix))
        .map(([vendorId, releases]): FieldOption | null => {
          const release = isLatest
            ? releases[0]
            : releases.find((r) => r.tag === releaseData.tag)
          if (!release) return null

          const sizeMB = (release.size / 1048576).toFixed(0)
          const downloadFiles = [{
            url: `${R2_BASE_URL}/${vendorId}/${release.tag}/${release.file}`,
            filename: release.file,
            size: release.size,
          }]
          return {
            value: vendorId,
            label: getVariantLabel(vendorId),
            description: `ComfyUI ${release.comfyui_version}  ·  Python ${release.python_version}  ·  ${sizeMB} MB`,
            data: {
              variantId: vendorId,
              manifest: { id: vendorId, comfyui_ref: release.comfyui_version, python_version: release.python_version },
              downloadFiles,
              downloadUrl: downloadFiles[0]!.url,
              r2Release: release,
            } as unknown as Record<string, unknown>,
            recommended: recommendVariant(vendorId, gpu),
          }
        })
        .filter((item): item is FieldOption => item != null)
    }

    return []
  },
}
