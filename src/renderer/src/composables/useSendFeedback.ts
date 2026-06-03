import { onMounted, onUnmounted, ref, type Ref } from 'vue'
import { emitTelemetryAction } from '../lib/telemetry'
import { buildSupportUrl } from '../lib/supportUrl'

interface UseSendFeedbackApi {
  /** True while the in-app feedback modal is mounted. */
  feedbackOpen: Ref<boolean>
  /** Typeform URL with `ver` + `platform` query params resolved at open time. */
  feedbackUrl: Ref<string>
  /** Imperative dismiss for the modal's `@close` handler. */
  closeFeedback: () => void
}

/**
 * Title-bar Send Feedback button + file-menu "Send Feedback" entry
 * both forward through main to `onOpenFeedback`. Fires the
 * `desktop2.feedback.opened` telemetry action with the originating
 * affordance and opens the in-app feedback modal (iframe-embedded
 * typeform — see `components/FeedbackModal.vue`) so the user never
 * leaves the desktop window.
 *
 * Caches the app version at mount so the support URL's `ver` query
 * param identifies the build without forcing the click handler to
 * await an IPC. Empty string while in flight or on failure —
 * `buildSupportUrl` treats falsy as "omit the param".
 */
export function useSendFeedback(): UseSendFeedbackApi {
  const appVersion = ref('')
  const feedbackOpen = ref(false)
  const feedbackUrl = ref('')
  let unsubOpenFeedback: (() => void) | null = null

  function handleOpenFeedback(source: 'titlebar' | 'menu'): void {
    emitTelemetryAction('desktop2.feedback.opened', { source })
    feedbackUrl.value = buildSupportUrl(appVersion.value || undefined)
    feedbackOpen.value = true
  }

  function closeFeedback(): void {
    feedbackOpen.value = false
    // Main flipped activePanel to 'feedback' (overlay over comfyView)
    // when the click arrived. Restoring the panel here is symmetrical
    // — without it the empty panel would stay layered on top of comfy
    // after the user dismisses the modal.
    void window.api.closeCurrentPanel()
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

  return { feedbackOpen, feedbackUrl, closeFeedback }
}
