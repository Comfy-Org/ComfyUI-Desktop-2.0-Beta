import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { downloadAndExtract, downloadAndExtractMulti } from '../../lib/installer'
import { copyDirWithProgress } from '../../lib/copy'
import { readGitHead, isGitAvailable, isPygit2Configured, tryConfigurePygit2Fallback, fetchTags } from '../../lib/git'
import { resolveLocalVersion } from '../../lib/version-resolve'
import { formatTime } from '../../lib/util'
import { t } from '../../lib/i18n'
import * as snapshots from '../../lib/snapshots'
import { fetchLatestRelease } from '../../lib/comfyui-releases'
import { repairMacBinaries, codesignBinaries } from './macRepair'
import { runComfyUIUpdate } from './updateOrchestrator'
import {
  MANIFEST_FILE, DEFAULT_LAUNCH_ARGS,
  getUvPath, getVenvDir, findSitePackages, getMasterPythonPath,
  writeComfyEnvironment,
} from './envPaths'
import type { InstallationRecord } from '../../installations'
import { tagsEqual, type ComfyVersion } from '../../lib/version'
import type { InstallTools, PostInstallTools } from '../../types/sources'

const BULKY_PREFIXES = ['torch', 'nvidia', 'triton', 'cuda']

async function stripMasterPackages(installPath: string): Promise<void> {
  try {
    const sitePackages = findSitePackages(path.join(installPath, 'standalone-env'))
    if (!sitePackages || !fs.existsSync(sitePackages)) return

    const entries = await fs.promises.readdir(sitePackages, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const lower = entry.name.toLowerCase()
      if (BULKY_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
        await fs.promises.rm(path.join(sitePackages, entry.name), { recursive: true, force: true })
      }
    }
  } catch (err) {
    console.warn('Failed to strip master packages:', err)
  }
}

async function createEnv(
  installPath: string,
  onProgress: (copied: number, total: number, elapsedSecs: number, etaSecs: number) => void,
  signal?: AbortSignal
): Promise<void> {
  const uvPath = getUvPath(installPath)
  const masterPython = getMasterPythonPath(installPath)
  const venvPath = getVenvDir(installPath)
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled'))
    const proc = execFile(uvPath, ['venv', '--python', masterPython, venvPath], { cwd: installPath }, (err, _stdout, stderr) => {
      if (signal?.aborted) return reject(new Error('Cancelled'))
      if (err) return reject(new Error(`Failed to create .venv: ${stderr || err.message}`))
      resolve()
    })
    signal?.addEventListener('abort', () => { try { proc.kill() } catch {} }, { once: true })
  })

  try {
    const masterSitePackages = findSitePackages(path.join(installPath, 'standalone-env'))
    const envSitePackages = findSitePackages(venvPath)
    if (!masterSitePackages || !envSitePackages || !fs.existsSync(masterSitePackages)) {
      throw new Error('Could not locate site-packages for .venv.')
    }
    await copyDirWithProgress(masterSitePackages, envSitePackages, onProgress, { signal })
    await codesignBinaries(envSitePackages)
  } catch (err) {
    await fs.promises.rm(venvPath, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

export async function install(installation: InstallationRecord, tools: InstallTools): Promise<void> {
  const files = installation.downloadFiles as Array<{ url: string; filename: string; size: number }> | undefined
  if (files && files.length > 0) {
    const cacheDir = `${installation.releaseTag as string}_${installation.variant as string}`
    await downloadAndExtractMulti(files, installation.installPath, cacheDir, tools)
  } else if (installation.downloadUrl as string | undefined) {
    const downloadUrl = installation.downloadUrl as string
    const filename = downloadUrl.split('/').pop()!
    const cacheKey = `${installation.releaseTag as string}_${filename}`
    await downloadAndExtract(downloadUrl, installation.installPath, cacheKey, tools)
  }
}

export async function postInstall(installation: InstallationRecord, { sendProgress, update, signal }: PostInstallTools): Promise<void> {
  const standaloneEnvDir = path.join(installation.installPath, 'standalone-env')
  if (process.platform !== 'win32') {
    const binDir = path.join(standaloneEnvDir, 'bin')
    try {
      const entries = fs.readdirSync(binDir)
      for (const entry of entries) {
        const fullPath = path.join(binDir, entry)
        try { fs.chmodSync(fullPath, 0o755) } catch {}
      }
    } catch {}
  }
  await repairMacBinaries(installation.installPath, sendProgress)
  if (signal?.aborted) throw new Error('Cancelled')
  sendProgress('setup', { percent: 0, status: 'Creating Python environment…' })
  await createEnv(installation.installPath, (copied, total, elapsedSecs, etaSecs) => {
    const percent = Math.round((copied / total) * 100)
    const elapsed = formatTime(elapsedSecs)
    const eta = etaSecs >= 0 ? formatTime(etaSecs) : '—'
    sendProgress('setup', { percent, status: `Copying packages… ${copied} / ${total} files  ·  ${elapsed} elapsed  ·  ${eta} remaining` })
  }, signal)
  if (signal?.aborted) throw new Error('Cancelled')
  sendProgress('cleanup', { percent: -1, status: t('standalone.cleanupEnvStatus') })
  await stripMasterPackages(installation.installPath)

  // Populate comfyVersion now so version displays are correct without waiting
  // for the first update. Without a global git binary, configure pygit2 against
  // the just-installed standalone Python so tag resolution works.
  if (!isPygit2Configured() && !await isGitAvailable()) {
    await tryConfigurePygit2Fallback(installation.installPath)
  }
  const comfyuiDir = path.join(installation.installPath, 'ComfyUI')
  await writeComfyEnvironment(comfyuiDir)
  sendProgress('cleanup', { percent: -1, status: 'Fetching version tags…' })
  await fetchTags(comfyuiDir)
  const headCommit = readGitHead(comfyuiDir)
  if (headCommit) {
    const ref = installation.version as string | undefined
    const comfyVersion = await resolveLocalVersion(comfyuiDir, headCommit, ref)
    await update({ comfyVersion })
    installation = { ...installation, comfyVersion } as InstallationRecord
  }

  // Capture initial snapshot so the detail view shows "Current" immediately.
  try {
    const filename = await snapshots.saveSnapshot(installation.installPath, installation, 'boot')
    const snapshotCount = await snapshots.getSnapshotCount(installation.installPath)
    await update({ lastSnapshot: filename, snapshotCount })
  } catch (err) {
    console.warn('Initial snapshot failed:', err)
  }

  // Auto-update to the channel the user picked on the install wizard.
  // `installation.updateChannel` is set by `buildInstallation`:
  // 'stable' → check out the latest stable tag; 'latest' → fast-forward
  // to master HEAD. Defaults to 'stable' for installs created before
  // the channel split, where `autoUpdateComfyUI` implicitly meant stable.
  if (installation.autoUpdateComfyUI && fs.existsSync(path.join(comfyuiDir, '.git'))) {
    if (signal?.aborted) throw new Error('Cancelled')
    const channel: 'stable' | 'latest' =
      (installation.updateChannel as 'stable' | 'latest' | undefined) ?? 'stable'
    // The wizard's version picker pins an explicit stable tag for the install.
    // When set, the post-install update checks out that tag instead of
    // resolving the channel head, so the user lands on the version they
    // picked even if a newer one shipped between selection and download.
    const pickedTag = installation.comfyVersionTag as string | undefined
    const channelLabel = pickedTag
      ? `ComfyUI ${pickedTag}`
      : channel === 'latest' ? 'latest version' : 'latest stable version'
    sendProgress('update', { percent: -1, status: `Fetching ${channelLabel}` })

    try {
      // Bypass the in-memory tag cache, which can be poisoned with `null` at
      // startup before any git backend is configured. `tryConfigurePygit2Fallback`
      // above has since configured pygit2, so the refreshed lookup fires.
      const latestRelease = await fetchLatestRelease(channel, { refresh: true })
      const latestTag = latestRelease?.tag_name as string | undefined
      const current = installation.comfyVersion as ComfyVersion | undefined
      const onLatestTag = !!latestTag && tagsEqual(current?.baseTag, latestTag) && current?.commitsAhead === 0
      const onPickedTag = !!pickedTag && tagsEqual(current?.baseTag, pickedTag) && current?.commitsAhead === 0

      if (!latestTag && !pickedTag) {
        // A network flake must not masquerade as "up to date" — that stranded
        // first installs on the bundled version.
        sendProgress('update', { percent: 100, status: `Skipped — could not verify ${channelLabel}` })
      } else if (pickedTag ? onPickedTag : onLatestTag) {
        sendProgress('update', { percent: 100, status: 'Already up to date' })
      } else {
        const result = await runComfyUIUpdate({
          installPath: installation.installPath,
          installation,
          channel,
          ...(pickedTag ? { targetTag: pickedTag } : {}),
          update,
          sendProgress: sendProgress as (step: string, data: Record<string, unknown>) => void,
          signal,
          // The standalone bundle ships a pre-extracted venv whose pinned
          // versions can lag ComfyUI's own `requirements.txt` (most visibly
          // `comfy-aimdo`, which crashes on import when the venv's copy is
          // older than what ComfyUI's source expects). Force a `pip install
          // --upgrade -r requirements.txt` after the post-install git update,
          // even when the file is byte-identical pre/post, so the venv always
          // ends up in sync with ComfyUI's pins before the user runs anything.
          forceDepsSync: true,
        })
        installation = result.installation
        if (result.ok) {
          sendProgress('update', { percent: 100, status: 'Up to date' })
        } else {
          sendProgress('update', { percent: 100, status: 'Skipped (update failed)' })
        }
      }
    } catch (err) {
      if ((err as Error).message === 'Cancelled') throw err
      console.warn(`Auto-update to ${channel} failed:`, err)
      sendProgress('update', { percent: 100, status: 'Skipped' })
    }
  }
}

export async function probeInstallation(dirPath: string): Promise<Record<string, unknown> | null> {
  const envExists = fs.existsSync(path.join(dirPath, 'standalone-env'))
  const mainExists = fs.existsSync(path.join(dirPath, 'ComfyUI', 'main.py'))
  if (!envExists || !mainExists) return null
  const hasVenv = fs.existsSync(path.join(dirPath, 'ComfyUI', '.venv'))
  const hasLegacyEnvs = fs.existsSync(path.join(dirPath, 'envs'))
  const hasGit = fs.existsSync(path.join(dirPath, 'ComfyUI', '.git'))

  let version = 'unknown'
  let releaseTag = ''
  let variant = ''
  let pythonVersion = ''
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dirPath, MANIFEST_FILE), 'utf8')) as Record<string, string>
    version = data.comfyui_ref || version
    releaseTag = data.version || releaseTag
    variant = data.id || variant
    pythonVersion = data.python_version || pythonVersion
  } catch {}

  let comfyVersion: ComfyVersion | undefined
  if (hasGit) {
    const comfyuiDir = path.join(dirPath, 'ComfyUI')
    const commit = readGitHead(comfyuiDir)
    if (commit) {
      const manifestTag = version !== 'unknown' ? version : undefined
      comfyVersion = await resolveLocalVersion(comfyuiDir, commit, manifestTag)
    }
  }

  return {
    version,
    ...(comfyVersion ? { comfyVersion } : {}),
    releaseTag,
    variant,
    pythonVersion,
    hasGit,
    launchArgs: DEFAULT_LAUNCH_ARGS,
    launchMode: 'window',
    ...(hasLegacyEnvs && !hasVenv ? { needsEnvMigration: true } : {}),
  }
}

export async function migrateEnvLayout(
  installPath: string,
  update: (data: Record<string, unknown>) => Promise<unknown>,
  sendProgress?: (step: string, data: { percent: number; status: string }) => void,
): Promise<boolean> {
  const venvDir = getVenvDir(installPath)
  if (fs.existsSync(venvDir)) return false

  const legacyEnvDir = path.join(installPath, 'envs', 'default')
  if (!fs.existsSync(legacyEnvDir)) return false

  sendProgress?.('migration', { percent: 0, status: 'Migrating environment layout…' })

  await fs.promises.rename(legacyEnvDir, venvDir)

  // Rewrite the pyvenv.cfg home path (old path included envs/default/).
  const cfgPath = path.join(venvDir, 'pyvenv.cfg')
  if (fs.existsSync(cfgPath)) {
    let content = await fs.promises.readFile(cfgPath, 'utf-8')
    const oldEnvPath = path.join(installPath, 'envs', 'default')
    content = content.replaceAll(oldEnvPath, venvDir)
    await fs.promises.writeFile(cfgPath, content, 'utf-8')
  }

  // Rewrite shebangs on unix.
  if (process.platform !== 'win32') {
    const binDir = path.join(venvDir, 'bin')
    if (fs.existsSync(binDir)) {
      const entries = await fs.promises.readdir(binDir, { withFileTypes: true })
      const oldEnvPath = path.join(installPath, 'envs', 'default')
      for (const entry of entries) {
        if (!entry.isFile()) continue
        const filePath = path.join(binDir, entry.name)
        try {
          let content = await fs.promises.readFile(filePath, 'utf-8')
          if (content.startsWith('#!') && content.includes(oldEnvPath)) {
            content = content.replaceAll(oldEnvPath, venvDir)
            await fs.promises.writeFile(filePath, content, 'utf-8')
          }
        } catch {}
      }
    }
  }

  // Re-codesign moved binaries on macOS.
  if (process.platform === 'darwin') {
    sendProgress?.('migration', { percent: 50, status: 'Codesigning migrated binaries…' })
    await codesignBinaries(venvDir)
  }

  const envsDir = path.join(installPath, 'envs')
  try {
    const remaining = await fs.promises.readdir(envsDir)
    if (remaining.length === 0) {
      await fs.promises.rmdir(envsDir)
    }
  } catch {}

  await update({ activeEnv: undefined, envMethods: undefined, needsEnvMigration: undefined })

  sendProgress?.('migration', { percent: 100, status: 'Migration complete' })
  return true
}
