<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Eye, EyeOff, Plus, X } from 'lucide-vue-next'
import BaseInput from '../../components/ui/BaseInput.vue'
import type { DetailField } from '../../types/ipc'

const SENSITIVE_KEY = /TOKEN|KEY|SECRET|PASSWORD|PASS(?!_)|AUTH|CREDENTIAL|API/i

function looksSensitive(key: string): boolean {
  return SENSITIVE_KEY.test(key)
}

/**
 * Environment variables key/value editor. The field header and security
 * callout live in SettingsSectionList — this component is body only.
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
const revealed = ref<Set<number>>(new Set())
const rowRefs = ref<(HTMLElement | null)[]>([])

function setRowRef(i: number, el: Element | null): void {
  rowRefs.value[i] = el as HTMLElement | null
}

function isRevealed(i: number): boolean {
  return revealed.value.has(i)
}

function toggleReveal(i: number): void {
  const next = new Set(revealed.value)
  if (next.has(i)) next.delete(i)
  else next.add(i)
  revealed.value = next
}

function isMasked(i: number): boolean {
  const row = rows.value[i]
  if (!row) return false
  if (isRevealed(i)) return false
  return looksSensitive(row.key)
}

watch(
  () => props.field.value,
  (val) => {
    const dict =
      val && typeof val === 'object' && !Array.isArray(val) ? (val as Record<string, string>) : {}
    const serverRows: Row[] = Object.entries(dict).map(([key, value]) => ({ key, value }))
    // Preserve any in-progress rows whose key is still empty — the
    // server can't have seen them yet (emitUpdate filters out keyless
    // rows), so an incoming snapshot that "doesn't mention them" must
    // not evict them. Previously, typing a value before a key would
    // round-trip an empty dict and the watch would wipe the row.
    const localPartial = rows.value.filter((r) => !r.key.trim())
    rows.value = [...serverRows, ...localPartial]
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

async function addRow(): Promise<void> {
  rows.value.push({ key: '', value: '' })
  await nextTick()
  const last = rowRefs.value[rowRefs.value.length - 1]
  last?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  last?.querySelector<HTMLInputElement>('input')?.focus()
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
    <div v-if="rows.length > 0" class="env-vars-rows">
      <div class="env-vars-head" aria-hidden="true">
        <span>{{ t('envVars.name') }}</span>
        <span>{{ t('envVars.value') }}</span>
        <span class="env-vars-head-action"></span>
      </div>

      <div
        v-for="(row, i) in rows"
        :key="i"
        :ref="(el) => setRowRef(i, el as Element | null)"
        class="env-var-row"
      >
        <div class="env-var-cell">
          <BaseInput
            mono
            :model-value="row.key"
            :placeholder="t('envVars.namePlaceholder')"
            :aria-label="t('envVars.name')"
            :invalid="isDuplicate(i)"
            :aria-invalid="isDuplicate(i)"
            @change="onKeyChange(i, $event)"
          />
          <p v-if="isDuplicate(i)" class="env-var-error" role="alert">
            {{ t('envVars.duplicateKey', 'Duplicate key') }}
          </p>
        </div>
        <div class="env-var-cell env-var-value-cell">
          <BaseInput
            mono
            :type="isMasked(i) ? 'password' : 'text'"
            :model-value="row.value"
            :placeholder="t('envVars.valuePlaceholder')"
            :aria-label="t('envVars.value')"
            @change="onValueChange(i, $event)"
          />
          <button
            v-if="looksSensitive(row.key)"
            type="button"
            class="env-var-reveal"
            :aria-label="
              isRevealed(i)
                ? t('envVars.hideValue', 'Hide value')
                : t('envVars.revealValue', 'Reveal value')
            "
            :aria-pressed="isRevealed(i)"
            @click="toggleReveal(i)"
          >
            <EyeOff v-if="isRevealed(i)" :size="14" />
            <Eye v-else :size="14" />
          </button>
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

.env-var-value-cell {
  position: relative;
}

.env-var-value-cell:has(.env-var-reveal) :deep(.ui-input-control) {
  padding-right: 36px;
  padding-top: 5px;
}

.env-var-reveal {
  position: absolute;
  top: 50%;
  right: 4px;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--neutral-100);
  cursor: pointer;
  transition:
    color 120ms ease,
    background-color 120ms ease;
}

.env-var-reveal:hover,
.env-var-reveal:focus-visible {
  color: var(--text);
  background: var(--border-hover);
  outline: none;
}

.env-var-error {
  margin: 4px 0 0;
  font-size: 11px;
  line-height: 16px;
  color: var(--danger);
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
