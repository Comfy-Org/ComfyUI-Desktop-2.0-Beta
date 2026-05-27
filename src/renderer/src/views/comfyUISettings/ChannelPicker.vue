<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2 } from 'lucide-vue-next'
import BaseSelect, { type BaseSelectOption } from '../../components/ui/BaseSelect.vue'
import InfoTooltip from '../../components/InfoTooltip.vue'
import { formatRelativeFromMs } from '../../lib/datetime'
import type { ActionDef, DetailField, DetailFieldOption } from '../../types/ipc'
import { TID } from '../../../../shared/testIds'

/**
 * Unified update surface: headline status, inset channel card, and
 * compact action row aligned with Global Settings UpdatesSection.
 */

interface Props {
  field: DetailField
  sectionActions?: ActionDef[]
  /** Inline-action busy set — drives the per-button spinner +
   *  disabled state so quick actions like Check-for-Update feel
   *  acknowledged. Passed through from SettingsSectionList. */
  runningActionIds?: Set<string>
}

const props = withDefaults(defineProps<Props>(), {
  sectionActions: () => [],
  runningActionIds: () => new Set<string>()
})

const runningIdsSet = computed(() => props.runningActionIds ?? new Set<string>())
function isActionRunning(actionId: string): boolean {
  return runningIdsSet.value.has(actionId)
}

const emit = defineEmits<{
  action: [action: ActionDef]
}>()

const { t, d } = useI18n()

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
  lastCheckedAt?: number
  updateAvailable?: boolean
  /** True while we know the upstream commit but haven't yet computed
   *  `commitsAhead` for this install's checkout. Drives the muted
   *  "Computing commits ahead…" hint so the eventual label swap
   *  doesn't look like a silent glitch. See `ChannelCardData` in
   *  `src/main/lib/channel-cards.ts` for derivation. */
  enriching?: boolean
}

const preview = computed<PreviewData | null>(() => {
  const data = selectedOption.value?.data as PreviewData | undefined
  if (!data) return null
  return {
    installedVersion: data.installedVersion,
    latestVersion: data.latestVersion,
    lastChecked: data.lastChecked,
    lastCheckedAt: data.lastCheckedAt,
    updateAvailable: data.updateAvailable,
    enriching: data.enriching
  }
})

// Safety net for the `enriching` hint. `commitsAhead` is computed by a
// background git fan-out (`enrichCommitsAhead`) — on failure (offline,
// timeout, repo state edge case) the flag stays true forever as far as
// this component knows. The expected enrichment window is sub-second on
// a fast link; 10s comfortably covers a slow link and still hides the
// hint long before the user starts wondering whether something is
// stuck. Once hidden, the value either upgrades silently (the goal) or
// stays at the documented `tag (sha)` fallback (acceptable).
const ENRICHING_HINT_MAX_MS = 10_000
const enrichingTimedOut = ref(false)
let enrichingTimer: ReturnType<typeof setTimeout> | null = null

function clearEnrichingTimer(): void {
  if (enrichingTimer !== null) {
    clearTimeout(enrichingTimer)
    enrichingTimer = null
  }
}

watch(
  () => preview.value?.enriching === true,
  (isEnriching) => {
    clearEnrichingTimer()
    if (!isEnriching) {
      enrichingTimedOut.value = false
      return
    }
    enrichingTimedOut.value = false
    enrichingTimer = setTimeout(() => {
      enrichingTimedOut.value = true
      enrichingTimer = null
    }, ENRICHING_HINT_MAX_MS)
  },
  { immediate: true }
)

onBeforeUnmount(clearEnrichingTimer)

const showEnrichingHint = computed(
  () => preview.value?.enriching === true && !enrichingTimedOut.value
)

function formatVersionLabel(raw: string | undefined): string {
  if (!raw || raw === '—') return '—'
  const trimmed = raw.trim()
  if (trimmed.startsWith('v') || trimmed.startsWith('V')) return trimmed
  return `v${trimmed}`
}

function normalizeVersion(raw: string | undefined): string {
  if (!raw || raw === '—') return ''
  return raw.trim().replace(/^[vV]/, '').toLowerCase()
}

const versionsMatch = computed(() => {
  if (!preview.value) return false
  const installed = normalizeVersion(preview.value.installedVersion)
  const latest = normalizeVersion(preview.value.latestVersion)
  if (!installed || !latest) return false
  return installed === latest
})

const headline = computed(() => {
  if (preview.value?.installedVersion) {
    return formatVersionLabel(preview.value.installedVersion)
  }
  if (!preview.value) {
    return draftIsCurrent.value
      ? t('channelCards.upToDate', 'Up to date')
      : t('channelCards.switchTo', { channel: selectedOption.value?.label ?? '' })
  }
  if (preview.value.updateAvailable) {
    const ver = preview.value.latestVersion
    return ver ? formatVersionLabel(ver) : t('channelCards.updateAvailable', 'Update available')
  }
  return formatVersionLabel(preview.value.installedVersion)
})

const statusBadge = computed(() => {
  if (!preview.value) return null
  if (preview.value.updateAvailable) {
    return t('channelCards.updateAvailable', 'Update available')
  }
  return t('channelCards.upToDate', 'Up to date')
})

const statusBadgeTone = computed<'current' | 'update'>(() =>
  preview.value?.updateAvailable ? 'update' : 'current'
)

interface StatRow {
  id: string
  label: string
  value: string
  title?: string
  highlight?: boolean
}

const lastCheckedDisplay = computed<{ value: string; title?: string } | null>(() => {
  if (!preview.value) return null
  if (preview.value.lastCheckedAt) {
    const ms = preview.value.lastCheckedAt
    let title: string | undefined
    try {
      title = d(new Date(ms), 'long')
    } catch {
      title = new Date(ms).toLocaleString()
    }
    return { value: formatRelativeFromMs(ms, t), title }
  }
  if (preview.value.lastChecked && preview.value.lastChecked !== '—') {
    return { value: preview.value.lastChecked }
  }
  return null
})

const statRows = computed<StatRow[]>(() => {
  if (!preview.value) return []
  const rows: StatRow[] = []
  const updateAvailable = preview.value.updateAvailable === true

  if (updateAvailable && preview.value.installedVersion) {
    rows.push({
      id: 'installed',
      label: t('channelCards.installedVersion', 'Installed'),
      value: formatVersionLabel(preview.value.installedVersion)
    })
  }
  if (updateAvailable && preview.value.latestVersion && !versionsMatch.value) {
    rows.push({
      id: 'latest',
      label: t('channelCards.latestVersion', 'Latest'),
      value: formatVersionLabel(preview.value.latestVersion),
      highlight: true
    })
  }

  const lastChecked = lastCheckedDisplay.value
  if (lastChecked) {
    rows.push({
      id: 'last-checked',
      label: t('channelCards.lastChecked', 'Last checked'),
      value: lastChecked.value,
      title: lastChecked.title
    })
  }

  return rows
})

const allActions = computed<ActionDef[]>(() => [...selectedActions.value, ...props.sectionActions])

const checkUpdateAction = computed<ActionDef | undefined>(() =>
  allActions.value.find((a) => a.id === 'check-update')
)

const promotedPrimaryActions = computed<ActionDef[]>(() =>
  selectedActions.value.filter((a) => a.id === 'update-comfyui' || a.id === 'copy-update')
)

const otherSecondaryActions = computed<ActionDef[]>(() =>
  selectedActions.value.filter(
    (a) =>
      a.id !== 'check-update' &&
      a.id !== 'update-comfyui' &&
      a.id !== 'copy-update' &&
      a.style !== 'primary' &&
      a.style !== 'accent'
  )
)

const showCheckInHeader = computed(
  () =>
    checkUpdateAction.value != null &&
    promotedPrimaryActions.value.length === 0 &&
    otherSecondaryActions.value.length === 0
)

// When an update is already detected, the user can see the new version
// + Update Now / Copy & Update right above — re-checking is redundant.
// Only surface the manual check when no update is currently visible.
const showCheckUpdateInFooter = computed(
  () =>
    checkUpdateAction.value != null &&
    !showCheckInHeader.value &&
    preview.value?.updateAvailable !== true
)

const showFooterActions = computed(
  () =>
    promotedPrimaryActions.value.length > 0 ||
    otherSecondaryActions.value.length > 0 ||
    showCheckUpdateInFooter.value
)

const footerActions = computed<
  Array<{ action: ActionDef; variant: 'accent' | 'default' | 'danger' }>
>(() => {
  const out: Array<{ action: ActionDef; variant: 'accent' | 'default' | 'danger' }> = []

  if (checkUpdateAction.value && showCheckUpdateInFooter.value) {
    out.push({ action: checkUpdateAction.value, variant: 'default' })
  }

  for (const action of otherSecondaryActions.value) {
    out.push({
      action,
      variant: action.style === 'danger' ? 'danger' : 'default'
    })
  }

  for (const action of promotedPrimaryActions.value) {
    if (action.id === 'copy-update') {
      out.push({ action, variant: 'default' })
    }
  }

  const updateNow = promotedPrimaryActions.value.find((a) => a.id === 'update-comfyui')
  if (updateNow) {
    out.push({ action: updateNow, variant: 'accent' })
  }

  return out
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
    <div class="channel-picker-status">
      <div class="channel-picker-headline-row">
        <p
          class="channel-picker-headline"
          :class="{ 'is-update-available': preview?.updateAvailable }"
        >
          {{ headline }}
        </p>
        <span v-if="statusBadge && preview" class="channel-picker-badge" :class="statusBadgeTone">
          {{ statusBadge }}
        </span>
      </div>

    </div>

    <dl v-if="statRows.length > 0" class="channel-picker-stats">
      <div
        v-for="row in statRows"
        :key="row.id"
        class="channel-picker-stat-row"
        :class="{ 'is-highlight': row.highlight }"
      >
        <dt>{{ row.label }}</dt>
        <dd :title="row.title">{{ row.value }}</dd>
      </div>
    </dl>

    <!-- Background-enrichment hint: visible while `commitsAhead` is still
         being computed against the install's local `.git` checkout. The
         "Latest" value above briefly reads as `tag (sha)` and upgrades
         to `tag + N commits (sha)` once enrichment lands. The hint is
         polite (announced once via aria-live) and self-hides after the
         max display window if enrichment never completes. -->
    <p
      v-if="showEnrichingHint"
      class="channel-picker-enriching"
      role="status"
      aria-live="polite"
    >
      <Loader2 :size="12" class="channel-picker-enriching-spinner" aria-hidden="true" />
      {{ t('channelCards.computingCommitsAhead', 'Computing commits ahead…') }}
    </p>

    <div class="channel-picker-card">
      <div class="channel-picker-channel-header">
        <span class="channel-picker-field-label">
          {{ field.label }}
          <InfoTooltip v-if="field.tooltip" :text="field.tooltip" />
        </span>
        <button
          v-if="showCheckInHeader && checkUpdateAction"
          type="button"
          class="channel-picker-action compact"
          :class="{ 'is-running': isActionRunning(checkUpdateAction.id) }"
          :disabled="checkUpdateAction.enabled === false || isActionRunning(checkUpdateAction.id)"
          :title="checkUpdateAction.tooltip"
          @click="emit('action', checkUpdateAction)"
        >
          <Loader2
            v-if="isActionRunning(checkUpdateAction.id)"
            :size="14"
            class="channel-picker-action-spinner"
          />
          {{ checkUpdateAction.label }}
        </button>
      </div>

      <div class="channel-picker-channel">
        <BaseSelect
          :model-value="state.draft"
          :options="selectOptions"
          :aria-label="field.label"
          @update:model-value="state.draft = $event"
        />
        <p v-if="selectedOption?.description" class="channel-picker-desc">
          {{ selectedOption.description }}
        </p>
      </div>

      <p v-if="!draftIsCurrent && !preview" class="channel-picker-empty">
        {{ t('channelCards.noInfo', 'No information available for this channel.') }}
      </p>
      <p v-else-if="!draftIsCurrent && preview" class="channel-picker-switch-hint">
        {{ t('channelCards.switchTo', { channel: selectedOption?.label ?? '' }) }}
      </p>

      <div v-if="showFooterActions" class="channel-picker-actions">
        <button
          v-for="{ action, variant } in footerActions"
          :key="action.id"
          type="button"
          class="channel-picker-action"
          :class="[variant, { 'is-running': isActionRunning(action.id) }]"
          :disabled="action.enabled === false || isActionRunning(action.id)"
          :title="action.tooltip"
          :data-testid="TID.updateActionButton(action.id)"
          @click="emit('action', action)"
        >
          <Loader2
            v-if="isActionRunning(action.id)"
            :size="14"
            class="channel-picker-action-spinner"
          />
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
  gap: 12px;
}

.channel-picker-headline-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.channel-picker-headline {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  line-height: 24px;
  color: var(--text);
}

.channel-picker-headline.is-update-available {
  color: var(--accent);
}

.channel-picker-badge {
  flex-shrink: 0;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 500;
  line-height: 16px;
  border-radius: 999px;
}

.channel-picker-badge.current {
  color: var(--success, #4ade80);
  background: color-mix(in srgb, var(--success, #4ade80) 12%, transparent);
}

.channel-picker-badge.update {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}

.channel-picker-stats {
  margin: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--chooser-surface-border);
  border-radius: 8px;
  padding: 4px 12px;
  background: var(--brand-surface-bg);
}

.channel-picker-stat-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-top: 1px solid var(--border-hover);
}

.channel-picker-stat-row:first-child {
  border-top: none;
}

.channel-picker-stat-row dt {
  margin: 0;
  font-size: 12px;
  line-height: 16px;
  color: var(--text-muted);
}

.channel-picker-stat-row dd {
  margin: 0;
  font-size: 13px;
  line-height: 19px;
  color: var(--neutral-100);
  text-align: right;
}

.channel-picker-stat-row.is-highlight dd {
  color: var(--accent);
  font-weight: 500;
}

.channel-picker-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--chooser-surface-border);
  border-radius: 8px;
  background: var(--brand-surface-bg);
}

.channel-picker-channel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.channel-picker-channel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.channel-picker-field-label {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 12px;
  font-weight: 400;
  color: var(--text-muted);
  line-height: 16px;
}

.channel-picker-desc {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 16.5px;
}

.channel-picker-empty,
.channel-picker-switch-hint {
  margin: 0;
  font-size: 12px;
  line-height: 16px;
  color: var(--text-muted);
}

.channel-picker-enriching {
  margin: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 16px;
  color: var(--text-muted);
  font-style: italic;
}

.channel-picker-enriching-spinner {
  flex: 0 0 auto;
  animation: channel-picker-action-spin 0.9s linear infinite;
}

@media (prefers-reduced-motion: reduce) {
  .channel-picker-enriching-spinner {
    animation: none;
  }
}

.channel-picker-empty {
  padding: 8px 10px;
  border: 1px dashed var(--chooser-surface-border);
  border-radius: 6px;
}

.channel-picker-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  padding-top: 12px;
  border-top: 1px solid var(--border-hover);
}

.channel-picker-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex: 0 0 auto;
  height: 32px;
  min-height: 32px;
  padding: 0 16px;
  border-radius: 8px;
  border: 1px solid var(--chooser-surface-border);
  background: var(--brand-surface-bg);
  color: var(--neutral-100);
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  box-sizing: border-box;
  transition:
    background-color 100ms ease,
    filter 100ms ease;
}

.channel-picker-action.is-running {
  cursor: progress;
  opacity: 0.85;
}

.channel-picker-action-spinner {
  flex: 0 0 auto;
  animation: channel-picker-action-spin 0.9s linear infinite;
}

@keyframes channel-picker-action-spin {
  to {
    transform: rotate(360deg);
  }
}

.channel-picker-action.compact {
  height: 28px;
  min-height: 28px;
  padding: 0 12px;
  font-size: 12px;
  flex-shrink: 0;
}

.channel-picker-action:hover:not(:disabled),
.channel-picker-action:focus-visible:not(:disabled) {
  background: var(--brand-surface-bg-hover);
  outline: none;
}

.channel-picker-action.accent {
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}

.channel-picker-action.accent:hover:not(:disabled),
.channel-picker-action.accent:focus-visible:not(:disabled) {
  background: var(--accent);
  color: var(--bg);
}

.channel-picker-action.danger {
  color: var(--danger);
  border-color: var(--chooser-surface-border);
}

.channel-picker-action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
