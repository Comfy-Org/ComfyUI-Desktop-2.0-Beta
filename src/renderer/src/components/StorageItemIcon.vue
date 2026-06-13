<script setup lang="ts">
import type { Component } from 'vue'
import { computed } from 'vue'
import { FolderSymlink } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'

/** A directory row's folder-style icon. Globally-shared dirs render a distinct
 *  linked-folder glyph (instead of the plain folder) so they read differently
 *  from per-instance dirs at a glance — the same way the locked dir uses
 *  FolderLock. Shared by the models list and the input/output rows. */
interface Props {
  /** The main folder-style icon for non-shared rows (Folder, FolderLock, …). */
  icon: Component
  /** Render the shared glyph + tooltip for a globally-shared directory. */
  shared?: boolean
  /** Title for the icon (e.g. the locked-dir explanation). */
  title?: string
}
const props = defineProps<Props>()

const { t } = useI18n()

const resolvedIcon = computed(() => (props.shared ? FolderSymlink : props.icon))
const resolvedTitle = computed(() =>
  props.shared ? t('tooltips.sharedDir', 'Shared across all your ComfyUI instances.') : props.title
)
</script>

<template>
  <component
    :is="resolvedIcon"
    :size="14"
    class="storage-item-icon"
    :class="{ 'is-shared': shared }"
    :title="resolvedTitle"
    aria-hidden="true"
  />
</template>

<style scoped>
.storage-item-icon {
  flex-shrink: 0;
  color: var(--text-muted);
}
</style>
