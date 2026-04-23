import { ref, onUnmounted } from 'vue'
import type { DiskSpaceInfo, PathIssue } from '../types/ipc'
import { emitTelemetryAction } from './telemetry'

export function toPathGuardrail(issue: PathIssue): string {
  switch (issue) {
    case 'insideAppBundle': return 'path_inside_bundle'
    case 'oneDrive': return 'onedrive'
    case 'insideSharedDir': return 'inside_shared_dir'
    case 'insideExistingInstall': return 'inside_existing_install'
    default: return 'path_issue'
  }
}

export function trackGuardrailBlocked(guardrailType: string, flow: string, stage: string): void {
  emitTelemetryAction('launcher.install.guardrail.blocked', {
    guardrail_type: guardrailType,
    flow,
    stage,
  })
}

export function trackDiskWarningResponse(warningType: string, accepted: boolean, flow: string): void {
  emitTelemetryAction('launcher.install.disk_warning.response', {
    warning_type: warningType,
    accepted,
    flow,
  })
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
          window.api.validateInstallPath(targetPath),
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
    reset,
  }
}
