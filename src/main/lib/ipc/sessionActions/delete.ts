import {
  path, fs,
  installations, i18n,
  deleteDir, formatDeleteStatus,
  findLockingProcesses,
  MARKER_FILE,
  makeSendProgress,
} from '../shared'
import type { ActionContext, ActionResult } from './types'
import { withAbortableSessionAction } from './withAbortable'

export async function handleDelete(ctx: ActionContext): Promise<ActionResult> {
  const { event, installationId, inst } = ctx
  if (!fs.existsSync(inst.installPath)) {
    await installations.remove(installationId)
    return { ok: true, navigate: 'list' }
  }
  const markerPath = path.join(inst.installPath, MARKER_FILE)
  let markerContent: string | null
  try { markerContent = fs.readFileSync(markerPath, 'utf-8').trim() } catch { markerContent = null }
  if (!markerContent) {
    return { ok: false, message: 'Safety check failed: this directory was not created by Comfy Desktop. Use Forget to remove it from the list, then delete the files manually.' }
  }
  if (markerContent !== inst.id && markerContent !== 'tracked') {
    return { ok: false, message: 'Safety check failed: the marker file does not match this installation. Use Forget instead.' }
  }
  const sender = event.sender
  const sendProgress = makeSendProgress(sender, installationId)
  sendProgress('delete', { percent: 0, status: 'Counting files…' })

  return withAbortableSessionAction(ctx, async (signal) => {
    try {
      await deleteDir(inst.installPath, (p) => {
        sendProgress('delete', { percent: p.percent, status: formatDeleteStatus(p) })
      }, { signal })
    } catch (err) {
      // Restore the safety marker so a retry still passes the marker check;
      // mark the install as partially deleted so the dashboard surfaces it.
      // The error is re-thrown so the wrapper maps it (cancelled → cancelled,
      // EBUSY/EPERM → the lock-friendly message below).
      try {
        fs.mkdirSync(inst.installPath, { recursive: true })
        fs.writeFileSync(markerPath, markerContent)
      } catch {}
      await installations.update(installationId, { status: 'partial-delete' })
      const raw = (err as NodeJS.ErrnoException)
      if (raw.code === 'EBUSY' || raw.code === 'EPERM') {
        const lockedPath = raw.path
        if (lockedPath) {
          findLockingProcesses(lockedPath).then((procs) => {
            if (procs.length > 0 && !sender.isDestroyed()) {
              const names = [...new Set(procs.map((p) => p.name))].join(', ')
              const detail = i18n.t('errors.deleteLockedBy', { processes: names, path: lockedPath })
              sender.send('error-detail', { installationId, message: detail })
            }
          }).catch((err) => { console.error('Failed to identify locking processes:', err) })
        }
        throw new Error(i18n.t('errors.deleteLocked', { path: raw.path ?? '' }), { cause: err })
      }
      throw err
    }
    await installations.remove(installationId)
    return { ok: true, navigate: 'list' }
  })
}
