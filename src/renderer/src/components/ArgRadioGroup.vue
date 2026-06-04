<script setup lang="ts">
// TODO(stale-old-modal): delete after Settings drawer (v2,
// ComfyUISettingsPanel + ArgsBuilderPage) reaches functional parity and
// ships everywhere.
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
    if (arg.type === 'boolean') emit('toggleBoolean', arg.name, arg)
    else if (arg.type === 'optional-value') emit('toggleOptionalValue', arg.name, arg)
    else emit('setValueArg', arg.name, '', arg)
  } else {
    // Parent's toggle/set handlers remove exclusiveGroup siblings.
    if (arg.type === 'boolean') emit('toggleBoolean', arg.name, arg)
    else emit('toggleOptionalValue', arg.name, arg)
  }
}
</script>

<template>
  <div class="arg-radio-group">
    <div v-for="arg in props.args" :key="arg.name" class="args-row">
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
</style>
