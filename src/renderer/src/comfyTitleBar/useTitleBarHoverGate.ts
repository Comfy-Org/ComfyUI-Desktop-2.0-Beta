import { onMounted, onUnmounted, ref, type Ref } from 'vue'

interface UseTitleBarHoverGateOpts {
  /** Hide any in-flight tooltip — input has left the title-bar
   *  webContents (window blur, pointerleave) so the tooltip would be
   *  stale. */
  hideTip: () => void
  /** Drive the macOS tooltip dispatcher off the same pointermove that
   *  re-enables the hover gate. */
  handleTooltipPointer: (event: PointerEvent) => void
}

interface TitleBarHoverGateApi {
  isHoverActive: Ref<boolean>
}

/**
 * `:hover` gating for the title-bar.
 *
 * The title bar lives in its own WebContentsView, which doesn't
 * receive a `mouseleave` when a native OS menu (Menu.popup, install
 * pill dropdown, etc.) opens over it, and the renderer's last-known
 * cursor position stays "frozen" while the OS menu has the input.
 * Plain `window.blur`/`focus` is not enough on its own — the user can
 * dismiss the menu by clicking back inside the title bar, which
 * immediately refocuses the renderer with a stale cursor position
 * still pointing at the button that opened the menu, leaving
 * `:hover` stuck.
 *
 * The fix is two-step:
 *   1. On `window.blur`, drop the hover gate (`isHoverActive = false`).
 *   2. Re-enable the gate ONLY after a fresh `pointermove` arrives —
 *      i.e. once we know the cursor's position is current. Pure
 *      `window.focus` does NOT re-enable hover, because focus can
 *      return without the cursor having moved (clicking back into
 *      the title bar to dismiss the menu does exactly that).
 *
 * Hover styles are keyed on `.title-bar.is-hover-active` in scoped
 * CSS, so flipping this single flag covers menu, nav, and pill
 * buttons uniformly.
 */
export function useTitleBarHoverGate(opts: UseTitleBarHoverGateOpts): TitleBarHoverGateApi {
  const isHoverActive = ref(true)

  /** Drop the hover gate immediately when input leaves the title-bar
   *  webContents — covers the case where a native menu (Menu.popup) or
   *  another view receives focus. Also dismisses any in-flight tooltip
   *  for the same reason. */
  const handleWindowBlur = (): void => {
    isHoverActive.value = false
    opts.hideTip()
  }

  /** Re-enable the hover gate only on a fresh `pointermove`. We do NOT
   *  re-enable on `window.focus` alone, because focus can return without
   *  any cursor movement (clicking back into the title bar to dismiss
   *  the menu refocuses the renderer with a stale cursor position).
   *  Also drives the macOS tooltip dispatcher (issue #514). */
  const handlePointerMove = (event: PointerEvent): void => {
    if (!isHoverActive.value) isHoverActive.value = true
    opts.handleTooltipPointer(event)
  }

  /** Belt-and-braces: if the cursor leaves the title-bar's bounds, drop
   *  the gate. The renderer should normally see a `mouseleave` here, but
   *  on some platforms / WebContentsView setups the leave doesn't fire
   *  reliably, so we mirror the blur path. */
  const handlePointerLeave = (): void => {
    isHoverActive.value = false
    opts.hideTip()
  }

  onMounted(() => {
    window.addEventListener('blur', handleWindowBlur)
    window.addEventListener('pointermove', handlePointerMove)
    document.documentElement.addEventListener('pointerleave', handlePointerLeave)
    // Assume hover is inert until the user actually moves the mouse over
    // the title bar — matches the post-blur behaviour.
    isHoverActive.value = false
  })

  onUnmounted(() => {
    window.removeEventListener('blur', handleWindowBlur)
    window.removeEventListener('pointermove', handlePointerMove)
    document.documentElement.removeEventListener('pointerleave', handlePointerLeave)
  })

  return { isHoverActive }
}
