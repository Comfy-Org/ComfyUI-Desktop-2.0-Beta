<script setup lang="ts">
import type { Component } from 'vue'
import { Users } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'

/** A directory row's folder-style icon with an optional "shared" badge, so
 *  globally-shared dirs are distinguishable from per-instance ones at a glance.
 *  Shared by the models list and the input/output rows for a consistent mark. */
interface Props {
  /** The main folder-style icon (Folder, FolderLock, Layers, …). */
  icon: Component
  /** Overlay the shared badge to mark a globally-shared directory. */
  shared?: boolean
  /** Title for the big icon (e.g. the locked-dir explanation). */
  title?: string
}
defineProps<Props>()

const { t } = useI18n()
</script>

<template>
  <span class="storage-item-icon">
    <component :is="icon" :size="14" :title="title" aria-hidden="true" />
    <span
      v-if="shared"
      class="storage-item-icon-badge"
      :title="t('tooltips.sharedDir', 'Shared across all your ComfyUI instances.')"
    >
      <Users :size="8" aria-hidden="true" />
    </span>
  </span>
</template>

<style scoped>
.storage-item-icon {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  color: var(--text-muted);
}

.storage-item-icon-badge {
  position: absolute;
  right: -4px;
  bottom: -4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 12px;
  height: 12px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--brand-surface-bg);
  box-shadow: 0 0 0 1.5px var(--brand-surface-bg);
}
</style>
