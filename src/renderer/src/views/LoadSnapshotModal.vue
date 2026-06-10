<script setup lang="ts">
import { ref, computed, watch, toRaw, onMounted, onBeforeUnmount, onUnmounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight, Upload } from 'lucide-vue-next'
import { useModal } from '../composables/useModal'

import type { SnapshotFilePreview, FieldOption, GPUInfo, ShowProgressOpts } from '../types/ipc'
import { getVariantGpuLabel, sortedCardOptions, findBestVariant } from '../lib/variants'
import { triggerLabel as _triggerLabel, formatDate, formatNodeVersion } from '../lib/snapshots'
import BrandVariantList from '../components/BrandVariantList.vue'
import BrandTakeoverLayout from '../components/BrandTakeoverLayout.vue'
import TakeoverBack from '../components/TakeoverBack.vue'
import { BaseSelect, type BaseSelectOption } from '../components/ui'
import { emitTelemetryAction, toVariantBucket } from '../lib/telemetry'

const emit = defineEmits<{
  close: []
  'show-progress': [opts: ShowProgressOpts]
}>()

const { t } = useI18n()
const modal = useModal()

const isOpen = ref(false)
const preview = ref<SnapshotFilePreview | null>(null)
const installName = ref('')
const loading = ref(false)
const creating = ref(false)
const dragging = ref(false)

const releaseOptions = ref<FieldOption[]>([])
const selectedRelease = ref<FieldOption | null>(null)
const releaseLoading = ref(false)
const variantOptions = ref<FieldOption[]>([])
const selectedVariant = ref<FieldOption | null>(null)
const variantLoading = ref(false)
const detectedGpu = ref<GPUInfo | null>(null)
let optionsGeneration = 0

const nodesExpanded = ref(true)
const pipExpanded = ref(false)
const timelineExpanded = ref(false)

const cardRef = ref<HTMLElement | null>(null)
let returnFocusTo: HTMLElement | null = null

const sortedVariants = computed(() => sortedCardOptions(variantOptions.value))

const snapshotGpuLabel = computed(() => {
  if (!preview.value) return null
  return getVariantGpuLabel(preview.value.newestSnapshot.comfyui.variant || '')
})
const detectedGpuLabel = computed(() => detectedGpu.value?.label || null)
const hardwareMismatch = computed(() => {
  if (!snapshotGpuLabel.value || !detectedGpuLabel.value) return false
  return snapshotGpuLabel.value !== detectedGpuLabel.value
})

const INVALID_NAME_CHARS = /[<>:"/\\|?*]/
const nameHasInvalidChars = computed(() => INVALID_NAME_CHARS.test(installName.value))

const releaseSelectOptions = computed<BaseSelectOption[]>(() =>
  releaseOptions.value.map((opt) => ({
    value: opt.value,
    label: opt.recommended ? `${opt.label} (${t('newInstall.recommended')})` : opt.label,
    description: opt.description
  }))
)
const releasePlaceholder = computed(() => {
  if (releaseLoading.value) return t('newInstall.loading')
  if (releaseOptions.value.length === 0) return t('newInstall.noOptions')
  return ''
})

function onReleaseChange(value: string): void {
  selectedRelease.value = releaseOptions.value.find((o) => o.value === value) ?? null
}

interface SummaryEntry {
  label: string
  value: string
}
const summaryEntries = computed<SummaryEntry[]>(() => {
  if (!preview.value) return []
  const p = preview.value
  const n = p.newestSnapshot
  return [
    { label: t('list.snapshotSourceName'), value: p.installationName || '—' },
    { label: t('list.snapshotCount'), value: String(p.snapshotCount) },
    { label: t('snapshots.comfyuiVersion'), value: n.comfyuiVersion || '—' },
    { label: t('snapshots.variant'), value: n.comfyui.variant || '—' },
    { label: t('snapshots.pythonVersion'), value: n.pythonVersion || '—' },
    { label: t('snapshots.capturedAt'), value: formatDate(n.createdAt) }
  ]
})

function triggerCopy(trigger: string): string {
  return _triggerLabel(trigger, t)
}

function open(): void {
  preview.value = null
  installName.value = ''
  loading.value = false
  creating.value = false
  dragging.value = false
  releaseOptions.value = []
  selectedRelease.value = null
  variantOptions.value = []
  selectedVariant.value = null
  releaseLoading.value = false
  variantLoading.value = false
  nodesExpanded.value = true
  pipExpanded.value = false
  timelineExpanded.value = false
  optionsGeneration++
  isOpen.value = true
}

async function loadReleaseOptions(): Promise<void> {
  const gen = ++optionsGeneration
  releaseLoading.value = true
  releaseOptions.value = []
  selectedRelease.value = null
  variantOptions.value = []
  selectedVariant.value = null
  try {
    const gpu = await window.api.detectGPU()
    if (gen !== optionsGeneration) return
    detectedGpu.value = gpu

    // `includeLatestStable: true` is the gate that opens the standalone source's
    // release list (see `standalone/index.ts:328`). Without it the source returns
    // an empty array and the Create Installation button stays disabled with no
    // visible reason. Mirrors the InstallWizardModal / QuickInstallModal calls
    // — the snapshot-import path was the only place that forgot to pass it.
    const options = await window.api.getFieldOptions('standalone', 'release', {}, { includeLatestStable: true })
    if (gen !== optionsGeneration) return
    releaseOptions.value = options

    // The release dropdown only offers the 'stable'/'latest' channels, so
    // match on the snapshot's update channel (a per-version releaseTag could
    // never equal a channel id). The created install is frozen regardless;
    // this only preselects the channel the snapshot was tracking.
    const snapshotChannel = preview.value?.newestSnapshot.updateChannel
    const match = snapshotChannel ? options.find((o) => o.value === snapshotChannel) : null
    selectedRelease.value = match || options[0] || null
  } finally {
    if (gen === optionsGeneration) releaseLoading.value = false
  }
}

async function loadVariantOptions(): Promise<void> {
  if (!selectedRelease.value) {
    variantOptions.value = []
    selectedVariant.value = null
    return
  }
  const gen = ++optionsGeneration
  variantLoading.value = true
  variantOptions.value = []
  selectedVariant.value = null
  try {
    const rawRelease = JSON.parse(JSON.stringify(toRaw(selectedRelease.value))) as FieldOption
    const options = await window.api.getFieldOptions('standalone', 'variant', {
      release: rawRelease
    })
    if (gen !== optionsGeneration) return
    variantOptions.value = options

    const snapshotVariantId = preview.value?.newestSnapshot.comfyui.variant || ''
    selectedVariant.value = findBestVariant(options, snapshotVariantId)
  } finally {
    if (gen === optionsGeneration) variantLoading.value = false
  }
}

watch(selectedRelease, () => {
  loadVariantOptions()
})

async function loadFromPath(filePath: string): Promise<void> {
  loading.value = true
  try {
    const result = await window.api.previewSnapshotPath(filePath)
    if (!result.ok) {
      if (result.message) {
        await modal.alert({ title: t('list.loadSnapshot'), message: result.message })
      }
      return
    }
    if (result.preview) {
      preview.value = result.preview
      installName.value = result.preview.installationName || ''
      await loadReleaseOptions()
    }
  } finally {
    loading.value = false
  }
}

async function handleBrowse(): Promise<void> {
  const result = await window.api.previewSnapshotFile()
  if (!result.ok) {
    if (result.message) {
      await modal.alert({ title: t('list.loadSnapshot'), message: result.message })
    }
    return
  }
  if (result.preview) {
    preview.value = result.preview
    installName.value = result.preview.installationName || ''
    await loadReleaseOptions()
  }
}

function handleDragOver(event: DragEvent): void {
  event.preventDefault()
  dragging.value = true
}

function handleDragLeave(event: DragEvent): void {
  if (cardRef.value && !cardRef.value.contains(event.relatedTarget as Node)) {
    dragging.value = false
  }
}

async function handleDrop(event: DragEvent): Promise<void> {
  event.preventDefault()
  dragging.value = false
  const file = event.dataTransfer?.files[0]
  if (!file) return
  if (!file.name.endsWith('.json')) {
    await modal.alert({ title: t('list.loadSnapshot'), message: t('snapshots.importInvalidFile') })
    return
  }
  const filePath = window.api.getPathForFile(file)
  if (!filePath) return
  await loadFromPath(filePath)
}

function handleClearPreview(): void {
  preview.value = null
  releaseOptions.value = []
  selectedRelease.value = null
  variantOptions.value = []
  selectedVariant.value = null
  optionsGeneration++
}

function selectVariant(option: FieldOption): void {
  selectedVariant.value = option
  emitTelemetryAction('comfy.desktop.install.variant.selected', {
    variant_bucket: toVariantBucket((option.data?.variantId as string | undefined) || option.value),
    recommended: !!option.recommended,
    flow: 'snapshot'
  })
}

async function handleCreate(): Promise<void> {
  if (!preview.value || creating.value) return
  creating.value = true
  const filePath = preview.value.filePath
  const releaseTag = selectedRelease.value?.value
  const variantId =
    (selectedVariant.value?.data?.variantId as string) || selectedVariant.value?.value || undefined

  try {
    const result = await window.api.createFromSnapshot(
      filePath,
      installName.value || undefined,
      releaseTag,
      variantId
    )
    if (!result.ok) {
      if (result.message) {
        await modal.alert({ title: t('list.loadSnapshot'), message: result.message })
      }
      return
    }
    if (result.entry) {
      creating.value = false
      isOpen.value = false
      emit('close')
      emit('show-progress', {
        installationId: result.entry.id,
        title: `${t('newInstall.installing')} — ${result.entry.name}`,
        apiCall: () => window.api.installInstance(result.entry!.id),
        cancellable: true,
        autoLaunchOnFinish: true,
        opKind: 'install'
      })
      return
    }
  } finally {
    creating.value = false
  }
}

function preventNav(event: Event): void {
  event.preventDefault()
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && isOpen.value) emit('close')
}

watch(isOpen, async (open) => {
  if (open) {
    document.addEventListener('keydown', onKeydown)
    returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
    await nextTick()
    // Prefer a real field (user types right away); otherwise focus the dialog
    // container itself — never a button — so opening doesn't paint a focus-
    // visible ring. Focus stays trapped for keyboard/AT either way.
    const field = cardRef.value?.querySelector<HTMLElement>('input, select, textarea')
    ;(field ?? cardRef.value)?.focus()
  } else {
    document.removeEventListener('keydown', onKeydown)
    returnFocusTo?.focus()
    returnFocusTo = null
  }
})

onMounted(() => {
  document.addEventListener('dragover', preventNav)
  document.addEventListener('drop', preventNav)
})
onUnmounted(() => {
  document.removeEventListener('dragover', preventNav)
  document.removeEventListener('drop', preventNav)
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
  if (returnFocusTo && document.contains(returnFocusTo)) returnFocusTo.focus()
  returnFocusTo = null
})

defineExpose({ open })
</script>

<template>
  <BrandTakeoverLayout v-if="isOpen">
    <div class="ls-shell" data-testid="load-snapshot-modal">
      <h1 class="brand-title">{{ $t('loadSnapshot.grandTitle') }}</h1>
      <p class="brand-lead">{{ $t('loadSnapshot.grandSubtitle') }}</p>
      <div
        ref="cardRef"
        class="brand-card"
        role="dialog"
        aria-modal="true"
        :aria-label="$t('loadSnapshot.grandTitle')"
        tabindex="-1"
        @dragover="!preview && handleDragOver($event)"
        @dragleave="!preview && handleDragLeave($event)"
        @drop="!preview && handleDrop($event)"
      >
        <div class="brand-card__body">
          <div
            v-if="!preview"
            class="ls-dropzone"
            :class="{ 'ls-dropzone--active': dragging, 'ls-dropzone--loading': loading }"
          >
            <div v-if="loading" class="ls-dropzone__loading with-spinner">
              {{ $t('newInstall.loading') }}
            </div>
            <template v-else>
              <Upload :size="32" class="ls-dropzone__icon" aria-hidden="true" />
              <div class="ls-dropzone__hint">{{ $t('list.snapshotDropHint') }}</div>
              <div class="ls-dropzone__or">{{ $t('common.or') }}</div>
              <button class="brand-tertiary" type="button" @click="handleBrowse">
                {{ $t('common.browse') }}
              </button>
            </template>
          </div>

          <template v-else>
            <div class="ls-field">
              <label class="ls-label" for="ls-name">{{ $t('common.name') }}</label>
              <div class="brand-input">
                <input
                  id="ls-name"
                  v-model="installName"
                  type="text"
                  :placeholder="$t('common.namePlaceholder')"
                />
              </div>
              <div v-if="nameHasInvalidChars" class="ls-hint ls-hint--warn">
                {{ $t('list.snapshotNameHint') }}
              </div>
            </div>

            <div class="ls-field">
              <label class="ls-label">{{ $t('list.snapshotRelease') }}</label>
              <BaseSelect
                :model-value="selectedRelease?.value ?? ''"
                :options="releaseSelectOptions"
                :placeholder="releasePlaceholder"
                :disabled="releaseLoading || releaseOptions.length === 0"
                :aria-label="$t('list.snapshotRelease')"
                @update:model-value="onReleaseChange"
              />
              <div v-if="preview.newestSnapshot.comfyui.releaseTag" class="ls-hint">
                {{
                  $t('list.snapshotOriginalRelease', {
                    tag: preview.newestSnapshot.comfyui.releaseTag
                  })
                }}
              </div>
            </div>

            <div class="ls-field">
              <label class="ls-label">{{ $t('list.snapshotDevice') }}</label>
              <div v-if="variantLoading" class="ls-loading with-spinner">
                {{ $t('newInstall.loading') }}
              </div>
              <BrandVariantList
                v-else-if="variantOptions.length > 0"
                :options="sortedVariants"
                :selected-value="selectedVariant?.value"
                :aria-label="$t('list.snapshotDevice')"
                @select="selectVariant"
              />
              <div v-else class="ls-loading">{{ $t('newInstall.noOptions') }}</div>
              <div v-if="hardwareMismatch" class="ls-hw-warning">
                {{
                  $t('list.snapshotHardwareMismatch', {
                    snapshotDevice: snapshotGpuLabel,
                    detectedDevice: detectedGpuLabel
                  })
                }}
              </div>
            </div>

            <div class="ls-divider" aria-hidden="true" />

            <div class="brand-summary">
              <div v-for="entry in summaryEntries" :key="entry.label" class="brand-summary__row">
                <span class="brand-summary__label">{{ entry.label }}</span>
                <span class="brand-summary__value">{{ entry.value }}</span>
              </div>
            </div>

            <div class="ls-disclosure" :class="{ 'is-open': nodesExpanded }">
              <button
                type="button"
                class="ls-disclosure__summary"
                :aria-expanded="nodesExpanded"
                @click="nodesExpanded = !nodesExpanded"
              >
                <ChevronRight :size="14" class="ls-disclosure__chevron" aria-hidden="true" />
                <span
                  >{{ $t('snapshots.customNodes') }} ({{
                    preview.newestSnapshot.customNodes.length
                  }})</span
                >
              </button>
              <div class="ls-disclosure__wrap">
                <div class="ls-disclosure__body">
                  <div v-if="preview.newestSnapshot.customNodes.length > 0" class="recessed-list">
                    <div
                      v-for="node in preview.newestSnapshot.customNodes"
                      :key="node.id"
                      class="ls-node-row"
                    >
                      <span
                        class="ls-node-status"
                        :class="node.enabled ? 'ls-node-enabled' : 'ls-node-disabled'"
                      />
                      <span class="ls-node-name">{{ node.id }}</span>
                      <span class="ls-node-type">{{ node.type }}</span>
                      <span class="ls-node-version" :title="formatNodeVersion(node)">
                        {{ formatNodeVersion(node) }}
                      </span>
                    </div>
                  </div>
                  <div v-else class="ls-empty">—</div>
                </div>
              </div>
            </div>

            <div class="ls-disclosure" :class="{ 'is-open': pipExpanded }">
              <button
                type="button"
                class="ls-disclosure__summary"
                :aria-expanded="pipExpanded"
                @click="pipExpanded = !pipExpanded"
              >
                <ChevronRight :size="14" class="ls-disclosure__chevron" aria-hidden="true" />
                <span
                  >{{ $t('snapshots.pipPackages') }} ({{
                    preview.newestSnapshot.pipPackageCount
                  }})</span
                >
              </button>
              <div class="ls-disclosure__wrap">
                <div class="ls-disclosure__body">
                  <div v-if="preview.newestSnapshot.pipPackageCount > 0" class="recessed-list">
                    <div
                      v-for="(version, name) in preview.newestSnapshot.pipPackages"
                      :key="name"
                      class="ls-pip-row"
                    >
                      <span class="ls-pip-name">{{ name }}</span>
                      <span class="ls-pip-version" :title="version">{{ version }}</span>
                    </div>
                  </div>
                  <div v-else class="ls-empty">—</div>
                </div>
              </div>
            </div>

            <div class="ls-disclosure" :class="{ 'is-open': timelineExpanded }">
              <button
                type="button"
                class="ls-disclosure__summary"
                :aria-expanded="timelineExpanded"
                @click="timelineExpanded = !timelineExpanded"
              >
                <ChevronRight :size="14" class="ls-disclosure__chevron" aria-hidden="true" />
                <span>{{ $t('list.snapshotTimeline') }} ({{ preview.snapshotCount }})</span>
              </button>
              <div class="ls-disclosure__wrap">
                <div class="ls-disclosure__body">
                  <div class="ls-timeline">
                    <div
                      v-for="(snap, i) in preview.snapshots"
                      :key="snap.filename"
                      class="ls-timeline-item"
                    >
                      <span class="ls-trigger" :class="'ls-trigger-' + snap.trigger">
                        {{ triggerCopy(snap.trigger) }}
                      </span>
                      <span v-if="i === 0" class="ls-current-tag">{{
                        $t('snapshots.current')
                      }}</span>
                      <span class="ls-meta">
                        {{ snap.comfyuiVersion }} ·
                        {{ $t('snapshots.nodesCount', { count: snap.nodeCount }) }} ·
                        {{ $t('snapshots.packagesCount', { count: snap.pipPackageCount }) }}
                      </span>
                      <span class="ls-time">{{ formatDate(snap.createdAt) }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </template>
        </div>

        <div v-if="preview" class="brand-card__footer">
          <button class="brand-ghost ls-back" type="button" @click="handleClearPreview">
            {{ $t('common.back') }}
          </button>
          <button
            class="brand-primary ls-create"
            :disabled="creating || !selectedVariant"
            @click="handleCreate"
          >
            {{ creating ? `${$t('newInstall.installing')}…` : $t('list.snapshotCreateInstall') }}
          </button>
        </div>
      </div>
    </div>
    <template #footer-left>
      <TakeoverBack
        class="ls-back-to-dashboard"
        :label="$t('common.backToDashboard')"
        @back="emit('close')"
      />
    </template>
  </BrandTakeoverLayout>
</template>

<style scoped>
.ls-shell {
  align-self: stretch;
  height: 100%;
  max-height: 100%;
  width: 100%;
  max-width: 720px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding-block: clamp(1.5rem, 4vh, 3rem);
  min-height: 0;
}

.ls-back {
  margin-right: auto;
}

.ls-back-to-dashboard {
  position: absolute;
  left: clamp(1.25rem, 2vw, 2rem);
  bottom: clamp(1.25rem, 2vw, 2rem);
  z-index: 2;
}

/* Empty state — drop zone fills the body */
.ls-dropzone {
  flex: 1 1 auto;
  min-height: 220px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  border: 2px dashed var(--brand-surface-border);
  border-radius: 8px;
  padding: 32px;
  transition:
    border-color 160ms ease,
    background 160ms ease;
  color: var(--neutral-200);
}
.ls-dropzone--active {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}
.ls-dropzone--loading {
  opacity: 0.6;
  pointer-events: none;
}
.ls-dropzone__icon {
  color: var(--neutral-300);
  margin-bottom: 4px;
}
.ls-dropzone__hint {
  font-size: var(--takeover-fs-body);
  color: var(--neutral-200);
  text-align: center;
}
.ls-dropzone__or {
  font-size: var(--takeover-fs-caption);
  color: var(--neutral-300);
}
.ls-dropzone__loading {
  font-size: var(--takeover-fs-body);
  color: var(--neutral-300);
}

/* Field rows */
.ls-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ls-label {
  font-size: 13px;
  color: var(--neutral-200);
}
.ls-hint {
  font-size: var(--takeover-fs-caption);
  color: var(--neutral-300);
}
.ls-hint--warn {
  color: var(--warning);
}
.ls-loading {
  font-size: var(--takeover-fs-body);
  color: var(--neutral-300);
  padding: 8px 0;
}

.ls-hw-warning {
  font-size: 13px;
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--warning) 30%, transparent);
  border-radius: 6px;
  padding: 8px 12px;
}

.ls-divider {
  height: 1px;
  background: var(--brand-surface-border);
  margin-block: 4px;
}

/* Disclosures — grid-rows animation, same recipe as InstallWizardModal's .config-advanced */
.ls-disclosure {
  border-top: 1px solid var(--brand-surface-border);
  padding-top: var(--takeover-gap-md);
}
.ls-disclosure__summary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  cursor: pointer;
  background: transparent;
  border: none;
  color: var(--neutral-200);
  font: inherit;
  font-size: var(--takeover-fs-body);
}
.ls-disclosure__summary:hover {
  color: var(--neutral-100);
  transition: color 120ms ease;
}
.ls-disclosure__summary:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
  border-radius: 4px;
}
.ls-disclosure__chevron {
  transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
}
.ls-disclosure.is-open .ls-disclosure__chevron {
  transform: rotate(90deg);
}
.ls-disclosure__wrap {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 280ms cubic-bezier(0.22, 1, 0.36, 1);
}
.ls-disclosure.is-open .ls-disclosure__wrap {
  grid-template-rows: 1fr;
}
.ls-disclosure__body {
  min-height: 0;
  overflow: hidden;
  opacity: 0;
  transform: translateY(-4px);
  transition:
    opacity 220ms ease 60ms,
    transform 260ms cubic-bezier(0.22, 1, 0.36, 1) 40ms;
}
.ls-disclosure.is-open .ls-disclosure__body {
  margin-top: 10px;
  opacity: 1;
  transform: translateY(0);
}

@media (prefers-reduced-motion: reduce) {
  .ls-disclosure__chevron,
  .ls-disclosure__wrap,
  .ls-disclosure__body,
  .ls-dropzone {
    transition: none;
  }
}
</style>
