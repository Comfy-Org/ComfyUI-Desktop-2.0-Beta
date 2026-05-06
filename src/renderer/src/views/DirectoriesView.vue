<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import DirCard from '../components/DirCard.vue'
import SettingField from '../components/SettingField.vue'
import InfoTooltip from '../components/InfoTooltip.vue'
import ModalShell from '../components/ModalShell.vue'
import type { ModelsSection, SettingsSection } from '../types/ipc'

const { t } = useI18n()

const emit = defineEmits<{ close: [] }>()

/**
 * Combined Models + Media directory browser. Lists each on-disk
 * directory the active installation reads/writes (model paths,
 * shared input/output) and lets the user add, browse, and reorder.
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
  <ModalShell :title="t('directories.title')" @close="emit('close')">
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

    <!-- Shared input/output directories — surfaced as plain settings fields
         (the media data layer exposes them as SettingsSection rows). -->
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
  </ModalShell>
</template>
