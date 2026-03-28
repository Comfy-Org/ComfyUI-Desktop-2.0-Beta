import fs from 'fs'
import path from 'path'
import { execFile, spawn } from 'child_process'
import { downloadAndExtract, downloadAndExtractMulti } from '../../lib/installer'
import { copyDirWithProgress } from '../../lib/copy'
import { readGitHead, isGitAvailable, isPygit2Configured, tryConfigurePygit2Fallback, fetchTags } from '../../lib/git'
import { resolveLocalVersion, clearVersionCache } from '../../lib/version-resolve'
import { formatTime } from '../../lib/util'
import { t } from '../../lib/i18n'
import * as snapshots from '../../lib/snapshots'
import { fetchLatestRelease } from '../../lib/comfyui-releases'
import { installFilteredRequirements } from '../../lib/pip'
import { getBundledScriptPath } from '../../lib/bundledScript'
import { formatComfyVersion } from '../../lib/version'
import * as settings from '../../settings'
import { repairMacBinaries, codesignBinaries } from './macRepair'
import {
  ENVS_DIR, DEFAULT_ENV, ENV_METHOD, MANIFEST_FILE, DEFAULT_LAUNCH_ARGS,
  getUvPath, findSitePackages, getMasterPythonPath, getActivePythonPath,
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

  // Auto-update to latest stable release if the bundled version is behind
  if (fs.existsSync(path.join(comfyuiDir, '.git'))) {
    if (signal?.aborted) throw new Error('Cancelled')
    sendProgress('update', { percent: -1, status: 'Fetching latest stable version' })

    try {
      const latestRelease = await fetchLatestRelease('stable')
      const latestTag = latestRelease?.tag_name as string | undefined
      const currentTag = (installation.comfyVersion as ComfyVersion | undefined)
        ? formatComfyVersion(installation.comfyVersion as ComfyVersion, 'short')
        : (installation.version as string | undefined)

      if (!latestTag || latestTag === currentTag) {
        sendProgress('update', { percent: 100, status: 'Already up to date' })
      } else {
        const masterPython = getMasterPythonPath(installation.installPath)
        const updateScript = getBundledScriptPath('update_comfyui.py')

        const reqPath = path.join(comfyuiDir, 'requirements.txt')
        let preReqs = ''
        try { preReqs = await fs.promises.readFile(reqPath, 'utf-8') } catch {}

        const mgrReqPath = path.join(comfyuiDir, 'manager_requirements.txt')
        let preMgrReqs = ''
        try { preMgrReqs = await fs.promises.readFile(mgrReqPath, 'utf-8') } catch {}

        const markers: Record<string, string> = {}
        let markerBuf = ''
        let outputBuf = ''
        const exitCode = await new Promise<number>((resolve) => {
          const proc = spawn(masterPython, ['-s', updateScript, comfyuiDir, '--stable'], {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          })
          if (signal) {
            const onAbort = (): void => { proc.kill() }
            signal.addEventListener('abort', onAbort, { once: true })
            proc.on('close', () => signal.removeEventListener('abort', onAbort))
          }
          proc.stdout.on('data', (chunk: Buffer) => {
            const text = chunk.toString('utf-8')
            outputBuf += text
            markerBuf += text
            const lines = markerBuf.split(/\r?\n/)
            markerBuf = lines.pop()!
            for (const line of lines) {
              const match = line.match(/^\[(\w+)\]\s*(.+)$/)
              if (match) markers[match[1]!] = match[2]!.trim()
            }
          })
          proc.stderr.on('data', (chunk: Buffer) => { outputBuf += chunk.toString('utf-8') })
          proc.on('error', () => resolve(1))
          proc.on('close', (code) => resolve(code ?? 1))
        })
        if (markerBuf) {
          const match = markerBuf.match(/^\[(\w+)\]\s*(.+)$/)
          if (match) markers[match[1]!] = match[2]!.trim()
        }

        if (exitCode !== 0) {
          console.warn(`Auto-update script failed (exit ${exitCode}):\n${outputBuf.trim().split('\n').slice(-10).join('\n')}`)
          sendProgress('update', { percent: 100, status: 'Skipped (update failed)' })
        } else {
          if (signal?.aborted) throw new Error('Cancelled')

          // Install updated dependencies if requirements.txt changed
          let postReqs = ''
          try { postReqs = await fs.promises.readFile(reqPath, 'utf-8') } catch {}

          if (preReqs !== postReqs && postReqs.length > 0) {
            sendProgress('update', { percent: -1, status: 'Installing updated dependencies' })
            const uvPath = getUvPath(installation.installPath)
            const activeEnvPython = getActivePythonPath(installation)

            if (fs.existsSync(uvPath) && activeEnvPython) {
              const result = await installFilteredRequirements(
                reqPath, uvPath, activeEnvPython, installation.installPath,
                '.post-install-reqs.txt', () => {}, signal, settings.getMirrorConfig()
              )
              if (result !== 0) {
                console.warn(`Post-install requirements install exited with code ${result}`)
              }
            }
          }

          // Install manager_requirements.txt if changed
          let postMgrReqs = ''
          try { postMgrReqs = await fs.promises.readFile(mgrReqPath, 'utf-8') } catch {}

          if (preMgrReqs !== postMgrReqs && postMgrReqs.length > 0) {
            const uvPath = getUvPath(installation.installPath)
            const activeEnvPython = getActivePythonPath(installation)

            if (fs.existsSync(uvPath) && activeEnvPython) {
              const result = await installFilteredRequirements(
                mgrReqPath, uvPath, activeEnvPython, installation.installPath,
                '.post-install-mgr-reqs.txt', () => {}, signal, settings.getMirrorConfig()
              )
              if (result !== 0) {
                console.warn(`Post-install manager requirements install exited with code ${result}`)
              }
            }
          }

          // Re-resolve comfyVersion from git state
          clearVersionCache()
          const checkedOutTag = markers.CHECKED_OUT_TAG || undefined
          const fullPostHead = markers.POST_UPDATE_HEAD || readGitHead(comfyuiDir)
          if (fullPostHead) {
            const newComfyVersion = await resolveLocalVersion(comfyuiDir, fullPostHead, checkedOutTag)
            const installedTag = formatComfyVersion(newComfyVersion, 'short')
            await update({
              comfyVersion: newComfyVersion,
              updateChannel: 'stable',
              updateInfoByChannel: {
                ...((installation.updateInfoByChannel as Record<string, Record<string, unknown>> | undefined) || {}),
                stable: { installedTag },
              },
            })
            installation = { ...installation, comfyVersion: newComfyVersion } as InstallationRecord
          }

          // Re-capture snapshot reflecting the updated state
          try {
            const filename = await snapshots.saveSnapshot(installation.installPath, installation, 'post-update')
            const snapshotCount = await snapshots.getSnapshotCount(installation.installPath)
            await update({ lastSnapshot: filename, snapshotCount })
          } catch (err) {
            console.warn('Post-update snapshot failed:', err)
          }

          sendProgress('update', { percent: 100, status: 'Up to date' })
        }
      }
    } catch (err) {
      if ((err as Error).message === 'Cancelled') throw err
      console.warn('Auto-update to latest stable failed:', err)
      sendProgress('update', { percent: 100, status: 'Skipped' })
    }
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
