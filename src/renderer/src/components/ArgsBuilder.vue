<script setup lang="ts">
import { ref, computed } from 'vue'
import type { ComfyArgDef } from '../../../types/ipc'
import InfoTooltip from './InfoTooltip.vue'
import { Settings } from 'lucide-vue-next'

interface Props {
  modelValue: string
  installationId: string
}

const props = defineProps<Props>()
const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const expanded = ref(false)
const schema = ref<ComfyArgDef[]>([])
const loading = ref(false)
const loadError = ref(false)
const fetched = ref(false)

// --- Fetch schema (deferred until panel is opened) ---

async function fetchSchema(): Promise<void> {
  if (fetched.value) return
  fetched.value = true
  loading.value = true
  loadError.value = false
  try {
    const result = await window.api.getComfyArgs(props.installationId)
    if (result?.args?.length) {
      schema.value = result.args
    } else {
      loadError.value = true
    }
  } catch {
    loadError.value = true
  } finally {
    loading.value = false
  }
}

function togglePanel(): void {
  expanded.value = !expanded.value
  if (expanded.value) {
    fetchSchema()
  }
}

// --- Parsing ---

interface ParsedArgs {
  known: Map<string, string>
  extra: string[]
}

function tokenize(raw: string): string[] {
  const tokens: string[] = []
  let current = ''
  let inQuote: string | null = null
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!
    if (inQuote) {
      if (ch === inQuote) { inQuote = null; continue }
      current += ch
    } else if (ch === '"' || ch === "'") {
      inQuote = ch
    } else if (/\s/.test(ch)) {
      if (current.length > 0) { tokens.push(current); current = '' }
    } else {
      current += ch
    }
  }
  if (current.length > 0) tokens.push(current)
  return tokens
}

function parseArgs(raw: string): ParsedArgs {
  const tokens = tokenize(raw)
  const schemaNames = new Set(schema.value.map((a) => a.name))
  const known = new Map<string, string>()
  const extra: string[] = []

  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]!
    if (token.startsWith('--')) {
      const name = token.slice(2)
      if (schemaNames.has(name)) {
        const def = schema.value.find((a) => a.name === name)
        if (def?.type === 'boolean') {
          known.set(name, '')
          i++
        } else if (def?.type === 'optional-value') {
          const next = tokens[i + 1]
          if (next !== undefined && !next.startsWith('--')) {
            known.set(name, next)
            i += 2
          } else {
            known.set(name, '')
            i++
          }
        } else {
          // value type
          const next = tokens[i + 1]
          if (next !== undefined && !next.startsWith('--')) {
            known.set(name, next)
            i += 2
          } else {
            known.set(name, '')
            i++
          }
        }
      } else {
        // Unknown flag — keep in extra
        extra.push(token)
        i++
        if (i < tokens.length && !tokens[i]!.startsWith('--')) {
          extra.push(tokens[i]!)
          i++
        }
      }
    } else {
      extra.push(token)
      i++
    }
  }

  return { known, extra }
}

function serialize(known: Map<string, string>, extra: string[]): string {
  const parts: string[] = []
  for (const [name, value] of known) {
    parts.push(`--${name}`)
    if (value !== '') {
      parts.push(value.includes(' ') ? `"${value}"` : value)
    }
  }
  parts.push(...extra)
  return parts.join(' ')
}

const parsed = computed(() => parseArgs(props.modelValue))

// --- Unsupported args detection ---

const unsupportedFlags = computed(() => {
  if (!schema.value.length) return []
  const schemaNames = new Set(schema.value.map((a) => a.name))
  const tokens = tokenize(props.modelValue)
  const unsupported: string[] = []
  for (const token of tokens) {
    if (token.startsWith('--')) {
      const name = token.slice(2)
      if (!schemaNames.has(name)) {
        unsupported.push(name)
      }
    }
  }
  return unsupported
})

// --- Grouped args for the helper panel ---

const groupedArgs = computed(() => {
  const groups = new Map<string, ComfyArgDef[]>()
  for (const arg of schema.value) {
    const list = groups.get(arg.category) || []
    list.push(arg)
    groups.set(arg.category, list)
  }
  return groups
})

// --- Getters ---

function isActive(name: string): boolean {
  return parsed.value.known.has(name)
}

function getValue(name: string): string {
  return parsed.value.known.get(name) ?? ''
}

// --- Mutators ---

function emitUpdate(known: Map<string, string>): void {
  emit('update:modelValue', serialize(known, parsed.value.extra))
}

function toggleBoolean(name: string, def: ComfyArgDef): void {
  const next = new Map(parsed.value.known)
  if (next.has(name)) {
    next.delete(name)
  } else {
    // Enforce exclusive group: remove siblings
    if (def.exclusiveGroup) {
      for (const a of schema.value) {
        if (a.exclusiveGroup === def.exclusiveGroup && a.name !== name) {
          next.delete(a.name)
        }
      }
    }
    next.set(name, '')
  }
  emitUpdate(next)
}

function setValueArg(name: string, value: string, def: ComfyArgDef): void {
  const next = new Map(parsed.value.known)
  if (value === '') {
    next.delete(name)
  } else {
    if (def.exclusiveGroup) {
      for (const a of schema.value) {
        if (a.exclusiveGroup === def.exclusiveGroup && a.name !== name) {
          next.delete(a.name)
        }
      }
    }
    next.set(name, value)
  }
  emitUpdate(next)
}

function toggleOptionalValue(name: string, def: ComfyArgDef): void {
  const next = new Map(parsed.value.known)
  if (next.has(name)) {
    next.delete(name)
  } else {
    if (def.exclusiveGroup) {
      for (const a of schema.value) {
        if (a.exclusiveGroup === def.exclusiveGroup && a.name !== name) {
          next.delete(a.name)
        }
      }
    }
    next.set(name, '')
  }
  emitUpdate(next)
}

function setOptionalValueText(name: string, value: string): void {
  const next = new Map(parsed.value.known)
  next.set(name, value)
  emitUpdate(next)
}

// --- Highlighted text display ---

interface TextToken {
  text: string
  unsupported: boolean
}

const textTokens = computed<TextToken[]>(() => {
  if (!schema.value.length || !props.modelValue) return []
  const schemaNames = new Set(schema.value.map((a) => a.name))
  const tokens = tokenize(props.modelValue)
  const result: TextToken[] = []

  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]!
    if (token.startsWith('--')) {
      const name = token.slice(2)
      const isBad = !schemaNames.has(name)
      result.push({ text: token, unsupported: isBad })
      i++
      // If next token is a value for this flag
      if (i < tokens.length && !tokens[i]!.startsWith('--')) {
        result.push({ text: tokens[i]!, unsupported: isBad })
        i++
      }
    } else {
      result.push({ text: token, unsupported: false })
      i++
    }
  }
  return result
})

const hasUnsupported = computed(() => unsupportedFlags.value.length > 0)

// --- Collapsed groups ---
const collapsedGroups = ref(new Set<string>())

function toggleGroup(group: string): void {
  if (collapsedGroups.value.has(group)) {
    collapsedGroups.value.delete(group)
  } else {
    collapsedGroups.value.add(group)
  }
}
</script>

<template>
  <div class="args-builder">
    <!-- Text input row -->
    <div class="args-field-row">
      <input
        type="text"
        class="detail-field-input"
        :class="{ 'has-unsupported': hasUnsupported }"
        :value="modelValue"
        placeholder="e.g. --port 8188 --lowvram"
        @change="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      >
      <button
        class="args-configure-btn"
        :class="{ active: expanded }"
        title="Configure startup arguments"
        @click="togglePanel"
      >
        <Settings :size="15" />
      </button>
    </div>

    <!-- Unsupported args warning -->
    <div v-if="hasUnsupported" class="args-unsupported-warning">
      <span class="args-warning-icon">⚠</span>
      Unsupported arguments (will not be passed):
      <span v-for="flag in unsupportedFlags" :key="flag" class="args-bad-flag">--{{ flag }}</span>
    </div>

    <!-- Token display with highlights -->
    <div v-if="hasUnsupported && textTokens.length" class="args-token-display">
      <span
        v-for="(tok, idx) in textTokens" :key="idx"
        :class="{ 'token-bad': tok.unsupported }"
        :title="tok.unsupported ? 'This argument is not supported by this ComfyUI version and will not be passed when launching.' : ''"
      >{{ tok.text }}</span>
    </div>

    <!-- Helper panel -->
    <div v-if="expanded" class="args-helper">
      <div v-if="loading" class="args-loading">Loading argument definitions…</div>
      <div v-else-if="loadError" class="args-error">
        Could not load argument definitions. You can still edit the text field directly.
      </div>
      <template v-else>
        <div v-for="[group, args] in groupedArgs" :key="group" class="args-group">
          <div class="args-group-header" @click="toggleGroup(group)">
            <span class="args-group-chevron" :class="{ collapsed: collapsedGroups.has(group) }">▸</span>
            {{ group }}
          </div>
          <div v-show="!collapsedGroups.has(group)" class="args-group-body">
            <div v-for="a in args" :key="a.name" class="args-row">

              <!-- Boolean toggle -->
              <template v-if="a.type === 'boolean'">
                <label class="args-check-row">
                  <input type="checkbox" :checked="isActive(a.name)" @change="toggleBoolean(a.name, a)">
                  <span class="args-name">{{ a.flag }}</span>
                  <InfoTooltip :text="a.help" />
                </label>
              </template>

              <!-- Optional-value: toggle + optional text inline -->
              <template v-else-if="a.type === 'optional-value'">
                <div class="args-inline-row">
                  <label class="args-check-row">
                    <input type="checkbox" :checked="isActive(a.name)" @change="toggleOptionalValue(a.name, a)">
                    <span class="args-name">{{ a.flag }}</span>
                    <InfoTooltip :text="a.help" />
                  </label>
                  <template v-if="a.choices">
                    <select
                      v-if="isActive(a.name)"
                      class="detail-field-input args-inline-input"
                      :value="getValue(a.name)"
                      @change="setOptionalValueText(a.name, ($event.target as HTMLSelectElement).value)"
                    >
                      <option value="">(default)</option>
                      <option v-for="c in a.choices" :key="c" :value="c">{{ c }}</option>
                    </select>
                  </template>
                  <input
                    v-else-if="isActive(a.name)"
                    type="text"
                    class="detail-field-input args-inline-input"
                    :value="getValue(a.name)"
                    :placeholder="a.metavar || ''"
                    @change="setOptionalValueText(a.name, ($event.target as HTMLInputElement).value)"
                  >
                </div>
              </template>

              <!-- Value type -->
              <template v-else>
                <div class="args-inline-row">
                  <span class="args-name">{{ a.flag }}</span>
                  <InfoTooltip :text="a.help" />
                  <template v-if="a.choices">
                    <select
                      class="detail-field-input args-inline-input"
                      :value="getValue(a.name)"
                      @change="setValueArg(a.name, ($event.target as HTMLSelectElement).value, a)"
                    >
                      <option value="">(default)</option>
                      <option v-for="c in a.choices" :key="c" :value="c">{{ c }}</option>
                    </select>
                  </template>
                  <input
                    v-else
                    :type="a.metavar && /^(PORT|NUM|SIZE|DEVICE_ID|DEFAULT_DEVICE_ID|PREVIEW_SIZE|CACHE_LRU|NUM_STREAMS|RESERVE_VRAM|MAX_UPLOAD_SIZE|CACHE_RAM)$/i.test(a.metavar) ? 'number' : 'text'"
                    class="detail-field-input args-inline-input"
                    :value="getValue(a.name)"
                    :placeholder="a.metavar || ''"
                    @change="setValueArg(a.name, ($event.target as HTMLInputElement).value, a)"
                  >
                </div>
              </template>

            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.args-builder {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.args-field-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.args-field-row .detail-field-input {
  flex: 1;
}
.args-field-row .detail-field-input.has-unsupported {
  border-color: var(--danger, #e53e3e);
}

.args-configure-btn {
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-muted);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}
.args-configure-btn :deep(svg) {
  stroke: currentColor;
}
.args-configure-btn:hover {
  color: var(--text);
  border-color: var(--border-hover);
}
.args-configure-btn.active {
  color: var(--accent);
  border-color: var(--accent);
}

.args-unsupported-warning {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  font-size: 12px;
  color: var(--danger, #e53e3e);
  padding: 4px 0;
}
.args-warning-icon {
  font-size: 13px;
}
.args-bad-flag {
  font-family: monospace;
  font-size: 11px;
  background: rgba(229, 62, 62, 0.15);
  padding: 1px 4px;
  border-radius: 3px;
}

.args-token-display {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: monospace;
  font-size: 12px;
  color: var(--text-muted);
}
.args-token-display .token-bad {
  color: var(--danger, #e53e3e);
  text-decoration: underline wavy;
  text-underline-offset: 3px;
  cursor: help;
}

.args-helper {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 6px 0;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  max-height: 400px;
  overflow-y: auto;
}

.args-loading, .args-error {
  padding: 12px;
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
}
.args-error {
  color: var(--danger, #e53e3e);
}

.args-group {
  border-bottom: 1px solid var(--border);
}
.args-group:last-child {
  border-bottom: none;
}

.args-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-muted);
  cursor: pointer;
  user-select: none;
}
.args-group-header:hover {
  color: var(--text);
}
.args-group-chevron {
  display: inline-block;
  transition: transform 0.15s;
  font-size: 10px;
}
.args-group-chevron:not(.collapsed) {
  transform: rotate(90deg);
}

.args-group-body {
  padding: 0 12px 6px;
}

.args-row {
  padding: 3px 0;
}
.args-row + .args-row {
  border-top: 1px solid var(--border);
}

.args-inline-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.args-check-row {
  display: flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
  flex-shrink: 0;
}
.args-check-row input[type="checkbox"] {
  margin: 0;
  flex-shrink: 0;
}

.args-name {
  font-size: 12px;
  color: var(--text);
  white-space: nowrap;
  font-family: monospace;
}

.args-inline-input {
  flex: 1;
  min-width: 0;
  max-width: 200px;
}
</style>
