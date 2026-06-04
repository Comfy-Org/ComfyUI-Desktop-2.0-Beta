import { onMounted, onUnmounted, ref, type Ref } from 'vue'

interface UseTitleBarHoverGateOpts {
  hideTip: () => void
  handleTooltipPointer: (event: PointerEvent) => void
}

interface TitleBarHoverGateApi {
  isHoverActive: Ref<boolean>
}

/**
 * `:hover` gating for the title-bar. The title-bar view doesn't get a `mouseleave`
 * when a native OS menu opens over it, and the cursor position freezes while the menu
 * holds input; clicking back in to dismiss refocuses with a stale cursor, leaving
 * `:hover` stuck. So: drop the gate on `window.blur`, re-enable ONLY on a fresh
 * `pointermove` (not `window.focus`, which can return without cursor movement).
 */
export function useTitleBarHoverGate(opts: UseTitleBarHoverGateOpts): TitleBarHoverGateApi {
  const isHoverActive = ref(true)

  const handleWindowBlur = (): void => {
    isHoverActive.value = false
    opts.hideTip()
  }

  // Re-enable only on a fresh pointermove (focus can return without cursor movement).
  const handlePointerMove = (event: PointerEvent): void => {
    if (!isHoverActive.value) isHoverActive.value = true
    opts.handleTooltipPointer(event)
  }

  // Belt-and-braces: mirror the blur path on pointerleave, which not all platforms fire reliably.
  const handlePointerLeave = (): void => {
    isHoverActive.value = false
    opts.hideTip()
  }

  onMounted(() => {
    window.addEventListener('blur', handleWindowBlur)
    window.addEventListener('pointermove', handlePointerMove)
    document.documentElement.addEventListener('pointerleave', handlePointerLeave)
    // Hover starts inert until the user moves over the bar.
    isHoverActive.value = false
  })

  onUnmounted(() => {
    window.removeEventListener('blur', handleWindowBlur)
    window.removeEventListener('pointermove', handlePointerMove)
    document.documentElement.removeEventListener('pointerleave', handlePointerLeave)
  })

  return { isHoverActive }
}
