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
import { repairMacBinaries, codesignBinaries } from './macRepair'
import {
  ENVS_DIR, DEFAULT_ENV, ENV_METHOD, MANIFEST_FILE, DEFAULT_LAUNCH_ARGS,
  getUvPath, findSitePackages, getMasterPythonPath,
} from './envPaths'
import type { InstallationRecord } from '../../installations'
import type { ComfyVersion } from '../../lib/version'
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
  envName: string,
  onProgress: (copied: number, total: number, elapsedSecs: number, etaSecs: number) => void,
  signal?: AbortSignal
): Promise<void> {
  const uvPath = getUvPath(installPath)
  const masterPython = getMasterPythonPath(installPath)
  const envPath = path.join(installPath, ENVS_DIR, envName)
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled'))
    const proc = execFile(uvPath, ['venv', '--python', masterPython, envPath], { cwd: installPath }, (err, _stdout, stderr) => {
      if (signal?.aborted) return reject(new Error('Cancelled'))
      if (err) return reject(new Error(`Failed to create environment "${envName}": ${stderr || err.message}`))
      resolve()
    })
    signal?.addEventListener('abort', () => { try { proc.kill() } catch {} }, { once: true })
  })

  try {
    const masterSitePackages = findSitePackages(path.join(installPath, 'standalone-env'))
    const envSitePackages = findSitePackages(envPath)
    if (!masterSitePackages || !envSitePackages || !fs.existsSync(masterSitePackages)) {
      throw new Error(`Could not locate site-packages for environment "${envName}".`)
    }
    await copyDirWithProgress(masterSitePackages, envSitePackages, onProgress, { signal })
    await codesignBinaries(envSitePackages)
  } catch (err) {
    await fs.promises.rm(envPath, { recursive: true, force: true }).catch(() => {})
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
  sendProgress('setup', { percent: 0, status: 'Creating default Python environment…' })
  await createEnv(installation.installPath, DEFAULT_ENV, (copied, total, elapsedSecs, etaSecs) => {
    const percent = Math.round((copied / total) * 100)
    const elapsed = formatTime(elapsedSecs)
    const eta = etaSecs >= 0 ? formatTime(etaSecs) : '—'
    sendProgress('setup', { percent, status: `Copying packages… ${copied} / ${total} files  ·  ${elapsed} elapsed  ·  ${eta} remaining` })
  }, signal)
  if (signal?.aborted) throw new Error('Cancelled')
  const envMethods = { ...(installation.envMethods as Record<string, string> | undefined), [DEFAULT_ENV]: ENV_METHOD }
  await update({ envMethods })
  sendProgress('cleanup', { percent: -1, status: t('standalone.cleanupEnvStatus') })
  await stripMasterPackages(installation.installPath)

  // Populate comfyVersion from the extracted git repo so version displays
  // are correct immediately, without waiting for the first update.
  // On machines without a global git binary, configure pygit2 using the
  // just-installed standalone Python so tag resolution works correctly.
  if (!isPygit2Configured() && !await isGitAvailable()) {
    tryConfigurePygit2Fallback(installation.installPath)
  }
  const comfyuiDir = path.join(installation.installPath, 'ComfyUI')
  sendProgress('cleanup', { percent: -1, status: 'Fetching version tags…' })
  await fetchTags(comfyuiDir)
  const headCommit = readGitHead(comfyuiDir)
  if (headCommit) {
    const ref = installation.version as string | undefined
    const comfyVersion = await resolveLocalVersion(comfyuiDir, headCommit, ref)
    await update({ comfyVersion })
    // Use updated installation for snapshot so it captures the version
    installation = { ...installation, comfyVersion } as InstallationRecord
  }

  // Capture initial snapshot so the detail view shows "Current" immediately
  try {
    const filename = await snapshots.saveSnapshot(installation.installPath, installation, 'boot')
    const snapshotCount = await snapshots.getSnapshotCount(installation.installPath)
    await update({ lastSnapshot: filename, snapshotCount })
  } catch (err) {
    console.warn('Initial snapshot failed:', err)
  }
}

export async function probeInstallation(dirPath: string): Promise<Record<string, unknown> | null> {
  const envExists = fs.existsSync(path.join(dirPath, 'standalone-env'))
  const mainExists = fs.existsSync(path.join(dirPath, 'ComfyUI', 'main.py'))
  if (!envExists || !mainExists) return null
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
  }
}
