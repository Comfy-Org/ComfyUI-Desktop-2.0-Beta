<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight } from 'lucide-vue-next'
import BaseInput from '../../components/ui/BaseInput.vue'
import BaseSelect, { type BaseSelectOption } from '../../components/ui/BaseSelect.vue'
import BooleanToggle from './BooleanToggle.vue'
import PathField from './PathField.vue'
import EnvVarsField from './EnvVarsField.vue'
import ChannelPicker from './ChannelPicker.vue'
import ArgsBuilderField from './ArgsBuilderField.vue'
import InfoTooltip from '../../components/InfoTooltip.vue'
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
}

const props = withDefaults(defineProps<Props>(), {
  readonly: false,
})

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
  { immediate: true },
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
</script>

<template>
  <article
    v-for="(section, si) in visibleSections"
    :key="`s-${si}`"
    class="settings-v2-section"
    :class="{
      'is-readonly-list': readonly,
      'is-collapsible': isCollapsible(section),
      'is-collapsed': isCollapsible(section) && isCollapsed(section),
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
      v-if="section.description && !isCollapsed(section)"
      class="settings-v2-section-desc"
    >
      {{ section.description }}
    </p>

    <div v-for="(item, i) in section.items" :key="`i-${i}`" class="settings-v2-item">
      <span class="settings-v2-item-label">
        {{ item.label }}{{ item.active ? ` (${t('common.active', 'active')})` : '' }}
        <span v-if="item.tag" class="settings-v2-item-tag">{{ item.tag }}</span>
      </span>
      <span
        v-if="item.actions && item.actions.length"
        class="settings-v2-item-actions"
      >
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
              { 'looks-disabled': a.enabled === false && a.disabledMessage },
            ]"
            :disabled="a.enabled === false && !a.disabledMessage"
            @click="emit('run-action', a)"
          >
            {{ a.label }}
          </button>
        </TooltipWrap>
      </span>
    </div>

    <div v-for="field in section.fields" :key="field.id" class="settings-v2-field">
      <label class="settings-v2-field-label">
        {{ field.label }}
        <InfoTooltip v-if="field.tooltip" :text="field.tooltip" />
      </label>

      <BooleanToggle
        v-if="field.editType === 'boolean'"
        :field="field"
        @update="(v) => emit('update-field', field, v)"
      />

      <BaseSelect
        v-else-if="field.editType === 'select'"
        :model-value="asString(field.value)"
        :options="
          (field.options ?? []).map(
            (opt): BaseSelectOption => ({
              value: opt.value,
              label: opt.label,
              description: opt.description,
            }),
          )
        "
        :aria-label="field.label"
        @update:model-value="(v: string) => emit('update-field', field, v)"
      />

      <PathField
        v-else-if="field.editType === 'path'"
        :field="field"
        @update="(f, v) => emit('update-field', f, v)"
      />

      <ArgsBuilderField
        v-else-if="field.editType === 'args-builder'"
        :field="field"
        @open="emit('open-args-page', field)"
        @update="(f, v) => emit('update-field', f, v)"
      />

      <EnvVarsField
        v-else-if="field.editType === 'env-vars'"
        :field="field"
        @update="(f, v) => emit('update-field', f, v)"
      />

      <ChannelPicker
        v-else-if="field.editType === 'channel-cards'"
        :field="field"
        @action="(a) => emit('run-action', a)"
      />

      <BaseInput
        v-else-if="field.editType === 'text'"
        :model-value="asString(field.value)"
        :aria-label="field.label"
        @change="(v: string) => emit('update-field', field, v)"
      />

      <span v-else class="settings-v2-field-readonly">{{ asString(field.value) }}</span>
    </div>

    <div v-if="section.actions && section.actions.length" class="settings-v2-actions">
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
            },
          ]"
          :disabled="action.enabled === false && !action.disabledMessage"
          @click="emit('run-action', action)"
        >
          {{ action.label }}
        </button>
      </TooltipWrap>
    </div>
  </article>
</template>

<style scoped>
/* Section + field styling lives WITH the component (not in the
 * consuming surface) so both the drawer and the instance-picker get
 * identical visuals without either having to re-declare these rules
 * — Vue scoped styles only reach their own DOM, and these classes
 * live in this template. */
.settings-v2-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
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
  gap: 6px;
}

.settings-v2-field-label {
  display: inline-flex;
  justify-content: space-between;
  align-items: center;
  font-size: 14px;
  color: var(--neutral-100);
  line-height: 19.5px;
}

.settings-v2-field-readonly {
  font-size: 14px;
  color: var(--neutral-100);
  line-height: 21px;
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
}

.settings-v2-section.is-readonly-list .settings-v2-field {
  padding: 10px 0;
  border-bottom: 1px solid var(--border-hover);
  gap: 2px;
}

.settings-v2-section.is-readonly-list .settings-v2-field-label {
  color: var(--text-muted);
  font-weight: 400;
}
</style>
