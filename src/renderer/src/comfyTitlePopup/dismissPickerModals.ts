import { useDialogs } from '../composables/useDialogs'
import { useModal } from '../composables/useModal'

/**
 * Dismiss any open useModal / useDialogs entry in the picker's WebContentsView,
 * settling each pending Promise with its falsy value. Driven by the
 * `comfy-titlepopup:dismiss-modals` IPC when another dropdown preempts the
 * picker; without it the resolver stays pending and the modal can resurface.
 */
export function dismissPickerModals(): void {
  const modal = useModal()
  modal.dismiss()
  const dialogs = useDialogs()
  if (dialogs.state.open) dialogs.cancel()
}
