<script setup lang="ts">
import { Check } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'

interface MenuItem {
  /** Item id — main routes by this. */
  id?: string
  /** Visible label. English fallback when `labelKey` is set. */
  label?: string
  /** Optional vue-i18n key. Translated against the popup renderer's
   *  shared en catalog (`lib/i18nMessages.ts`). Falls back to
   *  `label` when the key isn't in the catalog. */
  labelKey?: string
  /** Renders a checkmark glyph on the left when true. */
  checked?: boolean
  /** Marks a separator row instead of an interactive item. */
  kind?: 'separator'
}

defineProps<{
  items: MenuItem[]
}>()

const emit = defineEmits<{
  (e: 'activate', id: string): void
}>()

const { t } = useI18n()

/** Resolved label — translates when the item carries a `labelKey`,
 *  otherwise renders the raw `label` (e.g. dynamic labels like
 *  "Reset Zoom (120%)" that main composes inline). */
function labelFor(item: MenuItem): string {
  if (item.labelKey) return t(item.labelKey, item.label ?? '')
  return item.label ?? ''
}

function handleClick(item: MenuItem): void {
  if (item.kind === 'separator') return
  if (!item.id) return
  emit('activate', item.id)
}
</script>

<template>
  <ul class="menu">
    <template v-for="(item, idx) in items" :key="idx">
      <li v-if="item.kind === 'separator'" class="separator" role="separator" />
      <li
        v-else
        class="item"
        role="menuitem"
        tabindex="-1"
        @click="handleClick(item)"
      >
        <span class="check">
          <Check v-if="item.checked" :size="14" />
        </span>
        <span class="label">{{ labelFor(item) }}</span>
      </li>
    </template>
  </ul>
</template>

<style scoped>
.menu {
  list-style: none;
  margin: 0;
  padding: 4px 0;
}

.item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  height: 28px;
  box-sizing: border-box;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 0.08s;
}
.item:hover {
  background: rgba(255, 255, 255, 0.1);
}
:global(.popup.is-light) .item:hover {
  background: rgba(0, 0, 0, 0.07);
}

.check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  opacity: 0.85;
}

.label {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
}

.separator {
  height: 1px;
  margin: 4px 8px;
  background: var(--border, #494a50);
  opacity: 0.6;
}
</style>
