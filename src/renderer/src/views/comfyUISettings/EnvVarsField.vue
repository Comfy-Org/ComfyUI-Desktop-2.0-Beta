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
    <div v-if="rows.length > 0" class="env-vars-list">
      <div class="env-vars-notice">
        <ShieldAlert :size="13" />
        <span>{{ t('envVars.securityWarning') }}</span>
      </div>
      <div v-for="(row, i) in rows" :key="i" class="env-var-row">
        <div class="env-var-cell env-var-key">
          <BaseInput
            mono
            :model-value="row.key"
            :placeholder="t('envVars.namePlaceholder', 'NAME')"
            :aria-label="t('envVars.namePlaceholder', 'NAME')"
            :invalid="isDuplicate(i)"
            @change="onKeyChange(i, $event)"
          />
        </div>
        <div class="env-var-cell env-var-value">
          <BaseInput
            mono
            :model-value="row.value"
            :placeholder="t('envVars.valuePlaceholder', 'value')"
            :aria-label="t('envVars.valuePlaceholder', 'value')"
            @change="onValueChange(i, $event)"
          />
        </div>
        <button
          type="button"
          class="env-var-remove"
          :aria-label="t('common.cancel', 'Remove')"
          @click="removeRow(i)"
        >
          <X :size="13" />
        </button>
      </div>
    </div>
    <button type="button" class="env-var-add" @click="addRow">
      <Plus :size="13" />
      <span>{{ t('envVars.add', 'Add Variable') }}</span>
    </button>
  </div>
</template>

<style scoped>
.env-vars-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.env-vars-notice {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--takeover-fs-caption);
  color: var(--info);
}

.env-vars-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.env-var-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* Cell wrappers around BaseInput — only own the flex sizing.
 * Input chrome (bg, border, focus, invalid) is delegated to the
 * shared primitive in components/ui/. */
.env-var-cell {
  min-width: 0;
}

.env-var-key {
  flex: 2;
}

.env-var-value {
  flex: 3;
}

/* Remove (X) button — square override on top of the global button
 * chrome. The hover color flips to danger only on this button. */
.env-var-remove {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
}

.env-var-remove:hover {
  color: var(--danger);
  border-color: var(--danger);
  background: var(--surface);
}

.env-var-add {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 8px 16px 8px 8px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  color: var(--neutral-100);
  font-weight: 500;
  font-size: 14px;
}

.env-var-add:hover {
  color: var(--text);
  background: rgba(255, 255, 255, 0.15);
}

.env-var-add:focus-visible {
  outline: 2px solid var(--accent-primary);
  outline-offset: 2px;
}
</style>
