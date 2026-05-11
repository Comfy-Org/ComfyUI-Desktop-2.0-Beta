<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import SettingsSections from '../components/SettingsSections.vue'
import AppUpdateAction from '../components/AppUpdateAction.vue'
import { useModal } from '../composables/useModal'
import type { SettingsSection, SettingsAction } from '../types/ipc'

/**
 * Bare global-settings panel body. Mounted inside the unified
 * SettingsModal as the "Global Settings" tab. Owns its own data
 * fetch + setting-action handling but no chrome — the parent
 * supplies the ModalShell and close button.
 *
 * Renders the section list with the dedicated "Desktop Updates"
 * panel inserted directly below General — the legacy
 * `'check-for-update'` action that used to sit at the bottom of
 * General was retired in favour of the state-driven
 * `<AppUpdateAction />` section here.
 */

const { t } = useI18n()
const modal = useModal()

function openUrl(url: string): void {
  window.api.openExternal(url)
}

const sections = ref<SettingsSection[]>([])
const systemManaged = ref(false)

/** General is always the first section produced by main; everything
 *  after it (Telemetry, Cache, Advanced, source sections, About) gets
 *  rendered below the Desktop Updates panel. Splitting the list this
 *  way keeps the section ordering as data-driven as possible while
 *  still letting us interleave a renderer-only panel. */
const generalSection = computed<SettingsSection[]>(() => sections.value.slice(0, 1))
const tailSections = computed<SettingsSection[]>(() => sections.value.slice(1))

async function loadSettings(): Promise<void> {
  sections.value = await window.api.getSettingsSections()
  const caps = await window.api.getUpdateCapabilities()
  systemManaged.value = caps.systemManaged
}

async function handleAction(action: SettingsAction): Promise<void> {
  if (action.url) {
    openUrl(action.url)
  }
}

function handleUpToDate(): void {
  const message = systemManaged.value ? t('update.debUpToDate') : t('update.upToDate')
  void modal.alert({ title: t('update.updateCheck'), message })
}

function handleCheckError(message: string): void {
  void modal.alert({ title: t('update.updateError'), message })
}

// Refetch when main broadcasts a settings change so panels opened
// in multiple windows stay in sync. The cleanup runs on unmount
// (e.g. when the user switches sidebar tabs in the parent modal).
let unsubSettingsChanged: (() => void) | null = null

onMounted(() => {
  void loadSettings()
  unsubSettingsChanged = window.api.onSettingsChanged(() => {
    void loadSettings()
  })
})

onUnmounted(() => {
  unsubSettingsChanged?.()
})

defineExpose({ loadSettings })
</script>

<template>
  <SettingsSections
    :sections="generalSection"
    @setting-updated="loadSettings"
    @action="handleAction"
  />
  <AppUpdateAction
    @up-to-date="handleUpToDate"
    @check-error="handleCheckError"
  />
  <SettingsSections
    :sections="tailSections"
    @setting-updated="loadSettings"
    @action="handleAction"
  />
</template>
