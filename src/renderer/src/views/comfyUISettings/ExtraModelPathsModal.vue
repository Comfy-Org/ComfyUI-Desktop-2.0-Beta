<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { FileText, RefreshCw } from 'lucide-vue-next'
import BaseModal from '../../components/ui/BaseModal.vue'
import InfoTooltip from '../../components/InfoTooltip.vue'

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
  /** Every section in the install's `extra_model_paths.yaml`. */
  sections: ExtraModelPathSection[]
  /** Absolute path of the install's `extra_model_paths.yaml`. */
  yamlPath: string
}

defineProps<Props>()

const emit = defineEmits<{
  close: []
  /** Open a folder (base_path or a per-type dir) in the OS file manager. */
  'open-path': [path: string]
  /** Reveal a file (the .yaml) in the OS file manager, highlighting it. */
  'reveal-path': [path: string]
  /** Re-fetch on-disk status (the main process resolves existence per fetch). */
  refresh: []
}>()

const { t } = useI18n()
</script>

<template>
  <BaseModal
    :open="open"
    size="md"
    :aria-label="t('comfyUISettings.extraModelPathsModalTitle', 'Custom model paths')"
    @close="emit('close')"
  >
    <template #header>
      <div class="empm-header">
        <h2 class="empm-title">
          {{ t('comfyUISettings.extraModelPathsModalTitle', 'Custom model paths') }}
        </h2>
        <button
          type="button"
          class="empm-refresh"
          :aria-label="t('comfyUISettings.refreshCustomPaths', 'Refresh status')"
          :title="t('comfyUISettings.refreshCustomPaths', 'Refresh status')"
          @click="emit('refresh')"
        >
          <RefreshCw :size="14" aria-hidden="true" />
        </button>
      </div>
      <p v-if="yamlPath" class="empm-section-name">{{ yamlPath }}</p>
    </template>

    <p class="empm-note">
      {{
        t(
          'comfyUISettings.extraModelPathsModalNote',
          'Read-only — ComfyUI searches these directories, but the launcher does not manage them. Edit extra_model_paths.yaml to change them.'
        )
      }}
    </p>

    <section v-for="(section, si) in sections" :key="`${section.name}-${si}`" class="empm-section">
      <div class="empm-section-head">
        <span class="empm-section-title">{{ section.name }}</span>
        <span v-if="section.isDefault" class="empm-tag">
          {{ t('common.default', 'default') }}
          <InfoTooltip :text="t('tooltips.extraModelPathsDefault')" />
        </span>
      </div>
      <button
        v-if="section.basePath"
        type="button"
        class="empm-base-path"
        :class="{ 'is-missing': !section.basePathExists }"
        :title="
          section.basePathExists
            ? t('comfyUISettings.openBaseFolder', 'Open base folder')
            : t('comfyUISettings.dirMissingTitle', { dir: section.basePath })
        "
        @click="emit('open-path', section.basePath)"
      >{{ section.basePath }}</button>

      <ul class="empm-dirs">
        <li v-for="(d, i) in section.dirs" :key="`${d.rawType}-${i}`" class="empm-dir">
          <span class="empm-dir-type">{{ d.rawType }}</span>
          <button
            type="button"
            class="empm-dir-path"
            :class="{ 'is-missing': !d.dirExists }"
            :title="
              d.dirExists
                ? t('models.openDir', 'Open folder')
                : t('comfyUISettings.dirMissingTitle', { dir: d.dir })
            "
            @click="emit('open-path', d.dir)"
          >{{ d.dir }}</button>
        </li>
      </ul>
    </section>

    <template #footer>
      <button
        type="button"
        class="empm-action"
        :disabled="!yamlPath"
        @click="emit('reveal-path', yamlPath)"
      >
        <FileText :size="14" aria-hidden="true" />
        <span>{{ t('comfyUISettings.revealYaml', 'Show extra_model_paths.yaml') }}</span>
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
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 500;
  line-height: 14px;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  color: var(--text-muted);
  border: 1px solid var(--chooser-surface-border);
  background: color-mix(in srgb, var(--text) 6%, transparent);
}

.empm-section-name {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--text-muted);
  font-family: var(--font-mono, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empm-note {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.45;
  opacity: 0.75;
}

.empm-section {
  margin-bottom: 16px;
}

.empm-section:last-child {
  margin-bottom: 0;
}

.empm-section-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.empm-section-title {
  font-size: 13px;
  font-weight: 600;
}

.empm-base-path {
  display: inline-block;
  max-width: 100%;
  margin-bottom: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
  background: none;
  border: none;
  padding: 0;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  font-family: var(--font-mono, monospace);
}

.empm-base-path:hover,
.empm-base-path:focus-visible {
  color: var(--accent);
  text-decoration: underline;
  outline: none;
}

.empm-base-path.is-missing {
  color: var(--danger);
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
  /* Don't grow: the clickable area hugs the text, but still shrinks with an
     ellipsis for long paths. */
  flex: 0 1 auto;
  min-width: 0;
  max-width: 100%;
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

/* Missing directory: color the path red instead of a separate badge. */
.empm-dir-path.is-missing {
  color: var(--danger);
}

.empm-dir-path.is-missing:hover,
.empm-dir-path.is-missing:focus-visible {
  color: var(--danger);
}

.empm-refresh {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin-left: auto;
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

.empm-refresh:hover,
.empm-refresh:focus-visible {
  background: var(--brand-surface-bg-hover);
  color: var(--neutral-100);
  outline: none;
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
