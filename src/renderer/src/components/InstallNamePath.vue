<script setup lang="ts">
import type { PathIssue, DiskSpaceInfo } from '../types/ipc'
import PathDiskInfo from './PathDiskInfo.vue'

defineProps<{
  name: string
  path: string
  defaultPath: string
  hideInstallPath?: boolean
  pathIssues: PathIssue[]
  diskSpaceLoading: boolean
  diskSpace: DiskSpaceInfo | null
  estimatedSize: number
}>()

defineEmits<{
  'update:name': [value: string]
  'update:path': [value: string]
  browse: []
}>()
</script>

<template>
  <div class="field">
    <label for="inst-name">{{ $t('common.name') }}</label>
    <input
      id="inst-name"
      :value="name"
      type="text"
      :placeholder="$t('common.namePlaceholder')"
      @input="$emit('update:name', ($event.target as HTMLInputElement).value)"
    />
  </div>

  <div
    v-if="!hideInstallPath"
    class="field"
  >
    <label for="inst-path">{{ $t('newInstall.installLocation') }}</label>
    <div class="path-input">
      <input
        id="inst-path"
        :value="path"
        type="text"
        @input="$emit('update:path', ($event.target as HTMLInputElement).value)"
      />
      <button @click="$emit('browse')">{{ $t('common.browse') }}</button>
      <button
        v-if="path !== defaultPath"
        @click="$emit('update:path', defaultPath)"
      >{{ $t('common.resetDefault') }}</button>
    </div>
    <PathDiskInfo
      :path-issues="pathIssues"
      :disk-space-loading="diskSpaceLoading"
      :disk-space="diskSpace"
      :estimated-size="estimatedSize"
    />
  </div>
</template>
