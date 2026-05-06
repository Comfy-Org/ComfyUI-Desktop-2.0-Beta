<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useModal } from '../composables/useModal'
import { useAppUpdateState } from '../composables/useAppUpdateState'
import { emitTelemetryAction } from '../lib/telemetry'

const modal = useModal()
const { t } = useI18n()

/**
 * Phase 3 §18 — both the banner and the title-bar app-update popover
 * subscribe to the same `useAppUpdateState` composable so the two
 * surfaces never disagree about the current update state. The banner
 * keeps its own local `visible` flag (independent of `state`) so the
 * user can dismiss it without clearing the underlying state — the
 * pill / popover stay live.
 */
const { state, canAutoUpdate, systemManaged, clear } = useAppUpdateState()

const visible = ref(false)
// Auto-show the banner whenever a new state arrives (matches the
// pre-§18 behaviour where each `listen()` callback flipped visible
// on every transition). Dismiss only flips `visible`; `state` stays
// for the popover until main pushes a fresh state.
watch(state, (next) => {
  if (next) visible.value = true
})

function formatMarkdown(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>')
}

const bannerMessage = computed<string>(() => {
  if (!state.value) return ''
  switch (state.value.type) {
    case 'available':
      return formatMarkdown(systemManaged.value
        ? t('update.debAvailable', { version: state.value.version })
        : t('update.available', { version: state.value.version }))
    case 'downloading':
      return t('update.downloading', { progress: `${state.value.transferred} / ${state.value.total} MB (${Math.round(state.value.percent)}%)` })
    case 'ready':
      return formatMarkdown(t('update.ready', { version: state.value.version }))
    case 'error':
      return t('update.checkFailed')
    default:
      return ''
  }
})

function dismiss() {
  emitTelemetryAction('desktop2.update.cta', {
    action: 'dismissed',
    state: state.value?.type || 'unknown',
    target_version: (state.value?.type === 'available' || state.value?.type === 'ready') ? state.value.version : undefined,
  })
  visible.value = false
  clear()
}

async function download() {
  emitTelemetryAction('desktop2.update.cta', {
    action: 'download_clicked',
    state: state.value?.type || 'unknown',
    target_version: state.value?.type === 'available' ? state.value.version : undefined,
  })
  state.value = { type: 'downloading', transferred: '0', total: '0', percent: 0 }
  await window.api.downloadUpdate()
}

async function install() {
  emitTelemetryAction('desktop2.update.cta', {
    action: 'install_clicked',
    state: state.value?.type || 'unknown',
    target_version: state.value?.type === 'ready' ? state.value.version : undefined,
  })
  await window.api.installUpdate()
}

function retry() {
  emitTelemetryAction('desktop2.update.cta', {
    action: 'retry_clicked',
    state: state.value?.type || 'unknown',
  })
  clear()
  visible.value = false
  window.api.checkForUpdate()
}

async function showErrorDetails(message: string) {
  await modal.alert({
    title: t('update.updateError'),
    message,
  })
}
</script>

<template>
  <div v-if="visible && state" class="update-banner" :class="state.type">
    <span class="update-banner-message" v-html="bannerMessage"></span>

    <div class="update-banner-actions">
      <!-- available -->
      <template v-if="state.type === 'available'">
        <template v-if="canAutoUpdate">
          <button class="primary" @click="download">{{ $t('update.download') }}</button>
        </template>
        <button @click="dismiss">{{ $t('update.dismiss') }}</button>
      </template>

      <!-- downloading: no actions, just the message -->

      <!-- ready -->
      <template v-else-if="state.type === 'ready'">
        <button class="primary" @click="install">{{ $t('update.restartUpdate') }}</button>
        <button @click="dismiss">{{ $t('update.later') }}</button>
      </template>

      <!-- error -->
      <template v-else-if="state.type === 'error'">
        <button @click="showErrorDetails(state.message)">{{ $t('update.details') }}</button>
        <button @click="retry">{{ $t('update.retry') }}</button>
        <button @click="dismiss">{{ $t('update.dismiss') }}</button>
      </template>
    </div>
  </div>
</template>
