import { ref } from 'vue'
import type { ResolvedTheme } from '../../../types/ipc'

/**
 * Dark-only launcher theme. The Theme / ResolvedTheme types remain for
 * IPC compatibility (the title-bar bridge still pushes a per-page bg /
 * text colour for the install's own ComfyUI theme), but the launcher
 * UI itself is dark-only — no system / light variants.
 *
 * This composable just stamps `data-theme="dark"` on the documentElement
 * once on mount. There's no listener to drop and no IPC roundtrip needed.
 */
export function useTheme() {
  const theme = ref<ResolvedTheme>('dark')
  document.documentElement.setAttribute('data-theme', 'dark')
  return { theme }
}
