import type { Ref } from 'vue'

interface ShowTooltipPayload {
  text: string
  leftX: number
  rightX: number
  bottomY: number
}

interface TitleBarTooltipBridge {
  showTooltip: (payload: ShowTooltipPayload) => void
  hideTooltip: () => void
}

interface UseTitleBarTooltipOpts {
  bridge: TitleBarTooltipBridge | undefined
  isMac: Ref<boolean>
}

interface TitleBarTooltipApi {
  /** Control attribute bag. Emits `title` off-mac and `data-title-tooltip` on
   *  mac so the native and custom tooltips stay mutually exclusive (Cocoa
   *  occasionally fires `title` for sibling-view buttons). `aria-label` is
   *  unconditional. */
  tooltipAttrs: (text: string, ariaLabel?: string) => Record<string, string>
  handleTooltipPointer: (event: PointerEvent) => void
  hideTip: () => void
}

/**
 * macOS hover-tooltip plumbing. The native `title` tooltip doesn't reliably
 * fire for controls in an unfocused sibling chrome WebContentsView, so on macOS
 * we route hover through main, which positions a popup that escapes the title
 * bar's clip. Win/Linux use the native `title`; the JS handlers no-op there.
 * Delegated: a single pointer pair finds the closest `[data-title-tooltip]`
 * ancestor, so new tooltipped elements just need the data attribute.
 */
export function useTitleBarTooltip(opts: UseTitleBarTooltipOpts): TitleBarTooltipApi {
  const TOOLTIP_SHOW_DELAY_MS = 400
  /** If a tooltip was visible this recently, the next hover shows immediately so
   *  scanning across the bar feels snappy (matches native behaviour). */
  const TOOLTIP_HANDOFF_WINDOW_MS = 1500

  let tooltipShowTimer: number | null = null
  /** Text the renderer most recently asked main to show/queue; `null` when idle. */
  let activeTooltipText: string | null = null
  /** True while a tooltip is visible (false in the pending-but-not-shown state). */
  let isTooltipVisible = false
  /** `performance.now()` of the most recent hide; drives the handoff fast path. */
  let lastHiddenAt = -Infinity

  function tooltipAttrs(text: string, ariaLabel?: string): Record<string, string> {
    const base: Record<string, string> = { 'aria-label': ariaLabel ?? text }
    if (opts.isMac.value) {
      base['data-title-tooltip'] = text
    } else {
      base.title = text
    }
    return base
  }

  function findTooltipTarget(target: EventTarget | null): {
    text: string
    rect: DOMRect
  } | null {
    if (!(target instanceof Element)) return null
    const el = target.closest('[data-title-tooltip]') as HTMLElement | SVGElement | null
    if (!el) return null
    const text = el.getAttribute('data-title-tooltip')
    if (!text) return null
    return { text, rect: el.getBoundingClientRect() }
  }

  function cancelPendingTooltipShow(): void {
    if (tooltipShowTimer !== null) {
      window.clearTimeout(tooltipShowTimer)
      tooltipShowTimer = null
    }
  }

  function hideTip(): void {
    cancelPendingTooltipShow()
    if (activeTooltipText === null) return
    activeTooltipText = null
    if (isTooltipVisible) {
      isTooltipVisible = false
      lastHiddenAt = performance.now()
    }
    opts.bridge?.hideTooltip()
  }

  function fireShowTooltip(text: string, rect: DOMRect): void {
    opts.bridge?.showTooltip({
      text,
      leftX: Math.round(rect.left),
      rightX: Math.round(rect.right),
      bottomY: Math.round(rect.bottom),
    })
    isTooltipVisible = true
  }

  function handleTooltipPointer(event: PointerEvent): void {
    if (!opts.isMac.value) return
    const found = findTooltipTarget(event.target)
    if (!found) {
      hideTip()
      return
    }
    if (found.text === activeTooltipText) {
      // Same trigger — don't reset state mid-hover.
      return
    }
    // New target: hide any in-flight tooltip and queue the new one, skipping the
    // show delay on a hover-handoff.
    const handoff =
      isTooltipVisible || performance.now() - lastHiddenAt < TOOLTIP_HANDOFF_WINDOW_MS
    hideTip()
    const captured = found
    activeTooltipText = captured.text
    if (handoff) {
      fireShowTooltip(captured.text, captured.rect)
      return
    }
    tooltipShowTimer = window.setTimeout(() => {
      tooltipShowTimer = null
      if (activeTooltipText !== captured.text) return
      fireShowTooltip(captured.text, captured.rect)
    }, TOOLTIP_SHOW_DELAY_MS)
  }

  return { tooltipAttrs, handleTooltipPointer, hideTip }
}
