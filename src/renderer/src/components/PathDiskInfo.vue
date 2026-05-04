<script setup lang="ts">
import type { PathIssue, DiskSpaceInfo } from '../types/ipc'
import { formatBytes } from '../lib/formatting'

defineProps<{
  pathIssues: PathIssue[]
  diskSpaceLoading: boolean
  diskSpace: DiskSpaceInfo | null
  estimatedSize: number
}>()
</script>

<template>
  <div v-if="pathIssues.includes('insideAppBundle')" class="field-error">
    {{ $t('pathValidation.insideAppBundleMessage') }}
  </div>
  <div v-else-if="pathIssues.includes('oneDrive')" class="field-error">
    {{ $t('pathValidation.oneDriveMessage') }}
  </div>
  <div v-else-if="pathIssues.includes('insideSharedDir')" class="field-error">
    {{ $t('pathValidation.insideSharedDirMessage') }}
  </div>
  <div v-else-if="pathIssues.includes('insideExistingInstall')" class="field-error">
    {{ $t('pathValidation.insideExistingInstallMessage') }}
  </div>
  <div class="disk-space-info">
    <template v-if="diskSpaceLoading">
      {{ $t('diskSpace.checking') }}
    </template>
    <template v-else-if="diskSpace">
      {{ $t('diskSpace.free', { size: formatBytes(diskSpace.free) }) }}
      <template v-if="estimatedSize > 0">
        · {{ $t('diskSpace.estimatedRequired', { size: formatBytes(estimatedSize) }) }}
      </template>
    </template>
  </div>
</template>
