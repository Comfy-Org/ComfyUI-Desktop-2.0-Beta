<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useTemplateRef, watch, type Component } from 'vue'
import { TID } from '../../../../shared/testIds'
import type { ActionDef } from '../../types/ipc'

/**
 * Footer dropdown for the Settings drawer. Renders either the `pinBottom`
 * install-level actions ("More") or the navigation alternatives off the CTA
 * caret. Clicking an item emits `'pick'`; the parent runs it. Keyboard-navigable,
 * ESC / click-outside dismiss. An optional `heading` + per-item `icon` give the
 * caret variant a titled, icon-aligned look; the plain "More" menu passes
 * neither and renders unchanged.
 */

/** `ActionDef` plus an optional leading icon component (caret variant only). */
export type MenuAction = ActionDef & { icon?: Component }

interface Props {
  open: boolean
  actions: MenuAction[]
  /** Optional section title shown above a divider (caret variant). */
  heading?: string
}

const props = defineProps<Props>()

const emit = defineEmits<{
  close: []
  pick: [action: MenuAction]
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

function handlePick(action: MenuAction): void {
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
// Reserve the icon column when ANY item has an icon, so labels stay aligned
// whether or not a given row carries one.
const hasIcons = computed(() => props.actions.some((a) => !!a.icon))
</script>

<template>
  <Transition name="more-menu-fade">
    <ul
      v-if="open && visibleActions.length > 0"
      ref="menu"
      class="more-menu"
      :class="{ 'has-heading': !!heading, 'has-icons': hasIcons }"
      role="menu"
      :aria-label="heading"
      aria-orientation="vertical"
    >
      <li v-if="heading" class="more-menu-heading" role="presentation">{{ heading }}</li>
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
          <span v-if="hasIcons" class="more-menu-item-icon" aria-hidden="true">
            <component :is="action.icon" v-if="action.icon" :size="15" />
          </span>
          <span class="more-menu-item-label">{{ action.label }}</span>
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

/* Caret variant (titled / icon'd): hug the content instead of the fixed 200px
 * "More"-menu width, so a short single item doesn't float in a wide box. */
.more-menu.has-heading,
.more-menu.has-icons {
  min-width: 168px;
  width: max-content;
  max-width: 280px;
}

/* Section title above a hairline divider — turns a bare list into a deliberate menu. */
.more-menu-heading {
  padding: 4px 12px 6px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--chooser-surface-border);
  color: var(--text-muted);
  opacity: 0.7;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

/* Override global `button` chrome: transparent full-row popover items matching `.context-menu-item`. */
.more-menu-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 14px;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: var(--neutral-100);
  font-size: 13px;
  text-align: left;
  transition: background-color 100ms ease, color 100ms ease;
}

/* Fixed icon column so labels align whether or not a row carries an icon. */
.more-menu-item-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 16px;
  width: 16px;
  height: 16px;
  color: var(--text-muted);
}
.more-menu-item:hover:not(:disabled) .more-menu-item-icon,
.more-menu-item:focus-visible .more-menu-item-icon {
  color: inherit;
}
.more-menu-item-label {
  flex: 1 1 auto;
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
