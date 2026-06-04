<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useTemplateRef, watch } from 'vue'
import { TID } from '../../../../shared/testIds'
import type { ActionDef } from '../../types/ipc'

/**
 * Footer "More" dropdown for the Settings drawer, rendering the `pinBottom` install-level actions.
 * Clicking an item emits `'pick'` with the `ActionDef`; the parent runs it through `runAction`. Keyboard-navigable, ESC / click-outside dismiss.
 */

interface Props {
  open: boolean
  actions: ActionDef[]
}

const props = defineProps<Props>()

const emit = defineEmits<{
  close: []
  pick: [action: ActionDef]
}>()

const menuRef = useTemplateRef<HTMLElement>('menu')
const focusedIndex = ref(0)

// Reset focus to the first item every time the menu opens.
watch(
  () => props.open,
  async (next) => {
    if (!next) return
    focusedIndex.value = 0
    await nextTick()
    menuRef.value?.querySelectorAll<HTMLButtonElement>('.more-menu-item')[0]?.focus()
  },
)

function handlePick(action: ActionDef): void {
  if (action.enabled === false) return
  emit('pick', action)
  emit('close')
}

function handleKeydown(event: KeyboardEvent): void {
  if (!props.open) return
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
    return
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  event.preventDefault()
  const total = props.actions.length
  if (total === 0) return
  const delta = event.key === 'ArrowDown' ? 1 : -1
  focusedIndex.value = (focusedIndex.value + delta + total) % total
  nextTick(() => {
    menuRef.value
      ?.querySelectorAll<HTMLButtonElement>('.more-menu-item')[focusedIndex.value]
      ?.focus()
  })
}

// Click-outside dismiss. The trigger toggles `open` itself, so we skip clicks on it via the `data-more-trigger` attr (avoids threading a ref).
function handleDocumentClick(event: MouseEvent): void {
  if (!props.open) return
  const target = event.target as Node | null
  if (menuRef.value?.contains(target)) return
  const trigger = (event.target as HTMLElement | null)?.closest('[data-more-trigger]')
  if (trigger) return
  emit('close')
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
  document.addEventListener('mousedown', handleDocumentClick)
})
onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
  document.removeEventListener('mousedown', handleDocumentClick)
})

const visibleActions = computed(() => props.actions)
</script>

<template>
  <Transition name="more-menu-fade">
    <ul
      v-if="open && visibleActions.length > 0"
      ref="menu"
      class="more-menu"
      role="menu"
      aria-orientation="vertical"
    >
      <li
        v-for="(action, i) in visibleActions"
        :key="action.id"
        role="none"
      >
        <button
          type="button"
          role="menuitem"
          class="more-menu-item"
          :class="{
            'is-danger': action.style === 'danger',
            'is-accent': action.style === 'accent',
            'is-disabled': action.enabled === false,
          }"
          :disabled="action.enabled === false"
          :tabindex="focusedIndex === i ? 0 : -1"
          :data-testid="TID.pinBottomAction(action.id)"
          @click="handlePick(action)"
        >
          {{ action.label }}
        </button>
      </li>
    </ul>
  </Transition>
</template>

<style scoped>
/* Mirrors the dashboard's `.context-menu` chrome so kebab and More menu read as one family. */
.more-menu {
  position: absolute;
  right: 0;
  bottom: calc(100% + 6px);
  margin: 0;
  padding: 6px;
  list-style: none;
  min-width: 200px;
  background: var(--modal-surface-bg);
  border: 1px solid var(--chooser-surface-border);
  border-radius: 10px;
  box-shadow: var(--modal-surface-shadow);
  z-index: 62;
}

/* Override global `button` chrome: transparent full-row popover items matching `.context-menu-item`. */
.more-menu-item {
  width: 100%;
  display: block;
  padding: 8px 14px;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: var(--neutral-100);
  font-size: 13px;
  text-align: left;
  transition: background-color 100ms ease, color 100ms ease;
}

.more-menu-item:hover:not(:disabled) {
  background: var(--brand-surface-bg-hover);
  color: var(--text);
}

.more-menu-item:focus-visible {
  outline: none;
  background: var(--brand-surface-bg-hover);
  color: var(--text);
}

.more-menu-item.is-danger {
  color: var(--danger);
}
.more-menu-item.is-danger:hover:not(:disabled),
.more-menu-item.is-danger:focus-visible {
  color: var(--danger-hover);
}

.more-menu-item.is-accent {
  color: var(--accent-primary);
}

.more-menu-item.is-disabled,
.more-menu-item:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.more-menu-fade-enter-active,
.more-menu-fade-leave-active {
  transition: opacity 120ms ease, transform 120ms cubic-bezier(0.32, 0.72, 0, 1);
}
.more-menu-fade-enter-from,
.more-menu-fade-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>
