import {
  fs,
  dialog,
  BrowserWindow,
  installations,
  i18n,
  performLocalMigration,
  _operationAborts,
  sourceMap,
  uniqueName,
  makeSendProgress,
  makeSendOutput
} from '../shared'
import type { InstallationRecord } from '../shared'
import { adoptDesktopInstall, type AdoptPromptKind, type UserChoice } from '../../desktopAdopt'
import type { ActionContext, ActionResult } from './types'
import * as telemetry from '../../telemetry'

interface PromptSpec {
  type: 'info' | 'warning' | 'error' | 'question'
  title: string
  message: string
  detail?: string
  buttons: Array<{ label: string; choice: UserChoice }>
  defaultId: number
  cancelId: number
}

// Build the native-modal spec for a prompt kind; each button maps to a UserChoice.
function buildAdoptPromptSpec(kind: AdoptPromptKind, ctx: unknown): PromptSpec {
  const data = (ctx ?? {}) as Record<string, unknown>
  switch (kind) {
    case 'tcc':
      return {
        type: 'info',
        title: i18n.t('desktop.adoptPromptTccTitle'),
        message: i18n.t('desktop.adoptPromptTccMessage'),
        buttons: [{ label: i18n.t('common.cancel'), choice: { kind: 'tcc', choice: 'denied' } }],
        defaultId: 0,
        cancelId: 0
      }
    case 'venv-broken':
      return {
        type: 'warning',
        title: i18n.t('desktop.adoptPromptVenvBrokenTitle'),
        message: i18n.t('desktop.adoptPromptVenvBrokenMessage'),
        detail: typeof data['message'] === 'string' ? (data['message'] as string) : undefined,
        buttons: [
          {
            label: i18n.t('desktop.adoptPromptUseAnyway'),
            choice: { kind: 'venv-broken', choice: 'use-anyway' }
          },
          { label: i18n.t('common.cancel'), choice: { kind: 'venv-broken', choice: 'cancel' } }
        ],
        defaultId: 0,
        cancelId: 1
      }
    case 'source-missing':
      return {
        type: 'error',
        title: i18n.t('desktop.adoptPromptSourceMissingTitle'),
        message: i18n.t('desktop.adoptPromptSourceMissingMessage'),
        detail: typeof data['message'] === 'string' ? (data['message'] as string) : undefined,
        buttons: [
          {
            label: i18n.t('desktop.adoptPromptRetry'),
            choice: { kind: 'source-missing', choice: 'retry' }
          },
          { label: i18n.t('common.cancel'), choice: { kind: 'source-missing', choice: 'cancel' } }
        ],
        defaultId: 0,
        cancelId: 1
      }
    case 'confirm-adopt':
      // Only shown if the orchestrator escalates a runtime decision.
      return {
        type: 'question',
        title: i18n.t('desktop.adoptConfirmTitle'),
        message: i18n.t('desktop.adoptConfirmMessage'),
        buttons: [
          {
            label: i18n.t('desktop.adoptConfirm'),
            choice: { kind: 'confirm-adopt', choice: 'yes' }
          },
          { label: i18n.t('common.cancel'), choice: { kind: 'confirm-adopt', choice: 'no' } }
        ],
        defaultId: 0,
        cancelId: 1
      }
  }
}

// Resolve a UserChoice via a native modal anchored to the focused window.
async function showAdoptPrompt(kind: AdoptPromptKind, ctx: unknown): Promise<UserChoice> {
  const spec = buildAdoptPromptSpec(kind, ctx)
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
  const opts = {
    type: spec.type,
    title: spec.title,
    message: spec.message,
    detail: spec.detail,
    buttons: spec.buttons.map((b) => b.label),
    defaultId: spec.defaultId,
    cancelId: spec.cancelId,
    noLink: true
  }
  const result = parent
    ? await dialog.showMessageBox(parent, opts)
    : await dialog.showMessageBox(opts)
  const idx = Math.max(0, Math.min(result.response, spec.buttons.length - 1))
  return spec.buttons[idx]!.choice
}

export async function handleMigrateToStandalone({
  event,
  installationId,
  inst,
  actionData
}: ActionContext): Promise<ActionResult> {
  if (_operationAborts.has(installationId)) {
    return { ok: false, message: 'Another operation is already running for this installation.' }
  }

  const sender = event.sender
  const sendProgress = makeSendProgress(sender, installationId)
  const sendOutput = makeSendOutput(sender, installationId)

  const abort = new AbortController()
  _operationAborts.set(installationId, abort)

  const flowContext = {
    source_id: inst.sourceId as string,
    source_installation_id: inst.id
  }

  // Desktop source → adopt the legacy install in place (the legacy record
  // is left alone), returning a fresh standalone record.
  if (inst.sourceId === 'desktop') {
    let adopted: InstallationRecord | null = null
    try {
      adopted = await telemetry.trackedStep('comfy.desktop.migrate.flow', flowContext, async () => {
        return adoptDesktopInstall({
          tools: {
            sendProgress,
            sendOutput,
            signal: abort.signal,
            promptUser: showAdoptPrompt
          }
        })
      })
      _operationAborts.delete(installationId)
      sendProgress('done', { percent: 100, status: i18n.t('common.done') })
      return { ok: true, navigate: 'list', newInstallationId: adopted.id }
    } catch (err) {
      _operationAborts.delete(installationId)
      if (adopted) {
        try {
          await installations.remove(adopted.id)
          if (adopted.installPath && fs.existsSync(adopted.installPath)) {
            await fs.promises.rm(adopted.installPath, { recursive: true, force: true })
          }
        } catch {}
      }
      if (abort.signal.aborted) return { ok: true, navigate: 'detail' }
      const message = (err as Error).message
      // Adoption couldn't obtain the ComfyUI source (no staged copy and the
      // git clone failed). Fail clearly with a message that points the user
      // at doing a fresh install, rather than the old fake-success no-op.
      if (message.startsWith('source-missing')) {
        return { ok: false, message: i18n.t('desktop.adoptSourceMissingFailed') }
      }
      return { ok: false, message }
    }
  }

  // Non-desktop source → standard local-install migration.
  let entry: InstallationRecord | null = null
  let destPath = ''
  try {
    const migrationTools = {
      sendProgress,
      sendOutput,
      signal: abort.signal,
      sourceMap,
      uniqueName
    }
    const result = await telemetry.trackedStep(
      'comfy.desktop.migrate.flow',
      flowContext,
      async () => {
        return performLocalMigration(inst, actionData, migrationTools)
      }
    )
    entry = result.entry
    destPath = result.destPath

    _operationAborts.delete(installationId)
    sendProgress('done', { percent: 100, status: 'Complete' })
    return { ok: true, navigate: 'list' }
  } catch (err) {
    _operationAborts.delete(installationId)
    if (entry) {
      try {
        await installations.remove(entry.id)
      } catch {}
    }
    if (destPath && fs.existsSync(destPath)) {
      try {
        await fs.promises.rm(destPath, { recursive: true, force: true })
      } catch {}
    }
    if (abort.signal.aborted) return { ok: true, navigate: 'detail' }
    return { ok: false, message: (err as Error).message }
  }
}
