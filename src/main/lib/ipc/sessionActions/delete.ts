import {
  path, fs,
  installations, i18n,
  deleteDir, formatDeleteStatus,
  findLockingProcesses,
  MARKER_FILE,
  makeSendProgress,
  deleteBrowserPartition,
  instanceModelPathsYaml,
} from '../shared'
import type { ActionContext, ActionResult } from './types'
import { withAbortableSessionAction } from './withAbortable'

/** Best-effort removal of an install's per-instance model-paths YAML, which
 *  lives under dataDir() rather than inside the install directory. */
function removeInstanceModelPathsYaml(installationId: string): void {
  try {
    fs.rmSync(instanceModelPathsYaml(installationId), { force: true })
  } catch {}
}

// Wipe the launcher-owned parts of an adopted install (.venv + marker) at
// adoptedBaseDir, leaving the user's data. Best-effort: a locked venv must not
// block the primary wrapper deletion.
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
    // Wrapper already gone; still clean the legacy venv so re-adopt starts fresh.
    if (adopted && adoptedBaseDir) {
      const noopProgress = (): void => {}
      await cleanupAdoptedLegacyDir(adoptedBaseDir, noopProgress)
    }
    removeInstanceModelPathsYaml(installationId)
    await installations.remove(installationId)
    await deleteBrowserPartition(inst.id, inst.browserPartition as string | undefined)
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
      // Restore the marker (so retry passes the check) and flag partial-delete;
      // re-throw so the wrapper maps the error.
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
    removeInstanceModelPathsYaml(installationId)
    await installations.remove(installationId)
    await deleteBrowserPartition(inst.id, inst.browserPartition as string | undefined)
    return { ok: true, navigate: 'list' }
  })
}
