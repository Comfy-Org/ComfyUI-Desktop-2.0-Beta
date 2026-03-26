<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import DirCard from '../components/DirCard.vue'
import ModelBrowser from '../components/ModelBrowser.vue'
import type { ModelsSection } from '../types/ipc'

const { t } = useI18n()

type ModelsTab = 'directories' | 'browse'
const activeTab = ref<ModelsTab>('directories')
const systemDefault = ref('')
const sections = ref<ModelsSection[]>([])
const modelBrowserRef = ref<InstanceType<typeof ModelBrowser> | null>(null)

function normalizePath(p: string): string {
  return (p || '').replace(/[\\/]+$/, '').toLowerCase()
}

async function loadModels(): Promise<void> {
  const result = await window.api.getModelsSections()
  systemDefault.value = result.systemDefault
  sections.value = result.sections
  if (activeTab.value === 'browse') modelBrowserRef.value?.refresh()
}

function isDefault(path: string): boolean {
  return normalizePath(path) === normalizePath(systemDefault.value)
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

function switchTab(tab: ModelsTab): void {
  activeTab.value = tab
  if (tab === 'browse') modelBrowserRef.value?.refresh()
}

onMounted(() => loadModels())

defineExpose({ loadModels })
</script>

<template>
  <div class="view active">
    <div class="toolbar">
      <div class="breadcrumb">
        <span class="breadcrumb-current">{{ $t('models.title') }}</span>
      </div>
    </div>

    <div class="view-scroll">
      <div class="detail-tabs">
        <button
          class="detail-tab"
          :class="{ active: activeTab === 'directories' }"
          @click="switchTab('directories')"
        >
          {{ t('models.directoriesTab') }}
        </button>
        <button
          class="detail-tab"
          :class="{ active: activeTab === 'browse' }"
          @click="switchTab('browse')"
        >
          {{ t('models.browse') }}
        </button>
      </div>

      <template v-if="activeTab === 'directories'">
        <div
          v-for="(section, sIdx) in sections"
          :key="sIdx"
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
      </template>

      <ModelBrowser v-else ref="modelBrowserRef" />
    </div>
  </div>
</template>
