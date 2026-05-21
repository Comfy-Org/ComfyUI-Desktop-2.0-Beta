import { onMounted, onUnmounted } from 'vue'
import { useInstallationStore } from '../stores/installationStore'
import type { Installation, ShowProgressOpts } from '../types/ipc'

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
  /** Instance-picker popover's "More" menu selected an install-level
   *  action (Open Folder / Copy / Untrack / Delete). Routed to the
   *  panel so it dispatches through the same `useInstallContextMenu`
   *  path the dashboard kebab uses — confirm dialogs + showProgress
   *  + DetailModal-mediated Delete all live there. */
  runInstallActionFromPicker?: (installation: Installation, actionId: string) => Promise<void> | void
  /** Instance-picker's expanded settings UI fired `show-progress`; the
   *  popup forwarded it here so the panel's existing ProgressModal
   *  pipeline can run the operation. */
  showProgressFromPicker?: (opts: ShowProgressOpts) => void
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
          // `comfy://install-update/<id>` opens the picker directly
          // in expanded mode on the Update tab — same surface the
          // chooser-card kebab Update entry routes to.
          window.api.openInstancePicker({
            installationId: inst.id,
            mode: 'expanded',
            initialTab: 'update',
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
          if (tab === 'global') {
            window.api.openGlobalSettings()
            return
          }
          // Per-install deep links (`comfy://open-settings?tab=comfy`)
          // open the picker in expanded mode on the Config tab. If we
          // don't have an install context (chooser host, no active
          // install), fall back to compact so the user picks an install
          // first.
          if (inst) {
            window.api.openInstancePicker({
              installationId: inst.id,
              mode: 'expanded',
              initialTab: 'config',
            })
          } else {
            window.api.openInstancePicker()
          }
          return
        }
        if (payload.kind === 'picker-pick-install') {
          await opts.bootstrapReady
          const id = payload.installationId
          if (!id) return
          const inst = installationStore.getById(id)
          if (!inst) return
          await opts.pickInstallFromPicker?.(inst)
          return
        }
        if (payload.kind === 'picker-install-action') {
          await opts.bootstrapReady
          const id = payload.installationId
          const actionId = payload.actionId
          if (!id || !actionId) return
          const inst = installationStore.getById(id)
          if (!inst) return
          await opts.runInstallActionFromPicker?.(inst, actionId)
          return
        }
        if (payload.kind === 'picker-show-progress') {
          await opts.bootstrapReady
          const id = payload.installationId
          const actionId = payload.actionId
          const title = payload.title
          if (!id || !actionId || !title) return
          const inst = installationStore.getById(id)
          if (!inst) return
          const isRestart = !!payload.isRestart
          const actionData = (payload.actionData ?? undefined) as
            | Record<string, unknown>
            | undefined
          const apiCall = isRestart
            ? async () => {
              await window.api.stopComfyUI(id)
              const deadline = Date.now() + 10_000
              while (Date.now() < deadline) {
                try {
                  const installs = await window.api.getInstallations()
                  const stillRunning = installs.find((i) => i.id === id)?.status === 'running'
                  if (!stillRunning) break
                } catch {
                  break
                }
                await new Promise((r) => setTimeout(r, 100))
              }
              return window.api.runAction(id, 'launch')
            }
            : () => window.api.runAction(id, actionId, actionData)
          opts.showProgressFromPicker?.({
            installationId: id,
            title,
            apiCall,
            cancellable: !!payload.cancellable,
            returnTo: 'detail',
            triggersInstanceStart: !!payload.triggersInstanceStart,
            opKind: payload.opKind,
            actionId,
            actionData,
          })
        }
      })()
    })
  })

  onUnmounted(() => {
    unsubPanelTriggerOverlay?.()
  })
}
