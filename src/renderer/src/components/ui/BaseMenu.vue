<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue'

// Actions-menu primitive: a trigger and a popover list of items that fire
// `select` on pick. Auto-flips up/down by available space and teleports the
// popover to <body> so ancestor `overflow:hidden` can't clip it.

export interface BaseMenuItem {
  id: string
  label: string
  disabled?: boolean
  style?: 'default' | 'danger'
  /** Draws a divider above this item. */
  separator?: boolean
}

interface Props {
  items: BaseMenuItem[]
  triggerAriaLabel?: string
  /** Min popover width so labels don't reflow on open. */
  minWidth?: number
  /** `start` aligns the menu's left edge with the trigger's; `end` aligns
   *  the right edges, tucking trailing-side menus back into the viewport. */
  align?: 'start' | 'end'
  offset?: number
}

const props = withDefaults(defineProps<Props>(), {
  triggerAriaLabel: undefined,
  minWidth: undefined,
  align: 'start',
  offset: 4,
})

const emit = defineEmits<{
  select: [id: string]
}>()

const triggerRef = useTemplateRef<HTMLButtonElement>('trigger')
const menuRef = useTemplateRef<HTMLUListElement>('menu')
const open = ref(false)
const activeIndex = ref(-1)
const popoverStyle = ref<Record<string, string>>({})

const menuId = `ui-menu-${Math.random().toString(36).slice(2, 9)}`

function firstEnabledIndex(): number {
  return props.items.findIndex((i) => !i.disabled)
}

const VIEWPORT_PAD_PX = 4

// Picks a side by available space, anchors x by `align`, and clamps into
// the viewport. Called once with an estimated rect, then again post-mount
// with the measured rect (needed so long labels stop clipping).
function updatePosition(): void {
  const trigger = triggerRef.value
  if (!trigger) return
  const rect = trigger.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight

  const measured = menuRef.value?.getBoundingClientRect() ?? null
  const minWidth = props.minWidth ?? rect.width
  const menuWidth = Math.max(measured?.width ?? 0, minWidth)
  const estimatedHeight = Math.min(props.items.length * 36 + 16, 320)
  const menuHeight = measured?.height ?? estimatedHeight

  const spaceBelow = vh - rect.bottom - props.offset
  const spaceAbove = rect.top - props.offset
  const openUp =
    menuHeight + VIEWPORT_PAD_PX > spaceBelow && spaceAbove > spaceBelow
  const top = openUp ? rect.top - props.offset - menuHeight : rect.bottom + props.offset

  const anchorLeft = props.align === 'end' ? rect.right - menuWidth : rect.left
  const clampedLeft = Math.min(
    Math.max(anchorLeft, VIEWPORT_PAD_PX),
    Math.max(VIEWPORT_PAD_PX, vw - menuWidth - VIEWPORT_PAD_PX),
  )

  popoverStyle.value = {
    position: 'fixed',
    left: `${clampedLeft}px`,
    top: `${Math.max(VIEWPORT_PAD_PX, Math.min(top, vh - menuHeight - VIEWPORT_PAD_PX))}px`,
    minWidth: `${minWidth}px`,
    maxWidth: `${vw - VIEWPORT_PAD_PX * 2}px`,
    maxHeight: `${(openUp ? spaceAbove : spaceBelow) - VIEWPORT_PAD_PX}px`,
    zIndex: '9999',
  }
}

function openPanel(): void {
  if (open.value) return
  if (props.items.length === 0) return
  open.value = true
  activeIndex.value = firstEnabledIndex()
  // First pass avoids a flash at (0,0); second re-measures the real rect.
  updatePosition()
  void nextTick(() => {
    updatePosition()
    menuRef.value?.focus()
    scrollActiveIntoView()
  })
}

function closePanel(returnFocus = true): void {
  if (!open.value) return
  open.value = false
  if (returnFocus) {
    void nextTick(() => triggerRef.value?.focus())
  }
}

function toggle(): void {
  if (open.value) closePanel()
  else openPanel()
}

function pickIndex(i: number): void {
  const item = props.items[i]
  if (!item || item.disabled) return
  emit('select', item.id)
  closePanel()
}

function moveActive(delta: number): void {
  const len = props.items.length
  if (len === 0) return
  let i = activeIndex.value
  for (let step = 0; step < len; step++) {
    i = (i + delta + len) % len
    if (!props.items[i]?.disabled) {
      activeIndex.value = i
      scrollActiveIntoView()
      return
    }
  }
}

function scrollActiveIntoView(): void {
  const list = menuRef.value
  if (!list) return
  const el = list.querySelector<HTMLElement>(`[data-index="${activeIndex.value}"]`)
  el?.scrollIntoView({ block: 'nearest' })
}

function onTriggerKeydown(event: KeyboardEvent): void {
  if (
    event.key === 'ArrowDown' ||
    event.key === 'ArrowUp' ||
    event.key === 'Enter' ||
    event.key === ' '
  ) {
    event.preventDefault()
    openPanel()
  }
}

function onMenuKeydown(event: KeyboardEvent): void {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      moveActive(1)
      break
    case 'ArrowUp':
      event.preventDefault()
      moveActive(-1)
      break
    case 'Home':
      event.preventDefault()
      activeIndex.value = firstEnabledIndex()
      scrollActiveIntoView()
      break
    case 'End':
      event.preventDefault()
      for (let i = props.items.length - 1; i >= 0; i--) {
        if (!props.items[i]?.disabled) {
          activeIndex.value = i
          scrollActiveIntoView()
          break
        }
      }
      break
    case 'Enter':
    case ' ':
      event.preventDefault()
      if (activeIndex.value >= 0) pickIndex(activeIndex.value)
      break
    case 'Escape':
      event.preventDefault()
      closePanel()
      break
    case 'Tab':
      closePanel(false)
      break
  }
}

function onDocPointer(event: PointerEvent): void {
  if (!open.value) return
  const target = event.target as Node | null
  if (target && !triggerRef.value?.contains(target) && !menuRef.value?.contains(target)) {
    closePanel(false)
  }
}

function onWindowChange(): void {
  if (open.value) updatePosition()
}

watch(open, (isOpen) => {
  if (isOpen) {
    document.addEventListener('pointerdown', onDocPointer, true)
    window.addEventListener('resize', onWindowChange)
    window.addEventListener('scroll', onWindowChange, true)
  } else {
    document.removeEventListener('pointerdown', onDocPointer, true)
    window.removeEventListener('resize', onWindowChange)
    window.removeEventListener('scroll', onWindowChange, true)
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointer, true)
  window.removeEventListener('resize', onWindowChange)
  window.removeEventListener('scroll', onWindowChange, true)
})

defineExpose({ open: openPanel, close: closePanel, toggle })
</script>

<template>
  <button
    ref="trigger"
    type="button"
    class="ui-menu-trigger"
    :aria-expanded="open"
    :aria-controls="menuId"
    aria-haspopup="menu"
    :aria-label="triggerAriaLabel"
    @click="toggle"
    @keydown="onTriggerKeydown"
  >
    <slot />
  </button>

  <Teleport to="body">
    <Transition name="ui-menu-pop">
      <ul
        v-if="open"
        :id="menuId"
        ref="menu"
        class="ui-menu-list"
        role="menu"
        tabindex="-1"
        :style="popoverStyle"
        :aria-label="triggerAriaLabel"
        @keydown="onMenuKeydown"
      >
        <template v-for="(item, i) in items" :key="item.id">
          <li v-if="item.separator && i > 0" class="ui-menu-separator" role="separator" />
          <li
            class="ui-menu-item"
            role="menuitem"
            :data-index="i"
            :data-active="i === activeIndex ? '' : undefined"
            :data-danger="item.style === 'danger' ? '' : undefined"
            :aria-disabled="item.disabled || undefined"
            @mousemove="activeIndex = i"
            @click="pickIndex(i)"
          >
            {{ item.label }}
          </li>
        </template>
      </ul>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* Single-class specificity so consumer class overrides land cleanly. */
.ui-menu-trigger {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 8px 8px 8px 16px;
  border-radius: 8px;
  border: none;
  background: var(--pick-bg-active, color-mix(in srgb, var(--text) 10%, transparent));
  color: var(--neutral-100, var(--text));
  font-size: 12px;
  font-weight: 500;
  line-height: 16px;
  cursor: pointer;
  transition: background-color 120ms ease;
}
.ui-menu-trigger:hover,
.ui-menu-trigger:focus-visible {
  background: var(--pick-bg-hover, color-mix(in srgb, var(--text) 14%, transparent));
  outline: none;
}
.ui-menu-trigger[aria-expanded='true'] {
  background: var(--pick-bg-hover, color-mix(in srgb, var(--text) 14%, transparent));
}
</style>

<style>
/* Listbox is teleported to <body>, so it can't be scoped. */
.ui-menu-list {
  min-width: 200px;
  margin: 0;
  padding: 6px;
  list-style: none;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow:
    0 8px 24px rgba(0, 0, 0, 0.28),
    0 2px 6px rgba(0, 0, 0, 0.18);
  overflow-y: auto;
  outline: none;
}

.ui-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-radius: 6px;
  color: var(--text);
  font-size: 14px;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}

.ui-menu-item[data-active] {
  background: var(--border-hover);
}

.ui-menu-item[data-danger] {
  color: var(--danger);
}
.ui-menu-item[data-danger][data-active] {
  color: var(--danger-hover);
  background: color-mix(in srgb, var(--danger) 14%, transparent);
}

.ui-menu-item[aria-disabled='true'] {
  color: var(--text-muted);
  cursor: not-allowed;
}

.ui-menu-separator {
  list-style: none;
  height: 1px;
  margin: 4px 6px;
  background: var(--border);
  pointer-events: none;
}

.ui-menu-pop-enter-active,
.ui-menu-pop-leave-active {
  transition:
    opacity 150ms ease-out,
    transform 150ms ease-out;
}

.ui-menu-pop-enter-from,
.ui-menu-pop-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

@media (prefers-reduced-motion: reduce) {
  .ui-menu-pop-enter-active,
  .ui-menu-pop-leave-active {
    transition-duration: 0ms;
  }
}
</style>
