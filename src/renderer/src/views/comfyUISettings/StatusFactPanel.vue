<script setup lang="ts">
import { computed, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Pencil } from 'lucide-vue-next'
import BaseCopyButton from '../../components/ui/BaseCopyButton.vue'
import type { DetailField, DetailSection, Installation } from '../../types/ipc'

/**
 * Status tab: grouped install summary with an inline-editable identity hero (committing calls `onRename`).
 */

interface Props {
  installation: Installation | null
  sections: DetailSection[]
  diskUsage: { label: string; value: string } | null
  /** Commit a rename, resolving `true` on success; a function prop (not an emit) so blur can await and revert only on failure. */
  onRename?: (newName: string) => Promise<boolean>
}

const props = defineProps<Props>()

const { t } = useI18n()

// The Comfy Cloud entry is not user-renamable (issue #922): render its name as
// static text with no contenteditable / pencil affordance.
const nameEditable = computed(() => props.installation?.sourceCategory !== 'cloud')

// Drive the hero name imperatively: mixing `{{ }}` with the inline pencil icon left Vue unable to patch the edited text node, so a committed rename painted everywhere except here.
const nameEl = useTemplateRef<HTMLElement>('nameEl')

// Write the name into the editable element if it differs, without stomping the caret mid-edit.
function syncName(): void {
  const el = nameEl.value
  if (!el) return
  const name = props.installation?.name ?? ''
  if (el.textContent !== name) el.textContent = name
}

// Watch the name AND the ref (which starts null) so the initial name paints once the contenteditable mounts.
watch(
  [() => props.installation?.name ?? '', nameEl],
  () => {
    if (document.activeElement !== nameEl.value) syncName()
  },
  { immediate: true, flush: 'post' },
)

function handleNameSelectAll(event: KeyboardEvent): void {
  event.preventDefault()
  const el = event.currentTarget as HTMLElement
  const range = document.createRange()
  range.selectNodeContents(el)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

function handleNamePaste(event: ClipboardEvent): void {
  event.preventDefault()
  const text = event.clipboardData?.getData('text/plain') ?? ''
  document.execCommand('insertText', false, text)
}

// Escape restores the original name and blurs; the blur handler then no-ops.
function handleNameEscape(): void {
  syncName()
  nameEl.value?.blur()
}

async function handleNameBlur(event: FocusEvent): Promise<void> {
  const el = event.target as HTMLElement
  const current = props.installation?.name ?? ''
  const newName = el.textContent?.trim() ?? ''
  if (newName && newName !== current) {
    // Keep the trimmed text optimistically so the hero doesn't flash back mid-round-trip; only a rejection reverts.
    if (el.textContent !== newName) el.textContent = newName
    const committed = await props.onRename?.(newName)
    if (committed === false) syncName()
    return
  }
  // Empty / whitespace-only / unchanged: restore the canonical name now.
  syncName()
}

interface FactRow {
  id: string
  label: string
  value: string
  copyable?: boolean
  /** `'start'` keeps the tail visible (used by paths); everything else end-truncates. */
  truncate?: 'start' | 'end'
}

interface FactGroup {
  id: string
  title: string
  rows: FactRow[]
}

const allFields = computed<DetailField[]>(() => {
  const out: DetailField[] = []
  for (const section of props.sections) {
    for (const field of section.fields ?? []) {
      out.push(field)
    }
  }
  return out
})

function fieldValue(field: DetailField): string {
  const v = field.value
  if (v == null || v === '') return '—'
  return String(v)
}

// Localised dates contain only digits and separators; without this guard the slash-based path heuristic sprouts a nonsensical copy button on dates.
function looksLikeDate(value: string): boolean {
  return /^[\d/.\-: ]+$/.test(value)
}

function isPathLike(value: string): boolean {
  if (!value || value === '—') return false
  if (looksLikeDate(value)) return false
  return value.includes('/') || value.includes('\\') || value.startsWith('~')
}

function matchLabel(field: DetailField, keys: string[]): boolean {
  const extra = field as DetailField & { key?: string }
  const id = (field.id ?? extra.key ?? '').toLowerCase()
  const label = field.label.toLowerCase()
  return keys.some((k) => id.includes(k) || label.includes(k.toLowerCase()))
}

const heroSubtitle = computed(() => {
  const parts: string[] = []
  for (const field of allFields.value) {
    if (matchLabel(field, ['comfyui', 'comfyui-version'])) {
      parts.push(fieldValue(field))
      break
    }
  }
  for (const field of allFields.value) {
    if (matchLabel(field, ['variant'])) {
      parts.push(fieldValue(field))
      break
    }
  }
  for (const field of allFields.value) {
    if (matchLabel(field, ['python'])) {
      parts.push(fieldValue(field))
      break
    }
  }
  return parts.filter((p) => p && p !== '—').join(' · ')
})

function toRow(field: DetailField): FactRow {
  const value = fieldValue(field)
  const extra = field as DetailField & { key?: string }
  return {
    id: field.id ?? extra.key ?? field.label,
    label: field.label,
    value,
    copyable: isPathLike(value),
  }
}

const installDetailRows = computed<FactRow[]>(() => {
  const used = new Set<string>()
  const rows: FactRow[] = []
  const sourceLabel = props.installation?.sourceLabel?.toLowerCase()
  for (const field of allFields.value) {
    if (matchLabel(field, ['lineage'])) continue
    if (matchLabel(field, ['location', 'path', 'disk'])) continue
    if (matchLabel(field, ['comfyui', 'comfyui-version'])) continue
    if (matchLabel(field, ['variant', 'python']) && heroSubtitle.value) continue
    if (matchLabel(field, ['install method', 'method'])) continue
    const row = toRow(field)
    if (sourceLabel && row.value.toLowerCase() === sourceLabel) continue
    if (row.value === '—' && !field.label) continue
    rows.push(row)
    used.add(row.id)
  }
  return rows
})

const locationRows = computed<FactRow[]>(() => {
  const rows: FactRow[] = []
  for (const field of allFields.value) {
    if (matchLabel(field, ['location', 'path', 'install path'])) {
      const row = toRow(field)
      if (isPathLike(row.value)) row.truncate = 'start'
      rows.push(row)
    }
  }
  if (props.diskUsage) {
    rows.push({
      id: '__disk-usage',
      label: props.diskUsage.label,
      value: props.diskUsage.value,
    })
  }
  return rows
})

const lineageRows = computed<FactRow[]>(() => {
  return allFields.value
    .filter((field) => matchLabel(field, ['lineage']))
    .map(toRow)
})

const groups = computed<FactGroup[]>(() => {
  const out: FactGroup[] = []
  const details = installDetailRows.value
  if (details.length > 0) {
    out.push({
      id: 'install-details',
      title: t('statusFactPanel.installDetails', 'Install details'),
      rows: details,
    })
  }
  const location = locationRows.value
  if (location.length > 0) {
    out.push({
      id: 'location-storage',
      title: t('statusFactPanel.locationStorage', 'Location & storage'),
      rows: location,
    })
  }
  const lineage = lineageRows.value
  if (lineage.length > 0) {
    out.push({
      id: 'lineage',
      title: t('statusFactPanel.lineage', 'Lineage'),
      rows: lineage,
    })
  }
  return out
})
</script>

<template>
  <div class="status-fact-panel">
    <header v-if="installation" class="status-fact-hero">
      <div class="status-fact-hero-title-row">
        <span class="status-fact-hero-name-wrap">
          <span
            v-if="nameEditable"
            ref="nameEl"
            class="status-fact-hero-name"
            role="textbox"
            :aria-label="t('statusFactPanel.editName', 'Edit installation name')"
            contenteditable="plaintext-only"
            spellcheck="false"
            @blur="handleNameBlur"
            @keydown.enter.prevent="($event.target as HTMLElement).blur()"
            @keydown.esc.prevent="handleNameEscape"
            @keydown.ctrl.a.prevent="handleNameSelectAll"
            @keydown.meta.a.prevent="handleNameSelectAll"
            @paste="handleNamePaste"
          />
          <span v-else class="status-fact-hero-name status-fact-hero-name-static">{{
            installation.name
          }}</span>
          <Pencil
            v-if="nameEditable"
            :size="13"
            class="status-fact-hero-edit-hint"
            aria-hidden="true"
          />
        </span>
        <span v-if="installation.sourceLabel" class="status-fact-hero-badge">
          {{ installation.sourceLabel }}
        </span>
      </div>
      <p v-if="heroSubtitle" class="status-fact-hero-meta">{{ heroSubtitle }}</p>
    </header>

    <section v-for="group in groups" :key="group.id" class="status-fact-group">
      <h3 class="status-fact-group-title">{{ group.title }}</h3>
      <dl class="status-fact-list">
        <div v-for="row in group.rows" :key="row.id" class="status-fact-row">
          <dt>{{ row.label }}</dt>
          <dd>
            <span
              class="status-fact-value"
              :class="{ 'is-truncate-start': row.truncate === 'start' }"
              :title="row.value"
            >
              <bdi v-if="row.truncate === 'start'" dir="ltr">{{ row.value }}</bdi>
              <template v-else>{{ row.value }}</template>
            </span>
            <BaseCopyButton v-if="row.copyable" :value="row.value" />
          </dd>
        </div>
      </dl>
    </section>
  </div>
</template>

<style scoped>
.status-fact-panel {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.status-fact-hero {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.status-fact-hero-title-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

/* Name + pencil as siblings (the pencil can't live inside the contenteditable — `textContent =` would wipe it). */
.status-fact-hero-name-wrap {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  margin-left: -6px;
}

.status-fact-hero-name {
  font-size: 18px;
  font-weight: 600;
  line-height: 24px;
  color: var(--text);
  min-width: 0;
  padding: 2px 6px;
  border-radius: 6px;
  outline: none;
  cursor: text;
  /* Long names ellipsize at rest and scroll horizontally while editing. `nowrap` (not `pre`) so whitespace runs collapse. */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: background-color 120ms ease;
}

/* Static (non-renamable) name, e.g. Comfy Cloud: no edit affordance. */
.status-fact-hero-name-static {
  cursor: default;
}

.status-fact-hero-name:not(.status-fact-hero-name-static):hover {
  background: var(--brand-surface-bg-hover);
}

.status-fact-hero-name:focus-visible {
  background: var(--brand-surface-bg-hover);
  box-shadow: 0 0 0 2px var(--focus-ring, var(--neutral-50));
}

/* Pencil hint fades up on hover/focus. */
.status-fact-hero-edit-hint {
  flex-shrink: 0;
  color: var(--text-muted);
  opacity: 0;
  transition: opacity 120ms ease;
  user-select: none;
  pointer-events: none;
}

.status-fact-hero-name-wrap:hover .status-fact-hero-edit-hint,
.status-fact-hero-name:focus-visible ~ .status-fact-hero-edit-hint {
  opacity: 0.6;
}

.status-fact-hero-badge {
  flex-shrink: 0;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 500;
  line-height: 16px;
  color: var(--text-muted);
  background: color-mix(in srgb, var(--text) 8%, transparent);
  border-radius: 999px;
}

.status-fact-hero-meta {
  margin: 4px 0 0;
  font-size: 14px;
  line-height: 20px;
  color: var(--neutral-100);
}

.status-fact-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.status-fact-group-title {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted);
  opacity: 0.7;
}

.status-fact-list {
  margin: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--chooser-surface-border);
  border-radius: 8px;
  padding: 4px 12px;
  background: var(--brand-surface-bg);
}

.status-fact-row {
  display: grid;
  grid-template-columns: minmax(0, auto) minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-top: 1px solid var(--border-hover);
}

.status-fact-row:first-child {
  border-top: none;
}

.status-fact-row dt {
  margin: 0;
  font-size: 12px;
  line-height: 16px;
  color: var(--text-muted);
}

.status-fact-row dd {
  margin: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  min-width: 0;
  font-size: 13px;
  line-height: 19px;
  color: var(--neutral-100);
  text-align: right;
}

.status-fact-value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Truncate paths from the start to keep the trailing folder readable. `direction: rtl` puts the ellipsis on the left; the inner <bdi dir="ltr"> keeps character order. */
.status-fact-value.is-truncate-start {
  direction: rtl;
  text-align: left;
}
</style>
