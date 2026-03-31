<script setup lang="ts">
import type { ComfyArgDef } from '../../../types/ipc'
import InfoTooltip from './InfoTooltip.vue'

const props = defineProps<{
  args: ComfyArgDef[]
  activeArg: string | null
  activeValue: string
}>()

const emit = defineEmits<{
  toggleBoolean: [name: string, def: ComfyArgDef]
  toggleOptionalValue: [name: string, def: ComfyArgDef]
  setValueArg: [name: string, value: string, def: ComfyArgDef]
  setOptionalValueText: [name: string, value: string]
}>()

function selectArg(arg: ComfyArgDef): void {
  if (arg.name === props.activeArg) {
    // Deselect
    if (arg.type === 'boolean') emit('toggleBoolean', arg.name, arg)
    else if (arg.type === 'optional-value') emit('toggleOptionalValue', arg.name, arg)
    else emit('setValueArg', arg.name, '', arg)
  } else {
    // Select (the parent's toggle/set functions handle removing siblings via exclusiveGroup)
    if (arg.type === 'boolean') emit('toggleBoolean', arg.name, arg)
    else emit('toggleOptionalValue', arg.name, arg)
  }
}
</script>

<template>
  <div class="arg-radio-group">
    <div v-for="arg in props.args" :key="arg.name" class="args-row">
      <!-- Bare label when no inline input needed (matches ArgRow) -->
      <template v-if="arg.type === 'boolean' || arg.name !== props.activeArg">
        <label class="args-check-row">
          <input type="checkbox" :checked="arg.name === props.activeArg" @change="selectArg(arg)">
          <span class="args-name">{{ arg.flag }}</span>
          <span v-if="arg.metavar" class="args-value-tag" :class="arg.type === 'optional-value' ? 'optional' : 'required'">
            {{ arg.type === 'optional-value' ? `[${arg.metavar}]` : arg.metavar }}
          </span>
          <InfoTooltip :text="arg.help" />
        </label>
      </template>
      <!-- Active non-boolean: flex row with inline input (matches ArgRow) -->
      <template v-else>
        <div class="args-inline-row">
          <label class="args-check-row">
            <input type="checkbox" :checked="true" @change="selectArg(arg)">
            <span class="args-name">{{ arg.flag }}</span>
            <span v-if="arg.metavar" class="args-value-tag" :class="arg.type === 'optional-value' ? 'optional' : 'required'">
              {{ arg.type === 'optional-value' ? `[${arg.metavar}]` : arg.metavar }}
            </span>
            <InfoTooltip :text="arg.help" />
          </label>
          <template v-if="arg.choices && arg.choices.length > 1">
            <select
              class="detail-field-input args-inline-input"
              :value="props.activeValue"
              @change="emit('setOptionalValueText', arg.name, ($event.target as HTMLSelectElement).value)"
            >
              <option value="">(default)</option>
              <option v-for="c in arg.choices" :key="c" :value="c">{{ c }}</option>
            </select>
          </template>
          <input
            v-else
            type="text"
            class="detail-field-input args-inline-input"
            :value="props.activeValue"
            :placeholder="arg.metavar || arg.choices?.[0] || ''"
            @change="emit('setOptionalValueText', arg.name, ($event.target as HTMLInputElement).value)"
          >
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.arg-radio-group {
  border: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
  border-radius: 6px;
  padding: 4px 8px;
  margin: 2px 0;
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

.args-value-tag {
  font-size: 10px;
  font-family: monospace;
  padding: 1px 4px;
  border-radius: 3px;
  white-space: nowrap;
  flex-shrink: 0;
}
.args-value-tag.required {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 15%, transparent);
}
.args-value-tag.optional {
  color: var(--text-muted);
  background: color-mix(in srgb, var(--text-muted) 15%, transparent);
}
</style>
