import {
  path, fs,
  installations, settings, i18n,
  deleteDir, formatDeleteStatus,
  download, createCache, extract,
  MARKER_FILE,
  sourceMap, findDuplicatePath, uniqueName, sanitizeDirName, allocateUniqueDir,
  performCopy, copyBrowserPartition,
  makeSendProgress, makeSendOutput,
} from '../shared'
import type { FieldOption, InstallationRecord } from '../shared'
import type { ActionContext, ActionResult } from './types'
import { withAbortableSessionAction } from './withAbortable'

export async function handleCopy(ctx: ActionContext): Promise<ActionResult> {
  const { event, installationId, inst, actionData } = ctx
  const name = actionData?.name as string | undefined
  if (!name) return { ok: false, message: 'No name provided.' }
  if (!inst.installPath || !fs.existsSync(inst.installPath)) {
    return { ok: false, message: i18n.t('errors.dirNotExist', { path: inst.installPath || '' }) }
  }

  const sendProgress = makeSendProgress(event.sender, installationId)

  return withAbortableSessionAction(ctx, async (signal) => {
    const { entry } = await performCopy(inst, name, sendProgress, signal)
    sendProgress('done', { percent: 100, status: 'Complete' })
    return { ok: true, navigate: 'list', newInstallationId: entry.id }
  })
}

export async function handleCopyUpdate(ctx: ActionContext): Promise<ActionResult> {
  const { event, installationId, inst, actionData } = ctx
  const name = actionData?.name as string | undefined
  if (!name) return { ok: false, message: 'No name provided.' }
  if (!inst.installPath || !fs.existsSync(inst.installPath)) {
    return { ok: false, message: i18n.t('errors.dirNotExist', { path: inst.installPath || '' }) }
  }

  const sender = event.sender
  const sendProgress = makeSendProgress(sender, installationId)
  const sendOutput = makeSendOutput(sender, installationId)

  return withAbortableSessionAction(ctx, async (signal) => {
    sendProgress('steps', { steps: [
      { phase: 'copy', label: i18n.t('actions.copyingFiles') },
      { phase: 'prepare', label: i18n.t('standalone.updatePrepare') },
      { phase: 'run', label: i18n.t('standalone.updateRun') },
      { phase: 'deps', label: i18n.t('standalone.updateDeps') },
    ] })

    const { entry } = await performCopy(inst, name, sendProgress, signal, 'copy-update')

    const targetChannel = actionData?.channel as string | undefined
    if (targetChannel) {
      await installations.update(entry.id, { updateChannel: targetChannel })
    }

    const updateSendProgress = (phase: string, detail: Record<string, unknown>): void => {
      if (phase !== 'steps') sendProgress(phase, detail)
    }
    try {
      const source = sourceMap[inst.sourceId]
      if (!source) throw new Error(i18n.t('errors.unknownSource'))
      const newInst = await installations.get(entry.id)
      const newUpdate = (data: Record<string, unknown>): Promise<void> =>
        installations.update(entry.id, data).then(() => {})
      const updateResult = await source.handleAction('update-comfyui', newInst!, {}, {
        update: newUpdate,
        sendProgress: updateSendProgress,
        sendOutput,
        signal,
      })
      if (updateResult && !updateResult.ok) {
        sendOutput(`\n⚠ Update: ${updateResult.message}\n`)
        sendOutput('The copy was created successfully. You can retry the update from the new installation.\n')
      }
    } catch (updateErr) {
      sendOutput(`\n⚠ Update failed: ${(updateErr as Error).message}\n`)
      sendOutput('The copy was created successfully. You can retry the update from the new installation.\n')
    }

    // Channel-switch invocations come from inside an install-backed
    // host window (Settings → Updates ChannelPicker). Opening a new
    // window for the destination would spawn an empty chooser host
    // alongside the source's existing window — the user is mid-
    // workflow inside the source and the new install can be picked
    // from the dashboard later. Omit `newInstallationId` so
    // `ProgressModal.handleDone` skips the `openInstallWindow` branch.
    const isChannelSwitch = !!actionData?.channel
    return isChannelSwitch
      ? { ok: true, navigate: 'list' }
      : { ok: true, navigate: 'list', newInstallationId: entry.id }
  })
}

export async function handleReleaseUpdate(ctx: ActionContext): Promise<ActionResult> {
  const { event, installationId, inst, actionData } = ctx
  const name = actionData?.name as string | undefined
  const releaseSelection = actionData?.releaseSelection as Record<string, unknown> | undefined
  const variantSelection = actionData?.variantSelection as Record<string, unknown> | undefined
  if (!name || !releaseSelection || !variantSelection) {
    return { ok: false, message: 'Missing required selections.' }
  }
  if (!inst.installPath || !fs.existsSync(inst.installPath)) {
    return { ok: false, message: i18n.t('errors.dirNotExist', { path: inst.installPath || '' }) }
  }

  const source = sourceMap[inst.sourceId]
  if (!source) return { ok: false, message: i18n.t('errors.unknownSource') }
  const installData = source.buildInstallation({
    release: releaseSelection as unknown as FieldOption,
    variant: variantSelection as unknown as FieldOption,
  })

  const parentDir = path.dirname(inst.installPath)
  const dirName = sanitizeDirName(name)
  const destPath = allocateUniqueDir(parentDir, dirName)

  const duplicate = await findDuplicatePath(destPath)
  if (duplicate) {
    return { ok: false, message: `That directory is already used by "${duplicate.name}".` }
  }

  const sender = event.sender
  const sendProgress = makeSendProgress(sender, installationId)
  const sendOutput = makeSendOutput(sender, installationId)

  return withAbortableSessionAction(ctx, async (signal) => {
    sendProgress('steps', { steps: [
      { phase: 'download', label: i18n.t('common.download') },
      { phase: 'extract', label: i18n.t('common.extract') },
      { phase: 'setup', label: i18n.t('standalone.setupEnv') },
      { phase: 'migrate', label: i18n.t('migrate.filePhase') },
      { phase: 'deps', label: i18n.t('migrate.depsPhase') },
    ] })

    let entry: InstallationRecord | null = null
    let installComplete = false
    try {
      fs.mkdirSync(destPath, { recursive: true })
      const installRecord = { ...installData, installPath: destPath } as InstallationRecord
      const cache = createCache(settings.get('cacheDir') as string, settings.get('maxCachedFiles') as number)
      await source.install!(installRecord, { sendProgress, download, cache, extract, signal })

      const finalName = await uniqueName(name)
      entry = await installations.add({
        sourceId: inst.sourceId,
        sourceLabel: source.label,
        ...installData,
        name: finalName,
        installPath: destPath,
        status: 'installed',
        seen: false,
        browserPartition: 'unique',
        copiedFrom: inst.id,
        copiedFromName: inst.name,
        copiedAt: new Date().toISOString(),
        copyReason: 'release-update' as const,
      })
      try { fs.writeFileSync(path.join(destPath, MARKER_FILE), entry.id) } catch {}
      await copyBrowserPartition(inst.id, entry.id, inst.browserPartition as string | undefined)

      const newUpdate = (data: Record<string, unknown>): Promise<void> =>
        installations.update(entry!.id, data).then(() => {})
      await source.postInstall!(installRecord, { sendProgress, update: newUpdate, signal })
      installComplete = true

      const newInst = await installations.get(entry.id)
      const migrateSendProgress = (phase: string, detail: Record<string, unknown>): void => {
        if (phase !== 'steps' && phase !== 'done') sendProgress(phase, detail)
      }
      const migrateData = {
        sourceInstallationId: inst.id,
        customNodes: true,
        allUserData: true,
        models: true,
        input: true,
        output: true,
      }
      let migrateError: string | null = null
      try {
        const migrateResult = await source.handleAction('migrate-from', newInst!, migrateData, {
          update: newUpdate,
          sendProgress: migrateSendProgress,
          sendOutput,
          signal,
        })
        if (migrateResult && !migrateResult.ok) {
          migrateError = migrateResult.message || 'Unknown migration error'
        }
      } catch (migrateErr) {
        migrateError = (migrateErr as Error).message
      }

      if (migrateError) {
        sendOutput(`\n⚠ ${migrateError}\n`)
        sendProgress('migrate', { percent: -1, status: i18n.t('standalone.releaseUpdateCleaningUp') })
        try { await installations.remove(entry.id) } catch {}
        try {
          await deleteDir(destPath, (p) => {
            sendProgress('migrate', { percent: p.percent, status: formatDeleteStatus(p, i18n.t('standalone.releaseUpdateCleaningUp')) })
          })
        } catch {}
        return { ok: false, message: migrateError }
      }
      sendProgress('done', { percent: 100, status: 'Complete' })
      return { ok: true, navigate: 'list', newInstallationId: entry.id }
    } catch (err) {
      // Pre-install-complete rollback: any error during install / postInstall
      // leaves a half-built install on disk and (possibly) in the registry.
      // Wipe both before re-throwing so the wrapper maps the error.
      if (!installComplete) {
        if (entry) try { await installations.remove(entry.id) } catch {}
        try { await fs.promises.rm(destPath, { recursive: true, force: true }) } catch {}
      }
      throw err
    }
  })
}
