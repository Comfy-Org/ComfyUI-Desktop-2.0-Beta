export { IN_PLACE_RELAUNCH } from '../../../types/ipc'

/** Prepend the `errors.willStopRunning` sentence to a message body. This
 *  is the only warning the user gets before a REQUIRES_STOPPED apiCall
 *  stops a running session. */
export function augmentMessageWithStopWarning(
  existing: string | undefined,
  willStopRunning: string,
): string {
  if (!existing) return willStopRunning
  return `${willStopRunning}\n\n${existing}`
}

interface ActionLike {
  label: string
  confirm?: { message?: string; title?: string }
  prompt?: { message?: string }
}

/** Apply the willStopRunning warning to an action's confirm + prompt copy.
 *  Synthesizes a bare confirm when the action has neither so the warning
 *  is never silent. Preserves the caller's full ActionDef shape. */
export function augmentActionWithStopWarning<T extends ActionLike>(action: T, willStopRunning: string): T {
  let mut: T = action
  if (mut.confirm) {
    mut = {
      ...mut,
      confirm: {
        ...mut.confirm,
        message: augmentMessageWithStopWarning(mut.confirm.message, willStopRunning),
      },
    }
  }
  if (mut.prompt) {
    mut = {
      ...mut,
      prompt: {
        ...mut.prompt,
        message: augmentMessageWithStopWarning(mut.prompt.message, willStopRunning),
      },
    }
  }
  if (!mut.confirm && !mut.prompt) {
    mut = {
      ...mut,
      confirm: { title: mut.label, message: willStopRunning },
    }
  }
  return mut
}

/** Stop the install's ComfyUI and poll until the session store reports it
 *  stopped, with a 10s deadline. */
export async function stopAndWaitForExit(
  installationId: string,
  isRunning: () => boolean,
): Promise<void> {
  await window.api.stopComfyUI(installationId)
  const deadline = Date.now() + 10_000
  while (isRunning() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
  }
}
