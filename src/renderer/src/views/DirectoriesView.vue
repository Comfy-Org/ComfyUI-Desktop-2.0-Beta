<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { X } from 'lucide-vue-next'
import DirCard from '../components/DirCard.vue'
import SettingField from '../components/SettingField.vue'
import InfoTooltip from '../components/InfoTooltip.vue'
import type { ModelsSection, SettingsSection } from '../types/ipc'

const { t } = useI18n()

function handleClose(): void {
  // Reset the host window's panel-history stack and return to the
  // comfy/chooser root. Wired into main via the panel preload.
  window.api.closeCurrentPanel()
}

/**
 * Phase 3 §3 — Directories panel.
 *
 * Replaces the launcher window's separate Models + Media views with a
 * single panel reachable from the install pill caret menu. Both views
 * browse on-disk directories an installation reads/writes; the merge
 * surfaces them under one header instead of two parallel tabs.
 *
 * Data sources are unchanged for now:
 *   - `getModelsSections()` returns the model directory list (with
 *     primary / default markers per path).
 *   - `getMediaSections()` returns the shared input/output directory
 *     fields (rendered as SettingField since they're plain settings).
 *
 * Future work (out of scope for the merge landing): pull the per-source
 * folder-tree / scanning / breadcrumb pieces into shared components,
 * and let sources plug additional categories in (snapshots, logs, …).
 */

const modelsSystemDefault = ref('')
const modelsSections = ref<ModelsSection[]>([])
const mediaSections = ref<SettingsSection[]>([])

function normalizePath(p: string): string {
  return (p || '').replace(/[\\/]+$/, '').toLowerCase()
}

async function loadModels(): Promise<void> {
  const result = await window.api.getModelsSections()
  modelsSystemDefault.value = result.systemDefault
  modelsSections.value = result.sections
}

async function loadMedia(): Promise<void> {
  mediaSections.value = await window.api.getMediaSections()
}

async function loadAll(): Promise<void> {
  await Promise.all([loadModels(), loadMedia()])
}

function isDefault(path: string): boolean {
  return normalizePath(path) === normalizePath(modelsSystemDefault.value)
}

async function handleBrowse(field: ModelsSection['fields'][number], index: number): Promise<void> {
  const dir = await window.api.browseFolder(field.value[index])
  if (dir) {
    field.value[index] = dir
    await window.api.setSetting(field.id, [...field.value])
  }
}

async function handleRemove(field: ModelsSection['fields'][number], index: number): Promise<void> {
  field.value.splice(index, 1)
  await window.api.setSetting(field.id, [...field.value])
}

async function handleMakePrimary(
  field: ModelsSection['fields'][number],
  index: number
): Promise<void> {
  const path = field.value[index]
  if (!path) return
  field.value.splice(index, 1)
  field.value.unshift(path)
  await window.api.setSetting(field.id, [...field.value])
}

function handleOpen(path: string): void {
  window.api.openPath(path)
}

async function handleAdd(field: ModelsSection['fields'][number]): Promise<void> {
  const dir = await window.api.browseFolder()
  if (dir) {
    field.value.push(dir)
    await window.api.setSetting(field.id, [...field.value])
  }
}

onMounted(() => loadAll())

defineExpose({ loadAll, loadModels, loadMedia })
</script>

<template>
  <div class="view active">
    <div class="toolbar">
      <div class="breadcrumb">
        <span class="breadcrumb-current">{{ $t('directories.title') }}</span>
      </div>
      <button
        type="button"
        class="view-page-close"
        :title="t('common.close')"
        :aria-label="t('common.close')"
        @click="handleClose"
      >
        <X :size="18" />
      </button>
    </div>

    <div class="view-scroll">
      <!-- Models section: shared model directory list with primary marker. -->
      <div
        v-for="(section, sIdx) in modelsSections"
        :key="`models-${sIdx}`"
        class="settings-section"
      >
        <div v-if="section.title" class="detail-section-title">{{ section.title }}</div>

        <div class="detail-fields">
          <div v-for="field in section.fields" :key="field.id" class="field">
            <label>{{ field.label }}</label>

            <div class="dir-card-list">
              <DirCard
                v-for="(path, index) in field.value"
                :key="index"
                :path="path"
                :is-primary="index === 0"
                :is-default="isDefault(path)"
                @open="handleOpen(path)"
                @browse="handleBrowse(field, index)"
                @remove="handleRemove(field, index)"
                @make-primary="handleMakePrimary(field, index)"
              />
              <button @click="handleAdd(field)">{{ $t('models.addDir') }}</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Shared input/output directories — rendered as plain settings fields
           (the media data layer just exposes them as SettingsSection rows). -->
      <div
        v-for="(section, sIdx) in mediaSections"
        :key="`media-${sIdx}`"
        class="settings-section"
      >
        <div v-if="section.title" class="detail-section-title">
          {{ section.title }}<InfoTooltip :text="$t('tooltips.sharedDirs')" />
        </div>

        <div class="detail-fields">
          <SettingField
            v-for="field in section.fields"
            :key="field.id"
            :field="field"
            @setting-updated="loadMedia"
          />
        </div>
      </div>
    </div>
  </div>
</template>
