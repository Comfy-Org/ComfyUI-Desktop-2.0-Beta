<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseSelect, { type BaseSelectOption } from '../../components/ui/BaseSelect.vue'
import type { ActionDef, DetailField, DetailFieldOption } from '../../types/ipc'
import { TID } from '../../../../shared/testIds'

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
  draft: '' as string
})

watch(
  () => props.field.value,
  (next) => {
    state.draft = String(next ?? '')
  },
  { immediate: true }
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
    updateAvailable: data.updateAvailable
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

const selectOptions = computed<BaseSelectOption[]>(() =>
  (props.field.options ?? []).map((opt) => ({
    value: opt.value,
    label: optionLabel(opt),
    description: opt.description
  }))
)
</script>

<template>
  <div class="channel-picker">
    <BaseSelect
      :model-value="state.draft"
      :options="selectOptions"
      :aria-label="field.label"
      @update:model-value="state.draft = $event"
    />

    <p v-if="selectedOption?.description" class="channel-picker-desc">
      {{ selectedOption.description }}
    </p>

    <!-- Preview card. Per Figma, the channel-level actions (Update Now,
         Copy & Update, etc.) live INSIDE this card, separated from the
         info rows by a hairline. When there's no preview (channel switch
         drafted but no metadata for it) the actions are surfaced below
         the empty placeholder instead, since the card wouldn't render. -->
    <div v-if="preview" class="channel-picker-preview">
      <div class="channel-picker-row">
        <span class="channel-picker-label">{{
          t('channelCards.installedVersion', 'Installed Version')
        }}</span>
        <span class="channel-picker-value">{{ preview.installedVersion ?? '—' }}</span>
      </div>
      <div class="channel-picker-row">
        <span class="channel-picker-label">{{
          t('channelCards.latestVersion', 'Latest Version')
        }}</span>
        <span class="channel-picker-value">{{ preview.latestVersion ?? '—' }}</span>
      </div>
      <div class="channel-picker-row">
        <span class="channel-picker-label">{{
          t('channelCards.lastChecked', 'Last Checked')
        }}</span>
        <span class="channel-picker-value">{{ preview.lastChecked ?? '—' }}</span>
      </div>
      <div class="channel-picker-row">
        <span class="channel-picker-label">{{ t('channelCards.status', 'Status') }}</span>
        <span
          class="channel-picker-value"
          :class="{ 'is-update-available': preview.updateAvailable }"
        >
          {{
            preview.updateAvailable
              ? t('channelCards.updateAvailable', 'Update available')
              : t('channelCards.upToDate', 'Up to date')
          }}
        </span>
      </div>

      <div v-if="selectedActions.length > 0" class="channel-picker-card-actions">
        <p v-if="!draftIsCurrent" class="channel-picker-switch-hint">
          {{ t('channelCards.switchTo', { channel: selectedOption?.label ?? '' }) }}
        </p>
        <div class="channel-picker-action-row">
          <button
            v-for="action in selectedActions"
            :key="action.id"
            type="button"
            :class="[
              'channel-picker-action',
              {
                primary: action.style === 'primary',
                accent: action.style === 'accent',
                danger: action.style === 'danger'
              }
            ]"
            :disabled="action.enabled === false"
            :title="action.tooltip"
            :data-testid="TID.updateActionButton(action.id)"
            @click="emit('action', action)"
          >
            {{ action.label }}
          </button>
        </div>
      </div>
    </div>
    <p v-else-if="!draftIsCurrent" class="channel-picker-empty">
      {{ t('channelCards.noInfo', 'No information available for this channel.') }}
    </p>

    <!-- Fallback action row for the no-preview case (drafted channel
         has no cached metadata yet). -->
    <div v-if="!preview && selectedActions.length > 0" class="channel-picker-actions">
      <p v-if="!draftIsCurrent" class="channel-picker-switch-hint">
        {{ t('channelCards.switchTo', { channel: selectedOption?.label ?? '' }) }}
      </p>
      <div class="channel-picker-action-row">
        <button
          v-for="action in selectedActions"
          :key="action.id"
          type="button"
          :class="[
            'channel-picker-action',
            {
              primary: action.style === 'primary',
              accent: action.style === 'accent',
              danger: action.style === 'danger'
            }
          ]"
          :disabled="action.enabled === false"
          :title="action.tooltip"
          :data-testid="TID.updateActionButton(action.id)"
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
  gap: var(--takeover-gap-sm);
}

.channel-picker-desc {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 16.5px;
}

.channel-picker-preview {
  display: flex;
  flex-direction: column;
  padding: 12px;
  border: 1px solid var(--secondary-background);
  border-radius: 8px;
  margin-top: 12px;
}

/* Each metadata row gets a hairline divider to the next, per Figma. The
 * last row before the in-card action area has no divider — `:has()`
 * keeps the rule declarative without a Vue-template branch. */
.channel-picker-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 0;
  font-size: var(--takeover-fs-caption);
  border-top: 1px solid var(--border-hover);
}

.channel-picker-row:first-child {
  padding-top: 4px;
  border-top: none;
}

.channel-picker-preview:not(:has(.channel-picker-card-actions)) .channel-picker-row:last-child {
  padding-bottom: 4px;
}

.channel-picker-label {
  color: var(--text-muted);
  font-size: var(--takeover-fs-caption);
}

.channel-picker-value {
  color: var(--neutral-100);
  font-size: 14px;
  line-height: 21px;
}

.channel-picker-value.is-update-available {
  color: var(--info);
}

.channel-picker-empty {
  margin: 0;
  padding: 12px;
  border: 1px dashed var(--border);
  border-radius: 8px;
  font-size: var(--takeover-fs-caption);
  color: var(--text-muted);
}

.channel-picker-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.channel-picker-switch-hint {
  margin: 0;
  font-size: var(--takeover-fs-caption);
  color: var(--text-muted);
}

.channel-picker-action-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* Card-internal action row (Figma: actions sit inside the preview
 * card, separated from the metadata rows by a hairline divider, and
 * fill the card width as an evenly-split pair). */
.channel-picker-card-actions {
  margin-top: 4px;
  padding-top: 14px;
  border-top: 1px solid var(--border-hover);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.channel-picker-card-actions .channel-picker-action-row {
  gap: 8px;
}

.channel-picker-card-actions .channel-picker-action {
  flex: 1;
}

.channel-picker-action {
  border: none;
}
</style>
