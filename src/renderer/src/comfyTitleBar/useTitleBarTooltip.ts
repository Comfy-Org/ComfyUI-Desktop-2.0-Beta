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
  /** Title-bar control attribute bag.  Cocoa's native HTML `title`
   *  tooltip occasionally fires for sibling-view buttons even though
   *  it's documented as unreliable; when it does, the user gets two
   *  bubbles at once (the native one plus our custom popup). Keep
   *  them mutually exclusive at the source by emitting `title` only
   *  off-mac and `data-title-tooltip` only on mac. `aria-label` is
   *  unconditional so screen readers see the same string regardless
   *  of platform — pass `ariaLabel` separately when the visible label
   *  and the tooltip copy intentionally differ. */
  tooltipAttrs: (text: string, ariaLabel?: string) => Record<string, string>
  /** Pointermove handler — drives the macOS tooltip dispatcher. */
  handleTooltipPointer: (event: PointerEvent) => void
  /** Hide any in-flight tooltip and cancel a pending show timer. */
  hideTip: () => void
}

/**
 * Issue #514 — macOS hover-tooltip plumbing.
 *
 * On macOS the native HTML `title` tooltip does not reliably fire for
 * controls inside a sibling chrome `WebContentsView` that isn't the
 * focused web contents (Electron + Cocoa quirk). The title bar always
 * sits in such a view, so on macOS we route hover through main, which
 * positions a cached `WebContentsView` popup attached to the host
 * window — that popup escapes the title-bar view's 37px clip. On
 * Windows / Linux the native `title` attribute renders Chromium's own
 * tooltip widget reliably; the JS handlers here are no-ops in that
 * case so we don't end up with two tooltips.
 *
 * Implementation is delegated: a single `pointermove` / `pointerleave`
 * pair on the header root finds the closest `[data-title-tooltip]`
 * ancestor and fires `showTip` / `hideTip`. New tooltipped elements
 * just need the data attribute — no per-element wiring.
 */
export function useTitleBarTooltip(opts: UseTitleBarTooltipOpts): TitleBarTooltipApi {
  /** Initial show delay (ms). Matches the cadence of native HTML
   *  tooltips on macOS / Win so a quick fly-by across the title bar
   *  doesn't flash bubbles. */
  const TOOLTIP_SHOW_DELAY_MS = 400
  /** Hover-handoff window (ms). If a tooltip was visible up to this
   *  long ago, the next hover over a different tooltipped element shows
   *  immediately — same convention as native macOS / browser tooltips,
   *  where the first hover earns the wait but subsequent ones in a
   *  scanning gesture feel snappy. */
  const TOOLTIP_HANDOFF_WINDOW_MS = 1500

  let tooltipShowTimer: number | null = null
  /** Text of the tooltip the renderer most recently asked main to show
   *  (or queue). `null` while nothing is pending or visible. */
  let activeTooltipText: string | null = null
  /** True between `bridge.showTooltip()` and the corresponding
   *  `bridge.hideTooltip()` — i.e., a tooltip is currently visible. The
   *  pending-but-not-yet-shown state has this `false`. */
  let isTooltipVisible = false
  /** `performance.now()` timestamp of the most recent
   *  `bridge.hideTooltip()`. Drives the hover-handoff fast path. */
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
      // Same trigger as before — no work needed. (Either we're still
      // waiting on the show timer, or the tooltip is already visible;
      // either way we don't reset state mid-hover.)
      return
    }
    // Different (or first) tooltipped target. Hide any in-flight tooltip
    // and queue the new one. If we were just showing a tooltip moments
    // ago (hover-handoff), skip the show delay so scanning across the
    // title bar feels instant — matches native macOS behaviour.
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
