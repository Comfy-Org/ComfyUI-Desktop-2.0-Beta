<script setup lang="ts">
import { computed, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Pencil } from 'lucide-vue-next'
import BaseCopyButton from '../../components/ui/BaseCopyButton.vue'
import type { DetailField, DetailSection, Installation } from '../../types/ipc'
import { useSessionStore } from '../../stores/sessionStore'

/**
 * Status tab: grouped install summary with an inline-editable identity hero (committing calls `onRename`).
 */

interface Props {
  installation: Installation | null
  sections: DetailSection[]
  diskUsage: { label: string; value: string } | null
  /** Commit a rename, resolving `true` on success; a function prop (not an emit) so blur can await and revert only on failure. */
  onRename?: (newName: string) => Promise<boolean>
  /** Commit a remote-URL change, resolving `true` on success. Same function-prop rationale as `onRename`: blur awaits and reverts only on failure. */
  onUpdateUrl?: (newUrl: string) => Promise<boolean>
  /** True when the remote URL was edited while running and a reconnect is pending. Owned by the composable so it clears on stop/restart like the footer button. */
  urlRestartPending?: boolean
}

const props = defineProps<Props>()

const { t } = useI18n()
const sessionStore = useSessionStore()

/** Popup bridge for opening a folder in the OS file manager (same one the
 *  Storage tab uses). */
const popupBridge = (
  window as unknown as { __comfyTitlePopup?: { globalSettingsOpenPath(path: string): void } }
).__comfyTitlePopup

function openPath(path: string): void {
  if (path && path !== '—') popupBridge?.globalSettingsOpenPath(path)
}

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

// Clicking the pencil should behave like clicking into the field: focus the editable name and place the caret at the end.
function focusName(): void {
  const el = nameEl.value
  if (!el) return
  el.focus()
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

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

// --- Remote connection URL: inline-editable, mirroring the name-edit pattern above. ---

// Only the Remote Connection source exposes an editable `remoteUrl`; Cloud's URL stays read-only.
const urlEditable = computed(() => props.installation?.sourceCategory === 'remote')

// Mirrors main's `parseUrl`: a scheme-less value is tried as `http://<value>` and must yield a hostname.
function isValidConnectionUrl(raw: string): boolean {
  const trimmed = raw.trim()
  if (!trimmed) return false
  try {
    const parsed = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`)
    return parsed.hostname.length > 0
  } catch {
    return false
  }
}

// The live session is pinned to the launch-time URL, so an edit while running
// only takes effect on restart. Visibility is owned by the composable's
// restart-dirty state (via `urlRestartPending`), which clears on stop/restart —
// gated here on `isRunning` so the tag hides the instant the instance stops.
const showUrlRestart = computed(() => {
  const id = props.installation?.id
  return !!props.urlRestartPending && !!id && sessionStore.isRunning(id)
})

// Same imperative-sync rationale as the name hero (pencil sibling can't live inside the contenteditable).
// A `ref` on an element inside `v-for` resolves to an array; the URL row renders at most once, so unwrap to the single node.
const urlElRaw = useTemplateRef<HTMLElement | HTMLElement[]>('urlEl')
const urlEl = computed<HTMLElement | null>(() =>
  Array.isArray(urlElRaw.value) ? (urlElRaw.value[0] ?? null) : (urlElRaw.value ?? null),
)
// Source the canonical URL from the `remoteUrl` detail field (always present in
// the sections) rather than `installation.remoteUrl`, which the picker snapshot
// may omit. Falls back to the installation field if the section value is a placeholder.
function currentUrl(): string {
  for (const section of props.sections) {
    for (const field of section.fields ?? []) {
      if (field.id === 'remoteUrl') {
        const v = typeof field.value === 'string' ? field.value : ''
        if (v && v !== '—') return v
      }
    }
  }
  const fallback = props.installation?.remoteUrl
  return typeof fallback === 'string' ? fallback : ''
}
function syncUrl(): void {
  const el = urlEl.value
  if (!el) return
  const url = currentUrl()
  if (el.textContent !== url) el.textContent = url
}
// Repaint the canonical URL when it changes externally (e.g. main re-normalised
// it), without stomping the caret mid-edit.
watch(
  [() => currentUrl(), urlEl],
  () => {
    if (document.activeElement !== urlEl.value) syncUrl()
  },
  { immediate: true, flush: 'post' },
)

function handleUrlEscape(): void {
  syncUrl()
  urlEl.value?.blur()
}

// Pencil click: focus the URL field and drop the caret at the end so the user can edit immediately.
function focusUrlField(): void {
  const el = urlEl.value
  if (!el) return
  el.focus()
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

// The editable URL row is the remote source's `remoteUrl` fact (matched on the field id carried into the row).
function isUrlRow(row: { id: string }): boolean {
  return urlEditable.value && row.id === 'remoteUrl'
}

async function handleUrlBlur(event: FocusEvent): Promise<void> {
  const el = event.target as HTMLElement
  const current = currentUrl()
  const next = el.textContent?.trim() ?? ''
  if (!next || next === current || !isValidConnectionUrl(next)) {
    // Empty / unchanged / invalid: restore the canonical value, no commit.
    syncUrl()
    return
  }
  // On rejection, revert; on success the composable sets the restart-pending
  // state (when running) and main normalises the URL — the watcher repaints it.
  const committed = await props.onUpdateUrl?.(next)
  if (committed === false) syncUrl()
}

interface FactRow {
  id: string
  label: string
  value: string
  copyable?: boolean
  /** Clickable path that opens the folder in the OS file manager. */
  openable?: boolean
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
    if (matchLabel(field, ['active-port'])) continue
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
      if (isPathLike(row.value)) {
        row.truncate = 'start'
        row.openable = true
      }
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

// The running port arrives as an `active-port` field from main (it's the only
// source that knows the real port in every window). Visibility is gated on the
// reactive session store so the section hides the instant the instance stops,
// without waiting for a section refetch.
const runningDetailRows = computed<FactRow[]>(() => {
  const id = props.installation?.id
  if (!id || !sessionStore.isRunning(id)) return []
  return allFields.value
    .filter((field) => matchLabel(field, ['active-port']))
    .map(toRow)
})

const groups = computed<FactGroup[]>(() => {
  const out: FactGroup[] = []
  const details = installDetailRows.value
  if (details.length > 0) {
    out.push({
      id: 'install-details',
      title: t('statusFactPanel.installDetails', 'Instance details'),
      rows: details,
    })
  }
  const running = runningDetailRows.value
  if (running.length > 0) {
    out.push({
      id: 'running-details',
      title: t('statusFactPanel.runningDetails', 'Running details'),
      rows: running,
    })
  }
  // Location & storage only makes sense for a local on-disk install. Cloud and
  // remote connections have no local footprint, so suppress the whole group
  // (covers the "no disk storage data available" case too — `diskUsage` is null
  // for them and the path rows describe a remote host, not local storage).
  const isLocalInstall = props.installation?.sourceCategory === 'local'
  const location = locationRows.value
  if (isLocalInstall && location.length > 0) {
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
            id="status-fact-hero-name"
            ref="nameEl"
            class="status-fact-hero-name"
            role="textbox"
            :aria-label="t('statusFactPanel.editName', 'Edit instance name')"
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
          <button
            v-if="nameEditable"
            type="button"
            class="status-fact-hero-edit-btn"
            :aria-label="t('statusFactPanel.editName', 'Edit instance name')"
            aria-controls="status-fact-hero-name"
            @click="focusName"
          >
            <Pencil :size="13" class="status-fact-hero-edit-hint" aria-hidden="true" />
          </button>
        </span>
        <span v-if="installation.sourceLabel" class="status-fact-hero-badge">
          {{ installation.sourceLabel }}
        </span>
      </div>
    </header>

    <section v-for="group in groups" :key="group.id" class="status-fact-group">
      <h3 class="status-fact-group-title">{{ group.title }}</h3>
      <dl class="status-fact-list">
        <div v-for="row in group.rows" :key="row.id" class="status-fact-row">
          <dt>{{ row.label }}</dt>
          <dd v-if="isUrlRow(row)" class="status-fact-url-dd">
            <span class="status-fact-url-edit">
              <span
                ref="urlEl"
                class="status-fact-value status-fact-url-editable"
                role="textbox"
                :aria-label="t('statusFactPanel.editUrl', 'Edit connection URL')"
                contenteditable="plaintext-only"
                spellcheck="false"
                :title="row.value"
                @blur="handleUrlBlur"
                @keydown.enter.prevent="($event.target as HTMLElement).blur()"
                @keydown.esc.prevent="handleUrlEscape"
              />
              <button
                type="button"
                class="status-fact-url-edit-btn"
                :aria-label="t('statusFactPanel.editUrl', 'Edit connection URL')"
                :title="t('statusFactPanel.editUrl', 'Edit connection URL')"
                @click="focusUrlField"
              >
                <Pencil :size="12" aria-hidden="true" />
              </button>
            </span>
            <span v-if="showUrlRestart" class="status-fact-restart-tag" role="status">
              {{ t('statusFactPanel.restartToApply', 'Restart to apply') }}
            </span>
          </dd>
          <dd v-else>
            <button
              v-if="row.openable"
              type="button"
              class="status-fact-value status-fact-value-open"
              :class="{ 'is-truncate-start': row.truncate === 'start' }"
              :title="t('models.openDir', 'Open folder')"
              @click="openPath(row.value)"
            >
              <bdi v-if="row.truncate === 'start'" dir="ltr">{{ row.value }}</bdi>
              <template v-else>{{ row.value }}</template>
            </button>
            <span
              v-else
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

.status-fact-hero-edit-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 0;
  margin-left: -6px;
  padding: 0;
  overflow: hidden;
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition:
    width 120ms ease,
    margin-left 120ms ease;
}

.status-fact-hero-edit-btn:focus-visible {
  outline: 2px solid var(--focus-ring, var(--neutral-50));
  outline-offset: 1px;
}


.status-fact-hero-name-wrap:hover .status-fact-hero-edit-btn,
.status-fact-hero-edit-btn:focus-visible,
.status-fact-hero-name:focus-visible ~ .status-fact-hero-edit-btn {
  width: 17px;
  margin-left: 0;
}


.status-fact-hero-edit-hint {
  flex-shrink: 0;
  color: var(--text-muted);
  opacity: 0;
  transition: opacity 120ms ease;
  user-select: none;
}

.status-fact-hero-name-wrap:hover .status-fact-hero-edit-hint,
.status-fact-hero-edit-btn:focus-visible .status-fact-hero-edit-hint,
.status-fact-hero-name:focus-visible ~ .status-fact-hero-edit-btn .status-fact-hero-edit-hint {
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

/* Clickable path that opens the folder in the OS file manager. */
.status-fact-value-open {
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.status-fact-value-open:hover,
.status-fact-value-open:focus-visible {
  color: var(--accent);
  text-decoration: underline;
  outline: none;
}

/* Editable URL row: stack the field over the reconnect hint, keeping the right alignment of the fact list. */
.status-fact-url-dd {
  flex-wrap: wrap;
  justify-content: flex-end;
  row-gap: 4px;
}

/* Name + pencil as siblings (the pencil can't live inside the contenteditable — `textContent =` would wipe it). */
.status-fact-url-edit {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
}

.status-fact-url-editable {
  padding: 2px 6px;
  margin-right: -6px;
  border-radius: 6px;
  outline: none;
  cursor: text;
  text-align: right;
  transition: background-color 120ms ease;
}

.status-fact-url-editable:hover {
  background: var(--brand-surface-bg-hover);
}

.status-fact-url-editable:focus-visible {
  background: var(--brand-surface-bg-hover);
  box-shadow: 0 0 0 2px var(--focus-ring, var(--neutral-50));
  /* Let the full URL show while editing rather than ellipsizing. */
  overflow: visible;
  text-overflow: clip;
}

.status-fact-url-edit-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  /* Always visible so the edit affordance is discoverable without hover. */
  opacity: 0.6;
  transition:
    opacity 120ms ease,
    background-color 120ms ease,
    color 120ms ease;
}

.status-fact-url-edit-btn:hover,
.status-fact-url-edit-btn:focus-visible {
  opacity: 1;
  background: var(--brand-surface-bg-hover);
  color: var(--text);
  outline: none;
}

/* Reconnect hint: restart-tag shape in the warning ramp (mirrors SettingsSectionList's `.settings-v2-restart-tag`). */
.status-fact-restart-tag {
  flex: 0 0 auto;
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
</style>
