<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Folder, FolderOpen, RotateCcw } from 'lucide-vue-next'
import StorageItemIcon from '../../components/StorageItemIcon.vue'

/** Readonly directory row: an icon, a clickable path that opens the folder, an
 *  optional tag, and Browse / Reset actions. Shared by the per-instance and
 *  shared input/output sections so both states look identical. */

interface Props {
  /** Field label shown above the row. Omit when a section header already names it. */
  label?: string
  path: string
  /** Small pill shown after the path (e.g. "default"). */
  tag?: string
  /** Show a reset-to-default action. */
  resettable?: boolean
  /** Globally-shared dir → shows the shared badge on its icon. */
  shared?: boolean
}

withDefaults(defineProps<Props>(), {
  label: '',
  tag: '',
  resettable: false,
  shared: false,
})

const emit = defineEmits<{
  open: []
  browse: []
  reset: []
}>()

const { t } = useI18n()
</script>

<template>
  <div class="storage-dir-field">
    <label v-if="label" class="storage-dir-label">{{ label }}</label>
    <div class="storage-dir-row">
      <StorageItemIcon :icon="Folder" :shared="shared" />
      <div class="storage-dir-main">
        <button
          type="button"
          class="storage-dir-name"
          :title="t('models.openDir', 'Open folder')"
          @click="emit('open')"
        >{{ path }}</button>
      </div>
      <span v-if="tag" class="storage-dir-tag">{{ tag }}</span>
      <div class="storage-dir-actions">
        <button
          type="button"
          class="storage-dir-action"
          :aria-label="t('common.browse', 'Browse')"
          :title="t('common.browse', 'Browse')"
          @click="emit('browse')"
        >
          <FolderOpen :size="14" aria-hidden="true" />
        </button>
        <button
          v-if="resettable"
          type="button"
          class="storage-dir-action"
          :aria-label="t('common.resetDefault', 'Reset to default')"
          :title="t('common.resetDefault', 'Reset to default')"
          @click="emit('reset')"
        >
          <RotateCcw :size="14" aria-hidden="true" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.storage-dir-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.storage-dir-label {
  font-size: 12px;
  color: var(--text-muted);
}

.storage-dir-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--chooser-surface-border);
  border-radius: 8px;
  background: var(--brand-surface-bg);
}

/* Flex spacer so the actions stay right-aligned while the clickable path stays
 *  sized to its text (matching the models-dir row). */
.storage-dir-main {
  display: flex;
  align-items: center;
  min-width: 0;
  flex: 1 1 auto;
}

.storage-dir-name {
  min-width: 0;
  max-width: 100%;
  font-size: 13px;
  line-height: 18px;
  color: var(--neutral-100);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0;
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.storage-dir-name:hover,
.storage-dir-name:focus-visible {
  color: var(--accent);
  text-decoration: underline;
  outline: none;
}

.storage-dir-tag {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 500;
  line-height: 14px;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  color: var(--text-muted);
  border: 1px solid var(--chooser-surface-border);
}

.storage-dir-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.storage-dir-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition:
    background-color 100ms ease,
    color 100ms ease;
}

.storage-dir-action:hover,
.storage-dir-action:focus-visible {
  background: var(--brand-surface-bg-hover);
  color: var(--neutral-100);
  outline: none;
}
</style>
