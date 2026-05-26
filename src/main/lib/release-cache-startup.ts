/**
 * Startup-time release-cache pre-warm.
 *
 * The shared `releaseCache` is populated lazily — by explicit
 * `check-update` clicks, install creation, and the picker's
 * stale-cache watcher. Nothing in the bootstrap path proactively
 * refreshes it, so a user who opens the app after weeks of inactivity
 * sees stale `latestTag` everywhere the dashboard / title-bar pills
 * read from until they navigate to the Update tab.
 *
 * This module fires a background `ls-remote --tags` per unique
 * (repo, channel) the installed installs use, then broadcasts
 * `installations-changed` so the renderer re-enriches and the
 * dashboard pills repaint without user gesture.
 *
 * Cost: one cheap GitHub fetch per unique channel in use (today: 1-2
 * fetches per startup for a typical user with one stable install or
 * one stable + one latest). Single-flight + 10s `MIN_RECHECK_INTERVAL`
 * inside `releaseCache.getOrFetch` back-stop accidental double-fires.
 *
 * Gated by `STARTUP_RECHECK_MS` — skip the fetch entirely if the cache
 * was refreshed within the last hour so frequent restarts don't slam
 * GitHub.
 */

import type { InstallationRecord } from '../installations'
import * as releaseCache from './release-cache'
import { fetchLatestRelease } from './comfyui-releases'

/** Skip the startup check if any cache entry was refreshed within this
 *  window. One hour is well past the picker's 15-min stale threshold,
 *  so users who just had the picker open won't trigger redundant
 *  fetches on the next restart. */
const STARTUP_RECHECK_MS = 60 * 60 * 1000

/** The only repo today's standalone + portable sources point at. Cloud
 *  / remote installs don't have a release cache; desktop bundles its
 *  own ComfyUI runtime that doesn't use this cache. */
const COMFYUI_REPO = 'Comfy-Org/ComfyUI'

/** Source IDs that read from the shared ComfyUI release cache. */
const COMFYUI_SOURCE_IDS = new Set(['standalone', 'portable'])

function _isComfyUIInstall(inst: InstallationRecord): boolean {
  if (inst.status !== 'installed') return false
  const sourceId = (inst as unknown as { sourceId?: string }).sourceId
  return sourceId !== undefined && COMFYUI_SOURCE_IDS.has(sourceId)
}

function _channelOf(inst: InstallationRecord): string {
  const ch = (inst as unknown as { updateChannel?: string }).updateChannel
  return ch || 'stable'
}

/**
 * Refresh the shared ComfyUI release cache in the background for every
 * unique channel the installed installs use, then run `onComplete` if
 * at least one fetch actually ran. `onComplete` should re-broadcast
 * `installations-changed` so dashboard / title-bar pills repaint.
 *
 * Fire-and-forget — never throws. Caller doesn't need to await.
 */
export async function runStartupReleaseChecks(
  installations: InstallationRecord[],
  options: {
    onRefreshed?: () => void
    now?: () => number
    /** When true, ignore the 1h `STARTUP_RECHECK_MS` floor and always
     *  attempt to fetch. Used by the periodic background poll so the
     *  cache refreshes on its interval cadence; the 10s
     *  `MIN_RECHECK_INTERVAL` inside `releaseCache.getOrFetch` remains
     *  the final safety net against accidental hot-loops. */
    bypassFloor?: boolean
  } = {},
): Promise<void> {
  const now = options.now ?? (() => Date.now())

  const channels = new Set<string>()
  for (const inst of installations) {
    if (!_isComfyUIInstall(inst)) continue
    channels.add(_channelOf(inst))
  }
  if (channels.size === 0) return

  const tasks: Promise<unknown>[] = []
  for (const channel of channels) {
    if (!options.bypassFloor) {
      const existing = releaseCache.get(COMFYUI_REPO, channel)
      if (existing?.checkedAt && now() - existing.checkedAt < STARTUP_RECHECK_MS) continue
    }

    tasks.push(
      releaseCache.getOrFetch(
        COMFYUI_REPO,
        channel,
        async () => {
          const release = await fetchLatestRelease(channel)
          if (!release) return null
          return releaseCache.buildCacheEntry(release)
        },
        /* force */ true,
      ).catch(() => null),
    )
  }
  if (tasks.length === 0) return

  await Promise.allSettled(tasks)
  options.onRefreshed?.()
}

/**
 * 15-minute periodic poll cadence for the background timer below.
 *
 * Picked to match the picker's stale-cache watcher threshold (from the
 * sibling auto-refresh PR) — at this interval the dashboard / title-bar
 * update pills are guaranteed to reflect upstream state within 15
 * minutes of an upstream release, even for users who never open the
 * picker or click "Check for Update" manually.
 */
const PERIODIC_RECHECK_INTERVAL_MS = 15 * 60 * 1000

/**
 * Start the background timer that re-runs `runStartupReleaseChecks`
 * every `PERIODIC_RECHECK_INTERVAL_MS`. Returns a stop function the
 * caller can run on app quit to clear the interval cleanly.
 *
 * The timer is registered with `unref()` so it never keeps the
 * process alive on its own — if every window closes, the app still
 * quits. The first tick fires after one interval has elapsed; the
 * initial cache pre-warm is handled separately by the IPC-hook path
 * in `registerInstallationHandlers`.
 */
export function startPeriodicReleaseChecks(
  getInstallations: () => Promise<InstallationRecord[]>,
  options: { onRefreshed?: () => void; intervalMs?: number } = {},
): () => void {
  const intervalMs = options.intervalMs ?? PERIODIC_RECHECK_INTERVAL_MS
  const timer = setInterval(() => {
    void (async () => {
      try {
        const installs = await getInstallations()
        await runStartupReleaseChecks(installs, {
          onRefreshed: options.onRefreshed,
          bypassFloor: true,
        })
      } catch {
        // never let the periodic poll crash the timer
      }
    })()
  }, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
