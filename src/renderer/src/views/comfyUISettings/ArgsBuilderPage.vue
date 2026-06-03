<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useDebounceFn } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import { AlertCircle, ArrowLeft, Loader2, Search, SearchX, X } from 'lucide-vue-next'
import BaseInput from '../../components/ui/BaseInput.vue'
import BaseSelect, { type BaseSelectOption } from '../../components/ui/BaseSelect.vue'
import ArgsRawInput from './ArgsRawInput.vue'
import type { ComfyArgDef } from '../../types/ipc'
import { parseArgs, serialize, tokenize } from '../../lib/argsParser'
import { emitTelemetryAction } from '../../lib/telemetry'
import { scoreName } from '../../utils/fuzzyMatch'

/**
 * Sub-page editor for the `launchArgs` field. Takes over the drawer
 * body while open — opened by `ArgsBuilderField`'s gear button, closed
 * by the in-header Back arrow.
 *
 * Schema is fetched from `get-comfy-args` on mount (same IPC the legacy
 * `ArgsBuilder.vue` uses). Each flag renders as:
 *   - boolean  → toggle checkbox
 *   - value    → toggle + text input (value required when active)
 *   - optional → toggle + text input (value optional when active)
 *
 * `exclusiveGroup` flags collapse into a radio cluster: enabling one
 * disables its siblings. Unknown / typo'd flags in the current args
 * string round-trip verbatim via `parseArgs().extra`.
 *
 * Search bar filters by flag name / help text. The drawer is narrow so
 * categorical headers are sticky-ish but the page remains scrollable.
 *
 * The component owns its own local `value` mirror so rapid edits feel
 * snappy; the parent commits via the `update` emit on every mutation,
 * the composable persists through `update-installation`.
 */

interface Props {
  installationId: string
  initialValue: string
}

const props = defineProps<Props>()

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
    // Keep our local mirror in sync when the parent commits a value
    // we didn't originate (rare — e.g. backend default normalization).
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

// ArgsBuilder usage telemetry. The previous one-coarse-settings.changed
// event hid ArgsBuilder usage entirely; these make "did anyone edit
// launch args" answerable, with per-arg detail.
//
// Debounced 500ms: text-input args (`--listen 0.0.0.0`, `--port 8188`)
// otherwise emit one event per keystroke, which would make `args.changed`
// the loudest event in the dataset for no analytical gain — we only care
// that the user edited a given arg, not the per-character intermediate
// states.
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

// Last-chance flush — if the user closes the page mid-debounced edit,
// make sure the parent gets the final value.
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
  const next = serialize(known, parsed.value.extra)
  localValue.value = next
  emit('update', next)
}

function toggleBoolean(def: ComfyArgDef): void {
  const next = new Map(parsed.value.known)
  if (next.has(def.name)) {
    next.delete(def.name)
  } else {
    // Enforce exclusive group: remove siblings
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

function toggleValue(def: ComfyArgDef): void {
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

// Clearing an exclusive group is the affordance the native-radio version
// lost — radios can't deselect, so the user had to hand-edit the raw text
// to get back to "no flag from this group". The select picker below
// surfaces a synthetic "None" option that calls this.
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

function optionsForGroup(args: ComfyArgDef[]): BaseSelectOption[] {
  return [
    {
      value: '',
      label: t('comfyUISettings.argsExclusiveNone', 'None (default)'),
      description: t('comfyUISettings.argsExclusiveNoneHint', 'No flag from this group is set.')
    },
    ...args.map((a) => ({ value: a.name, label: `--${a.name}`, description: a.help }))
  ]
}

function onExclusiveChange(group: string, value: string): void {
  if (value === '') clearExclusive(group)
  else selectExclusive(group, value)
}

/**
 * Score a single query token against a flag *help* text. Help is long
 * prose, so the scorer is intentionally strict — only word-boundary or
 * contiguous-substring matches count. We never fall through to loose
 * subsequence; otherwise short queries like "cuda" hit unrelated help
 * via c…u…d…a spread across the sentence.
 */
function scoreHelp(needle: string, help: string): number {
  if (!needle) return 1
  if (!help) return 0
  // Word-boundary match: token sits at the start of a word in help.
  // \b is unicode-aware enough for our ASCII-ish flag descriptions.
  const wordBoundaryRe = new RegExp(`\\b${escapeRegExp(needle)}`, 'i')
  if (wordBoundaryRe.test(help)) return 500
  // Plain substring (catches "tls" inside "TLS-encrypted") — lower
  // score so name hits always win.
  if (help.includes(needle)) return 200
  return 0
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Score a flag definition against the (potentially multi-token) query.
 * Every token must hit *something* — name or help. Name hits dominate
 * help hits 3:1 so typing the start of a flag name surfaces that flag
 * even when the literal token appears in some other flag's help text.
 */
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
  // For 'arg' — the single flag def.
  arg?: ComfyArgDef
  // For 'exclusive' — the group key + member defs.
  group?: string
  args?: ComfyArgDef[]
}

// Categorized + search-filtered structure, with exclusive groups
// collapsed into a single row per group. When a search query is
// present, every category's items are sorted by descending fuzzy
// score so the best matches surface first.
const structuredGroups = computed(() => {
  const q = search.value.trim().toLowerCase()
  // Pre-score every flag once; flags with score 0 are dropped when
  // there's an active query. With no query, every flag scores 1 so
  // ordering falls back to the schema's original order.
  const scored = new Map<string, number>()
  for (const arg of schema.value) {
    const s = q ? scoreArg(q, arg) : 1
    if (s > 0) scored.set(arg.name, s)
  }

  // Score of an exclusive group = max score among its members. Lets a
  // query like "tls" surface the TLS-related radio cluster even if
  // only one member matched.
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
  return result
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

// Unknown-flag warning so users know if a typo silently survives.
const unknownFlags = computed(() => {
  if (!schema.value.length) return []
  const known = new Set(schema.value.map((a) => a.name))
  const tokens = tokenize(localValue.value)
  const out: string[] = []
  for (const tok of tokens) {
    if (!tok.startsWith('--')) continue
    const rest = tok.slice(2)
    const eqIdx = rest.indexOf('=')
    const name = eqIdx >= 0 ? rest.slice(0, eqIdx) : rest
    if (name && !known.has(name)) out.push(name)
  }
  return out
})

// Render the warning ourselves rather than going through vue-i18n's
// interpolated key — no catalog entry exists, so the bare key was
// leaking into the UI. Fallback string lives here; a locale catalog
// can override by registering the key with `{flags}` placeholder.
const unknownFlagsMessage = computed(() => {
  const flags = unknownFlags.value.join(', ')
  return t('comfyUISettings.argsUnknown', { flags }) === 'comfyUISettings.argsUnknown'
    ? `Unknown flag(s): ${flags}`
    : t('comfyUISettings.argsUnknown', { flags })
})
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
      <h2 class="args-page-title">{{ t('comfyUISettings.argsTitle', 'Startup Arguments') }}</h2>
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
      <p v-if="unknownFlags.length > 0" class="args-page-unknown" role="status">
        <AlertCircle :size="12" aria-hidden="true" />
        <span>{{ unknownFlagsMessage }}</span>
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
          <!-- Exclusive cluster: a single select picker. Members render as
             options (label = `--flag`, description = help text) with a
             synthetic "None" entry as the first option so the group is
             clearable — the native-radio version this replaced had no
             way to deselect, forcing users to edit the raw text. The
             surrounding category heading + the "Choose one" label
             below supply the human-readable context the auto-assigned
             `group_N` ID can't. -->
          <template v-if="item.kind === 'exclusive' && item.args && item.group">
            <div class="args-page-row args-page-row-cluster-label">
              <span class="args-page-cluster-label">
                {{ t('comfyUISettings.argsExclusiveLabel', 'Choose one') }}
              </span>
            </div>
            <!-- BaseSelect has two root nodes (trigger + Teleport) so
               attributes don't auto-fall through. Wrap in a div to
               carry the layout class. -->
            <div class="args-page-exclusive-select">
              <BaseSelect
                :model-value="activeInGroup(item.group)"
                :options="optionsForGroup(item.args)"
                :aria-label="t('comfyUISettings.argsExclusiveLabel', 'Choose one')"
                :placeholder="t('comfyUISettings.argsExclusiveNone', 'None (default)')"
                @update:model-value="(v) => onExclusiveChange(item.group!, v)"
              />
            </div>
          </template>

          <!-- Single arg row: leading switch + flag/help stack. The
             optional value input renders below, indented under the
             flag column so it reads as subordinate. -->
          <template v-else-if="item.kind === 'arg' && item.arg">
            <div class="args-page-arg-row">
              <button
                type="button"
                role="switch"
                class="args-page-switch"
                :data-state="isActive(item.arg.name) ? 'checked' : 'unchecked'"
                :aria-checked="isActive(item.arg.name)"
                :aria-label="`--${item.arg.name}`"
                @click="
                  item.arg.type === 'boolean' ? toggleBoolean(item.arg) : toggleValue(item.arg)
                "
              >
                <span class="args-page-switch-thumb" aria-hidden="true"></span>
              </button>
              <div class="args-page-arg-body">
                <span class="args-page-flag">--{{ item.arg.name }}</span>
                <p class="args-page-help">{{ item.arg.help }}</p>
                <BaseInput
                  v-if="
                    isActive(item.arg.name) &&
                    (item.arg.type === 'value' || item.arg.type === 'optional-value')
                  "
                  class="args-page-value-input"
                  :model-value="getValue(item.arg.name)"
                  :placeholder="
                    item.arg.metavar ??
                    (item.arg.type === 'optional-value'
                      ? t('comfyUISettings.argsOptionalPlaceholder', 'optional')
                      : t('comfyUISettings.argsValuePlaceholder', 'value'))
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

.args-page-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: -0.01em;
  line-height: 1.2;
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

.args-page-unknown {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 6px 0 0;
  padding: 6px 10px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 14%, transparent);
  border-radius: 6px;
}

.args-page-unknown :deep(svg) {
  flex-shrink: 0;
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

/* Single arg row: grid puts the switch in column 1 (top-aligned) and
 * the flag + help + optional value input stacked in column 2. The whole
 * row gets a subtle hover background for affordance. */
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

/* Switch (single arg) — built on a <button role="switch"> so the click
 * target is wide enough and keyboard focus is preserved. Visual matches
 * the BooleanToggle primitive (36×20 track, 16px thumb, accent fill on
 * checked) so the inner page reads as the same family. */
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

/* Exclusive ("choose one") cluster — the faint inline label sits above
 * a BaseSelect picker so the group can be cleared via a synthetic "None"
 * option (native radios couldn't deselect). Uses the shared BaseSelect
 * chrome — same as Global Settings language and other select fields. */
.args-page-row-cluster-label {
  padding: 0 2px;
  margin: 2px 0 4px;
}

.args-page-cluster-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.args-page-exclusive-select {
  min-width: 0;
}

/* TODO(brand-cleanup): the radio cluster styles below are no longer
 * referenced — the exclusive group renders as a BaseSelect above. Kept
 * for one release cycle of validation per the soft-delete convention,
 * then drop the block entirely. */
.args-page-radio-row {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 10px 12px;
  align-items: start;
  padding: 8px 10px;
  margin: 0 -10px;
  border-radius: 8px;
  cursor: pointer;
  transition: background-color 120ms ease;
}

.args-page-radio-row:hover {
  background: color-mix(in srgb, var(--text) 4%, transparent);
}

.args-page-radio-row.is-active {
  background: color-mix(in srgb, var(--accent-primary) 8%, transparent);
}

.args-page-radio-input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
  pointer-events: none;
}

.args-page-radio-indicator {
  flex-shrink: 0;
  position: relative;
  width: 16px;
  height: 16px;
  margin-top: 3px;
  border-radius: 50%;
  border: 1.5px solid color-mix(in srgb, var(--text-muted) 60%, transparent);
  background: transparent;
  transition:
    border-color 150ms ease,
    background-color 150ms ease;
}

.args-page-radio-row.is-active .args-page-radio-indicator {
  border-color: var(--accent-primary);
  background: var(--accent-primary);
}

.args-page-radio-row.is-active .args-page-radio-indicator::after {
  content: '';
  position: absolute;
  inset: 3px;
  border-radius: 50%;
  background: #ffffff;
}

.args-page-radio-input:focus-visible + .args-page-radio-indicator {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.args-page-radio-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
</style>
