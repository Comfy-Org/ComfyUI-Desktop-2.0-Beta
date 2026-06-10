import fs from 'fs'
import path from 'path'
import { fetchJSON } from '../../lib/fetch'
import { parseArgs, extractPort, formatTime } from '../../lib/util'
import { t } from '../../lib/i18n'
import { launchAction } from '../../lib/actions'
import { getLatestStableTag, getStableTags } from '../../lib/comfyui-releases'
import { copyDirWithProgress } from '../../lib/copy'
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

/**
 * Build a variant card FieldOption from a single R2 bundle release. Shared by
 * the install-wizard variant list (newest bundle per vendor) and the
 * snapshot-load flow (a specific historical bundle). `displayStableTag`, when
 * set, advertises the upstream stable version the post-install update lands on
 * instead of the bundle's checked-in ComfyUI version.
 */
function buildVariantOption(
  vendorId: string,
  release: R2Variant,
  displayStableTag: string | null,
  gpu: string | undefined
): FieldOption {
  const sizeMB = (release.size / 1048576).toFixed(0)
  const downloadFiles = [{
    url: `${R2_BASE_URL}/${vendorId}/${release.tag}/${release.file}`,
    filename: release.file,
    size: release.size,
  }]
  const displayVersion = displayStableTag
    ? displayStableTag.replace(/^v/, '')
    : release.comfyui_version
  return {
    value: vendorId,
    label: getVariantLabel(vendorId),
    description: `ComfyUI ${displayVersion}  ·  Python ${release.python_version}  ·  ${sizeMB} MB`,
    data: {
      variantId: vendorId,
      manifest: { id: vendorId, comfyui_ref: release.comfyui_version, python_version: release.python_version },
      downloadFiles,
      downloadUrl: downloadFiles[0]!.url,
      r2Release: release,
    } as unknown as Record<string, unknown>,
    recommended: recommendVariant(vendorId, gpu),
  }
}

/**
 * Resolve a variant card pinned to a specific historical bundle `releaseTag`
 * for `variantId`, using the vendor history carried on a 'release' FieldOption.
 * Lets the snapshot-load flow recreate the exact standalone environment a
 * snapshot was captured on. Returns null when that tag is no longer in R2
 * (pruned), so the caller can fall back to the newest bundle for the channel.
 */
export function buildPinnedVariant(
  release: FieldOption,
  variantId: string,
  releaseTag: string,
  gpu?: string
): FieldOption | null {
  const releaseData = release.data as { vendorReleases?: Record<string, R2Variant[]> } | undefined
  const history = releaseData?.vendorReleases?.[variantId]
  if (!history) return null
  const exact = history.find((r) => r.tag === releaseTag)
  if (!exact) return null
  return buildVariantOption(variantId, exact, null, gpu)
}

export const standalone: SourcePlugin = {
  id: 'standalone',
  get label() { return t('standalone.label') },
  get description() { return t('standalone.desc') },
  category: 'local',

  get fields() {
    return [
      { id: 'release', label: t('common.release'), type: 'select' as const },
      // Last-N stable tags ordered newest first. Only shown for the 'stable'
      // channel; the 'latest' channel always follows master HEAD by definition,
      // and a tag picker there would contradict the channel intent. The
      // wizard renders an empty/disabled select on 'latest' (zero options).
      { id: 'comfyVersion', label: t('standalone.comfyVersion'), type: 'select' as const },
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
    // The release dropdown values now match the IPP channel ids.
    // BOTH options trigger the post-install update step — the bundle
    // ships with whatever commit was current when the R2 artefact was
    // built, which is necessarily behind master AND usually behind the
    // latest stable tag too. So:
    //   - 'stable' → autoUpdateComfyUI + updateChannel='stable' →
    //     post-install checks out the latest stable tag.
    //   - 'latest' → autoUpdateComfyUI + updateChannel='latest' →
    //     post-install fast-forwards to master HEAD ('Latest on GitHub'
    //     means actually-on-GitHub, not bundle-time).
    // The same `updateChannel` is consumed by the IPP Update tab so
    // future channel-switches stay consistent with the install-time pick.
    const isStable = selections.release?.value === 'stable'
    const isLatest = selections.release?.value === 'latest'
    const releaseTag = r2Release?.tag || (selections.release?.value || 'unknown')
    // Only honour a comfyVersion pick on the stable channel; getFieldOptions
    // returns [] for 'latest', so any stale value carried in selections from
    // a prior channel toggle is dropped here as a defence-in-depth.
    const pickedComfyTag = isStable
      ? (typeof selections.comfyVersion?.value === 'string' && /^v\d+\.\d+\.\d+$/.test(selections.comfyVersion.value)
          ? selections.comfyVersion.value
          : undefined)
      : undefined
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
      ...(isStable || isLatest ? { autoUpdateComfyUI: true } : {}),
      ...(isStable ? { updateChannel: 'stable' } : {}),
      ...(isLatest ? { updateChannel: 'latest' } : {}),
      ...(pickedComfyTag ? { comfyVersionTag: pickedComfyTag } : {}),
    }
  },

  getLaunchCommand(installation: InstallationRecord): LaunchCommand | null {
    // `getActivePythonPath` is adopted-aware: returns `adoptedPythonPath`
    // for legacy-desktop adoptions and the managed `ComfyUI/.venv` python
    // otherwise.
    const adopted = installation.adopted === true
    const pythonPath = getActivePythonPath(installation)
    if (!pythonPath || !fs.existsSync(pythonPath)) return null
    const mainPy = path.join(installation.installPath, 'ComfyUI', 'main.py')
    if (!fs.existsSync(mainPy)) return null
    const userArgs = ((installation.launchArgs as string | undefined) ?? DEFAULT_LAUNCH_ARGS).trim()
    const parsed = userArgs.length > 0 ? parseArgs(userArgs) : []
    const port = extractPort(parsed)
    // Adopted installs keep their data (models, user, input, output,
    // custom_nodes) at the legacy basePath. `--base-directory` and
    // `--user-directory` are structural plumbing the user shouldn't need
    // to touch, so pin them here. Input/output are first-class per-install
    // fields (`installation.inputDir` / `outputDir`) handled by launch.ts'
    // shared-input-output branch — adopted records ship with both set to
    // `<legacyBasePath>/{input,output}` so the end result is the same.
    //
    // `--database-url` is also pinned: ComfyUI's default DB path resolves
    // to `<source>/../user/comfyui.db`, which for an adopted install
    // points at the empty `<newInstallPath>/user/` (parent dir doesn't
    // exist) → SQLite "unable to open database file". The user's real
    // SQLite DB lives in the legacy user dir, so point ComfyUI at it
    // explicitly. Skipped when the user already set their own
    // `--database-url` in launchArgs.
    const adoptedBaseDir = adopted ? (installation.adoptedBaseDir as string | undefined) : undefined
    const userSetDatabaseUrl = parsed.some(
      (a) => a === '--database-url' || a.startsWith('--database-url=')
    )
    const adoptArgs = adoptedBaseDir
      ? [
          '--base-directory', adoptedBaseDir,
          '--user-directory', path.join(adoptedBaseDir, 'user'),
          ...(userSetDatabaseUrl
            ? []
            : ['--database-url', `sqlite:///${path.join(adoptedBaseDir, 'user', 'comfyui.db')}`]),
        ]
      : []
    // Desktop-managed feature flags (e.g. show_signin_button) are injected in
    // handleLaunch after we discover the running ComfyUI's feature-flag registry,
    // so we only set keys the install actually knows about.
    return {
      cmd: pythonPath,
      args: ['-s', path.join('ComfyUI', 'main.py'), ...adoptArgs, ...parsed],
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

  async fixupCopy(
    inst: InstallationRecord,
    destPath: string,
    sendProgress: (phase: string, detail: Record<string, unknown>) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    await writeComfyEnvironment(path.join(destPath, 'ComfyUI'))

    const adopted = inst.adopted === true
    const adoptedBaseDir = adopted ? (inst.adoptedBaseDir as string | undefined) : undefined

    // For an adopted install, the wrapper at `installPath` only contains
    // the freshly cloned ComfyUI source — the venv and user data live
    // under `adoptedBaseDir`. We need to pull those over too so the copy
    // is a self-contained install that can run independently of the
    // original Legacy Desktop workspace.
    //
    // Models are deliberately NOT copied — they remain shared via the
    // global `modelsDirs` setting (inherited from the source record),
    // matching the source's `useSharedModels: true`. This keeps the
    // copy cheap and avoids duplicating multi-GB checkpoint files.
    if (adopted && adoptedBaseDir && fs.existsSync(adoptedBaseDir)) {
      // Order matters only for cancellation responsiveness — the venv is
      // by far the largest, so put it first to surface progress quickly.
      const carryOver = ['.venv', 'user', 'custom_nodes', 'input', 'output']
      const destComfyUI = path.join(destPath, 'ComfyUI')
      for (const entry of carryOver) {
        if (signal?.aborted) return
        const src = path.join(adoptedBaseDir, entry)
        if (!fs.existsSync(src)) continue
        const dst = path.join(destComfyUI, entry)
        // Skip if the wrapper copy already placed an entry there (the
        // upstream ComfyUI clone has empty `input/`, `output/`,
        // `custom_nodes/` checked in). Remove the empty placeholder
        // first so the merge isn't ambiguous.
        if (fs.existsSync(dst)) {
          try { await fs.promises.rm(dst, { recursive: true, force: true }) } catch {}
        }
        sendProgress('copy', { percent: 0, status: `Copying legacy ${entry}…` })
        await copyDirWithProgress(src, dst, (copied, total, elapsedSecs, etaSecs) => {
          const percent = total > 0 ? Math.round((copied / total) * 100) : 0
          const elapsed = formatTime(elapsedSecs)
          const eta = etaSecs >= 0 ? formatTime(etaSecs) : '—'
          sendProgress('copy', {
            percent,
            status: `Copying legacy ${entry}  ${copied} / ${total}  ·  ${elapsed} elapsed  ·  ${eta} remaining`,
          })
        }, { signal })
      }
    }

    const venvPath = getVenvDir(destPath)
    if (!fs.existsSync(venvPath)) return

    // Path-rewrite source for the venv metadata:
    //   - managed: pyvenv.cfg references `<installPath>/ComfyUI/.venv/...`
    //     → rewrite `<installPath>` → `<destPath>`.
    //   - adopted: pyvenv.cfg references `<adoptedBaseDir>/.venv/...`
    //     → rewrite `<adoptedBaseDir>` → `<destPath>/ComfyUI`, since the
    //     venv now lives one directory deeper than it did in the legacy
    //     workspace.
    const srcRewriteFrom = adopted && adoptedBaseDir ? adoptedBaseDir : inst.installPath
    const srcRewriteTo = adopted && adoptedBaseDir ? path.join(destPath, 'ComfyUI') : destPath

    const cfgPath = path.join(venvPath, 'pyvenv.cfg')
    if (fs.existsSync(cfgPath)) {
      let content = await fs.promises.readFile(cfgPath, 'utf-8')
      content = content.replaceAll(srcRewriteFrom, srcRewriteTo)
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
            if (content.startsWith('#!') && content.includes(srcRewriteFrom)) {
              content = content.replaceAll(srcRewriteFrom, srcRewriteTo)
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

      // Always revalidate R2 manifests when populating the install wizard —
      // a stale persisted ETag can otherwise hide a freshly-shipped standalone
      // release and strand new installs on whatever the previous run cached.
      const latest = await fetchJSON(`${R2_BASE_URL}/latest.json`, { refresh: true }) as R2Latest
      const vendorIds = Object.keys(latest).filter((id) => id.startsWith(prefix))
      if (vendorIds.length === 0) return []

      const vendorReleases = Object.fromEntries(
        await Promise.all(vendorIds.map(async (id) => {
          const data = await fetchJSON(`${R2_BASE_URL}/${id}/releases.json`, { refresh: true }) as R2VendorReleases
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

      // Same two channel options the IPP Update tab uses (see
      // `getChannelDefs()` in `./updateSections.ts`). 'stable' is
      // recommended and triggers the post-install update-to-stable
      // step. 'latest' (master HEAD) leaves the bundle's checked-in
      // commit alone — the user can fast-forward from the IPP Update
      // tab. Per-bundle-tag entries (v0.20.1-env1, etc.) were dropped
      // at the same time; they exposed an implementation detail
      // (the R2 bundle tag) instead of the channel users actually
      // care about.
      if (tags.length > 0 && context?.includeLatestStable) {
        const latestStableTag = await getLatestStableTag()
        const newestBundle = tags[0]!
        options.push({
          value: 'stable',
          label: t('standalone.channelStable'),
          description: t('standalone.channelStableDesc'),
          recommended: true,
          // `latestStableTag` is the upstream ComfyUI version the post-install
          // "update to stable" step resolves to. Thread it through so the
          // variant cards show that same version rather than the older
          // ComfyUI baked into the standalone bundle (issue #708).
          data: { tag: newestBundle.tag, vendorReleases, latestStableTag } as unknown as Record<string, unknown>,
        })
        options.push({
          value: 'latest',
          label: t('standalone.channelLatest'),
          description: t('standalone.channelLatestDesc'),
          data: { tag: newestBundle.tag, vendorReleases } as unknown as Record<string, unknown>,
        })
      }
      return options
    }

    if (fieldId === 'comfyVersion') {
      // The picker is only meaningful on 'stable' — 'latest' tracks master
      // HEAD by intent, and the post-install update already fast-forwards
      // there. Returning [] makes the wizard render an empty/disabled select.
      if (selections.release?.value !== 'stable') return []
      const tags = await getStableTags()
      if (tags.length === 0) return []
      // Newest first; the wizard auto-selects the `recommended` option so
      // the default lands on the most recent stable tag.
      return tags.map((tag, i) => ({
        value: tag,
        label: tag,
        recommended: i === 0,
        description: i === 0 ? t('newInstall.latestStable') : undefined,
      }))
    }

    if (fieldId === 'variant') {
      const releaseData = selections.release?.data as { tag: string; vendorReleases: Record<string, R2Variant[]>; latestStableTag?: string | null } | undefined
      if (!releaseData) return []
      const prefix = PLATFORM_PREFIX[process.platform]
      if (!prefix) return []

      const isStable = selections.release?.value === 'stable'
      const gpu = context?.gpu as string | undefined
      // When the user picked a specific stable tag from the comfyVersion
      // dropdown, the variant card should advertise THAT version (the one
      // the post-install update checks out), not the channel head. Falls
      // back to the channel-head's resolved tag when no pick was made.
      const pickedComfyTag =
        isStable && typeof selections.comfyVersion?.value === 'string'
          && /^v\d+\.\d+\.\d+$/.test(selections.comfyVersion.value)
          ? selections.comfyVersion.value
          : null

      return Object.entries(releaseData.vendorReleases)
        .filter(([vendorId]) => vendorId.startsWith(prefix))
        .map(([vendorId, releases]): FieldOption | null => {
          const release = releases[0]
          if (!release) return null
          // Stable: advertise the upstream tag the user lands on after the
          // post-install auto-update (picked tag wins; otherwise channel
          // head). Falls back to the bundled version when neither is
          // resolvable (offline, etc.).
          const displayStableTag = isStable
            ? pickedComfyTag ?? releaseData.latestStableTag ?? null
            : null
          return buildVariantOption(vendorId, release, displayStableTag, gpu)
        })
        .filter((item): item is FieldOption => item != null)
    }

    return []
  },
}
