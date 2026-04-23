<script setup lang="ts">
import { computed } from 'vue'
import type { ComfyArgDef } from '../../../types/ipc'
import InfoTooltip from './InfoTooltip.vue'

const props = defineProps<{
  arg: ComfyArgDef
  active: boolean
  value: string
}>()

const emit = defineEmits<{
  toggleBoolean: [name: string, def: ComfyArgDef]
  toggleOptionalValue: [name: string, def: ComfyArgDef]
  setValueArg: [name: string, value: string, def: ComfyArgDef]
  setOptionalValueText: [name: string, value: string]
}>()

const hasChoices = computed(() => !!props.arg.choices && props.arg.choices.length > 1)
</script>

<template>
  <div class="args-row">
    <!-- Boolean toggle -->
    <template v-if="props.arg.type === 'boolean'">
      <label class="args-check-row">
        <input type="checkbox" :checked="props.active" @change="emit('toggleBoolean', props.arg.name, props.arg)">
        <span class="args-name">{{ props.arg.flag }}</span>
        <InfoTooltip :text="props.arg.help" />
      </label>
    </template>

    <!-- Optional-value: toggle + optional text inline -->
    <template v-else-if="props.arg.type === 'optional-value'">
      <div class="args-inline-row">
        <label class="args-check-row">
          <input type="checkbox" :checked="props.active" @change="emit('toggleOptionalValue', props.arg.name, props.arg)">
          <span class="args-name">{{ props.arg.flag }}</span>
          <span v-if="props.arg.metavar" class="args-value-tag optional">[{{ props.arg.metavar }}]</span>
          <InfoTooltip :text="props.arg.help" />
        </label>
        <template v-if="hasChoices">
          <select
            v-if="props.active"
            class="detail-field-input args-inline-input"
            :value="props.value"
            @change="emit('setOptionalValueText', props.arg.name, ($event.target as HTMLSelectElement).value)"
          >
            <option value="">(default)</option>
            <option v-for="c in props.arg.choices" :key="c" :value="c">{{ c }}</option>
          </select>
        </template>
        <input
          v-else-if="props.active"
          type="text"
          class="detail-field-input args-inline-input"
          :value="props.value"
          :placeholder="props.arg.metavar || props.arg.choices?.[0] || ''"
          @change="emit('setOptionalValueText', props.arg.name, ($event.target as HTMLInputElement).value)"
        >
      </div>
    </template>

    <!-- Value type -->
    <template v-else>
      <div class="args-inline-row">
        <span class="args-name">{{ props.arg.flag }}</span>
        <span v-if="props.arg.metavar" class="args-value-tag required">{{ props.arg.metavar }}</span>
        <InfoTooltip :text="props.arg.help" />
        <template v-if="hasChoices">
          <select
            class="detail-field-input args-inline-input"
            :value="props.value"
            @change="emit('setValueArg', props.arg.name, ($event.target as HTMLSelectElement).value, props.arg)"
          >
            <option value="">(default)</option>
            <option v-for="c in props.arg.choices" :key="c" :value="c">{{ c }}</option>
          </select>
        </template>
        <input
          v-else
          type="text"
          class="detail-field-input args-inline-input"
          :value="props.value"
          :placeholder="props.arg.metavar || props.arg.choices?.[0] || ''"
          @change="emit('setValueArg', props.arg.name, ($event.target as HTMLInputElement).value, props.arg)"
        >
      </div>
    </template>
  </div>
</template>


