<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import BrandTakeoverLayout from '../components/BrandTakeoverLayout.vue'
import MigrateConfirmBody, {
  type MigrateDetailGroup,
  type MigrateCheckbox
} from '../components/MigrateConfirmBody.vue'
import type { SnapshotDetailData } from '../types/ipc'

interface OpenOpts {
  title: string
  confirmLabel: string
  preview: SnapshotDetailData
  details: MigrateDetailGroup[]
  checkboxes: MigrateCheckbox[]
}

const isOpen = ref(false)
const loading = ref(true)
const title = ref('')
const confirmLabel = ref('')
const preview = ref<SnapshotDetailData | null>(null)
const details = ref<MigrateDetailGroup[]>([])
const checkboxes = ref<MigrateCheckbox[]>([])
const dialogRef = ref<HTMLElement | null>(null)
/** Focus owner before open, restored on commit regardless of close path. */
let returnFocusTo: HTMLElement | null = null

let resolver: ((value: { confirmed: boolean; checkboxValues: Record<string, boolean> }) => void) | null = null

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && isOpen.value) commit(false)
}

// Bind/unbind ESC + focus per open() rather than onMounted, since the instance outlives the visible surface.
watch(isOpen, async (open) => {
  if (open) {
    document.addEventListener('keydown', onKeydown)
    returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
    await nextTick()
    // Focus the dialog container, not the cancel button — keeps focus trapped
    // for keyboard/AT without painting a focus-visible ring on open.
    dialogRef.value?.focus()
  } else {
    document.removeEventListener('keydown', onKeydown)
    returnFocusTo?.focus()
    returnFocusTo = null
  }
})

async function open(initialTitle: string, initialConfirmLabel: string): Promise<{
  confirmed: boolean
  checkboxValues: Record<string, boolean>
}> {
  title.value = initialTitle
  confirmLabel.value = initialConfirmLabel
  loading.value = true
  preview.value = null
  details.value = []
  checkboxes.value = []
  isOpen.value = true
  return new Promise((resolve) => {
    resolver = resolve
  })
}

function update(opts: Partial<OpenOpts> & { loading?: boolean }): void {
  if (opts.title !== undefined) title.value = opts.title
  if (opts.confirmLabel !== undefined) confirmLabel.value = opts.confirmLabel
  if (opts.preview !== undefined) preview.value = opts.preview
  if (opts.details !== undefined) details.value = opts.details.map((g) => ({ ...g, items: [...g.items] }))
  if (opts.checkboxes !== undefined) checkboxes.value = opts.checkboxes.map((c) => ({ ...c }))
  if (opts.loading !== undefined) loading.value = opts.loading
}

function onToggle(id: string, checked: boolean): void {
  const cb = checkboxes.value.find((c) => c.id === id)
  if (cb) cb.checked = checked
}

function commit(confirmed: boolean): void {
  const checkboxValues = Object.fromEntries(checkboxes.value.map((c) => [c.id, c.checked]))
  isOpen.value = false
  resolver?.({ confirmed, checkboxValues })
  resolver = null
}

defineExpose({ open, update, commit })
</script>

<template>
  <BrandTakeoverLayout v-if="isOpen">
    <div
      ref="dialogRef"
      class="brand-hero migrate-takeover"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
      tabindex="-1"
    >
      <h1 class="brand-title">{{ title }}</h1>
      <div class="migrate-takeover__card">
        <div v-if="loading" class="migrate-takeover__loading">
          {{ $t('common.loading') }}
        </div>
        <MigrateConfirmBody
          v-else
          :preview="preview"
          :details="details"
          :checkboxes="checkboxes"
          @toggle-checkbox="onToggle"
        />
      </div>
      <div class="migrate-takeover__actions">
        <button
          type="button"
          class="brand-ghost"
          data-testid="migrate-takeover-cancel"
          @click="commit(false)"
        >
          {{ $t('common.cancel') }}
        </button>
        <button
          type="button"
          class="brand-primary"
          data-testid="migrate-takeover-confirm"
          :disabled="loading"
          @click="commit(true)"
        >
          {{ confirmLabel }}
        </button>
      </div>
    </div>
  </BrandTakeoverLayout>
</template>

<style scoped>
.migrate-takeover {
  max-width: 640px;
  gap: var(--takeover-gap-md);
}
.migrate-takeover__card {
  width: 100%;
  padding: 20px;
  border: 1px solid var(--brand-surface-border);
  border-radius: 12px;
  background: var(--brand-surface-bg);
}
.migrate-takeover__loading {
  font-size: var(--takeover-fs-body);
  color: var(--neutral-300);
  padding: 24px 0;
  text-align: center;
}
.migrate-takeover__actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 12px;
  width: 100%;
}
</style>
