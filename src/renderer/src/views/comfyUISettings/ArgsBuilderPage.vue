<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowLeft, Search } from 'lucide-vue-next'
import BaseInput from '../../components/ui/BaseInput.vue'
import type { ComfyArgDef } from '../../types/ipc'
import { parseArgs, serialize, tokenize } from '../../lib/argsParser'

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
  },
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
      loadError.value = t('comfyUISettings.argsSchemaUnavailable', 'Argument schema unavailable for this install.')
    }
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
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
}

function setValue(def: ComfyArgDef, value: string): void {
  const next = new Map(parsed.value.known)
  next.set(def.name, value)
  commit(next)
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
// collapsed into a single row per group.
const structuredGroups = computed(() => {
  const q = search.value.trim().toLowerCase()
  const groups = new Map<string, ComfyArgDef[]>()
  for (const arg of schema.value) {
    if (q && !arg.name.toLowerCase().includes(q) && !arg.help.toLowerCase().includes(q)) {
      continue
    }
    const list = groups.get(arg.category) ?? []
    list.push(arg)
    groups.set(arg.category, list)
  }
  const result = new Map<string, GroupItem[]>()
  const seenExclusive = new Set<string>()
  for (const [category, args] of groups) {
    const items: GroupItem[] = []
    for (const arg of args) {
      if (arg.exclusiveGroup) {
        if (seenExclusive.has(arg.exclusiveGroup)) continue
        seenExclusive.add(arg.exclusiveGroup)
        const siblings = schema.value.filter((a) => a.exclusiveGroup === arg.exclusiveGroup)
        if (siblings.length > 1) {
          items.push({ kind: 'exclusive', group: arg.exclusiveGroup, args: siblings })
          continue
        }
      }
      items.push({ kind: 'arg', arg })
    }
    result.set(category, items)
  }
  return result
})

const hasResults = computed(() => Array.from(structuredGroups.value.values()).some((items) => items.length > 0))

// Free-text mirror — lets the user paste raw args directly.
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
      <label class="args-page-raw-label">{{ t('comfyUISettings.argsRawLabel', 'Raw arguments') }}</label>
      <BaseInput
        mono
        :model-value="localValue"
        :placeholder="t('comfyUISettings.argsPlaceholder', 'No arguments set')"
        @change="onRawChange"
      />
      <p v-if="unknownFlags.length > 0" class="args-page-unknown">
        {{ t('comfyUISettings.argsUnknown', { flags: unknownFlags.join(', ') }) }}
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
    </BaseInput>

    <p v-if="loading" class="args-page-status">{{ t('common.loading', 'Loading…') }}</p>
    <p v-else-if="loadError" class="args-page-status args-page-status-error">{{ loadError }}</p>
    <p v-else-if="!hasResults" class="args-page-status">
      {{ t('comfyUISettings.argsNoMatches', 'No arguments match your search.') }}
    </p>

    <template v-else>
    <section
      v-for="[category, items] in structuredGroups"
      :key="category"
      class="args-page-category"
    >
      <header class="args-page-category-title">{{ category }}</header>

      <div v-for="(item, idx) in items" :key="idx" class="args-page-item">
        <!-- Exclusive radio cluster -->
        <template v-if="item.kind === 'exclusive' && item.args && item.group">
          <div class="args-page-row">
            <div class="args-page-row-label">{{ t('comfyUISettings.argsExclusiveLabel', 'Choose one') }}</div>
          </div>
          <div
            v-for="member in item.args"
            :key="member.name"
            class="args-page-row args-page-row-sub"
          >
            <label class="args-page-radio-label">
              <input
                type="radio"
                :name="`exclusive-${item.group}`"
                :checked="isActive(member.name)"
                @change="selectExclusive(item.group!, member.name)"
              />
              <span class="args-page-flag">--{{ member.name }}</span>
            </label>
            <p class="args-page-help">{{ member.help }}</p>
          </div>
        </template>

        <!-- Single arg row -->
        <template v-else-if="item.kind === 'arg' && item.arg">
          <div class="args-page-row">
            <label class="args-page-toggle">
              <input
                type="checkbox"
                :checked="isActive(item.arg.name)"
                @change="
                  item.arg.type === 'boolean'
                    ? toggleBoolean(item.arg)
                    : toggleValue(item.arg)
                "
              />
              <span class="args-page-flag">--{{ item.arg.name }}</span>
            </label>
          </div>
          <p class="args-page-help">{{ item.arg.help }}</p>
          <BaseInput
            v-if="
              isActive(item.arg.name) &&
              (item.arg.type === 'value' || item.arg.type === 'optional-value')
            "
            class="args-page-value-input"
            :model-value="getValue(item.arg.name)"
            :placeholder="item.arg.metavar ?? (item.arg.type === 'optional-value' ? t('comfyUISettings.argsOptionalPlaceholder', 'optional') : t('comfyUISettings.argsValuePlaceholder', 'value'))"
            @change="(v) => setValue(item.arg!, v)"
          />
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
  gap: 16px;
  padding: 16px;
  height: 100%;
  overflow-y: auto;
}

.args-page-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.args-page-back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background: transparent;
  border: none;
  color: var(--text-muted);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  border-radius: 4px;
  transition: color 120ms ease, background-color 120ms ease;
}

.args-page-back:hover {
  color: var(--text);
  background: color-mix(in srgb, var(--text) 6%, transparent);
}

.args-page-back:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.args-page-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}

.args-page-raw {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.args-page-raw-label {
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.args-page-unknown {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--warning);
}

.args-page-status {
  margin: 0;
  font-size: 13px;
  color: var(--text-muted);
}

.args-page-status-error {
  color: var(--danger);
}

.args-page-category {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.args-page-category-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--border);
}

.args-page-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.args-page-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.args-page-row-sub {
  padding-left: 14px;
}

.args-page-row-label {
  font-size: 12px;
  color: var(--text-muted);
}

.args-page-toggle,
.args-page-radio-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.args-page-flag {
  font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--text);
}

.args-page-help {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.4;
}

.args-page-value-input {
  margin-top: 4px;
}
</style>
