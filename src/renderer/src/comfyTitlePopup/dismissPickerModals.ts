import { useDialogs } from '../composables/useDialogs'
import { useModal } from '../composables/useModal'

/**
 * Dismiss any open `useModal` / `useDialogs` entry mounted inside the
 * picker's WebContentsView. Mirrors a backdrop / ESC click — each
 * awaited Promise settles with the kind-appropriate falsy value
 * (`null` for prompt/select, `false` for confirm, `undefined` for
 * alert) so callers never see a stale resolution.
 *
 * Driven by the `comfy-titlepopup:dismiss-modals` IPC main fires when
 * another title-bar dropdown (downloads / waffle / global-settings)
 * preempts an open picker. Without it the picker's modal layer survives
 * the kind-switch as orphaned Vue state: the WebContentsView is hidden,
 * but the `useModal` resolver stays pending, and the next time the
 * picker opens (or its state is otherwise re-rendered) the modal can
 * unexpectedly resurface.
 *
 * Both composables are singletons (module-scoped reactive state), so
 * `dismiss()` / `cancel()` work on whatever the picker's renderer has
 * open without needing a component instance.
 */
export function dismissPickerModals(): void {
  const modal = useModal()
  modal.dismiss()
  const dialogs = useDialogs()
  if (dialogs.state.open) dialogs.cancel()
}
