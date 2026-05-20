<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue'

/**
 * Actions-menu primitive. Renders a trigger button (default slot:
 * trigger label) and a popover list of clickable items that fire
 * `select` and close on pick. Unlike `BaseSelect` this carries no
 * `modelValue` — each item is an action, not a selection.
 *
 * Auto-flips placement: opens downward when there's room beneath the
 * trigger, upward when there isn't. Matches the affordance the
 * instance-picker's footer "More" button needs (picker is anchored
 * near the bottom of the screen so a downward drop would clip).
 *
 * Popover is teleported to <body> so any `overflow:hidden` on an
 * ancestor (popup webContents body, drawer chrome) can't clip it.
 *
 * The design language matches `BaseSelect` and the rest of the shadcn-
 * style ui primitives — same surface/border tokens, same chevron
 * rotation on open, same enter/leave transition timing.
 */

export interface BaseMenuItem {
  id: string
  label: string
  disabled?: boolean
  /** Optional style hint. `danger` renders the row in `--danger` color
   *  so destructive items (Delete, Untrack) read correctly without a
   *  per-call CSS override. */
  style?: 'default' | 'danger'
  /** When true, a thin divider is drawn above this item — useful for
   *  grouping destructive items below the rest. */
  separator?: boolean
}

interface Props {
  items: BaseMenuItem[]
  /** Accessible label for the trigger button. */
  triggerAriaLabel?: string
  /** Minimum width applied to the popover so labels don't reflow as
   *  the menu opens. Defaults to the trigger's measured width. */
  minWidth?: number
  /** Horizontal alignment of the menu relative to the trigger —
   *  mirrors Radix / shadcn `DropdownMenu`'s `align` prop.
   *  - `'start'` (default): menu's left edge aligns with the trigger's
   *    left edge (open down-and-right).
   *  - `'end'`: menu's right edge aligns with the trigger's right edge
   *    (open down-and-left). Use this for trailing-side triggers like a
   *    footer "More" pill — the menu tucks back into the viewport
   *    instead of trying to escape past the right edge. */
  align?: 'start' | 'end'
  /** Pixel gap between the trigger and the menu. */
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

/**
 * Position the menu with shadcn / Radix semantics:
 *
 *   1. Pick a side (top vs bottom) based on which has more space.
 *   2. Pick an x anchor based on `align` (start = trigger left,
 *      end = trigger right).
 *   3. Clamp the menu's bounding box into the viewport so it can't
 *      escape on any edge — Radix calls this "collision avoidance."
 *
 * Called once before paint with an estimated menu rect, then again
 * after the first frame with the menu's measured rect. The second
 * call is what makes long labels stop clipping at the right edge —
 * we only know the menu's real width once the DOM has it.
 */
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

  // Vertical side decision.
  const spaceBelow = vh - rect.bottom - props.offset
  const spaceAbove = rect.top - props.offset
  const openUp =
    menuHeight + VIEWPORT_PAD_PX > spaceBelow && spaceAbove > spaceBelow
  const top = openUp ? rect.top - props.offset - menuHeight : rect.bottom + props.offset

  // Horizontal anchor — start aligns with trigger's left, end with
  // trigger's right. Once anchored we clamp into the viewport so the
  // menu can never sit outside [VIEWPORT_PAD_PX, vw - VIEWPORT_PAD_PX].
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
  // First pass: place with the estimated rect so the first paint
  // doesn't flash at (0, 0). Second pass (post-mount): re-measure
  // and clamp against the real menu rect so long labels can't push
  // the right edge past the viewport.
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
/* Default trigger chrome — matches the dark pill affordance used by
 * other menu/secondary buttons across the app (--pick-bg-active fill,
 * 8px radius, 12px label, 32px row, brightness on hover). Consumers
 * can still re-skin via class fallthrough — keep selectors at single-
 * class specificity so overrides land cleanly. */
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
  /* Comfortable resting width — long labels like "Copy Installation"
   * shouldn't sit flush against the menu border. The positioning
   * logic clamps this against the viewport, so widening here is
   * safe; narrow viewports just trim via `maxWidth` set inline. */
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
