import { nextTick, onBeforeUnmount, ref, type Ref } from 'vue'

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

export function useTooltip(
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

  let rafId: number | null = null
  let listenersAttached = false

  function measure(): void {
    const trigger = triggerRef.value?.getBoundingClientRect()
    const bubble = bubbleRef.value?.getBoundingClientRect()
    if (!trigger || !bubble) return

    const vw = window.innerWidth
    const vh = window.innerHeight

    const placement = resolvePlacement(opts.side(), trigger, bubble, vw, vh, offset)
    resolvedSide.value = placement

    const { top, left } = computeBubbleOrigin(placement, align(), trigger, bubble, offset)
    const clampedLeft = clamp(left, edgePadding, vw - bubble.width - edgePadding)
    const clampedTop = clamp(top, edgePadding, vh - bubble.height - edgePadding)

    bubbleStyle.value = {
      top: `${clampedTop}px`,
      left: `${clampedLeft}px`,
    }

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

  function scheduleMeasure(): void {
    if (rafId !== null) return
    rafId = requestAnimationFrame(() => {
      rafId = null
      if (visible.value) measure()
    })
  }

  function attachReflowListeners(): void {
    if (listenersAttached) return
    listenersAttached = true
    // Capture-phase scroll catches scroll on any ancestor container, not
    // just the window — without this an open tooltip stays pinned to its
    // stale viewport coords when a parent scrolls.
    window.addEventListener('scroll', scheduleMeasure, { capture: true, passive: true })
    window.addEventListener('resize', scheduleMeasure)
  }

  function detachReflowListeners(): void {
    if (!listenersAttached) return
    listenersAttached = false
    window.removeEventListener('scroll', scheduleMeasure, { capture: true } as EventListenerOptions)
    window.removeEventListener('resize', scheduleMeasure)
  }

  function hide(): void {
    visible.value = false
    detachReflowListeners()
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
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
    measure()
    attachReflowListeners()
  }

  onBeforeUnmount(detachReflowListeners)

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
