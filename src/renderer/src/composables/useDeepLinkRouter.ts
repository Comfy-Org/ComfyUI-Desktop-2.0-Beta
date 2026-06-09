import { onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useInstallationStore } from '../stores/installationStore'
import { useSessionStore } from '../stores/sessionStore'
import { IN_PLACE_RELAUNCH, stopAndWaitForExit } from '../lib/stopWarning'
import { successTerminalGoDashboardOrOpen } from '../lib/progressTerminalPresets'
import { REQUIRES_STOPPED, type Installation, type ShowProgressOpts } from '../types/ipc'

import type { Overlay } from './useOverlay'

interface DeepLinkRouterOpts {
  /** Host id this panel is bound to. `install-update` payloads ignore
   *  mismatched ids so a deep link fires only on the targeted host. */
  installationId: string
  /** Resolves once `onMounted` finishes store/locale hydration. Handlers
   *  await this so the store + translations are populated before use. */
  bootstrapReady: Promise<void>
  openOverlay: (next: Overlay | null) => Promise<boolean>
  showAppUpdateRestartPrompt: (version: string | null) => Promise<void>
  showAppUpdateDownloadPrompt: (version: string | null) => Promise<void>
  /** Picker picked a non-running install; runs the chooser's launch flow
   *  without the attach-claim that would swap this host's install out.
   *  `startupRestore` marks the boot-time restore path (dashboard fallback on
   *  missing action + reveal handshake). */
  pickInstallFromPicker?: (
    installation: Installation,
    opts?: { startupRestore?: boolean },
  ) => Promise<void> | void
  /** Picker "More" menu selected an install-level action; dispatches
   *  through the same `useInstallContextMenu` path the dashboard kebab uses. */
  runInstallActionFromPicker?: (installation: Installation, actionId: string) => Promise<void> | void
  /** Picker's settings UI fired `show-progress`, forwarded here to the
   *  panel's ProgressModal pipeline. */
  showProgressFromPicker?: (opts: ShowProgressOpts) => void
}

/** Routes `panel-trigger-overlay` IPCs into the right renderer surface.
 *  Registered before the panel's async bootstrap; payloads that need the
 *  store park on `bootstrapReady` until hydration completes. */
export function useDeepLinkRouter(opts: DeepLinkRouterOpts): void {
  const installationStore = useInstallationStore()
  const sessionStore = useSessionStore()
  const { t } = useI18n()
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
          // Opens the picker on the Update tab and auto-fires
          // `update-comfyui` so the user lands directly on its confirm modal.
          window.api.openInstancePicker({
            installationId: inst.id,
            initialTab: 'update',
            autoAction: 'update-comfyui',
          })
          return
        }
        if (payload.kind === 'open-settings') {
          await opts.bootstrapReady
          const inst = opts.installationId ? installationStore.getById(opts.installationId) : null
          const requested = payload.settingsTab
          // Default to the host's natural tab.
          const tab = requested ?? (inst ? 'comfy' : 'global')
          if (tab === 'global') {
            window.api.openGlobalSettings()
            return
          }
          // Per-install deep links open the Config tab; with no install
          // context, open without a tab so the user picks one first.
          if (inst) {
            window.api.openInstancePicker({
              installationId: inst.id,
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
          if (!inst) {
            // Boot restore against a now-missing install: tell main to reveal
            // the dashboard rather than leaving the hidden window stuck.
            if (payload.startupRestore) {
              window.api.resolveStartupRestoreReveal('dashboard-fallback')
            }
            return
          }
          await opts.pickInstallFromPicker?.(inst, {
            startupRestore: payload.startupRestore === true,
          })
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
          // Rebuild the apiCall here because closures don't cross IPC:
          // self-stop for REQUIRES_STOPPED, append relaunch for IN_PLACE_RELAUNCH.
          const isRestart = !!payload.isRestart
          const actionData = (payload.actionData ?? undefined) as
            | Record<string, unknown>
            | undefined
          const wasRunning = sessionStore.isRunning(id)
          const requiresStoppedGuard = !isRestart
            && actionId !== 'migrate-to-standalone'
            && REQUIRES_STOPPED.has(actionId)
          const needsSelfStop = wasRunning && requiresStoppedGuard
          const wantsRelaunch = needsSelfStop && IN_PLACE_RELAUNCH.has(actionId)
          const isRunning = (): boolean => sessionStore.isRunning(id)
          const apiCall = isRestart
            ? async () => {
              await stopAndWaitForExit(id, isRunning)
              return window.api.runAction(id, 'launch')
            }
            : needsSelfStop
              ? async () => {
                await stopAndWaitForExit(id, isRunning)
                const result = await window.api.runAction(id, actionId, actionData)
                if (wantsRelaunch && result?.ok !== false) {
                  await window.api.runAction(id, 'launch')
                }
                return result
              }
              : () => window.api.runAction(id, actionId, actionData)
          // Built here because this side owns the i18n catalog the popup doesn't.
          const successTerminal = payload.successChoice
            ? successTerminalGoDashboardOrOpen({
              title: payload.opKind === 'update'
                ? t('progress.updatedSuccess', 'Updated successfully')
                : undefined,
              dashboardLabel: t('progress.successChoiceGoDashboard', 'Go to Dashboard'),
              openLabel: t('progress.successChoiceOpen', 'Open Instance'),
            })
            : undefined
          opts.showProgressFromPicker?.({
            installationId: id,
            title,
            apiCall,
            cancellable: !!payload.cancellable,
            returnTo: 'detail',
            triggersInstanceStart: !!payload.triggersInstanceStart || wantsRelaunch,
            opKind: payload.opKind,
            actionId,
            actionData,
            successTerminal,
          })
        }
      })()
    })
  })

  onUnmounted(() => {
    unsubPanelTriggerOverlay?.()
  })
}
