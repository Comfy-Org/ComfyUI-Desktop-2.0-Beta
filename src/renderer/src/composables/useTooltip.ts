import { nextTick, ref, type Ref } from 'vue'

/**
 * Position-aware tooltip placement primitive (shadcn-style).
 *
 * Owns the math for placing a teleported bubble next to a trigger:
 *   - measures both `getBoundingClientRect`s
 *   - flips the requested side when the bubble would overflow the viewport
 *     and the opposite side has more room
 *   - clamps the bubble's `left` / `top` into an edge-padded band so the
 *     panel never sits flush against the screen edge
 *   - reports the resolved side + arrow offset so the bubble can paint
 *     its triangle pointing back at the trigger even after horizontal
 *     clamping shifts the bubble away from centered alignment
 *
 * `show()` waits one tick after flipping `visible` so the bubble exists
 * in the DOM before we measure it. The bubble must therefore render
 * non-interactively until positioned — the consumer uses `visible` to
 * gate `pointer-events` / opacity, not to v-if the node out.
 */

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right'
export type TooltipAlign = 'start' | 'center' | 'end'

export interface UseTooltipOpts {
  side: () => TooltipSide
  align?: () => TooltipAlign
  canShow?: () => boolean
  /** Viewport margin the bubble's bounds must stay inside. Default 8px. */
  edgePadding?: number
  /** Gap between trigger edge and bubble edge along the placement axis. Default 8px. */
  offset?: number
}

export interface TooltipPlacement {
  visible: Ref<boolean>
  show: () => void
  hide: () => void
  bubbleStyle: Ref<Record<string, string>>
  resolvedSide: Ref<TooltipSide>
  arrowStyle: Ref<Record<string, string>>
}

/**
 * Legacy single-ref signature used by `TooltipWrap.vue` / `InfoTooltip.vue`
 * before the primitive migration. Keeps these callers working with the
 * old "no bubble ref, centered transform" math; the new `useTooltip`
 * overload takes a bubble ref and does collision detection. We pick the
 * overload based on whether the second argument is a Ref (bubble) or a
 * function (side).
 */
export function useTooltip(
  triggerRef: Ref<HTMLElement | null>,
  bubbleRef: Ref<HTMLElement | null>,
  opts: UseTooltipOpts,
): TooltipPlacement
export function useTooltip(
  triggerRef: Ref<HTMLElement | null>,
  side: () => 'top' | 'bottom',
  canShow?: () => boolean,
): {
  visible: Ref<boolean>
  show: () => void
  hide: () => void
  bubbleStyle: Ref<Record<string, string>>
}
export function useTooltip(
  triggerRef: Ref<HTMLElement | null>,
  secondArg: Ref<HTMLElement | null> | (() => 'top' | 'bottom'),
  thirdArg?: UseTooltipOpts | (() => boolean),
): TooltipPlacement | {
  visible: Ref<boolean>
  show: () => void
  hide: () => void
  bubbleStyle: Ref<Record<string, string>>
} {
  if (typeof secondArg === 'function') {
    return useLegacyTooltip(
      triggerRef,
      secondArg,
      thirdArg as (() => boolean) | undefined,
    )
  }
  return usePlacementTooltip(triggerRef, secondArg, thirdArg as UseTooltipOpts)
}

function useLegacyTooltip(
  triggerRef: Ref<HTMLElement | null>,
  side: () => 'top' | 'bottom',
  canShow?: () => boolean,
) {
  const bubbleStyle = ref<Record<string, string>>({})
  const visible = ref(false)

  function show(): void {
    if (!triggerRef.value) return
    if (canShow && !canShow()) return
    const rect = triggerRef.value.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    if (side() === 'bottom') {
      bubbleStyle.value = {
        top: `${rect.bottom + 6}px`,
        left: `${x}px`,
      }
    } else {
      bubbleStyle.value = {
        bottom: `${window.innerHeight - rect.top + 6}px`,
        left: `${x}px`,
      }
    }
    visible.value = true
  }

  function hide(): void {
    visible.value = false
  }

  return { bubbleStyle, visible, show, hide }
}

function usePlacementTooltip(
  triggerRef: Ref<HTMLElement | null>,
  bubbleRef: Ref<HTMLElement | null>,
  opts: UseTooltipOpts,
): TooltipPlacement {
  const visible = ref(false)
  const bubbleStyle = ref<Record<string, string>>({})
  const arrowStyle = ref<Record<string, string>>({})
  const resolvedSide = ref<TooltipSide>(opts.side())

  const edgePadding = opts.edgePadding ?? 8
  const offset = opts.offset ?? 8
  const align = opts.align ?? (() => 'center' as TooltipAlign)

  function hide(): void {
    visible.value = false
  }

  async function show(): Promise<void> {
    if (!triggerRef.value) return
    if (opts.canShow && !opts.canShow()) return

    // Mount the bubble off-screen first so we can measure its intrinsic
    // size before placing it. Without this the first hover paints in the
    // wrong spot for one frame.
    visible.value = true
    bubbleStyle.value = {
      top: '-9999px',
      left: '-9999px',
      visibility: 'hidden',
    }
    await nextTick()

    const trigger = triggerRef.value?.getBoundingClientRect()
    const bubble = bubbleRef.value?.getBoundingClientRect()
    if (!trigger || !bubble) return

    const vw = window.innerWidth
    const vh = window.innerHeight

    const requested = opts.side()
    const placement = resolvePlacement(requested, trigger, bubble, vw, vh, offset)
    resolvedSide.value = placement

    const { top, left } = computeBubbleOrigin(
      placement,
      align(),
      trigger,
      bubble,
      offset,
    )
    const clampedLeft = clamp(left, edgePadding, vw - bubble.width - edgePadding)
    const clampedTop = clamp(top, edgePadding, vh - bubble.height - edgePadding)

    bubbleStyle.value = {
      top: `${clampedTop}px`,
      left: `${clampedLeft}px`,
    }

    // Arrow offset is the trigger's center expressed relative to the
    // clamped bubble origin — so even when clamping shifts the bubble
    // away from a centered alignment, the arrow still points at the
    // trigger.
    const triggerCenterX = trigger.left + trigger.width / 2
    const triggerCenterY = trigger.top + trigger.height / 2
    if (placement === 'top' || placement === 'bottom') {
      const local = clamp(triggerCenterX - clampedLeft, 12, bubble.width - 12)
      arrowStyle.value = { left: `${local}px` }
    } else {
      const local = clamp(triggerCenterY - clampedTop, 12, bubble.height - 12)
      arrowStyle.value = { top: `${local}px` }
    }
  }

  return { visible, show: () => void show(), hide, bubbleStyle, resolvedSide, arrowStyle }
}

function resolvePlacement(
  requested: TooltipSide,
  trigger: DOMRect,
  bubble: DOMRect,
  vw: number,
  vh: number,
  offset: number,
): TooltipSide {
  const room: Record<TooltipSide, number> = {
    top: trigger.top - offset,
    bottom: vh - trigger.bottom - offset,
    left: trigger.left - offset,
    right: vw - trigger.right - offset,
  }
  const need = (s: TooltipSide) =>
    s === 'top' || s === 'bottom' ? bubble.height : bubble.width

  if (room[requested] >= need(requested)) return requested

  const opposite: Record<TooltipSide, TooltipSide> = {
    top: 'bottom',
    bottom: 'top',
    left: 'right',
    right: 'left',
  }
  const flip = opposite[requested]
  if (room[flip] >= need(flip)) return flip
  return room[flip] > room[requested] ? flip : requested
}

function computeBubbleOrigin(
  side: TooltipSide,
  align: TooltipAlign,
  trigger: DOMRect,
  bubble: DOMRect,
  offset: number,
): { top: number; left: number } {
  if (side === 'top' || side === 'bottom') {
    const top = side === 'top' ? trigger.top - bubble.height - offset : trigger.bottom + offset
    const left = alignedAxisOrigin(align, trigger.left, trigger.width, bubble.width)
    return { top, left }
  }
  const left = side === 'left' ? trigger.left - bubble.width - offset : trigger.right + offset
  const top = alignedAxisOrigin(align, trigger.top, trigger.height, bubble.height)
  return { top, left }
}

function alignedAxisOrigin(
  align: TooltipAlign,
  triggerStart: number,
  triggerSize: number,
  bubbleSize: number,
): number {
  if (align === 'start') return triggerStart
  if (align === 'end') return triggerStart + triggerSize - bubbleSize
  return triggerStart + triggerSize / 2 - bubbleSize / 2
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}
