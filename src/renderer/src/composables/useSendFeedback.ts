import { onMounted, onUnmounted, ref } from 'vue'
import { emitTelemetryAction } from '../lib/telemetry'
import { buildSupportUrl } from '../lib/supportUrl'

/**
 * Title-bar Send Feedback button + file-menu "Send Feedback" entry both
 * forward through main to `onOpenFeedback`. Fires the
 * `desktop2.feedback.opened` telemetry action with the originating
 * affordance and opens the typeform support URL via `openExternal`.
 *
 * Caches the app version at mount so the support URL's `ver` query
 * param identifies the build without forcing the click handler to
 * await an IPC. Empty string while in flight or on failure —
 * `buildSupportUrl` treats falsy as "omit the param".
 */
export function useSendFeedback(): void {
  const appVersion = ref('')
  let unsubOpenFeedback: (() => void) | null = null

  function handleOpenFeedback(source: 'titlebar' | 'menu'): void {
    emitTelemetryAction('desktop2.feedback.opened', { source })
    void window.api.openExternal(buildSupportUrl(appVersion.value || undefined))
  }

  onMounted(() => {
    unsubOpenFeedback = window.api.onOpenFeedback(({ source }) => {
      handleOpenFeedback(source)
    })

    void window.api
      .getAppVersion()
      .then((v) => {
        appVersion.value = v
      })
      .catch(() => {})
  })

  onUnmounted(() => {
    unsubOpenFeedback?.()
  })
}
