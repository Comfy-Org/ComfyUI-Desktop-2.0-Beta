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

/**
 * Wipe the launcher-owned parts of an adopted install at
 * `adoptedBaseDir`, leaving the user's data alone:
 *
 *   delete  `<adoptedBaseDir>/.venv` — opaque interpreter state
 *   delete  `<adoptedBaseDir>/<MARKER_FILE>` — re-adopt sentinel
 *   keep    `models/`, `user/`, `input/`, `output/`, `custom_nodes/`
 *   keep    everything else (user-added files, configs, …)
 *
 * The wrapper at `installPath` is deleted by the standard
 * `deleteDir(installPath)` call in `handleDelete`; this function only
 * handles the legacy-side cleanup, which `deleteDir` cannot reach.
 *
 * Best-effort: a missing or locked legacy venv must not block the primary
 * wrapper deletion — the install record is already on its way out and a
 * half-cleaned legacy dir is recoverable manually.
 */
async function cleanupAdoptedLegacyDir(
  adoptedBaseDir: string,
  sendProgress: (phase: string, detail: Record<string, unknown>) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!fs.existsSync(adoptedBaseDir)) return
  const venvDir = path.join(adoptedBaseDir, '.venv')
  if (fs.existsSync(venvDir)) {
    try {
      sendProgress('delete', { percent: 0, status: 'Removing legacy venv…' })
      await deleteDir(venvDir, (p) => {
        sendProgress('delete', { percent: p.percent, status: formatDeleteStatus(p, 'Removing legacy venv…') })
      }, { signal })
    } catch (err) {
      console.warn('Failed to remove legacy venv at', venvDir, err)
    }
  }
  const adoptMarker = path.join(adoptedBaseDir, MARKER_FILE)
  if (fs.existsSync(adoptMarker)) {
    try { await fs.promises.unlink(adoptMarker) } catch {}
  }
}

export async function handleDelete(ctx: ActionContext): Promise<ActionResult> {
  const { event, installationId, inst } = ctx
  const adopted = inst.adopted === true
  const adoptedBaseDir = adopted ? (inst.adoptedBaseDir as string | undefined) : undefined
  if (!fs.existsSync(inst.installPath)) {
    // Wrapper is already gone but the legacy venv may still be on disk
    // (e.g. user deleted the wrapper manually). Best-effort cleanup before
    // we drop the record so re-adopt later starts clean.
    if (adopted && adoptedBaseDir) {
      const noopProgress = (): void => {}
      await cleanupAdoptedLegacyDir(adoptedBaseDir, noopProgress)
    }
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
      if (adopted && adoptedBaseDir) {
        await cleanupAdoptedLegacyDir(adoptedBaseDir, sendProgress, signal)
      }
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
