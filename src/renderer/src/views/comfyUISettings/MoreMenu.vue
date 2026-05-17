<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useTemplateRef, watch } from 'vue'
import type { ActionDef } from '../../types/ipc'

/**
 * Footer "More" dropdown for the brand-redesigned Settings drawer
 * (v2). Renders the install-level actions main ships in the
 * `pinBottom` section of `getDetailSections()` — Launch / Copy
 * Installation / Open Folder / Untrack Installation / Delete
 * Installation — without leaving the drawer.
 *
 * UX:
 *   - The drawer's footer renders a single "More" button (with a
 *     chevron). Clicking it opens this menu anchored above the button.
 *   - Items are sourced from `pinBottomActions` in `useComfyUISettings`
 *     (which already applies the Launch→Restart synthetic swap).
 *   - Clicking an item closes the menu and emits `'pick'` with the
 *     `ActionDef` — the parent runs it through `runAction` so all the
 *     prompt/confirm/select/showProgress chains fire correctly.
 *   - ESC, click-outside, or another click on the trigger closes.
 *
 * The menu is keyboard-navigable (ArrowUp / ArrowDown) and respects
 * the a11y baseline the drawer set (role="menu", aria-activedescendant,
 * focus restore on close).
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

// Click-outside dismiss. The trigger button toggles `open` itself —
// so we only close when the click lands outside both the trigger and
// the menu. Detecting "outside the trigger" needs the trigger's
// element; the drawer's footer passes us a `data-more-trigger` attr
// (see ComfyUISettingsPanel template) so we don't have to thread a ref.
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
          @click="handlePick(action)"
        >
          {{ action.label }}
        </button>
      </li>
    </ul>
  </Transition>
</template>

<style scoped>
.more-menu {
  position: absolute;
  right: 0;
  bottom: calc(100% + 6px);
  margin: 0;
  padding: 4px;
  list-style: none;
  min-width: 200px;
  background: color-mix(in srgb, var(--bg) 90%, transparent);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
  z-index: 62;
}

.more-menu-item {
  width: 100%;
  display: block;
  padding: 8px 12px;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease;
}

.more-menu-item:hover:not(:disabled) {
  background: color-mix(in srgb, var(--text) 8%, transparent);
}

.more-menu-item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.more-menu-item.is-danger {
  color: var(--danger);
}

.more-menu-item.is-accent {
  color: var(--accent);
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
