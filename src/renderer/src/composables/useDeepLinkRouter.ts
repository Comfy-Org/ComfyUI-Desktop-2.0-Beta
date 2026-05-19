import { onMounted, onUnmounted } from 'vue'
import { useInstallationStore } from '../stores/installationStore'
import type { Installation } from '../types/ipc'
import type { Overlay } from './useOverlay'

interface DeepLinkRouterOpts {
  /** URL-derived installation id — the host this panel is bound to.
   *  `install-update` payloads ignore mismatched ids so a deep link
   *  fires only on the targeted host. */
  installationId: string
  /** Resolves once `onMounted` finishes its async store/locale hydration.
   *  Listener handlers await this so the install-update branch sees a
   *  populated installationStore + translated copy on the very first
   *  click after the panelView's `did-finish-load`. */
  bootstrapReady: Promise<void>
  openOverlay: (next: Overlay | null) => Promise<boolean>
  showAppUpdateRestartPrompt: (version: string | null) => Promise<void>
  showAppUpdateDownloadPrompt: (version: string | null) => Promise<void>
  /** Instance-picker popover picked an install that's not already
   *  running. Routed to the panel so it can run the same
   *  `useListAction` launch flow the chooser uses — without the
   *  chooser-host attach-claim (which would swap install A out of
   *  this host). */
  pickInstallFromPicker?: (installation: Installation) => Promise<void> | void
}

/**
 * Routes `panel-trigger-overlay` IPCs from main into the right
 * renderer surface. Registered BEFORE the panel's async bootstrap
 * (locale + stores) so a deep-link IPC fired right after the
 * panelView's first `did-finish-load` is never dropped — payloads
 * that need the store park on `bootstrapReady` until hydration
 * completes.
 */
export function useDeepLinkRouter(opts: DeepLinkRouterOpts): void {
  const installationStore = useInstallationStore()
  let unsubPanelTriggerOverlay: (() => void) | null = null

  onMounted(() => {
    unsubPanelTriggerOverlay = window.api.onPanelTriggerOverlay((payload) => {
      void (async () => {
        if (payload.kind === 'app-update-restart-prompt') {
          await opts.bootstrapReady
          await opts.showAppUpdateRestartPrompt(payload.version ?? null)
          return
        }
        if (payload.kind === 'app-update-download-prompt') {
          await opts.bootstrapReady
          await opts.showAppUpdateDownloadPrompt(payload.version ?? null)
          return
        }
        if (payload.kind === 'install-update') {
          const id = payload.installationId
          if (!id || id !== opts.installationId) return
          await opts.bootstrapReady
          const inst = installationStore.getById(id)
          if (!inst) return
          await opts.openOverlay({
            kind: 'settings',
            installation: inst,
            initialTab: 'comfy',
            initialDetailTab: 'update',
          })
          return
        }
        if (payload.kind === 'open-settings') {
          await opts.bootstrapReady
          const inst = opts.installationId ? installationStore.getById(opts.installationId) : null
          const requested = payload.settingsTab
          // Default to the host's natural tab — same fall-through the
          // file-menu / title-bar Settings entries use via switchPanel.
          const tab = requested ?? (inst ? 'comfy' : 'global')
          await opts.openOverlay({
            kind: 'settings',
            installation: inst ?? null,
            initialTab: tab,
          })
          return
        }
        if (payload.kind === 'picker-pick-install') {
          await opts.bootstrapReady
          const id = payload.installationId
          if (!id) return
          const inst = installationStore.getById(id)
          if (!inst) return
          await opts.pickInstallFromPicker?.(inst)
        }
      })()
    })
  })

  onUnmounted(() => {
    unsubPanelTriggerOverlay?.()
  })
}
