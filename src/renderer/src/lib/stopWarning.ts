/** REQUIRES_STOPPED actions whose self-stopping apiCall wrapper should
 *  auto-launch the same install after the op succeeds — picks up an
 *  in-place update / restore so the user isn't left staring at a stopped
 *  ComfyUI. Copy / copy-update / release-update intentionally excluded:
 *  focus moves to the newly-created destination install
 *  (`ActionResult.newInstallationId` opens A' in a new window). Delete
 *  excluded: nothing to relaunch. Migrate-to-standalone excluded: same
 *  reason as copy. */
export const IN_PLACE_RELAUNCH = new Set(['update-comfyui', 'snapshot-restore'])

/** Prepend the `errors.willStopRunning` sentence to an existing message
 *  body. Used by every renderer surface that runs a REQUIRES_STOPPED
 *  action against a currently-running install — the per-action confirm /
 *  prompt copy doesn't mention the stop, and the standalone
 *  stop-confirm modal was removed, so this sentence is the only
 *  surfaced warning the user gets before the apiCall stops the session. */
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

/** Apply the willStopRunning warning to an action's confirm + prompt
 *  copy, returning a new ActionDef-shaped object. Synthesizes a
 *  bare-bones confirm when the action has neither so the warning is
 *  never silent. Used by every surface that runs a REQUIRES_STOPPED
 *  action through its own confirm/prompt chain. The generic preserves
 *  the caller's full ActionDef shape so downstream `.id` / `.data` /
 *  etc. stay accessible after augmentation. */
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

/** Stop the install's running ComfyUI and poll until the session store
 *  reports it as stopped, with a 10s deadline. Shared by every apiCall
 *  wrapper that needs to drop a running session before invoking a
 *  REQUIRES_STOPPED action. */
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
