<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMigrateAction } from '../composables/useMigrateAction'
import { ArrowRightLeft, Download } from 'lucide-vue-next'
import type { Installation, ShowProgressOpts } from '../types/ipc'

const props = defineProps<{
  installation: Installation
}>()

const emit = defineEmits<{
  'show-progress': [opts: ShowProgressOpts]
  'show-settings': []
  'show-quick-install': []
}>()

const { t } = useI18n()
const { confirmMigration } = useMigrateAction()
const migrating = ref(false)

async function startMigration(): Promise<void> {
  if (migrating.value) return
  migrating.value = true
  try {
    const result = await confirmMigration(props.installation)
    if (!result) return

    emit('show-progress', {
      installationId: props.installation.id,
      title: `${t('desktop.migrating')} — ${props.installation.name}`,
      apiCall: () => window.api.runAction(
        props.installation.id,
        'migrate-to-standalone',
        result,
      ),
      cancellable: true,
      opKind: 'update',
    })
  } finally {
    migrating.value = false
  }
}
</script>

<template>
  <div class="dashboard-welcome">
    <div class="dashboard-welcome-icon">
      <ArrowRightLeft :size="48" />
    </div>

    <h1 class="dashboard-welcome-title">{{ $t('dashboard.migrateBannerTitle') }}</h1>
    <p class="dashboard-welcome-desc">{{ $t('dashboard.migrateBannerDesc') }}</p>
    <button
      class="primary dashboard-cta-btn"
      :disabled="migrating"
      @click="startMigration"
    >
      <ArrowRightLeft :size="18" />
      {{ $t('dashboard.migrateBannerAction') }}
    </button>
    <button
      class="dashboard-cta-btn"
      style="margin-top: 10px"
      @click="emit('show-quick-install')"
    >
      <Download :size="18" />
      {{ $t('dashboard.migrateBannerSkip') }}
    </button>

    <p class="dashboard-telemetry-notice">
      {{ $t('dashboard.telemetryNotice') }}
      <button class="dashboard-telemetry-link" @click="emit('show-settings')">
        {{ $t('dashboard.telemetrySettings') }}
      </button>
    </p>
  </div>
</template>
