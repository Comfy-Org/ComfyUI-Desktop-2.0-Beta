import { onMounted, onUnmounted } from 'vue'
import { useNavigation, type NavigationControllerMap } from './useNavigation'

/**
 * Register a controller with the navigation system on mount and unregister on unmount.
 * Replaces the repeated onMounted/onUnmounted boilerplate in modal views.
 */
export function useControllerRegistration<K extends keyof NavigationControllerMap>(
  key: K,
  controller: NavigationControllerMap[K],
): void {
  const nav = useNavigation()
  onMounted(() => nav.registerController(key, controller))
  onUnmounted(() => nav.registerController(key, null))
}
