<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight, Loader2, ShieldAlert } from 'lucide-vue-next'
import BaseInput from '../../components/ui/BaseInput.vue'
import BaseSelect, { type BaseSelectOption } from '../../components/ui/BaseSelect.vue'
import BooleanToggle from './BooleanToggle.vue'
import PathField from './PathField.vue'
import EnvVarsField from './EnvVarsField.vue'
import ChannelPicker from './ChannelPicker.vue'
import ArgsBuilderField from './ArgsBuilderField.vue'
import InfoTooltip from '../../components/InfoTooltip.vue'
import BaseCopyButton from '../../components/ui/BaseCopyButton.vue'
import TooltipWrap from '../../components/TooltipWrap.vue'
import type { ActionDef, DetailField, DetailSection } from '../../types/ipc'

/**
 * Shared section + field renderer used by both the unified Settings
 * drawer (`ComfyUISettingsPanel.vue`) and the instance-picker popover's
 * right-pane Settings accordion (`InstancePickerView.vue`). Owns the
 * collapse state per section title, but is otherwise pure presentation
 * — the host wires updateField / runAction / openArgsPage handlers so
 * the same DOM serves both the panel's `window.api`-backed handlers
 * AND the popup's bridge-backed handlers without either surface
 * importing the other's IPC layer.
 *
 * Status-tab styling (label-over-value, no input chrome, hairline
 * dividers between rows) is enabled via the `readonly` prop —
 * mirrors the drawer's `activeTab === 'status'` modifier without
 * forking the template.
 */

interface Props {
  sections: DetailSection[]
  /** Status-tab styling: hairline dividers + label-over-value layout
   *  (no input chrome). Equivalent to the drawer's
   *  `is-readonly-list` section modifier. */
  readonly?: boolean
  /** Installation context for fields that need to hit install-scoped
   *  IPCs (e.g. ArgsBuilderField loads the arg schema via
   *  `getComfyArgs(id)`). Optional so call sites without a current
   *  install degrade gracefully. */
  installationId?: string
  /** Inline-action busy set from the host's `useComfyUISettings` —
   *  drives the per-button spinner + disabled state so quick
   *  actions like Check-for-Update feel acknowledged. */
  runningActionIds?: Set<string>
  /** Field ids edited while the install is running that need a
   *  process restart to take effect. Renders a small tag next to the
   *  field label so users can spot which specific edits are pending. */
  pendingRestartFieldIds?: Set<string>
  /** Per-field transient error messages from failed
   *  `updateInstallation` IPCs. Renders a red inline pill next to
   *  the field label so the user knows the change didn't land. */
  fieldErrorMessages?: Map<string, string>
}

const props = withDefaults(defineProps<Props>(), {
  readonly: false,
  installationId: undefined,
  runningActionIds: () => new Set<string>(),
  pendingRestartFieldIds: () => new Set<string>(),
  fieldErrorMessages: () => new Map<string, string>()
})

// Wrap the Set in a computed so each `.has()` call tracks a reactive
// dep on the prop — bare-function access on a destructured prop inside
// a template attribute binding can miss the dep otherwise.
const runningIdsSet = computed(() => props.runningActionIds ?? new Set<string>())
function isActionRunning(actionId: string): boolean {
  return runningIdsSet.value.has(actionId)
}

const pendingRestartSet = computed(() => props.pendingRestartFieldIds ?? new Set<string>())
function needsRestartTag(field: DetailField): boolean {
  return !!field.requiresRestart && pendingRestartSet.value.has(field.id)
}

const errorMessagesMap = computed(() => props.fieldErrorMessages ?? new Map<string, string>())
function fieldErrorMessage(field: DetailField): string | null {
  return errorMessagesMap.value.get(field.id) ?? null
}

const emit = defineEmits<{
  'update-field': [field: DetailField, value: unknown]
  'run-action': [action: ActionDef]
  'open-args-page': [field: DetailField]
}>()

const { t } = useI18n()

function asString(v: DetailField['value']): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

/** Per-title collapse state. Sections opt into collapsibility by
 *  carrying a `section.collapsed` boolean in their payload; that
 *  initial value pre-seeds this set on first render. Only titled
 *  sections are collapsible (the title is the click target). */
const collapsedTitles = ref(new Set<string>())

watch(
  () => props.sections,
  (sections) => {
    for (const s of sections) {
      if (s.title && s.collapsed === true && !collapsedTitles.value.has(s.title)) {
        collapsedTitles.value.add(s.title)
      }
    }
  },
  { immediate: true }
)

function isCollapsible(section: { title?: string; collapsed?: boolean }): boolean {
  return Boolean(section.title) && section.collapsed !== undefined
}

function isCollapsed(section: { title?: string }): boolean {
  return section.title ? collapsedTitles.value.has(section.title) : false
}

function toggleCollapsed(section: { title?: string }): void {
  if (!section.title) return
  if (collapsedTitles.value.has(section.title)) {
    collapsedTitles.value.delete(section.title)
  } else {
    collapsedTitles.value.add(section.title)
  }
}

const visibleSections = computed(() => props.sections)

const NESTED_FIELD_IDS = new Set(['useSharedOutputDir', 'outputDir'])

function isNestedField(field: DetailField): boolean {
  return NESTED_FIELD_IDS.has(field.id ?? '')
}

function hasChannelPicker(section: DetailSection): boolean {
  return (section.fields ?? []).some((f) => f.editType === 'channel-cards')
}

function isPathLikeValue(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const v = value.trim()
  if (!v || v === '—') return false
  return v.includes('/') || v.includes('\\') || v.startsWith('~')
}

function readonlyDisplayValue(field: DetailField): string {
  return asString(field.value)
}

function fieldOwnsLabel(field: DetailField): boolean {
  return field.editType === 'env-vars' || field.editType === 'channel-cards'
}
</script>

<template>
  <div class="settings-v2-sections">
    <article
      v-for="(section, si) in visibleSections"
      :key="`s-${si}`"
      class="settings-v2-section"
      :class="{
        'is-readonly-list': readonly,
        'is-collapsible': isCollapsible(section),
        'is-collapsed': isCollapsible(section) && isCollapsed(section)
      }"
    >
      <button
        v-if="isCollapsible(section)"
        type="button"
        class="settings-v2-section-title is-toggle"
        :aria-expanded="!isCollapsed(section)"
        @click="toggleCollapsed(section)"
      >
        <ChevronRight
          :size="14"
          class="settings-v2-section-chevron"
          :class="{ 'is-open': !isCollapsed(section) }"
        />
        {{ section.title }}
      </button>

      <p
        v-else-if="section.title && readonly"
        class="settings-v2-section-title settings-v2-section-title--readonly"
      >
        {{ section.title }}
      </p>

      <p v-if="section.description && !isCollapsed(section)" class="settings-v2-section-desc">
        {{ section.description }}
      </p>

      <div v-for="(item, i) in section.items" :key="`i-${i}`" class="settings-v2-item">
        <span class="settings-v2-item-label">
          {{ item.label }}{{ item.active ? ` (${t('common.active', 'active')})` : '' }}
          <span v-if="item.tag" class="settings-v2-item-tag">{{ item.tag }}</span>
        </span>
        <span v-if="item.actions && item.actions.length" class="settings-v2-item-actions">
          <TooltipWrap
            v-for="a in item.actions"
            :key="a.id"
            :text="a.enabled === false && a.disabledMessage ? a.disabledMessage : a.tooltip"
          >
            <button
              type="button"
              :class="[
                'settings-v2-action',
                a.style,
                { 'looks-disabled': a.enabled === false && a.disabledMessage }
              ]"
              :disabled="a.enabled === false && !a.disabledMessage"
              @click="emit('run-action', a)"
            >
              {{ a.label }}
            </button>
          </TooltipWrap>
        </span>
      </div>

      <div
        v-for="field in section.fields"
        :key="field.id"
        class="settings-v2-field"
        :class="{
          'is-boolean-row': field.editType === 'boolean',
          'is-nested': isNestedField(field),
          'is-env-vars': field.editType === 'env-vars',
          'is-channel-picker': field.editType === 'channel-cards'
        }"
      >
        <template v-if="field.editType === 'env-vars'">
          <div class="settings-v2-env-header">
            <label class="settings-v2-field-label">
              <span class="settings-v2-field-label-text">{{ field.label }}</span>
              <InfoTooltip v-if="field.tooltip" :text="field.tooltip" />
              <span v-if="needsRestartTag(field)" class="settings-v2-restart-tag" role="status">
                {{ t('comfyUISettings.restartRequired', 'Restart to apply') }}
              </span>
              <span
                v-if="fieldErrorMessage(field)"
                class="settings-v2-field-error-tag"
                role="alert"
                :title="fieldErrorMessage(field) ?? ''"
              >
                {{ fieldErrorMessage(field) }}
              </span>
            </label>
            <div class="settings-v2-env-notice" role="note">
              <ShieldAlert :size="14" class="settings-v2-env-notice-icon" aria-hidden="true" />
              <span class="settings-v2-env-notice-text">
                {{ t('envVars.securityWarningShort', 'Environment variables may contain secrets') }}
              </span>
            </div>
          </div>
          <EnvVarsField :field="field" @update="(f, v) => emit('update-field', f, v)" />
        </template>

        <div v-else-if="field.editType === 'boolean'" class="settings-v2-boolean-row">
          <label class="settings-v2-field-label">
            <span class="settings-v2-field-label-text">{{ field.label }}</span>
            <InfoTooltip v-if="field.tooltip" :text="field.tooltip" />
            <span v-if="needsRestartTag(field)" class="settings-v2-restart-tag" role="status">
              {{ t('comfyUISettings.restartRequired', 'Restart to apply') }}
            </span>
          </label>
          <BooleanToggle :field="field" @update="(v) => emit('update-field', field, v)" />
        </div>

        <template v-else>
          <label v-if="!fieldOwnsLabel(field)" class="settings-v2-field-label">
            <span class="settings-v2-field-label-text">{{ field.label }}</span>
            <InfoTooltip v-if="field.tooltip" :text="field.tooltip" />
            <span v-if="needsRestartTag(field)" class="settings-v2-restart-tag" role="status">
              {{ t('comfyUISettings.restartRequired', 'Restart to apply') }}
            </span>
          </label>

          <PathField
            v-if="field.editType === 'path' && !readonly"
            :field="field"
            @update="(f, v) => emit('update-field', f, v)"
          />

          <div
            v-else-if="readonly && (field.editType === 'path' || isPathLikeValue(field.value))"
            class="settings-v2-readonly-path"
          >
            <span class="settings-v2-field-readonly settings-v2-field-readonly-path">{{
              readonlyDisplayValue(field)
            }}</span>
            <BaseCopyButton :value="readonlyDisplayValue(field)" />
          </div>

          <BaseSelect
            v-else-if="field.editType === 'select'"
            :model-value="asString(field.value)"
            :options="
              (field.options ?? []).map(
                (opt): BaseSelectOption => ({
                  value: opt.value,
                  label: opt.label,
                  description: opt.description
                })
              )
            "
            :aria-label="field.label"
            @update:model-value="(v: string) => emit('update-field', field, v)"
          />

          <ArgsBuilderField
            v-else-if="field.editType === 'args-builder'"
            :field="field"
            :installation-id="props.installationId"
            @open="emit('open-args-page', field)"
            @update="(f, v) => emit('update-field', f, v)"
          />

          <ChannelPicker
            v-else-if="field.editType === 'channel-cards'"
            :field="field"
            :section-actions="section.actions ?? []"
            :running-action-ids="runningIdsSet"
            @action="(a) => emit('run-action', a)"
          />

          <BaseInput
            v-else-if="field.editType === 'text'"
            :model-value="asString(field.value)"
            :aria-label="field.label"
            :placeholder="field.placeholder"
            @change="(v: string) => emit('update-field', field, v)"
          />

          <BaseInput
            v-else-if="field.editType === 'number'"
            :model-value="asString(field.value)"
            :aria-label="field.label"
            type="number"
            :min="field.min"
            :max="field.max"
            @change="(v: string) => emit('update-field', field, v === '' ? null : Number(v))"
          />

          <span v-else class="settings-v2-field-readonly">{{ asString(field.value) }}</span>
        </template>
      </div>

      <div
        v-if="section.actions && section.actions.length && !hasChannelPicker(section)"
        class="settings-v2-actions"
      >
        <TooltipWrap
          v-for="action in section.actions"
          :key="action.id"
          class="settings-v2-action-tooltip"
          :text="
            action.enabled === false && action.disabledMessage
              ? action.disabledMessage
              : action.tooltip
          "
        >
          <button
            type="button"
            :class="[
              'settings-v2-action',
              {
                primary: action.style === 'primary',
                danger: action.style === 'danger',
                'looks-disabled': action.enabled === false && action.disabledMessage,
                'is-running': isActionRunning(action.id)
              }
            ]"
            :disabled="
              (action.enabled === false && !action.disabledMessage) ||
              isActionRunning(action.id)
            "
            @click="emit('run-action', action)"
          >
            <Loader2
              v-if="isActionRunning(action.id)"
              :size="14"
              class="settings-v2-action-spinner"
            />
            {{ action.label }}
          </button>
        </TooltipWrap>
      </div>
    </article>
  </div>
</template>

<style scoped>
.settings-v2-sections {
  display: flex;
  flex-direction: column;
  gap: 32px;
}

.settings-v2-section {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.settings-v2-section-title {
  font-size: var(--takeover-fs-body);
  font-weight: 500;
  color: var(--text-muted);
}

.settings-v2-section-title.is-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  background: transparent;
  border: none;
  color: var(--text-muted);
  text-align: left;
  align-self: flex-start;
}

.settings-v2-section-title.is-toggle:hover {
  background: transparent;
  color: var(--text);
}

.settings-v2-section-title--micro {
  padding: 0 0 4px;
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted);
  opacity: 0.55;
}

.settings-v2-section-chevron {
  color: var(--text-muted);
  transition: transform 160ms cubic-bezier(0.32, 0.72, 0, 1);
}

.settings-v2-section-chevron.is-open {
  transform: rotate(90deg);
}

/* Collapse the body: hide every direct child of the section EXCEPT
 * the title button (which the user clicks to toggle). Description and
 * the items/fields/actions blocks share this rule so the entire
 * section body disappears in one go. */
.settings-v2-section.is-collapsed > *:not(.settings-v2-section-title) {
  display: none;
}

.settings-v2-section-desc {
  margin: -4px 0 4px;
  font-size: var(--takeover-fs-caption);
  color: var(--text-muted);
  line-height: 1.4;
}

.settings-v2-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: var(--takeover-fs-body);
  color: var(--text);
  line-height: 1.4;
}

.settings-v2-item-label {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.settings-v2-item-tag {
  padding: 2px 6px;
  font-size: var(--takeover-fs-caption);
  font-weight: 500;
  color: var(--text-muted);
  background: color-mix(in srgb, var(--text) 8%, transparent);
  border-radius: 999px;
}

.settings-v2-item-actions {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.settings-v2-field {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* Dependent (nested) fields are revealed by the toggle directly above
 * them — e.g. "Use shared output directory" only appears once
 * "Auto-download outputs" is on, and the output-path picker only once
 * that's off. Pull them up tight to their parent (cancelling most of the
 * section's 16px row gap) and indent behind a hairline rail so the chain
 * reads as one dependent group instead of equally-weighted rows. */
.settings-v2-field.is-nested {
  margin-top: -8px;
  padding-left: 14px;
  border-left: 1px solid color-mix(in srgb, var(--chooser-surface-border) 70%, transparent);
}

.settings-v2-field-label {
  display: inline-flex;
  align-items: center;
  width: fit-content;
  max-width: 100%;
  gap: 2px;
  font-size: 12px;
  font-weight: 400;
  color: var(--text-muted);
  line-height: 16px;
}

.settings-v2-field-label-text {
  flex: 0 1 auto;
  min-width: 0;
}

.settings-v2-restart-tag {
  flex: 0 0 auto;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 9999px;
  font-size: 10px;
  font-weight: 500;
  line-height: 14px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--warning) 36%, transparent);
  white-space: nowrap;
}

/* Failed-write inline pill. Same shape as the restart tag (so the
 * label row stays calm when one swaps in for the other) but in the
 * danger ramp so the user immediately reads "rejected" not "pending".
 * Clamped to a max-width with ellipsis — IPC errors can be long; the
 * full message lives in the `title` tooltip. */
.settings-v2-field-error-tag {
  flex: 0 0 auto;
  margin-left: 6px;
  max-width: 240px;
  padding: 1px 6px;
  border-radius: 9999px;
  font-size: 10px;
  font-weight: 500;
  line-height: 14px;
  letter-spacing: 0.02em;
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--danger) 36%, transparent);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.settings-v2-boolean-row .settings-v2-field-label {
  flex: 0 1 auto;
  max-width: calc(100% - 48px);
}

.settings-v2-field.is-env-vars,
.settings-v2-field.is-channel-picker {
  gap: 10px;
}

.settings-v2-env-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.settings-v2-env-header .settings-v2-field-label {
  flex: 1 1 auto;
  min-width: 0;
}

.settings-v2-env-notice {
  flex: 0 0 auto;
  width: fit-content;
  max-width: min(100%, 320px);
  display: inline-flex;
  align-items: flex-start;
  gap: 6px;
  padding: 6px 8px;
  margin: -6px 0 -6px auto;
  border: 1px solid var(--chooser-surface-border);
  border-radius: 8px;
  background: var(--chooser-surface-bg);
  font-size: 10.5px;
  line-height: 16px;
  color: var(--text-muted);
  text-align: left;
}

.settings-v2-env-notice-icon {
  flex-shrink: 0;
  margin-top: 1px;
  color: var(--neutral-100);
}

.settings-v2-env-notice-text {
  min-width: 0;
}

.settings-v2-boolean-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 44px;
  padding: 4px 0;
}
.settings-v2-readonly-path {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.settings-v2-field-readonly-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settings-v2-field-readonly {
  font-size: 13px;
  color: var(--neutral-100);
  line-height: 19px;
}

.settings-v2-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}

.settings-v2-action {
  border: none;
  width: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.settings-v2-action.is-running {
  cursor: progress;
  opacity: 0.85;
}

.settings-v2-action-spinner {
  flex: 0 0 auto;
  animation: settings-v2-action-spin 0.9s linear infinite;
}

@keyframes settings-v2-action-spin {
  to { transform: rotate(360deg); }
}

.settings-v2-action-tooltip {
  width: 100%;
}

.settings-v2-actions:has(> .settings-v2-action:only-child) .settings-v2-action {
  flex: 1;
}

/* Status-tab treatment: hairline dividers between rows + muted
 * label-over-value layout instead of input-style field chrome. */
.settings-v2-section.is-readonly-list {
  gap: 0;
  padding: 4px 12px;
  border-radius: 10px;
  background: var(--secondary-background);
  border: 1px solid var(--chooser-surface-border);
}

.settings-v2-section.is-readonly-list .settings-v2-section-title {
  padding: 8px 0 4px;
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  opacity: 0.55;
}

.settings-v2-section.is-readonly-list .settings-v2-field {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr);
  align-items: start;
  gap: 8px 16px;
  padding: 10px 0;
  border-bottom: 1px solid var(--chooser-surface-border);
}

.settings-v2-section.is-readonly-list .settings-v2-field:last-child {
  border-bottom: none;
}

.settings-v2-section.is-readonly-list .settings-v2-field-label {
  color: var(--text-muted);
  font-weight: 400;
}

.settings-v2-section.is-readonly-list .settings-v2-field-readonly,
.settings-v2-section.is-readonly-list .settings-v2-readonly-path {
  justify-self: end;
  text-align: right;
  width: 100%;
}

.settings-v2-section.is-readonly-list .settings-v2-readonly-path {
  justify-self: stretch;
}
</style>
