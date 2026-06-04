<script setup lang="ts">
import { Check } from 'lucide-vue-next'
import type { SnapshotDetailData } from '../types/ipc'

export interface MigrateDetailGroup {
  label: string
  items: string[]
}

export interface MigrateCheckbox {
  id: string
  label: string
  checked: boolean
}

defineProps<{
  preview: SnapshotDetailData | null
  details: MigrateDetailGroup[]
  checkboxes: MigrateCheckbox[]
}>()

const emit = defineEmits<{
  'toggle-checkbox': [id: string, checked: boolean]
}>()

function onCheckboxToggle(id: string, event: Event): void {
  const target = event.target as HTMLInputElement
  emit('toggle-checkbox', id, target.checked)
}
</script>

<template>
  <div class="mig-body">
    <div v-if="preview" class="mig-summary">
      <div class="mig-summary__row">
        <span class="mig-summary__label">{{ $t('snapshots.comfyuiVersion') }}</span>
        <span class="mig-summary__value">{{ preview.comfyuiVersion }}</span>
      </div>
      <div class="mig-summary__row">
        <span class="mig-summary__label">{{ $t('snapshots.customNodes') }}</span>
        <span class="mig-summary__value">{{ preview.customNodes.length }}</span>
      </div>
      <div class="mig-summary__row">
        <span class="mig-summary__label">{{ $t('snapshots.pipPackages') }}</span>
        <span class="mig-summary__value">{{ preview.pipPackageCount }}</span>
      </div>
    </div>

    <div v-if="details.length" class="mig-actions-list">
      <div v-for="(group, gi) in details" :key="gi" class="mig-actions-group">
        <span class="mig-actions-label">{{ group.label }}</span>
        <ul class="mig-actions-items">
          <li v-for="(item, ii) in group.items" :key="ii" class="mig-actions-item">
            <Check :size="14" :stroke-width="2" class="mig-actions-check" aria-hidden="true" />
            <span>{{ item }}</span>
          </li>
        </ul>
      </div>
    </div>

    <div v-if="checkboxes.length" class="mig-options">
      <label v-for="cb in checkboxes" :key="cb.id" class="mig-option">
        <input
          type="checkbox"
          :checked="cb.checked"
          @change="onCheckboxToggle(cb.id, $event)"
        />
        <span>{{ cb.label }}</span>
      </label>
    </div>
  </div>
</template>

<style scoped>
.mig-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.mig-summary {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 14px 16px;
  border: 1px solid var(--brand-surface-border);
  border-radius: 8px;
  background: var(--brand-surface-bg);
}
.mig-summary__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 6px 0;
  font-size: var(--takeover-fs-body);
}
.mig-summary__row + .mig-summary__row {
  border-top: 1px solid color-mix(in oklab, var(--neutral-100) 6%, transparent);
}
.mig-summary__label {
  color: var(--neutral-300);
}
.mig-summary__value {
  color: var(--neutral-100);
  font-weight: 500;
}

.mig-actions-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mig-actions-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mig-actions-label {
  font-size: var(--takeover-fs-caption);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--neutral-300);
}
.mig-actions-items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: var(--neutral-100);
}
.mig-actions-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: var(--takeover-fs-body);
  color: var(--neutral-200);
  line-height: 1.5;
}
.mig-actions-check {
  flex: 0 0 auto;
  margin-top: 4px;
  color: var(--neutral-100);
}

.mig-options {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mig-option {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: var(--takeover-fs-body);
  color: var(--neutral-200);
  cursor: pointer;
}
</style>
