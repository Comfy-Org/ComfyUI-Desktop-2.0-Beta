<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { FileText, FolderOpen } from 'lucide-vue-next'
import BaseModal from '../../components/ui/BaseModal.vue'

/** One resolved per-type directory inside a section (mirrors the main-process
 *  `ExtraModelPathDir`). */
export interface ExtraModelPathDir {
  type: string
  rawType: string
  dir: string
  dirExists: boolean
}

/** A grouped `extra_model_paths.yaml` section (mirrors the main-process
 *  `ExtraModelPathSection`). */
export interface ExtraModelPathSection {
  name: string
  basePath: string | null
  basePathExists: boolean
  isDefault: boolean
  dirs: ExtraModelPathDir[]
}

interface Props {
  open: boolean
  section: ExtraModelPathSection | null
  /** Absolute path of the install's `extra_model_paths.yaml`. */
  yamlPath: string
}

const props = defineProps<Props>()

const emit = defineEmits<{
  close: []
  /** Open a folder (base_path or a per-type dir) in the OS file manager. */
  'open-path': [path: string]
}>()

const { t } = useI18n()

const title = computed(() =>
  props.section ? props.section.basePath || props.section.name : ''
)
</script>

<template>
  <BaseModal
    :open="open"
    size="md"
    :aria-label="t('comfyUISettings.extraModelPathsModalTitle', 'Custom model paths')"
    @close="emit('close')"
  >
    <template v-if="section" #header>
      <div class="empm-header">
        <h2 class="empm-title">{{ title }}</h2>
        <span v-if="section.isDefault" class="empm-tag">{{ t('common.default', 'default') }}</span>
      </div>
      <p class="empm-section-name">{{ section.name }}</p>
    </template>

    <template v-if="section">
      <p class="empm-note">
        {{
          t(
            'comfyUISettings.extraModelPathsModalNote',
            'Read-only — ComfyUI searches these directories, but the launcher does not manage them. Edit extra_model_paths.yaml to change them.'
          )
        }}
      </p>

      <ul class="empm-dirs">
        <li v-for="(d, i) in section.dirs" :key="`${d.rawType}-${i}`" class="empm-dir">
          <span class="empm-dir-type">{{ d.rawType }}</span>
          <button
            type="button"
            class="empm-dir-path"
            :title="t('models.openDir', 'Open folder')"
            @click="emit('open-path', d.dir)"
          >{{ d.dir }}</button>
          <span v-if="!d.dirExists" class="empm-dir-missing">{{
            t('comfyUISettings.dirMissing', 'missing')
          }}</span>
        </li>
      </ul>
    </template>

    <template v-if="section" #footer>
      <button
        v-if="section.basePath"
        type="button"
        class="empm-action"
        @click="emit('open-path', section.basePath)"
      >
        <FolderOpen :size="14" aria-hidden="true" />
        <span>{{ t('comfyUISettings.openBaseFolder', 'Open base folder') }}</span>
      </button>
      <button
        type="button"
        class="empm-action"
        :disabled="!yamlPath"
        @click="emit('open-path', yamlPath)"
      >
        <FileText :size="14" aria-hidden="true" />
        <span>{{ t('comfyUISettings.openYaml', 'Open extra_model_paths.yaml') }}</span>
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.empm-header {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.empm-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.empm-tag {
  flex: 0 0 auto;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 12%, transparent);
  opacity: 0.85;
}

.empm-section-name {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--text-muted);
  font-family: var(--font-mono, monospace);
}

.empm-note {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.45;
  opacity: 0.75;
}

.empm-dirs {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--chooser-surface-border);
  border-radius: 8px;
  background: var(--brand-surface-bg);
}

.empm-dir {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 8px 10px;
  border-top: 1px solid var(--border-hover);
}

.empm-dir:first-child {
  border-top: none;
}

.empm-dir-type {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  opacity: 0.85;
  min-width: 92px;
}

.empm-dir-path {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
  background: none;
  border: none;
  padding: 0;
  color: var(--neutral-100);
  cursor: pointer;
  font-size: 12px;
}

.empm-dir-path:hover,
.empm-dir-path:focus-visible {
  color: var(--accent);
  text-decoration: underline;
  outline: none;
}

.empm-dir-missing {
  flex: 0 0 auto;
  font-size: 11px;
  color: #d9822b;
}

.empm-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid var(--chooser-surface-border);
  border-radius: 8px;
  background: transparent;
  color: var(--neutral-100);
  font-size: 13px;
  cursor: pointer;
  transition:
    background-color 100ms ease,
    color 100ms ease;
}

.empm-action:hover:not(:disabled),
.empm-action:focus-visible:not(:disabled) {
  background: var(--brand-surface-bg-hover);
  outline: none;
}

.empm-action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
