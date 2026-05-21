<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useModal } from '../composables/useModal'
import { ArrowRightLeft } from 'lucide-vue-next'
import type { Installation, ShowProgressOpts } from '../types/ipc'

/**
 * Side-by-side dashboard banner: prompts users who already have at least
 * one Desktop 2.0 install to adopt their detected Legacy Desktop install
 * in place. Skipped in cutover mode (the silent first-launch flow runs
 * before any install exists, so this banner never collides).
 *
 * Mounted by ChooserView above the install grid; emits `show-progress`
 * with the `adopt-in-place` runAction call so PanelApp's existing
 * progress pipeline drives the rest.
 */
const props = defineProps<{
  /** The legacy desktop install (sourceId === 'desktop'). */
  installation: Installation
}>()

const emit = defineEmits<{
  'show-progress': [opts: ShowProgressOpts]
  dismiss: []
}>()

const { t } = useI18n()
const modal = useModal()
const adopting = ref(false)

const adoptTitle = computed(() => t('desktop.adoptBannerTitle'))
const adoptMessage = computed(() => t('desktop.adoptBannerMessage'))

async function startAdopt(): Promise<void> {
  if (adopting.value) return
  adopting.value = true
  try {
    const confirmed = await modal.confirm({
      title: t('desktop.adoptConfirmTitle'),
      message: t('desktop.adoptConfirmMessage'),
      confirmLabel: t('desktop.adoptConfirm'),
      confirmStyle: 'primary',
    })
    if (!confirmed) return

    emit('show-progress', {
      installationId: props.installation.id,
      title: `${t('desktop.adopting')} — ${props.installation.name}`,
      apiCall: () => window.api.runAction(
        props.installation.id,
        'adopt-in-place',
      ),
      cancellable: true,
      opKind: 'update',
    })
  } finally {
    adopting.value = false
  }
}
</script>

<template>
  <div class="adopt-legacy-banner">
    <div class="adopt-legacy-banner-icon">
      <ArrowRightLeft :size="20" />
    </div>
    <div class="adopt-legacy-banner-text">
      <div class="adopt-legacy-banner-title">{{ adoptTitle }}</div>
      <div class="adopt-legacy-banner-desc">{{ adoptMessage }}</div>
    </div>
    <div class="adopt-legacy-banner-actions">
      <button class="primary" :disabled="adopting" @click="startAdopt">
        {{ t('desktop.adoptBannerAction') }}
      </button>
      <button class="ghost" :disabled="adopting" @click="emit('dismiss')">
        {{ t('desktop.adoptBannerDismiss') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.adopt-legacy-banner {
  display: flex;
  align-items: center;
  gap: 16px;
  width: 100%;
  max-width: 1080px;
  padding: 12px 16px;
  border-radius: 12px;
  background: var(--chooser-surface-bg, rgba(255, 255, 255, 0.06));
  border: 1px solid var(--chooser-surface-border, rgba(255, 255, 255, 0.12));
}

.adopt-legacy-banner-icon {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  background: var(--comfy-yellow, #f5c518);
  color: #1a1a1a;
}

.adopt-legacy-banner-text {
  flex: 1 1 0;
  min-width: 0;
}

.adopt-legacy-banner-title {
  font-weight: 600;
  font-size: 14px;
}

.adopt-legacy-banner-desc {
  font-size: 12px;
  opacity: 0.75;
  margin-top: 2px;
}

.adopt-legacy-banner-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.adopt-legacy-banner-actions button {
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 13px;
}
</style>
