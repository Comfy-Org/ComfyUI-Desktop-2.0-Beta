import {
  path,
  fs,
  ipcMain,
  sources,
  installations,
  settings,
  i18n,
  sourceMap,
  formatComfyVersion,
  scheduleResolveAndBroadcastVersions,
  findDuplicatePath,
  uniqueName,
  sanitizeDirName,
  allocateUniqueDir,
  syncOemSeedBestEffort,
  isEffectivelyEmptyInstallDir,
  download,
  createCache,
  extract,
  deleteDir,
  formatDeleteStatus,
  deleteAction,
  untrackAction,
  MARKER_FILE,
  _operationAborts,
  _runningSessions,
  sanitizeEnvVars,
  getComfyArgsSchema,
  COMFYUI_REPO
} from './shared'
import type { ComfyVersion, ComfyArgDef, InstallationRecord } from './shared'
import * as releaseCache from '../release-cache'
import { runStartupReleaseChecks } from '../release-cache-startup'
import { _broadcastToRenderer } from './shared'
import { hasGitDir } from '../git'
import { parseUrl } from '../util'
import { restoreSnapshotIntoInstallation } from '../standaloneMigration'
import * as mainTelemetry from '../telemetry'
import { recordIpcInvocation } from '../e2eOverrides'

/** Fire-and-forget: refresh the shared ComfyUI release cache for the
 *  channels these installs use, then re-broadcast `installations-changed`
 *  so renderers re-pull statusTag (which drives the dashboard's
 *  per-install "Update" pill). Gated inside the helper by a 1h floor
 *  so it never spams GitHub on dashboard refreshes. */
function _kickReleaseCachePrewarm(allInstalls: InstallationRecord[]): void {
  void runStartupReleaseChecks(allInstalls, {
    onRefreshed: () => _broadcastToRenderer('installations-changed', {})
  }).catch(() => {})
}

/**
 * Apply the migration-source filter + per-install source enrichment
 * (sourceLabel / sourceCategory / hasConsole / listPreview / statusTag
 * / formatted version) the renderer's `Installation` shape expects.
 *
 * Shared so the renderer-facing IPC handler AND the title-bar instance-
 * picker popup snapshot push the *same* per-install shape — without
 * sharing, the two surfaces would render different data for the same
 * install (e.g. picker missing the version pill because nobody attached
 * the comfyVersion → version mapping).
 */
export function enrichInstallationsForRenderer(allInstalls: InstallationRecord[]): {
  visible: InstallationRecord[]
  enriched: Record<string, unknown>[]
} {
  // Hide source installs that have been migrated to standalone, as long
  // as at least one child install (with copiedFrom pointing to them)
  // still exists.
  const migratedSourceIds = new Set(
    allInstalls
      .filter(
        (i) =>
          (i.copyReason as string | undefined) === 'standalone-migration' &&
          i.status !== 'installing'
      )
      .map((i) => i.copiedFrom as string)
      .filter(Boolean)
  )
  const visible = allInstalls.filter(
    (i) => i.status !== 'installing' && !migratedSourceIds.has(i.id)
  )
  const enriched = visible.map((inst) => {
    const source = sourceMap[inst.sourceId]
    if (!source) return inst as unknown as Record<string, unknown>
    const listPreview = source.getListPreview ? source.getListPreview(inst) : undefined
    const statusTag =
      inst.status === 'partial-delete'
        ? { label: i18n.t('errors.deleteInterrupted'), style: 'danger' }
        : inst.status === 'failed'
          ? { label: i18n.t('errors.installFailed'), style: 'danger' }
          : source.getStatusTag
            ? source.getStatusTag(inst)
            : undefined
    const cv = inst.comfyVersion as ComfyVersion | undefined
    const rawVersion = cv ? formatComfyVersion(cv, 'short') : (inst.version as string | undefined)
    const version = rawVersion === inst.sourceId ? undefined : rawVersion
    return {
      ...inst,
      version,
      sourceLabel: source.label,
      sourceCategory: source.category,
      hasConsole: source.hasConsole !== false,
      ...(listPreview != null ? { listPreview } : {}),
      ...(statusTag ? { statusTag } : {})
    }
  })
  return { visible, enriched }
}

export function registerInstallationHandlers(): void {
  // Installations
  ipcMain.handle('get-installations', async () => {
    const allInstalls = await installations.list()
    const { visible, enriched } = enrichInstallationsForRenderer(allInstalls)

    // Resolve versions from git state in the background.  Coalesced +
    // TTL-throttled so repeated renderer refreshes don't trigger
    // pygit2 bursts (every get-installations used to fire a fresh
    // background git pass — see scheduleResolveAndBroadcastVersions).
    scheduleResolveAndBroadcastVersions(visible)

    // Pre-warm the shared ComfyUI release cache so the dashboard /
    // title-bar update pills reflect upstream state without requiring
    // the user to open the picker's Update tab. Fire-and-forget;
    // gated inside the helper by a 1h floor so dashboard refreshes
    // don't spam GitHub.
    _kickReleaseCachePrewarm(visible)

    return enriched
  })

  ipcMain.handle('get-unique-name', async (_event, baseName: string) => {
    return uniqueName(baseName)
  })

  // Cohort summary for telemetry global context. Reads from the same
  // `installations.list()` source as `get-installations`; values are
  // coarse counters / booleans only (no IDs, paths, or names) so the
  // payload is safe to register as PostHog / Datadog cohort properties.
  //
  // `localCount` excludes the always-seeded Comfy Cloud entry (re-seeded
  // every boot via `installations.ensureExists('cloud', …)`), which would
  // otherwise inflate the count by 1 for every user and obscure the
  // actual local-install footprint.
  //
  // `hasLaunchedCloud` is the real Cloud-usage signal: the seeded entry
  // exists for everyone, so its presence is meaningless, but a
  // non-null `lastLaunchedAt` on it means the user has actually opened
  // it at least once.
  ipcMain.handle('get-installations-summary', async () => {
    const all = await installations.list()
    const visible = all.filter((i) => i.status !== 'installing')
    return {
      localCount: visible.filter((i) => i.sourceId !== 'cloud').length,
      hasLaunchedCloud: visible.some((i) => i.sourceId === 'cloud' && !!i.lastLaunchedAt),
      hasLegacyDesktop: visible.some((i) => i.sourceId === 'desktop')
    }
  })

  ipcMain.handle('add-installation', async (_event, data: Record<string, unknown>) => {
    data.name = await uniqueName((data.name as string) || 'ComfyUI')
    if (data.installPath) {
      const dirName = sanitizeDirName(data.name as string)
      data.installPath = allocateUniqueDir(data.installPath as string, dirName)
      const duplicate = await findDuplicatePath(data.installPath as string)
      if (duplicate) {
        return { ok: false, message: `That directory is already used by "${duplicate.name}".` }
      }
    }
    const entry = await installations.add({ ...data, seen: false })
    return { ok: true, entry }
  })

  ipcMain.handle('reorder-installations', async (_event, orderedIds: string[]) => {
    await installations.reorder(orderedIds)
  })

  ipcMain.handle('probe-installation', async (_event, dirPath: string) => {
    const results: Record<string, unknown>[] = []
    for (const source of sources) {
      if (source.probeInstallation) {
        const data = await source.probeInstallation(dirPath)
        if (data) {
          results.push({ sourceId: source.id, sourceLabel: source.label, ...data })
        }
      }
    }
    return results
  })

  ipcMain.handle('track-installation', async (_event, data: Record<string, unknown>) => {
    const duplicate = await findDuplicatePath(data.installPath as string)
    if (duplicate) {
      return { ok: false, message: `That directory is already used by "${duplicate.name}".` }
    }
    if (!fs.existsSync(data.installPath as string)) {
      return { ok: false, message: 'That directory does not exist.' }
    }
    try {
      fs.writeFileSync(path.join(data.installPath as string, MARKER_FILE), 'tracked')
    } catch (err) {
      return { ok: false, message: `Cannot write to directory: ${(err as Error).message}` }
    }
    const entry = await installations.add({ ...data, status: 'installed', seen: false })
    await syncOemSeedBestEffort()
    return { ok: true, entry }
  })

  ipcMain.handle('install-instance', async (_event, installationId: string) => {
    const inst = await installations.get(installationId)
    if (!inst) return { ok: false, message: 'Installation not found.' }
    const source = sourceMap[inst.sourceId]
    if (!source) return { ok: false, message: i18n.t('errors.unknownSource') }
    if (_operationAborts.has(installationId)) {
      return { ok: false, message: 'Another operation is already running for this installation.' }
    }
    const sender = _event.sender

    const sendProgress = (phase: string, detail: Record<string, unknown>): void => {
      if (!sender.isDestroyed()) {
        sender.send('install-progress', { installationId, phase, ...detail })
      }
    }

    // Capture the prior comfyVersion BEFORE the install runs so we can fire
    // comfy.desktop.comfyui.update.applied at the end. An install on a record that
    // already has a comfyVersion is a *version update*, not a fresh install
    // (per 04 cross-cutting Add #5). Fresh installs have no prior version
    // populated; this handler runs the same source.install() for both, so
    // pre-vs-post comfyVersion is the cleanest signal.
    const priorComfyVersion = inst.comfyVersion as ComfyVersion | undefined
    const isComfyUpdate = priorComfyVersion != null

    if (source.install) {
      fs.mkdirSync(inst.installPath, { recursive: true })
      fs.writeFileSync(path.join(inst.installPath, MARKER_FILE), installationId)
      if (source.installSteps) {
        let steps = [...source.installSteps]
        if (!inst.autoUpdateComfyUI) {
          steps = steps.filter((s) => s.phase !== 'update')
        }
        if (inst.pendingSnapshotRestore) {
          steps.push(
            { phase: 'restore-nodes', label: i18n.t('standalone.snapshotRestoreNodesPhase') },
            { phase: 'restore-pip', label: i18n.t('standalone.snapshotRestorePipPhase') }
          )
        }
        sendProgress('steps', { steps })
      }
      const abort = new AbortController()
      _operationAborts.set(installationId, abort)
      const cache = createCache(
        settings.get('cacheDir') as string,
        settings.get('maxCachedDownloads') as number
      )
      try {
        await source.install(inst, { sendProgress, download, cache, extract, signal: abort.signal })
        if (source.postInstall) {
          const update = (data: Record<string, unknown>): Promise<void> =>
            installations.update(installationId, data).then(() => {})
          await source.postInstall(inst, { sendProgress, update, signal: abort.signal })
        }

        // After postInstall, check for pending snapshot restore
        const freshInst = await installations.get(installationId)
        const pendingFile = freshInst?.pendingSnapshotRestore as string | undefined
        if (freshInst && pendingFile && fs.existsSync(pendingFile)) {
          const sendOutput = (text: string): void => {
            try {
              if (!sender.isDestroyed()) sender.send('comfy-output', { installationId, text })
            } catch {}
          }
          const update = (data: Record<string, unknown>): Promise<void> =>
            installations.update(installationId, data).then(() => {})
          await restoreSnapshotIntoInstallation(
            freshInst,
            pendingFile,
            true,
            { sendProgress, sendOutput, signal: abort.signal },
            update
          )
        }

        sendProgress('done', { percent: 100, status: 'Complete' })
      } catch (err) {
        _operationAborts.delete(installationId)
        if (abort.signal.aborted) {
          if (isComfyUpdate) {
            mainTelemetry.emit('comfy.desktop.comfyui.update.applied', {
              installation_id: installationId,
              from_version: formatComfyVersion(priorComfyVersion, 'short'),
              to_version: null,
              result: 'cancelled'
            })
          }
          let cleaned = !fs.existsSync(inst.installPath)
          if (!cleaned) {
            try {
              fs.rmSync(inst.installPath, { recursive: true, force: true })
              cleaned = true
            } catch {}
          }
          if (cleaned) {
            await installations.remove(installationId)
            return { ok: true, navigate: 'list' }
          }
          const markerPath = path.join(inst.installPath, MARKER_FILE)
          try {
            fs.writeFileSync(markerPath, installationId)
          } catch {}
          await installations.update(installationId, { status: 'partial-delete' })
          const deleteAbort = new AbortController()
          _operationAborts.set(installationId, deleteAbort)
          sendProgress('delete', { percent: 0, status: 'Counting files…' })
          try {
            await deleteDir(
              inst.installPath,
              (p) => {
                sendProgress('delete', { percent: p.percent, status: formatDeleteStatus(p) })
              },
              { signal: deleteAbort.signal }
            )
            _operationAborts.delete(installationId)
            await installations.remove(installationId)
          } catch (_delErr) {
            _operationAborts.delete(installationId)
            if (deleteAbort.signal.aborted) {
              if (isEffectivelyEmptyInstallDir(inst.installPath)) {
                try {
                  fs.rmSync(inst.installPath, { recursive: true, force: true })
                } catch {}
                await installations.remove(installationId)
              } else {
                try {
                  fs.writeFileSync(markerPath, installationId)
                } catch {}
                await installations.update(installationId, { status: 'partial-delete' })
              }
            }
          }
          return { ok: true, navigate: 'list' }
        }
        await installations.update(installationId, { status: 'failed' })
        if (isComfyUpdate) {
          mainTelemetry.emit('comfy.desktop.comfyui.update.applied', {
            installation_id: installationId,
            from_version: formatComfyVersion(priorComfyVersion, 'short'),
            to_version: null,
            result: 'error',
            error_bucket: mainTelemetry.bucketError(err),
            error_message: (err as Error).message.slice(0, 500)
          })
        }
        return { ok: false, message: (err as Error).message }
      }
      _operationAborts.delete(installationId)
      await installations.update(installationId, { status: 'installed' })
      await syncOemSeedBestEffort()
      if (isComfyUpdate) {
        const freshInst = await installations.get(installationId)
        const newComfyVersion = freshInst?.comfyVersion as ComfyVersion | undefined
        mainTelemetry.emit('comfy.desktop.comfyui.update.applied', {
          installation_id: installationId,
          from_version: formatComfyVersion(priorComfyVersion, 'short'),
          to_version: newComfyVersion ? formatComfyVersion(newComfyVersion, 'short') : null,
          result: 'success'
        })
      }
      return { ok: true }
    }

    await installations.update(installationId, { status: 'failed' })
    return { ok: false, message: 'This source does not support installation.' }
  })

  // List actions
  ipcMain.handle('get-list-actions', async (_event, installationId: string) => {
    const inst = await installations.get(installationId)
    if (!inst) return []
    const source = sourceMap[inst.sourceId]
    if (!source) return []
    return source.getListActions ? source.getListActions(inst) : []
  })

  // Detail — validate editable fields dynamically from source schema
  ipcMain.handle(
    'update-installation',
    async (_event, installationId: string, data: Record<string, unknown>) => {
      const inst = await installations.get(installationId)
      if (!inst) return { ok: false, message: 'Installation not found.' }
      const source = sourceMap[inst.sourceId]
      if (!source) return { ok: false, message: i18n.t('errors.unknownSource') }
      const sections = source.getDetailSections(inst)
      const allowedIds = new Set(['name', 'seen'])
      for (const section of sections) {
        const fields = (section as Record<string, unknown>).fields as
          | Record<string, unknown>[]
          | undefined
        if (!fields) continue
        for (const f of fields) {
          if ((f as Record<string, unknown>).editable && (f as Record<string, unknown>).id) {
            allowedIds.add((f as Record<string, unknown>).id as string)
          }
        }
      }
      // The Comfy Cloud entry is not user-renamable (issue #922); drop any
      // attempted name change so the canonical name is preserved.
      if (inst.sourceId === installations.CLOUD_SOURCE_ID) {
        allowedIds.delete('name')
      }
      const filtered: Record<string, unknown> = {}
      for (const key of Object.keys(data)) {
        if (!allowedIds.has(key)) continue
        if (key === 'remoteUrl') {
          const parsed = parseUrl(data[key] as string)
          if (!parsed) return { ok: false, message: i18n.t('errors.invalidUrl') }
          // Store the normalized href (scheme-completed, trailing slash
          // stripped) so it matches creation's `buildInstallation`.
          filtered[key] = parsed.href
          continue
        }
        filtered[key] = key === 'envVars' ? sanitizeEnvVars(data[key]) : data[key]
      }
      if (filtered.name && filtered.name !== inst.name) {
        if (await installations.hasNameConflict(installationId, filtered.name as string)) {
          return {
            ok: false,
            message: i18n.t('errors.duplicateName', { name: filtered.name as string })
          }
        }
      }
      await installations.update(installationId, filtered)
      return { ok: true }
    }
  )

  ipcMain.handle('get-detail-sections', async (_event, installationId: string) => {
    recordIpcInvocation('get-detail-sections', installationId)
    const inst = await installations.get(installationId)
    if (!inst) return []
    // Same prewarm side-effect as `get-installations` — covers the
    // case where the renderer asks for sections of an install whose
    // channel was never warmed (e.g. picker opens for an install
    // added since last dashboard mount, or a freshly switched channel).
    // The helper's 1h floor dedupes against the dashboard's prewarm.
    _kickReleaseCachePrewarm([inst])
    const source = sourceMap[inst.sourceId]
    if (!source) {
      const actions = [untrackAction()]
      if (inst.installPath && fs.existsSync(inst.installPath)) {
        actions.unshift(deleteAction(inst))
      }
      return [
        {
          title: '',
          description: i18n.t('errors.unknownSource')
        },
        {
          pinBottom: true,
          actions
        }
      ]
    }
    // Resolve commitsAhead for the `latest` channel against the install's
    // own git checkout. Fire-and-forget — enrichment spawns up to three
    // git child processes (fetch tags, fetch sha, rev-list) which can
    // take seconds on a slow link and must not block the section render.
    // When enrichment actually writes a new value, release-cache emits
    // `release-cache-enriched` so the renderer can refresh in place.
    // The helper short-circuits on already-enriched / no-git-dir, so
    // repeat opens and cloud installs cost nothing.
    if (inst.installPath) {
      const comfyuiDir = path.join(inst.installPath, 'ComfyUI')
      if (hasGitDir(comfyuiDir)) {
        void releaseCache.enrichCommitsAhead(COMFYUI_REPO, comfyuiDir).catch((err) => {
          // Enrichment is best-effort; the channel card falls back to
          // `tag (sha)` (a documented supported render path) when
          // commitsAhead is unavailable. Log so the next bug report has
          // a breadcrumb instead of silent failure.
          console.warn('[get-detail-sections] enrichCommitsAhead failed:', err)
        })
      }
    }
    const sections = source.getDetailSections(inst)
    // Surface the live port for a running instance. Sourced here (not in the
    // renderer session store) so it works in every window the settings panel
    // renders in, including the title popup where the store isn't initialised.
    const running = _runningSessions.get(installationId)
    if (running?.port) {
      sections.push({
        tab: 'status',
        fields: [{ key: 'active-port', label: i18n.t('common.port'), value: String(running.port) }],
      })
    }
    return sections
  })

  ipcMain.handle(
    'get-comfy-args',
    async (
      _event,
      installationId: string
    ): Promise<{ args: ComfyArgDef[]; error?: string } | null> => {
      const inst = await installations.get(installationId)
      if (!inst) return { args: [], error: 'Installation not found' }
      const source = sourceMap[inst.sourceId]
      if (!source) return { args: [], error: `Unknown source: ${inst.sourceId}` }
      const launchCmd = source.getLaunchCommand(inst)
      if (!launchCmd?.cmd || !launchCmd.args || !launchCmd.cwd) {
        return { args: [], error: `No launch command available (source: ${inst.sourceId})` }
      }
      const sIdx = launchCmd.args.indexOf('-s')
      if (sIdx === -1 || sIdx + 1 >= launchCmd.args.length) {
        return { args: [], error: `No -s flag in launch args: [${launchCmd.args.join(', ')}]` }
      }
      const mainPyRel = launchCmd.args[sIdx + 1]!
      const mainPyAbs = path.resolve(launchCmd.cwd, mainPyRel)
      try {
        const schema = await getComfyArgsSchema(
          launchCmd.cmd,
          mainPyAbs,
          launchCmd.cwd,
          installationId,
          inst.version as string | undefined
        )
        return { args: schema.args }
      } catch (err) {
        const msg = (err as Error).message ?? String(err)
        console.warn('[get-comfy-args] Failed to get schema:', msg)
        return { args: [], error: msg }
      }
    }
  )
}
