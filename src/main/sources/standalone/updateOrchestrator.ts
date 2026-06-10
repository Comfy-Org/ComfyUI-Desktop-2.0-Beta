import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { killProcTree } from '../../lib/process'
import { resolveLocalVersion, clearVersionCache, type LatestTagOverride } from '../../lib/version-resolve'
import { readGitHead, rollbackComfySource, fetchTags, findLatestVersionTag, revParseRef } from '../../lib/git'
import { PYTORCH_RE, installFilteredRequirements, getPipIndexArgs } from '../../lib/pip'
import { formatComfyVersion } from '../../lib/version'
import type { ComfyVersion } from '../../lib/version'
import { t } from '../../lib/i18n'
import { getBundledScriptPath } from '../../lib/bundledScript'
import * as settings from '../../settings'
import * as snapshots from '../../lib/snapshots'
import { repairMacBinaries } from './macRepair'
import { getActivePythonPath, getActiveUvPath, getMasterPythonPath } from './envPaths'
import { writeOpMarker, completeOpMarker } from '../../lib/opMarker'
import type { InstallationRecord } from '../../installations'

interface ScriptResult {
  exitCode: number
  exitSignal: string | null
  markers: Record<string, string>
  stdoutBuf: string
  stderrBuf: string
}

export interface UpdateOrchestrationOptions {
  installPath: string
  installation: InstallationRecord
  channel: 'stable' | 'latest'
  update: (data: Record<string, unknown>) => Promise<void>
  sendProgress: (step: string, data: Record<string, unknown>) => void
  sendOutput?: (text: string) => void
  signal?: AbortSignal
  dryRunConflictCheck?: boolean
  saveRollback?: boolean
  preUpdateSnapshot?: boolean
  /** Force `uv pip install -r requirements.txt` to run after the git update,
   *  even when the requirements.txt content is byte-identical pre/post. Used
   *  by the post-install auto-update in `install.ts` to reconcile the
   *  pre-extracted standalone bundle's venv against ComfyUI's pinned deps. */
  forceDepsSync?: boolean
  /** Optional explicit ComfyUI release tag (e.g. `v1.19.4`). Set by the
   *  install-wizard / IPP version picker. When present, `update_comfyui.py`
   *  is invoked with `--tag <ref>` instead of `--stable` / no flag, so the
   *  checkout lands on a specific historical release (upgrade or downgrade).
   *  Must be a strict `vMAJOR.MINOR.PATCH` shape; the script rejects anything
   *  else with exit code 2. The `channel` carried alongside still records the
   *  user's declared preference — same as a manual checkout on the stable
   *  channel. */
  targetTag?: string
}

export interface UpdateOrchestrationResult {
  ok: boolean
  message?: string
  navigate?: string
  comfyVersion?: ComfyVersion
  installation: InstallationRecord
}

export function spawnCommand(
  command: string,
  args: string[],
  cwd: string,
  onStdout: ((text: string) => void) | undefined,
  onStderr: ((text: string) => void) | undefined,
  signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (signal?.aborted) return Promise.resolve({ code: 1, stdout: '', stderr: '' })
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const onAbort = (): void => { killProcTree(proc) }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8')
      stdout += text
      onStdout?.(text)
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8')
      stderr += text
      onStderr?.(text)
    })
    proc.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort)
      onStderr?.(`Error: ${err.message}\n`)
      resolve({ code: 1, stdout, stderr })
    })
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

function spawnUpdateScript(
  masterPython: string,
  comfyuiDir: string,
  channelArgs: string[],
  sendOutput: ((text: string) => void) | undefined,
  signal?: AbortSignal,
): Promise<ScriptResult> {
  const updateScript = getBundledScriptPath('update_comfyui.py')
  const markers: Record<string, string> = {}
  let markerBuf = ''
  let stdoutBuf = ''
  let stderrBuf = ''
  let exitSignal: string | null = null

  const exitCode = new Promise<number>((resolve) => {
    const proc = spawn(masterPython, ['-s', updateScript, comfyuiDir, ...channelArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    if (signal) {
      const onAbort = (): void => { proc.kill() }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
      proc.on('close', () => signal.removeEventListener('abort', onAbort))
    }
    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8')
      stdoutBuf += text
      markerBuf += text
      const lines = markerBuf.split(/\r?\n/)
      markerBuf = lines.pop()!
      for (const line of lines) {
        const match = line.match(/^\[(\w+)\]\s*(.+)$/)
        if (match) markers[match[1]!] = match[2]!.trim()
      }
      sendOutput?.(text)
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8')
      stderrBuf += text
      sendOutput?.(text)
    })
    proc.on('error', (err) => {
      sendOutput?.(`Error: ${err.message}\n`)
      resolve(1)
    })
    proc.on('close', (code, sig) => {
      exitSignal = sig
      resolve(code ?? 1)
    })
  })

  return exitCode.then((code) => {
    if (markerBuf) {
      const match = markerBuf.match(/^\[(\w+)\]\s*(.+)$/)
      if (match) markers[match[1]!] = match[2]!.trim()
    }
    return { exitCode: code, exitSignal, markers, stdoutBuf, stderrBuf }
  })
}

export async function runComfyUIUpdate(opts: UpdateOrchestrationOptions): Promise<UpdateOrchestrationResult> {
  const {
    installPath, channel, update, sendProgress, signal,
    dryRunConflictCheck = false,
    saveRollback = false,
    preUpdateSnapshot = false,
  } = opts
  let { installation } = opts
  const sendOutput = opts.sendOutput
  const comfyuiDir = path.join(installPath, 'ComfyUI')
  // Adopted installs run the updater against the legacy `.venv` Python (it has
  // pygit2 from adoption); `update_comfyui.py` only needs pygit2 + stdlib.
  const updaterPython = installation.adopted === true
    ? (installation.adoptedPythonPath as string)
    : getMasterPythonPath(installPath)
  // `targetTag` (vMAJOR.MINOR.PATCH) wins over channel: the user explicitly
  // picked a specific release in the install wizard or IPP, and `--tag` and
  // `--stable` are mutually exclusive script-side. The orchestration record
  // still keeps `channel` for downstream bookkeeping (release-cache, snapshots).
  const channelArgs = opts.targetTag
    ? ['--tag', opts.targetTag]
    : channel === 'stable' ? ['--stable'] : []

  const reqPath = path.join(comfyuiDir, 'requirements.txt')
  let preReqs = ''
  try { preReqs = await fs.promises.readFile(reqPath, 'utf-8') } catch {}

  const mgrReqPath = path.join(comfyuiDir, 'manager_requirements.txt')
  let preMgrReqs = ''
  try { preMgrReqs = await fs.promises.readFile(mgrReqPath, 'utf-8') } catch {}

  let preUpdateFilename: string | undefined
  if (preUpdateSnapshot) {
    try {
      preUpdateFilename = await snapshots.saveSnapshot(installPath, installation, 'pre-update')
      const snapshotCount = await snapshots.getSnapshotCount(installPath)
      await update({ lastSnapshot: preUpdateFilename, snapshotCount })
    } catch (err) {
      console.warn('Pre-update snapshot failed:', err)
    }
  }

  // Mark the source-moving window so a hard process kill (power loss, taskkill)
  // mid-update is recovered on the next launch — see recoverInterruptedComfyOp.
  // The marker is cleared once source + packages are consistent below.
  const preOpHead = readGitHead(comfyuiDir)
  if (preOpHead) {
    await writeOpMarker(installPath, { op: 'update', preHead: preOpHead, startedAt: Date.now() })
  }

  // Run the update script (with a macOS SIGKILL repair-and-retry).
  let result = await spawnUpdateScript(updaterPython, comfyuiDir, channelArgs, sendOutput, signal)

  if (result.exitCode !== 0 && result.exitSignal === 'SIGKILL' && process.platform === 'darwin') {
    if (sendOutput) {
      sendOutput('\nProcess was killed by macOS — attempting binary repair…\n')
    } else {
      console.warn('macOS killed update process — attempting binary repair and retry')
    }
    // Recovers a Gatekeeper SIGKILL on either install type: `repairMacBinaries`
    // picks the right runtime venv via `getActiveVenvDir(installation)`.
    await repairMacBinaries(installPath, sendProgress, sendOutput, installation)
    if (sendOutput) {
      sendOutput('Repair complete — retrying update…\n\n')
    }
    result = await spawnUpdateScript(updaterPython, comfyuiDir, channelArgs, sendOutput, signal)
  }

  // Check cancellation before the exit code — aborted processes exit non-zero
  // and shouldn't surface an error.
  if (signal?.aborted) return { ok: false, message: 'Cancelled', installation }

  if (result.exitCode !== 0) {
    const detail = [result.stderrBuf, result.stdoutBuf].filter(Boolean).join('\n').trim().split('\n').slice(-20).join('\n')
    if (sendOutput) {
      let message: string
      if (detail) {
        message = `${t('standalone.updateFailed', { code: result.exitCode })}\n\n${detail}`
      } else if (result.exitSignal) {
        message = `${t('standalone.updateFailed', { code: result.exitCode })}\n\nProcess was killed by signal ${result.exitSignal}.\npython: ${updaterPython}\nscript: ${getBundledScriptPath('update_comfyui.py')}`
      } else {
        message = `${t('standalone.updateFailed', { code: result.exitCode })}\n\nProcess produced no output.\npython: ${updaterPython}\nscript: ${getBundledScriptPath('update_comfyui.py')}`
      }
      return { ok: false, message, installation }
    }
    console.warn(`Auto-update script failed (exit ${result.exitCode}):\n${detail.split('\n').slice(-10).join('\n')}`)
    return { ok: false, installation }
  }

  const { markers } = result

  let postReqs = ''
  try { postReqs = await fs.promises.readFile(reqPath, 'utf-8') } catch {}

  // Re-sync deps when reqs changed (the historical trigger), OR when git HEAD
  // moved (source can import new APIs without bumping requirements.txt — saw
  // this with `comfy_aimdo.vram_buffer` showing up in `model_management.py`
  // between aimdo bumps), OR when the caller demands it (first-run auto-update
  // reconciling the bundled venv against the bundled requirements.txt).
  const headMoved = !!(markers.PRE_UPDATE_HEAD && markers.POST_UPDATE_HEAD && markers.PRE_UPDATE_HEAD !== markers.POST_UPDATE_HEAD)
  const reqsChanged = preReqs !== postReqs
  const shouldSyncDeps = (reqsChanged || headMoved || !!opts.forceDepsSync) && postReqs.length > 0

  // Tracks a dependency-sync failure so the transactional guard below can roll
  // ComfyUI's source back instead of leaving new source + stale packages.
  let depFailure: string | null = null

  if (shouldSyncDeps) {
    const uvPath = getActiveUvPath(installation)
    const activeEnvPython = getActivePythonPath(installation)

    if (!fs.existsSync(uvPath) || !activeEnvPython) {
      depFailure = 'Python environment or uv not found while installing updated dependencies'
    } else if (!signal?.aborted) {
      if (dryRunConflictCheck) {
        const filteredReqs = postReqs.split('\n').filter((l) => !PYTORCH_RE.test(l.trim())).join('\n')
        const filteredReqPath = path.join(installPath, '.comfyui-reqs-filtered.txt')
        await fs.promises.writeFile(filteredReqPath, filteredReqs, 'utf-8')

        try {
          const indexArgs = getPipIndexArgs(settings.get('pypiMirror'), settings.get('useChineseMirrors') === true)
          sendProgress('deps', { percent: -1, status: t('standalone.updateDepsDryRun') })

          if (!signal?.aborted) {
            const dryRunResult = await spawnCommand(
              uvPath, ['pip', 'install', '--dry-run', '-r', filteredReqPath, '--python', activeEnvPython, ...indexArgs],
              installPath, undefined, undefined, signal
            )

            // Dry-run conflicts are advisory only — never a rollback trigger.
            if (dryRunResult.code !== 0) {
              sendOutput?.(`\n⚠ Requirements dry-run detected potential conflicts:\n${dryRunResult.stderr || dryRunResult.stdout}\n`)
              sendOutput?.('Proceeding with install attempt — some conflicts may be benign.\nTip: Use "Copy & Update" for a risk-free update that leaves this installation untouched.\n')
            } else if (dryRunResult.stderr) {
              sendOutput?.(dryRunResult.stderr)
            }
          }

          if (!signal?.aborted) {
            sendProgress('deps', { percent: -1, status: t('standalone.updateDepsInstalling') })
            const pipResult = await spawnCommand(
              uvPath, ['pip', 'install', '-r', filteredReqPath, '--python', activeEnvPython, ...indexArgs],
              installPath, sendOutput, sendOutput, signal
            )
            if (pipResult.code !== 0) {
              depFailure = `requirements install exited with code ${pipResult.code}`
            }
          }
        } catch (err) {
          depFailure = `requirements install failed: ${(err as Error).message}`
        } finally {
          try { await fs.promises.unlink(filteredReqPath) } catch {}
        }
      } else {
        sendProgress('update', { percent: -1, status: 'Installing updated dependencies' })
        const logFn = sendOutput ?? console.log
        try {
          const installResult = await installFilteredRequirements(
            reqPath, uvPath, activeEnvPython, installPath,
            '.post-install-reqs.txt', logFn, signal, settings.getMirrorConfig()
          )
          if (installResult !== 0) {
            depFailure = `requirements install exited with code ${installResult}`
          }
        } catch (err) {
          depFailure = `requirements install failed: ${(err as Error).message}`
        }
      }
    }
  } else if (dryRunConflictCheck) {
    sendProgress('deps', { percent: -1, status: t('standalone.updateDepsUpToDate') })
  }

  let postMgrReqs = ''
  try { postMgrReqs = await fs.promises.readFile(mgrReqPath, 'utf-8') } catch {}

  // Fail fast: skip the manager requirements sync if the main one already failed.
  if (!depFailure && !signal?.aborted && preMgrReqs !== postMgrReqs && postMgrReqs.length > 0) {
    const uvPath = getActiveUvPath(installation)
    const activeEnvPython = getActivePythonPath(installation)

    if (!fs.existsSync(uvPath) || !activeEnvPython) {
      depFailure = 'Python environment or uv not found while installing manager dependencies'
    } else {
      if (dryRunConflictCheck) {
        sendProgress('deps', { percent: -1, status: t('standalone.updateDepsInstalling') })
        sendOutput?.('\nInstalling manager requirements…\n')
      }
      const logFn = sendOutput ?? console.log
      try {
        const mgrResult = await installFilteredRequirements(
          mgrReqPath, uvPath, activeEnvPython, installPath,
          dryRunConflictCheck ? '.manager-reqs-filtered.txt' : '.post-install-mgr-reqs.txt',
          logFn, signal, settings.getMirrorConfig()
        )
        if (mgrResult !== 0) {
          depFailure = `manager requirements install exited with code ${mgrResult}`
        }
      } catch (err) {
        depFailure = `manager requirements install failed: ${(err as Error).message}`
      }
    }
  }

  // Transactional guard: if the dependency sync failed or was cancelled after the
  // git update moved ComfyUI's source, roll the source back to the pre-update
  // commit. Otherwise we leave new source + stale packages — the half-applied
  // state that crashes on import (e.g. `comfy_aimdo.vram_buffer`). uv installs are
  // ~atomic, so on failure packages are typically untouched and restoring the
  // source restores a consistent old-source/old-packages state.
  if (depFailure || signal?.aborted) {
    const preHead = markers.PRE_UPDATE_HEAD
    const sourceMoved = !!preHead && readGitHead(comfyuiDir) !== preHead
    let rolledBack = true
    if (sourceMoved) {
      rolledBack = await rollbackComfySource(comfyuiDir, preHead!, sendOutput)
    }
    const reason = signal?.aborted ? 'Cancelled' : depFailure!
    const message = sourceMoved
      ? (rolledBack
          ? `${reason}\n\nComfyUI source was rolled back to ${preHead!.slice(0, 7)}.`
          : `${reason}\n\nComfyUI source rollback failed; installation may be inconsistent.`)
      : reason
    if (!sendOutput) console.warn(`ComfyUI update aborted: ${reason}`)
    // Leave the op marker: if the in-process rollback failed (rolledBack=false),
    // recoverInterruptedComfyOp retries on the next launch; if it succeeded,
    // HEAD already matches preHead so recovery is a harmless no-op.
    return { ok: false, message, installation }
  }

  // Source + packages are now consistent — the update succeeded. Stamp the marker
  // completed and clear it so the next launch doesn't roll a good update back.
  await completeOpMarker(installPath)

  // Fetch tags so version resolution sees all release tags (the update script
  // may only fetch master on the latest channel).
  await fetchTags(comfyuiDir)
  clearVersionCache()
  const checkedOutTag = markers.CHECKED_OUT_TAG || undefined
  const fullPostHead = markers.POST_UPDATE_HEAD || readGitHead(comfyuiDir)

  // Pass the tag's SHA directly to resolveLocalVersion.
  let latestTagOverride: LatestTagOverride | undefined
  const latestTag = await findLatestVersionTag(comfyuiDir)
  if (latestTag) {
    const sha = await revParseRef(comfyuiDir, latestTag)
    if (sha) latestTagOverride = { name: latestTag, sha }
  }

  let comfyVersion: ComfyVersion | undefined
  if (fullPostHead) {
    comfyVersion = await resolveLocalVersion(
      comfyuiDir, fullPostHead, checkedOutTag, latestTagOverride
    )
  }

  const installedTag = comfyVersion
    ? formatComfyVersion(comfyVersion, 'short')
    : (checkedOutTag || 'unknown')

  const existing = (installation.updateInfoByChannel as Record<string, Record<string, unknown>> | undefined) || {}
  const updateData: Record<string, unknown> = {
    ...(comfyVersion ? { comfyVersion } : {}),
    updateChannel: channel,
    updateInfoByChannel: {
      ...existing,
      [channel]: { installedTag },
    },
  }

  if (saveRollback) {
    updateData.lastRollback = {
      preUpdateHead: markers.PRE_UPDATE_HEAD || null,
      postUpdateHead: fullPostHead,
      backupBranch: markers.BACKUP_BRANCH || null,
      channel,
      updatedAt: Date.now(),
    }
  }

  await update(updateData)
  if (comfyVersion) {
    installation = { ...installation, comfyVersion } as InstallationRecord
  }

  try {
    const updatedInstallation = { ...installation, updateChannel: channel }
    const filename = await snapshots.saveSnapshot(installPath, updatedInstallation, 'post-update')
    const snapshotCount = await snapshots.getSnapshotCount(installPath)
    await update({ lastSnapshot: filename, snapshotCount })

    // Prune the pre-update snapshot if identical to the one before it.
    if (preUpdateFilename) {
      const pruned = await snapshots.deduplicatePreUpdateSnapshot(installPath, preUpdateFilename)
      if (pruned) {
        const updatedCount = await snapshots.getSnapshotCount(installPath)
        await update({ snapshotCount: updatedCount })
      }
    }
  } catch (err) {
    console.warn('Post-update snapshot failed:', err)
  }

  return { ok: true, comfyVersion, installation }
}
