/** Minimum visible duration for busy feedback, so spinners on sub-frame IPCs don't flash and read as a no-op. */
export const MIN_BUSY_FEEDBACK_MS = 700

/** Run `task`, ensuring at least `minDurationMs` elapses before resolving. Result/rejection propagate unchanged. */
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

/** Sleep until `minDurationMs` has passed since `startedAt`, or return immediately if already past. */
export async function sleepRemainder(
  startedAt: number,
  minDurationMs: number = MIN_BUSY_FEEDBACK_MS,
): Promise<void> {
  const remaining = minDurationMs - (Date.now() - startedAt)
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining))
  }
}
