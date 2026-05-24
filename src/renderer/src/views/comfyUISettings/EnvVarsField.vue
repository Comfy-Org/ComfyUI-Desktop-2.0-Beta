<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, ShieldAlert, X } from 'lucide-vue-next'
import BaseInput from '../../components/ui/BaseInput.vue'
import type { DetailField } from '../../types/ipc'

/**
 * Environment variables field for the brand-redesigned Settings drawer
 * (v2). Mirrors `EnvVarsEditor.vue`'s data model exactly — local KEY /
 * VALUE rows, duplicate-key highlight, single emit when any cell
 * changes — but in the drawer's design language.
 *
 * The parent (`ComfyUISettingsPanel`) listens for `update` and runs the
 * value through the composable's `updateField` → `update-installation`
 * IPC. Same path the legacy modal uses; main applies `sanitizeEnvVars`
 * server-side.
 */

interface Props {
  field: DetailField
}

const props = defineProps<Props>()

const emit = defineEmits<{
  update: [field: DetailField, value: Record<string, string>]
}>()

const { t } = useI18n()

interface Row {
  key: string
  value: string
}

const rows = ref<Row[]>([])

// Sync from prop to local state. Avoid resetting if the structural
// contents haven't changed — would interrupt mid-edit typing on a key.
watch(
  () => props.field.value,
  (val) => {
    const dict =
      val && typeof val === 'object' && !Array.isArray(val) ? (val as Record<string, string>) : {}
    const incoming: Row[] = Object.entries(dict).map(([key, value]) => ({ key, value }))
    const currentNonEmpty = rows.value.filter((r) => r.key || r.value)
    if (JSON.stringify(incoming) !== JSON.stringify(currentNonEmpty)) {
      rows.value = incoming
    }
  },
  { immediate: true }
)

const duplicateKeys = computed(() => {
  const counts = new Map<string, number>()
  for (const r of rows.value) {
    const k = r.key.trim()
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const dupes = new Set<string>()
  for (const [k, n] of counts) {
    if (n > 1) dupes.add(k)
  }
  return dupes
})

function isDuplicate(i: number): boolean {
  const k = rows.value[i]?.key.trim()
  return !!k && duplicateKeys.value.has(k)
}

function emitUpdate(): void {
  const out: Record<string, string> = {}
  for (const r of rows.value) {
    const k = r.key.trim()
    if (k) out[k] = r.value
  }
  emit('update', props.field, out)
}

function addRow(): void {
  rows.value.push({ key: '', value: '' })
}

function removeRow(i: number): void {
  rows.value.splice(i, 1)
  emitUpdate()
}

function onKeyChange(i: number, val: string): void {
  if (rows.value[i]) {
    rows.value[i].key = val
    emitUpdate()
  }
}

function onValueChange(i: number, val: string): void {
  if (rows.value[i]) {
    rows.value[i].value = val
    emitUpdate()
  }
}
</script>

<template>
  <div class="env-vars-field">
    <div class="env-vars-notice">
      <ShieldAlert :size="14" class="env-vars-notice-icon" aria-hidden="true" />
      <span>{{ t('envVars.securityWarning') }}</span>
    </div>

    <div v-if="rows.length > 0" class="env-vars-rows">
      <div class="env-vars-head" aria-hidden="true">
        <span>{{ t('envVars.name') }}</span>
        <span>{{ t('envVars.value') }}</span>
        <span class="env-vars-head-action"></span>
      </div>

      <div v-for="(row, i) in rows" :key="i" class="env-var-row">
        <div class="env-var-cell">
          <BaseInput
            mono
            :model-value="row.key"
            :placeholder="t('envVars.namePlaceholder')"
            :aria-label="t('envVars.name')"
            :invalid="isDuplicate(i)"
            @change="onKeyChange(i, $event)"
          />
        </div>
        <div class="env-var-cell">
          <BaseInput
            mono
            :model-value="row.value"
            :placeholder="t('envVars.valuePlaceholder')"
            :aria-label="t('envVars.value')"
            @change="onValueChange(i, $event)"
          />
        </div>
        <button
          type="button"
          class="env-var-remove"
          :aria-label="t('envVars.remove', 'Remove variable')"
          @click="removeRow(i)"
        >
          <X :size="14" />
        </button>
      </div>
    </div>

    <button type="button" class="env-var-add" @click="addRow">
      <Plus :size="16" aria-hidden="true" />
      <span>{{ t('envVars.add') }}</span>
    </button>
  </div>
</template>

<style scoped>
.env-vars-field {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.env-vars-notice {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--chooser-surface-border);
  background: rgba(255, 255, 255, 0.04);
  font-size: 10.5px;
  line-height: 16px;
  color: var(--text-muted);
}

.env-vars-notice-icon {
  flex-shrink: 0;
  margin-top: 1px;
  color: var(--neutral-100);
}

.env-vars-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.env-vars-head,
.env-var-row {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 1.8fr) 32px;
  gap: 8px;
  align-items: center;
}

.env-vars-head {
  padding: 0 2px;
  font-size: 11px;
  font-weight: 500;
  line-height: 16px;
  color: var(--text-muted);
}

.env-vars-head-action {
  width: 32px;
}

.env-var-cell {
  min-width: 0;
}

.env-var-remove {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition:
    background-color 120ms ease,
    border-color 120ms ease,
    color 120ms ease;
}

.env-var-remove:hover,
.env-var-remove:focus-visible {
  color: var(--danger);
  border-color: var(--chooser-surface-border);
  background: var(--brand-surface-bg-hover);
  outline: none;
}

/* Matches expanded picker left-bar "+ New Instance" affordance. */
.env-var-add {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 32px;
  padding: 8px 14px;
  border: none;
  border-radius: 8px;
  background: var(--chooser-surface-border-hover);
  color: var(--neutral-100);
  font-size: 12px;
  font-weight: 500;
  line-height: 16px;
  cursor: pointer;
  transition:
    background-color 120ms ease,
    color 120ms ease;
}

.env-var-add:hover,
.env-var-add:focus-visible {
  background: var(--brand-surface-border-hover);
  color: var(--text);
  outline: none;
}
</style>
