<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useDebounceFn } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import { AlertCircle, ArrowLeft, Loader2, Search, SearchX, X } from 'lucide-vue-next'
import BaseInput from '../../components/ui/BaseInput.vue'
import BaseSelect, { type BaseSelectOption } from '../../components/ui/BaseSelect.vue'
import ArgsRawInput from './ArgsRawInput.vue'
import type { ComfyArgDef } from '../../types/ipc'
import { parseArgs, serialize } from '../../lib/argsParser'
import { emitTelemetryAction } from '../../lib/telemetry'
import { scoreName } from '../../utils/fuzzyMatch'

/**
 * Sub-page editor for `launchArgs`. Schema fetched from `get-comfy-args` on mount; each flag renders as a toggle (+ text input for value/optional types).
 * `exclusiveGroup` flags collapse into a radio cluster (enabling one disables siblings); unknown flags round-trip via `parseArgs().extra`.
 * Owns a local `value` mirror for snappy edits and commits to the parent via `update` on every mutation.
 */

interface Props {
  installationId: string
  initialValue: string
  /** True when args were edited while the instance is running, so they won't
   *  apply until a restart; mirrors the tag other settings fields show. */
  pendingRestart?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  pendingRestart: false
})

const emit = defineEmits<{
  back: []
  update: [value: string]
}>()

const { t } = useI18n()

const localValue = ref(props.initialValue)
const schema = ref<ComfyArgDef[]>([])
const loading = ref(false)
const loadError = ref<string | null>(null)
const search = ref('')

watch(
  () => props.initialValue,
  (next) => {
    // Resync the mirror when the parent commits a value we didn't originate.
    if (next !== localValue.value) localValue.value = next
  }
)

async function fetchSchema(): Promise<void> {
  loading.value = true
  loadError.value = null
  try {
    const result = await window.api.getComfyArgs(props.installationId)
    if (result?.args?.length) {
      schema.value = result.args
    } else if (result?.error) {
      loadError.value = result.error
    } else {
      loadError.value = t(
        'comfyUISettings.argsSchemaUnavailable',
        'Argument schema unavailable for this install.'
      )
    }
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

// Debounced 500ms so text-input args don't emit one event per keystroke.
const emitArgsChanged = useDebounceFn((argKey: string, valueKind: ComfyArgDef['type']) => {
  emitTelemetryAction('comfy.desktop.args.changed', {
    installation_id: props.installationId,
    arg_key: argKey,
    value_kind: valueKind
  })
}, 500)

onMounted(() => {
  emitTelemetryAction('comfy.desktop.args.builder.opened', {
    installation_id: props.installationId
  })
  void fetchSchema()
})

// Flush the final value if the page closes mid-debounced edit.
onBeforeUnmount(() => {
  if (localValue.value !== props.initialValue) emit('update', localValue.value)
})

const parsed = computed(() => parseArgs(localValue.value, schema.value))

function isActive(name: string): boolean {
  return parsed.value.known.has(name)
}

function getValue(name: string): string {
  return parsed.value.known.get(name) ?? ''
}

function commit(known: Map<string, string>): void {
  const next = serialize(known, parsed.value.extra, schema.value)
  localValue.value = next
  emit('update', next)
}

// Toggle a flag on/off; turning one on clears its exclusive-group siblings.
function toggleFlag(def: ComfyArgDef): void {
  const next = new Map(parsed.value.known)
  if (next.has(def.name)) {
    next.delete(def.name)
  } else {
    if (def.exclusiveGroup) {
      for (const a of schema.value) {
        if (a.exclusiveGroup === def.exclusiveGroup && a.name !== def.name) {
          next.delete(a.name)
        }
      }
    }
    next.set(def.name, '')
  }
  commit(next)
  emitArgsChanged(def.name, def.type)
}

function setValue(def: ComfyArgDef, value: string): void {
  const next = new Map(parsed.value.known)
  next.set(def.name, value)
  commit(next)
  emitArgsChanged(def.name, def.type)
}

function selectExclusive(group: string, name: string): void {
  const next = new Map(parsed.value.known)
  for (const a of schema.value) {
    if (a.exclusiveGroup === group) {
      next.delete(a.name)
    }
  }
  next.set(name, '')
  commit(next)
  const chosen = schema.value.find((a) => a.name === name)
  if (chosen) emitArgsChanged(chosen.name, chosen.type)
}

// Backs the select's synthetic "None" option, which clears the group (a plain
// radio set can't deselect).
function clearExclusive(group: string): void {
  const next = new Map(parsed.value.known)
  for (const a of schema.value) {
    if (a.exclusiveGroup === group) next.delete(a.name)
  }
  commit(next)
}

function activeInGroup(group: string): string {
  for (const a of schema.value) {
    if (a.exclusiveGroup === group && parsed.value.known.has(a.name)) return a.name
  }
  return ''
}

// The currently-selected member of an exclusive group, so the cluster can show
// its full help text below the dropdown (the dropdown options are collapsed
// once one is chosen).
function activeDefInGroup(group: string): ComfyArgDef | null {
  const name = activeInGroup(group)
  if (!name) return null
  return schema.value.find((a) => a.name === name) ?? null
}

// The active member of an exclusive group, when it takes a value — lets the
// cluster show a value input (e.g. `--cache-ram 4 8`, `--cache-lru 10`).
function activeValueDefInGroup(group: string): ComfyArgDef | null {
  const def = activeDefInGroup(group)
  return def && def.type !== 'boolean' ? def : null
}

// Dropdown options for an exclusive cluster: a synthetic "None" entry that
// clears the group, followed by each member flag.
function clusterOptions(args: ComfyArgDef[]): BaseSelectOption[] {
  return [
    {
      value: '',
      label: t('comfyUISettings.argsExclusiveNone', 'None (default)'),
      description: t('comfyUISettings.argsExclusiveNoneHint', 'No flag from this group is set.')
    },
    ...args.map((a) => ({ value: a.name, label: `--${a.name}`, description: a.help }))
  ]
}

// One-line preview of the members so the collapsed dropdown says what you're
// choosing between, not just a generic "Choose one".
function clusterSummary(args: ComfyArgDef[]): string {
  return args.map((a) => `--${a.name}`).join(' ')
}

function onExclusivePick(group: string, value: string): void {
  if (value === '') clearExclusive(group)
  else selectExclusive(group, value)
}

// Score a query token against help prose. Strict (word-boundary or substring only); loose subsequence would make "cuda" hit unrelated help.
function scoreHelp(needle: string, help: string): number {
  if (!needle) return 1
  if (!help) return 0
  const wordBoundaryRe = new RegExp(`\\b${escapeRegExp(needle)}`, 'i')
  if (wordBoundaryRe.test(help)) return 500
  if (help.includes(needle)) return 200
  return 0
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Score a flag against a multi-token query; every token must hit name or help. Name hits dominate help 3:1.
function scoreArg(query: string, arg: ComfyArgDef): number {
  const tokens = query.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return 1
  const name = arg.name.toLowerCase()
  const help = arg.help.toLowerCase()
  let total = 0
  for (const token of tokens) {
    const nameScore = scoreName(token, name)
    const helpScore = scoreHelp(token, help)
    const best = Math.max(nameScore, helpScore / 3)
    if (best === 0) return 0
    total += best
  }
  return total
}

interface GroupItem {
  kind: 'arg' | 'exclusive'
  arg?: ComfyArgDef
  group?: string
  args?: ComfyArgDef[]
}

// Categorized, search-filtered structure with exclusive groups collapsed to one row; sorted by descending score when a query is present.
const structuredGroups = computed(() => {
  const q = search.value.trim().toLowerCase()
  // Pre-score every flag once; score-0 flags drop under an active query, and no query scores everything 1 (schema order).
  const scored = new Map<string, number>()
  for (const arg of schema.value) {
    const s = q ? scoreArg(q, arg) : 1
    if (s > 0) scored.set(arg.name, s)
  }

  // Group score = max member score, so a query surfaces the cluster even if one member matched.
  function groupScore(exclusiveGroup: string): number {
    let best = 0
    for (const a of schema.value) {
      if (a.exclusiveGroup === exclusiveGroup) {
        const s = scored.get(a.name) ?? 0
        if (s > best) best = s
      }
    }
    return best
  }

  const groups = new Map<string, ComfyArgDef[]>()
  for (const arg of schema.value) {
    if (q && !scored.has(arg.name)) continue
    const list = groups.get(arg.category) ?? []
    list.push(arg)
    groups.set(arg.category, list)
  }

  const result = new Map<string, GroupItem[]>()
  const seenExclusive = new Set<string>()
  for (const [category, args] of groups) {
    const items: { item: GroupItem; score: number }[] = []
    for (const arg of args) {
      if (arg.exclusiveGroup) {
        if (seenExclusive.has(arg.exclusiveGroup)) continue
        seenExclusive.add(arg.exclusiveGroup)
        const siblings = schema.value.filter((a) => a.exclusiveGroup === arg.exclusiveGroup)
        if (siblings.length > 1) {
          items.push({
            item: { kind: 'exclusive', group: arg.exclusiveGroup, args: siblings },
            score: groupScore(arg.exclusiveGroup)
          })
          continue
        }
      }
      items.push({ item: { kind: 'arg', arg }, score: scored.get(arg.name) ?? 0 })
    }
    if (q) items.sort((a, b) => b.score - a.score)
    result.set(
      category,
      items.map((i) => i.item)
    )
  }

  // Pin currently-set flags to the top as their own section so they're
  // editable without hunting through categories. Skipped while searching
  // (the filtered list already narrows things down). Reuses the same items
  // as the categories below, so an active exclusive group shows as its
  // dropdown here too.
  if (q) return result
  const activeItems: GroupItem[] = []
  for (const items of result.values()) {
    for (const item of items) {
      if (item.kind === 'exclusive') {
        if (item.group && activeInGroup(item.group) !== '') activeItems.push(item)
      } else if (item.arg && parsed.value.known.has(item.arg.name)) {
        activeItems.push(item)
      }
    }
  }
  if (activeItems.length === 0) return result
  const ordered = new Map<string, GroupItem[]>()
  ordered.set(t('comfyUISettings.argsActiveTitle', 'Active'), activeItems)
  for (const [category, items] of result) ordered.set(category, items)
  return ordered
})

const hasResults = computed(() =>
  Array.from(structuredGroups.value.values()).some((items) => items.length > 0)
)

function onRawInput(value: string): void {
  localValue.value = value
}

function onRawChange(value: string): void {
  localValue.value = value
  emit('update', value)
}

</script>

<template>
  <div class="args-page">
    <header class="args-page-header">
      <button
        type="button"
        class="args-page-back"
        :aria-label="t('common.back', 'Back')"
        @click="emit('back')"
      >
        <ArrowLeft :size="16" />
        <span>{{ t('common.back', 'Back') }}</span>
      </button>
      <div class="args-page-title-row">
        <h2 class="args-page-title">{{ t('comfyUISettings.argsTitle', 'Startup Arguments') }}</h2>
        <span v-if="pendingRestart" class="args-page-restart-tag" role="status">
          {{ t('comfyUISettings.restartRequired', 'Restart to apply') }}
        </span>
      </div>
    </header>

    <div class="args-page-raw">
      <label class="args-page-raw-label">{{
        t('comfyUISettings.argsRawLabel', 'Raw arguments')
      }}</label>
      <ArgsRawInput
        :model-value="localValue"
        :schema="schema"
        :placeholder="t('comfyUISettings.argsPlaceholder', 'No arguments set')"
        :aria-label="t('comfyUISettings.argsRawLabel', 'Raw arguments')"
        @update:model-value="onRawInput"
        @change="onRawChange"
      />
      <p class="args-page-raw-hint">
        {{ t('comfyUISettings.argsRawHint', 'Edit directly, or toggle individual flags below.') }}
      </p>
    </div>

    <BaseInput
      class="args-page-search"
      :model-value="search"
      :placeholder="t('comfyUISettings.argsSearchPlaceholder', 'Search arguments…')"
      :aria-label="t('comfyUISettings.argsSearchPlaceholder', 'Search arguments')"
      @update:model-value="search = $event"
    >
      <template #leading>
        <Search :size="14" />
      </template>
      <template v-if="search.length > 0" #trailing>
        <button
          type="button"
          class="args-page-search-clear"
          :aria-label="t('common.clear', 'Clear')"
          @click="search = ''"
        >
          <X :size="14" />
        </button>
      </template>
    </BaseInput>

    <div v-if="loading" class="args-page-state">
      <Loader2 :size="18" class="args-page-state-spinner" aria-hidden="true" />
      <p class="args-page-state-text">{{ t('common.loading', 'Loading…') }}</p>
    </div>
    <div v-else-if="loadError" class="args-page-state args-page-state-error">
      <AlertCircle :size="18" aria-hidden="true" />
      <p class="args-page-state-text">{{ loadError }}</p>
    </div>
    <div v-else-if="!hasResults" class="args-page-state">
      <SearchX :size="18" aria-hidden="true" />
      <p class="args-page-state-text">
        {{ t('comfyUISettings.argsNoMatches', 'No arguments match your search.') }}
      </p>
    </div>

    <template v-else>
      <section
        v-for="[category, items] in structuredGroups"
        :key="category"
        class="args-page-category"
      >
        <header class="args-page-category-title">{{ category }}</header>

        <div v-for="(item, idx) in items" :key="idx" class="args-page-item">
          <!-- Exclusive cluster as a compact dropdown; the label lists the members so you can see the choices before opening, and a synthetic "None" option clears the group. -->
          <template v-if="item.kind === 'exclusive' && item.args && item.group">
            <div class="args-page-cluster">
              <span class="args-page-cluster-label">
                {{ t('comfyUISettings.argsExclusiveLabel', 'Choose one') }}:
                <span class="args-page-cluster-options">{{ clusterSummary(item.args) }}</span>
              </span>
              <BaseSelect
                :model-value="activeInGroup(item.group)"
                :options="clusterOptions(item.args)"
                :aria-label="`${t('comfyUISettings.argsExclusiveLabel', 'Choose one')}: ${clusterSummary(item.args)}`"
                :placeholder="t('comfyUISettings.argsExclusiveNone', 'None (default)')"
                @update:model-value="(v) => onExclusivePick(item.group!, v)"
              />
              <BaseInput
                v-if="activeValueDefInGroup(item.group)"
                class="args-page-value-input"
                :model-value="getValue(activeValueDefInGroup(item.group)!.name)"
                :placeholder="
                  activeValueDefInGroup(item.group)!.type === 'multi-value'
                    ? t('comfyUISettings.argsMultiPlaceholder', 'space-separated values')
                    : (activeValueDefInGroup(item.group)!.metavar ??
                      t('comfyUISettings.argsValuePlaceholder', 'value'))
                "
                @change="(v) => setValue(activeValueDefInGroup(item.group!)!, v)"
              />
              <p v-if="activeDefInGroup(item.group)?.help" class="args-page-cluster-help">
                {{ activeDefInGroup(item.group)!.help }}
              </p>
            </div>
          </template>

          <!-- Single arg row: switch + flag/help stack, optional value input indented below. -->
          <template v-else-if="item.kind === 'arg' && item.arg">
            <div class="args-page-arg-row">
              <button
                type="button"
                role="switch"
                class="args-page-switch"
                :data-state="isActive(item.arg.name) ? 'checked' : 'unchecked'"
                :aria-checked="isActive(item.arg.name)"
                :aria-label="`--${item.arg.name}`"
                @click="toggleFlag(item.arg)"
              >
                <span class="args-page-switch-thumb" aria-hidden="true"></span>
              </button>
              <div class="args-page-arg-body">
                <span class="args-page-flag">--{{ item.arg.name }}</span>
                <p class="args-page-help">{{ item.arg.help }}</p>
                <BaseInput
                  v-if="
                    isActive(item.arg.name) &&
                    (item.arg.type === 'value' ||
                      item.arg.type === 'optional-value' ||
                      item.arg.type === 'multi-value')
                  "
                  class="args-page-value-input"
                  :model-value="getValue(item.arg.name)"
                  :placeholder="
                    item.arg.type === 'multi-value'
                      ? t('comfyUISettings.argsMultiPlaceholder', 'space-separated values')
                      : (item.arg.metavar ??
                        (item.arg.type === 'optional-value'
                          ? t('comfyUISettings.argsOptionalPlaceholder', 'optional')
                          : t('comfyUISettings.argsValuePlaceholder', 'value')))
                  "
                  @change="(v) => setValue(item.arg!, v)"
                />
              </div>
            </div>
          </template>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.args-page {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 4px 4px 12px;
  height: 100%;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: none;
}

.args-page::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.args-page-header {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding-bottom: 4px;
}

.args-page-back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px 6px 8px;
  margin-left: -4px;
  background: transparent;
  border: none;
  color: var(--text-muted);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  border-radius: 6px;
  transition:
    color 120ms ease,
    background-color 120ms ease,
    transform 80ms ease;
}

.args-page-back:hover {
  color: var(--text);
  background: color-mix(in srgb, var(--text) 6%, transparent);
}

.args-page-back:active {
  transform: scale(0.97);
}

.args-page-back:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.args-page-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.args-page-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: -0.01em;
  line-height: 1.2;
}

/* Mirrors SettingsSectionList's restart tag so the args page reads as the same family. */
.args-page-restart-tag {
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

.args-page-raw {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.args-page-raw-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-muted);
}

.args-page-raw :deep(.ui-input-control) {
  font-size: 13px;
  letter-spacing: -0.01em;
}

.args-page-raw-hint {
  margin: 2px 0 0;
  font-size: 11px;
  line-height: 1.4;
  color: color-mix(in srgb, var(--text-muted) 80%, transparent);
}

.args-page-search :deep(.ui-input-leading) {
  color: color-mix(in srgb, var(--text-muted) 75%, transparent);
}

.args-page-search-clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  background: transparent;
  border: none;
  color: var(--text-muted);
  border-radius: 4px;
  cursor: pointer;
  transition:
    color 120ms ease,
    background-color 120ms ease;
}

.args-page-search-clear:hover {
  color: var(--text);
  background: color-mix(in srgb, var(--text) 8%, transparent);
}

.args-page-search-clear:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.args-page-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 24px 16px;
  color: var(--text-muted);
  text-align: center;
}

.args-page-state-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
}

.args-page-state-error {
  color: var(--danger);
}

.args-page-state-spinner {
  animation: args-page-spin 900ms linear infinite;
}

@keyframes args-page-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .args-page-state-spinner {
    animation-duration: 2400ms;
  }
}

.args-page-category {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.args-page-category + .args-page-category {
  margin-top: 12px;
}

.args-page-category-title {
  margin: 0 0 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.args-page-item {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.args-page-item + .args-page-item {
  margin-top: 2px;
}

/* Switch in column 1, flag + help + value stacked in column 2. */
.args-page-arg-row {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 10px 12px;
  align-items: start;
  padding: 8px 10px;
  margin: 0 -10px;
  border-radius: 8px;
  transition: background-color 120ms ease;
}

.args-page-arg-row:hover {
  background: color-mix(in srgb, var(--text) 4%, transparent);
}

.args-page-arg-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.args-page-flag {
  font:
    13px ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
  color: var(--text);
  overflow-wrap: anywhere;
  word-break: break-word;
}

.args-page-help {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-muted);
}

.args-page-value-input {
  margin-top: 8px;
}

/* Matches the BooleanToggle primitive so the inner page reads as the same family. */
.args-page-switch {
  flex-shrink: 0;
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  margin-top: 2px;
  padding: 0;
  background-color: color-mix(in srgb, var(--text-muted) 40%, transparent);
  border: none;
  border-radius: 999px;
  cursor: pointer;
  transition: background-color 200ms ease;
}

.args-page-switch[data-state='checked'] {
  background-color: var(--accent-primary);
}

.args-page-switch:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.args-page-switch-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  background: #ffffff;
  border-radius: 50%;
  box-shadow:
    0 1px 2px rgba(0, 0, 0, 0.2),
    0 1px 1px rgba(0, 0, 0, 0.08);
  transition: transform 200ms cubic-bezier(0.4, 0, 0.2, 1);
  transform: translateX(0);
}

.args-page-switch[data-state='checked'] .args-page-switch-thumb {
  transform: translateX(16px);
}

@media (prefers-reduced-motion: reduce) {
  .args-page-switch,
  .args-page-switch-thumb {
    transition-duration: 0ms;
  }
}

/* "Choose one" cluster: label (with member preview) above a compact dropdown. */
.args-page-cluster {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.args-page-cluster-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin: 2px 0 2px;
  padding: 0 2px;
}

/* Member preview: monospaced and slightly dimmer so it reads as the option list. */
.args-page-cluster-options {
  font-family:
    ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
  text-transform: none;
  letter-spacing: 0;
  color: color-mix(in srgb, var(--text-muted) 85%, transparent);
}

/* Full help text for the selected cluster member; wraps freely (no clamping). */
.args-page-cluster-help {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-muted);
  overflow-wrap: anywhere;
}
</style>
