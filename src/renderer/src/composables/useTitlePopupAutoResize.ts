import { onMounted, onUnmounted, type Ref } from 'vue'

/**
 * Wire a `ResizeObserver` on a renderer-side popup view that asks main
 * to size the WebContentsView to the natural content height whenever
 * the observed element changes size.
 *
 * Used by `GlobalSettingsView` and `InstancePickerView` — both have
 * `BaseAccordion`s whose expand / collapse should grow and shrink the
 * outer popup bounds, but neither view's root can be measured directly
 * because it is height-clamped to the WebContentsView's current
 * bounds. Each view supplies:
 *
 *  - `observed`: an inner wrapper that sits OUTSIDE any
 *    `max-height: 100%` / `overflow-y: auto` clamp so its
 *    `offsetHeight` reports the unclamped natural content height in
 *    both directions.
 *  - `compute`: returns the popup view height the renderer wants in
 *    CSS px, given the current DOM state. Called every observation
 *    tick. Main clamps the request to the popup kind's ceiling band
 *    so unbounded growth is impossible.
 *
 * The bridge's `requestSize` IPC is the same channel `DownloadsView`
 * uses — this composable just centralises the ResizeObserver wiring
 * the two accordion-driven popups would otherwise duplicate.
 */
/**
 * Options for fine-grained control over when the observer fires.
 *
 *  - `enabled`: predicate the observer calls on every tick. Returning
 *    `false` makes the tick a no-op — useful when the caller knows the
 *    natural-height signal is meaningless for the current mode (e.g.
 *    the picker's expanded mode is sized main-side, so renderer
 *    measurement is pure cost).
 *  - The composable also dedupes consecutive identical heights (within
 *    a ±2px slop) so font-loading jitter and integer-rounding wobble
 *    don't flood the IPC channel with no-op `setBounds` calls.
 */
interface UseTitlePopupAutoResizeOptions {
  enabled?: () => boolean
}

export function useTitlePopupAutoResize(
  observed: Ref<HTMLElement | null>,
  compute: () => number,
  requestSize: ((height: number) => void) | undefined,
  options?: UseTitlePopupAutoResizeOptions,
): void {
  let resizeObserver: ResizeObserver | null = null
  let lastSent: number | null = null

  onMounted(() => {
    const el = observed.value
    if (!el || typeof ResizeObserver === 'undefined') return
    resizeObserver = new ResizeObserver(() => {
      if (!requestSize) return
      if (options?.enabled && !options.enabled()) return
      const next = compute()
      if (!Number.isFinite(next)) return
      if (lastSent !== null && Math.abs(next - lastSent) < 2) return
      lastSent = next
      requestSize(next)
    })
    resizeObserver.observe(el)
  })

  onUnmounted(() => {
    resizeObserver?.disconnect()
    resizeObserver = null
  })
}
