<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ActionDef, DetailField, DetailFieldOption } from '../../types/ipc'

/**
 * Update Channel picker for the brand-redesigned Settings drawer (v2).
 * Replaces the legacy `DetailSection`'s `channel-cards` branch with the
 * drawer-style layout from the Figma: a dropdown to pick a channel, a
 * preview block for the selected channel's version info, and a row of
 * actions (Update Now / Copy & Update / Switch Channel) — actions are
 * nested in `option.data.actions` per the same payload main builds.
 *
 * Draft state: switching to a different channel via the dropdown does
 * NOT commit until the user clicks an action. The committed channel is
 * `field.value`; the drafted choice lives in `draftValue` until the
 * action fires. Mirrors `DetailSection`'s `draftValues` reactive map.
 */

interface Props {
  field: DetailField
}

const props = defineProps<Props>()

const emit = defineEmits<{
  action: [action: ActionDef]
}>()

const { t } = useI18n()

// Local draft selection — reset whenever main commits a new value
// (e.g. after a successful channel switch).
const state = reactive({
  draft: '' as string,
})

watch(
  () => props.field.value,
  (next) => {
    state.draft = String(next ?? '')
  },
  { immediate: true },
)

const currentValue = computed(() => String(props.field.value ?? ''))

const selectedOption = computed<DetailFieldOption | undefined>(() => {
  return props.field.options?.find((o) => o.value === state.draft)
})

const selectedActions = computed<ActionDef[]>(() => {
  const data = selectedOption.value?.data as Record<string, unknown> | undefined
  return (data?.actions as ActionDef[] | undefined) ?? []
})

const draftIsCurrent = computed(() => state.draft === currentValue.value)

interface PreviewData {
  installedVersion?: string
  latestVersion?: string
  lastChecked?: string
  updateAvailable?: boolean
}

const preview = computed<PreviewData | null>(() => {
  const data = selectedOption.value?.data as PreviewData | undefined
  if (!data) return null
  // Discard `actions` for the preview computation — only the metadata
  // fields are rendered as rows.
  return {
    installedVersion: data.installedVersion,
    latestVersion: data.latestVersion,
    lastChecked: data.lastChecked,
    updateAvailable: data.updateAvailable,
  }
})

function optionLabel(opt: DetailFieldOption): string {
  if (opt.value === currentValue.value) {
    return `${opt.label} — ${t('channelCards.current', 'Current')}`
  }
  if (opt.recommended) {
    return `${opt.label} — ${t('newInstall.recommended', 'Recommended')}`
  }
  return opt.label
}
</script>

<template>
  <div class="channel-picker">
    <select
      class="channel-picker-select"
      :value="state.draft"
      :aria-label="field.label"
      @change="state.draft = ($event.target as HTMLSelectElement).value"
    >
      <option v-for="opt in field.options" :key="opt.value" :value="opt.value">
        {{ optionLabel(opt) }}
      </option>
    </select>

    <p v-if="selectedOption?.description" class="channel-picker-desc">
      {{ selectedOption.description }}
    </p>

    <div v-if="preview" class="channel-picker-preview">
      <div class="channel-picker-row">
        <span class="channel-picker-label">{{ t('channelCards.installedVersion', 'Installed Version') }}</span>
        <span class="channel-picker-value">{{ preview.installedVersion ?? '—' }}</span>
      </div>
      <div class="channel-picker-row">
        <span class="channel-picker-label">{{ t('channelCards.latestVersion', 'Latest Version') }}</span>
        <span class="channel-picker-value">{{ preview.latestVersion ?? '—' }}</span>
      </div>
      <div class="channel-picker-row">
        <span class="channel-picker-label">{{ t('channelCards.lastChecked', 'Last Checked') }}</span>
        <span class="channel-picker-value">{{ preview.lastChecked ?? '—' }}</span>
      </div>
      <div class="channel-picker-row">
        <span class="channel-picker-label">{{ t('channelCards.status', 'Status') }}</span>
        <span
          class="channel-picker-value"
          :class="{ 'is-update-available': preview.updateAvailable }"
        >
          {{ preview.updateAvailable
            ? t('channelCards.updateAvailable', 'Update available')
            : t('channelCards.upToDate', 'Up to date') }}
        </span>
      </div>
    </div>
    <p v-else-if="!draftIsCurrent" class="channel-picker-empty">
      {{ t('channelCards.noInfo', 'No information available for this channel.') }}
    </p>

    <div v-if="selectedActions.length > 0" class="channel-picker-actions">
      <p v-if="!draftIsCurrent" class="channel-picker-switch-hint">
        {{ t('channelCards.switchTo', { channel: selectedOption?.label ?? '' }) }}
      </p>
      <div class="channel-picker-action-row">
        <button
          v-for="action in selectedActions"
          :key="action.id"
          type="button"
          class="channel-picker-action"
          :class="{
            'is-primary': action.style === 'primary',
            'is-accent': action.style === 'accent',
            'is-danger': action.style === 'danger',
          }"
          :disabled="action.enabled === false"
          :title="action.tooltip"
          @click="emit('action', action)"
        >
          {{ action.label }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.channel-picker {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.channel-picker-select {
  padding: 6px 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  font: inherit;
  font-size: 13px;
}

.channel-picker-select:focus {
  outline: none;
  border-color: var(--accent);
}

.channel-picker-desc {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.4;
}

.channel-picker-preview {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  background: color-mix(in srgb, var(--bg) 60%, transparent);
  border: 1px solid var(--border);
  border-radius: 6px;
}

.channel-picker-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
}

.channel-picker-label {
  color: var(--text-muted);
}

.channel-picker-value {
  color: var(--text);
  font-weight: 500;
  font: 500 12px ui-monospace, SFMono-Regular, Menlo, monospace;
}

.channel-picker-value.is-update-available {
  color: var(--info);
}

.channel-picker-empty {
  margin: 0;
  padding: 10px 12px;
  border: 1px dashed var(--border);
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-muted);
}

.channel-picker-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.channel-picker-switch-hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
}

.channel-picker-action-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.channel-picker-action {
  padding: 6px 12px;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;
}

.channel-picker-action:hover:not(:disabled) {
  background: color-mix(in srgb, var(--text) 6%, transparent);
  border-color: var(--border-hover);
}

.channel-picker-action.is-primary {
  background: var(--accent);
  color: var(--bg);
  border-color: var(--accent);
  font-weight: 600;
}

.channel-picker-action.is-primary:hover:not(:disabled) {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
}

.channel-picker-action.is-accent {
  color: var(--accent);
  border-color: var(--accent);
}

.channel-picker-action.is-danger {
  color: var(--danger);
  border-color: var(--danger);
}

.channel-picker-action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
