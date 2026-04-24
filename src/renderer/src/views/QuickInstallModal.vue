<script setup lang="ts">
import { ref, computed, watch, onMounted, toRaw } from 'vue'
import { useI18n } from 'vue-i18n'
import { useModal } from '../composables/useModal'
import { useModalOverlay } from '../composables/useModalOverlay'
import type { Source, FieldOption } from '../types/ipc'
import { emitTelemetryAction, toVariantBucket } from '../lib/telemetry'
import { stripVariantPrefix, sortedCardOptions } from '../lib/variants'
import VariantCardGrid from '../components/VariantCardGrid.vue'
import { trackGuardrailBlocked, createDiskSpaceChecker, showPathIssueAlerts, checkNvidiaDriverOrWarn, checkDiskSpaceOrWarn } from '../lib/installHelpers'
import InstallNamePath from '../components/InstallNamePath.vue'

const emit = defineEmits<{
  close: []
  'show-progress': [
    opts: {
      installationId: string
      title: string
      apiCall: () => Promise<unknown>
      cancellable?: boolean
    }
  ]
}>()

const { t } = useI18n()
const modal = useModal()

const { handleOverlayMouseDown, handleOverlayClick } = useModalOverlay(
  () => true,
  () => emit('close'),
)

const source = ref<Source | null>(null)
const detectedGpu = ref('')
const variantOptions = ref<FieldOption[]>([])
const selectedVariant = ref<FieldOption | null>(null)
const releaseSelection = ref<FieldOption | null>(null)
const loading = ref(true)
const installing = ref(false)
const errorMessage = ref('')
const instName = ref('')
const instPath = ref('')
const defaultInstPath = ref('')
const { diskSpace, diskSpaceLoading, pathIssues, fetchDiskSpace, reset: resetDiskSpace } = createDiskSpaceChecker()

const estimatedInstallSize = computed(() => {
  const files = selectedVariant.value?.data?.downloadFiles as Array<{ size: number }> | undefined
  const downloadBytes = files ? files.reduce((sum, f) => sum + f.size, 0) : 0
  return downloadBytes > 0 ? Math.ceil(downloadBytes * 2.25) : 0
})

const canInstall = computed(() =>
  !loading.value && !installing.value && selectedVariant.value !== null && pathIssues.value.length === 0
)

watch(instPath, (newPath) => {
  diskSpace.value = null
  pathIssues.value = []
  fetchDiskSpace(newPath)
})



async function handleBrowse(): Promise<void> {
  const chosen = await window.api.browseFolder(instPath.value)
  if (chosen) instPath.value = chosen
}

/** Deep-strip Vue reactive proxies for safe IPC serialization */
function rawSelections(): Record<string, FieldOption> {
  const result: Record<string, FieldOption> = {}
  if (releaseSelection.value) {
    result.release = JSON.parse(JSON.stringify(toRaw(releaseSelection.value))) as FieldOption
  }
  if (selectedVariant.value) {
    result.variant = JSON.parse(JSON.stringify(toRaw(selectedVariant.value))) as FieldOption
  }
  return result
}

let installDirPromise: Promise<string> | null = null

onMounted(() => {
  installDirPromise = window.api.getDefaultInstallDir().catch(() => '')
})

async function open(): Promise<void> {
  loading.value = true
  installing.value = false
  errorMessage.value = ''
  variantOptions.value = []
  selectedVariant.value = null
  releaseSelection.value = null
  source.value = null
  instName.value = ''
  resetDiskSpace()

  detectedGpu.value = t('newInstall.detectingGpu')

  try {
    const [sources, gpu, defaultDir, hw] = await Promise.all([
      window.api.getSources(),
      window.api.detectGPU().catch(() => null),
      installDirPromise ?? window.api.getDefaultInstallDir().catch(() => ''),
      window.api.validateHardware(),
    ])

    if (!hw.supported) {
      trackGuardrailBlocked('unsupported_hw', 'quick', 'open')
      await modal.alert({
        title: t('newInstall.unsupportedHardwareTitle'),
        message: hw.error || '',
      })
      emit('close')
      return
    }

    defaultInstPath.value = defaultDir ?? ''
    instPath.value = defaultInstPath.value

    if (gpu) {
      detectedGpu.value = t('newInstall.detectedGpu', { label: gpu.label })
    } else {
      detectedGpu.value = t('newInstall.noGpuDetected')
    }

    const standalone = sources.find((s) => s.id === 'standalone')
    if (!standalone) {
      errorMessage.value = t('newInstall.noOptions')
      loading.value = false
      return
    }
    source.value = standalone
    emitTelemetryAction('launcher.install.method.selected', {
      source_id: standalone.id,
      source_category: standalone.category || standalone.id,
      flow: 'quick',
    })

    // Load releases and auto-select latest
    const releases = await window.api.getFieldOptions('standalone', 'release', {}, { includeLatestStable: true })
    if (releases.length === 0) {
      errorMessage.value = t('newInstall.noOptions')
      loading.value = false
      return
    }
    releaseSelection.value = releases[0]!

    // Load variants for the selected release
    const variants = await window.api.getFieldOptions(
      'standalone',
      'variant',
      { release: JSON.parse(JSON.stringify(toRaw(releaseSelection.value))) as FieldOption }
    )
    variantOptions.value = variants

    // Auto-select recommended variant
    const recommended = variants.find((v) => v.recommended)
    selectedVariant.value = recommended ?? variants[0] ?? null

    loading.value = false
  } catch (err: unknown) {
    errorMessage.value = (err as Error).message || String(err)
    loading.value = false
  }
}

function selectVariant(option: FieldOption): void {
  selectedVariant.value = option
  emitTelemetryAction('launcher.install.variant.selected', {
    variant_bucket: toVariantBucket((option.data?.variantId as string | undefined) || option.value),
    recommended: !!option.recommended,
    flow: 'quick',
  })
}

async function handleInstall(): Promise<void> {
  if (!source.value || !selectedVariant.value) return
  installing.value = true

  try {
    // Warn if NVIDIA driver is too old for the bundled PyTorch
    const variantId = selectedVariant.value.data?.variantId as string | undefined
    if (variantId && stripVariantPrefix(variantId).startsWith('nvidia')) {
      if (!await checkNvidiaDriverOrWarn('quick', 'install', modal.confirm, t)) {
        installing.value = false
        return
      }
    }

    // Validate install path
    if (instPath.value) {
      try {
        const issues = await window.api.validateInstallPath(instPath.value)
        if (!await showPathIssueAlerts(issues, 'quick', 'install', modal.alert, t)) {
          installing.value = false
          return
        }
      } catch {
        // If validation fails, proceed anyway
      }
    }

    // Check disk space
    if (instPath.value) {
      try {
        const downloadFiles = selectedVariant.value.data?.downloadFiles as
          Array<{ size: number }> | undefined
        const downloadBytes = downloadFiles
          ? downloadFiles.reduce((sum, f) => sum + f.size, 0)
          : 0
        const estimatedRequired = downloadBytes > 0 ? downloadBytes * 2 : 0

        if (!await checkDiskSpaceOrWarn({
          path: instPath.value,
          estimatedRequired,
          flow: 'quick',
          confirm: modal.confirm,
          t,
        })) {
          installing.value = false
          return
        }
      } catch {
        // If disk space check fails, proceed anyway
      }
    }

    const instData = await window.api.buildInstallation('standalone', rawSelections())
    const baseName = instName.value.trim() || 'ComfyUI'
    const name = await window.api.getUniqueName(baseName)

    const result = await window.api.addInstallation({
      name,
      installPath: instPath.value,
      ...instData
    })

    if (!result.ok) {
      await modal.alert({
        title: t('errors.cannotAdd'),
        message: result.message || ''
      })
      installing.value = false
      return
    }

    emit('close')
    if (result.entry) {
      emit('show-progress', {
        installationId: result.entry.id,
        title: `${t('newInstall.installing')} — ${name}`,
        apiCall: () => window.api.installInstance(result.entry!.id)
      })
    }
  } catch (err: unknown) {
    await modal.alert({
      title: t('errors.installFailed'),
      message: (err as Error).message || String(err)
    })
    installing.value = false
  }
}

defineExpose({ open })
</script>

<template>
  <div
    class="view-modal active"
    @mousedown="handleOverlayMouseDown"
    @click="handleOverlayClick"
  >
    <div class="view-modal-content quick-install-modal">
      <div class="view-modal-header">
        <div class="view-modal-title">{{ $t('quickInstall.title') }}</div>
        <button class="view-modal-close" @click="emit('close')">✕</button>
      </div>
      <div class="view-modal-body">
        <div class="view-scroll">
          <div v-if="loading" class="wizard-loading with-spinner">
            {{ $t('newInstall.loading') }}
          </div>

          <div v-else-if="errorMessage" class="wizard-loading">
            {{ errorMessage }}
          </div>

          <template v-else>
            <p class="quick-install-desc">{{ $t('quickInstall.desc') }}</p>

            <div class="detected-hardware">{{ detectedGpu }}</div>

            <div class="field">
              <label>{{ $t('quickInstall.selectVariant') }}</label>
              <VariantCardGrid
                :options="sortedCardOptions(variantOptions)"
                :selected-value="selectedVariant?.value"
                @select="selectVariant"
              />
            </div>

            <InstallNamePath
              :name="instName"
              :path="instPath"
              :default-path="defaultInstPath"
              :path-issues="pathIssues"
              :disk-space-loading="diskSpaceLoading"
              :disk-space="diskSpace"
              :estimated-size="estimatedInstallSize"
              @update:name="instName = $event"
              @update:path="instPath = $event"
              @browse="handleBrowse"
            />
          </template>
        </div>

        <div class="wizard-footer">
          <div class="wizard-back-placeholder"></div>
          <div></div>
          <button
            class="primary quick-install-btn"
            :class="{ loading: installing }"
            :disabled="!canInstall"
            @click="handleInstall"
          >
            {{ installing ? $t('newInstall.installing') : $t('quickInstall.confirmInstall') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
