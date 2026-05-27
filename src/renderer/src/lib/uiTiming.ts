/**
 * Minimum visible duration for in-flight UI feedback (spinners, busy
 * labels) on quick, opaque async actions like "Check for updates".
 *
 * Why a floor exists: some of these IPCs resolve in <16ms — a cached
 * rate-limit response from `releaseCache`, an `up_to_date` short-circuit
 * inside todesktop's autoUpdater, or a dev-mode no-op when no updater
 * is bound. Without a floor the spinner appears and disappears inside
 * a single frame and the click reads as a no-op to the user.
 *
 * Why 700ms: roughly the floor below which a feedback flash stops
 * reading as "the system did something" and starts reading as "did I
 * even click?". Long enough to register, short enough that successful
 * cases never feel laggy. Calibrate here, not at each call site.
 */
export const MIN_BUSY_FEEDBACK_MS = 700

/**
 * Run `task` and ensure at least `minDurationMs` has elapsed before
 * resolving. If the task already took longer, returns immediately —
 * the floor never delays a legitimately slow action.
 *
 * The task's result and rejection both propagate unchanged. Errors
 * are not swallowed.
 */
export async function withMinDuration<T>(
  task: () => Promise<T>,
  minDurationMs: number = MIN_BUSY_FEEDBACK_MS,
): Promise<T> {
  const startedAt = Date.now()
  try {
    return await task()
  } finally {
    await sleepRemainder(startedAt, minDurationMs)
  }
}

/**
 * Sleep until `minDurationMs` has passed since `startedAt`. Returns
 * immediately if the deadline is already in the past. Use when a
 * try/catch/finally already exists around the awaited work and a
 * `withMinDuration` wrap would fight the existing control flow.
 */
export async function sleepRemainder(
  startedAt: number,
  minDurationMs: number = MIN_BUSY_FEEDBACK_MS,
): Promise<void> {
  const remaining = minDurationMs - (Date.now() - startedAt)
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining))
  }
}
