import { ref, onUnmounted } from 'vue'
import type { DiskSpaceInfo, PathIssue } from '../types/ipc'
import { emitTelemetryAction } from './telemetry'
import { formatBytes } from './formatting'

const pathIssueI18nKeys: Record<PathIssue, { title: string; message: string }> = {
  insideAppBundle: {
    title: 'pathValidation.insideAppBundleTitle',
    message: 'pathValidation.insideAppBundleMessage'
  },
  oneDrive: {
    title: 'pathValidation.oneDriveTitle',
    message: 'pathValidation.oneDriveMessage'
  },
  insideSharedDir: {
    title: 'pathValidation.insideSharedDirTitle',
    message: 'pathValidation.insideSharedDirMessage'
  },
  insideExistingInstall: {
    title: 'pathValidation.insideExistingInstallTitle',
    message: 'pathValidation.insideExistingInstallMessage'
  }
}

export function toPathGuardrail(issue: PathIssue): string {
  switch (issue) {
    case 'insideAppBundle':
      return 'path_inside_bundle'
    case 'oneDrive':
      return 'onedrive'
    case 'insideSharedDir':
      return 'inside_shared_dir'
    case 'insideExistingInstall':
      return 'inside_existing_install'
    default:
      return 'path_issue'
  }
}

export function trackGuardrailBlocked(guardrailType: string, flow: string, stage: string): void {
  emitTelemetryAction('comfy.desktop.install.guardrail.blocked', {
    guardrail_type: guardrailType,
    flow,
    stage
  })
}

/**
 * Show blocking alerts for each path issue. Returns `true` if the path is valid
 * (no issues), or `false` if a blocking issue was shown.
 */
export async function showPathIssueAlerts(
  issues: PathIssue[],
  flow: string,
  stage: string,
  alert: (opts: { title: string; message: string }) => Promise<void>,
  t: (key: string) => string
): Promise<boolean> {
  for (const issue of issues) {
    const keys = pathIssueI18nKeys[issue]
    if (keys) {
      trackGuardrailBlocked(toPathGuardrail(issue), flow, stage)
      await alert({ title: t(keys.title), message: t(keys.message) })
      return false
    }
  }
  return true
}

/**
 * Check NVIDIA driver compatibility and show a warning if unsupported.
 * Returns `true` if the caller should proceed, `false` if the user cancelled.
 */
export async function checkNvidiaDriverOrWarn(
  flow: string,
  stage: string,
  confirm: (opts: {
    title: string
    message: string
    confirmLabel: string
    confirmStyle: string
  }) => Promise<boolean>,
  t: (key: string, params?: Record<string, string>) => string
): Promise<boolean> {
  const driverCheck = await window.api.checkNvidiaDriver()
  if (driverCheck && !driverCheck.supported) {
    const ok = await confirm({
      title: t('newInstall.nvidiaDriverWarningTitle'),
      message: t('newInstall.nvidiaDriverWarning', {
        driverVersion: driverCheck.driverVersion,
        minimumVersion: driverCheck.minimumVersion
      }),
      confirmLabel: t('newInstall.nvidiaDriverContinue'),
      confirmStyle: 'primary'
    })
    if (!ok) {
      trackGuardrailBlocked('nvidia_driver', flow, stage)
      return false
    }
  }
  return true
}

export function trackDiskWarningResponse(
  warningType: string,
  accepted: boolean,
  flow: string
): void {
  emitTelemetryAction('comfy.desktop.install.disk_warning.response', {
    warning_type: warningType,
    accepted,
    flow
  })
}

/**
 * Check disk space at the given path and show a warning dialog if insufficient.
 * Returns `true` if the caller should proceed, `false` if the user cancelled.
 */
export async function checkDiskSpaceOrWarn(opts: {
  path: string
  estimatedRequired: number
  flow: string
  confirm: (opts: {
    title: string
    message: string
    confirmLabel: string
    confirmStyle: string
  }) => Promise<boolean>
  t: (key: string, params?: Record<string, string>) => string
}): Promise<boolean> {
  const space = await window.api.getDiskSpace(opts.path)

  if (opts.estimatedRequired > 0 && space.free < opts.estimatedRequired) {
    const ok = await opts.confirm({
      title: opts.t('diskSpace.warningTitle'),
      message: opts.t('diskSpace.warningMessage', {
        free: formatBytes(space.free),
        required: formatBytes(opts.estimatedRequired)
      }),
      confirmLabel: opts.t('diskSpace.continueAnyway'),
      confirmStyle: 'primary'
    })
    trackDiskWarningResponse('insufficient_estimated', !!ok, opts.flow)
    if (!ok) return false
  } else if (space.free < 1073741824) {
    const ok = await opts.confirm({
      title: opts.t('diskSpace.warningTitle'),
      message: opts.t('diskSpace.warningMessageGeneric', {
        free: formatBytes(space.free)
      }),
      confirmLabel: opts.t('diskSpace.continueAnyway'),
      confirmStyle: 'primary'
    })
    trackDiskWarningResponse('low_free_space', !!ok, opts.flow)
    if (!ok) return false
  }

  return true
}

/**
 * Hard-block (not a warn) when the volume can't hold the template's required
 * models. Unlike `checkDiskSpaceOrWarn`, there's no "continue anyway" — running
 * out of disk would leave a half-downloaded model set and a confusing error
 * row, so the user must free space or deselect the template first.
 *
 * Returns `true` when there's room (or nothing to check), `false` when the
 * block alert was shown. `estimatedModelBytes` is the template's coarse model
 * size; a small headroom multiplier covers the unzip/temp overhead and the
 * estimate's imprecision.
 */
const TEMPLATE_DISK_HEADROOM = 1.1

/** Bytes the volume must have free to safely fit `estimatedModelBytes` of
 *  template models (model size + a headroom for temp/unzip + estimate slop).
 *  Pure — the threshold math, isolated so it's unit-testable. */
export function templateDiskRequiredBytes(estimatedModelBytes: number): number {
  if (estimatedModelBytes <= 0) return 0
  return Math.ceil(estimatedModelBytes * TEMPLATE_DISK_HEADROOM)
}

/**
 * Single source of truth for "is the volume too small for this template's
 * models?" — used by the picker (to show the alert + disable Install) and by the
 * wizard (the same decision). Pure: `false` when there's nothing to check
 * (no models, disk space not yet known, or it fits). Keeps the three callers
 * from each re-deriving the rule and drifting.
 */
export function isTemplateDiskBlocked(
  diskSpace: DiskSpaceInfo | null,
  estimatedModelBytes: number,
): boolean {
  const required = templateDiskRequiredBytes(estimatedModelBytes)
  if (required === 0 || !diskSpace) return false
  return diskSpace.free < required
}

/**
 * Smallest model footprint among the model-bearing templates, or 0 when none
 * carry models. Drives the "skip the picker entirely when even the cheapest
 * template won't fit" gate — there's no point offering a showcase nothing on it
 * can install. Zero-model templates are ignored (they need no disk).
 */
export function minTemplateModelBytes(modelByteSizes: number[]): number {
  const withModels = modelByteSizes.filter((b) => b > 0)
  return withModels.length ? Math.min(...withModels) : 0
}

export async function checkTemplateDiskOrBlock(opts: {
  path: string
  estimatedModelBytes: number
  flow: string
  alert: (opts: { title: string; message: string }) => Promise<void>
  t: (key: string, params?: Record<string, string>) => string
}): Promise<boolean> {
  if (templateDiskRequiredBytes(opts.estimatedModelBytes) === 0) return true

  let diskSpace: DiskSpaceInfo
  try {
    diskSpace = await window.api.getDiskSpace(opts.path)
  } catch {
    // Can't probe — don't block on a failed read; the in-task guard is the net.
    return true
  }
  if (!isTemplateDiskBlocked(diskSpace, opts.estimatedModelBytes)) return true

  trackGuardrailBlocked('template_models_disk', opts.flow, 'save')
  await opts.alert({
    title: opts.t('diskSpace.templateBlockTitle'),
    message: opts.t('diskSpace.templateBlockMessage', {
      required: formatBytes(templateDiskRequiredBytes(opts.estimatedModelBytes)),
      free: formatBytes(diskSpace.free)
    })
  })
  return false
}

export function createDiskSpaceChecker() {
  const diskSpace = ref<DiskSpaceInfo | null>(null)
  const diskSpaceLoading = ref(false)
  const pathIssues = ref<PathIssue[]>([])
  let diskSpaceTimer: ReturnType<typeof setTimeout> | null = null
  let diskSpaceGeneration = 0

  function fetchDiskSpace(targetPath: string): void {
    if (diskSpaceTimer) clearTimeout(diskSpaceTimer)
    diskSpaceTimer = setTimeout(async () => {
      if (!targetPath) {
        diskSpace.value = null
        pathIssues.value = []
        return
      }
      const gen = ++diskSpaceGeneration
      diskSpaceLoading.value = true
      try {
        const [space, issues] = await Promise.all([
          window.api.getDiskSpace(targetPath),
          window.api.validateInstallPath(targetPath)
        ])
        if (gen !== diskSpaceGeneration) return
        diskSpace.value = space
        pathIssues.value = issues
      } catch {
        if (gen !== diskSpaceGeneration) return
        diskSpace.value = null
        pathIssues.value = []
      } finally {
        if (gen === diskSpaceGeneration) {
          diskSpaceLoading.value = false
        }
      }
    }, 300)
  }

  function reset(): void {
    diskSpace.value = null
    diskSpaceLoading.value = false
    pathIssues.value = []
    if (diskSpaceTimer) clearTimeout(diskSpaceTimer)
    diskSpaceGeneration++
  }

  onUnmounted(() => {
    if (diskSpaceTimer) clearTimeout(diskSpaceTimer)
  })

  return {
    diskSpace,
    diskSpaceLoading,
    pathIssues,
    fetchDiskSpace,
    reset
  }
}
