import {
  fs,
  installations, i18n,
  openPath,
} from '../shared'
import type { ActionContext, ActionResult } from './types'

export async function handleRemove({ installationId }: ActionContext): Promise<ActionResult> {
  await installations.remove(installationId)
  return { ok: true, navigate: 'list' }
}

export async function handleOpenFolder({ inst }: ActionContext): Promise<ActionResult> {
  if (inst.installPath) {
    if (fs.existsSync(inst.installPath)) {
      const err = await openPath(inst.installPath)
      if (err) return { ok: false, message: i18n.t('errors.cannotOpenDir', { error: err }) }
    } else {
      return { ok: false, message: i18n.t('errors.dirNotExist', { path: inst.installPath }) }
    }
  }
  return { ok: true }
}
