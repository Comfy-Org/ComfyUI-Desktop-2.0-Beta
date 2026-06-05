import { defineStore } from 'pinia'
import { reactive, computed, ref } from 'vue'
import type { RunningInstance, ComfyOutputData, ComfyExitedData } from '../types/ipc'

interface SessionBuffer {
  output: string
  exited: boolean
}

interface ActiveSession {
  label: string
}

interface ErrorInstance {
  installationName: string
  exitCode?: number | string
  /** POSIX signal name (e.g. `'SIGKILL'`) when the ComfyUI child process
   *  was killed by signal. Absent on a normal crash with a non-zero exit
   *  code and on Windows TerminateProcess paths. */
  signal?: string
  message?: string
  /** Scrubbed tail of the failed process's stderr, if main captured one
   *  (only set on `crashed=true` exits — operation failures stay
   *  message-only). The lifecycle view renders this inline so the user
   *  doesn't have to dig into the log file to see what blew up. */
  lastStderr?: string
  /** Wall-clock ms when the crash was first recorded. Used to measure
   *  crash-to-relaunch latency on `comfy.desktop.instance.relaunched_after_crash`. */
  crashedAtMs?: number
}

export const useSessionStore = defineStore('session', () => {
  const runningInstances = reactive(new Map<string, RunningInstance>())
  const launchingInstances = reactive(new Map<string, { installationName: string }>())
  const activeSessions = reactive(new Map<string, ActiveSession>())
  const errorInstances = reactive(new Map<string, ErrorInstance>())
  const stoppingInstances = reactive(new Set<string>())
  const stoppingTimeouts = new Map<string, ReturnType<typeof setTimeout>>()
  const sessions = reactive(new Map<string, SessionBuffer>())

  /** Flips to `true` after the first `init()` completes (running-instance
   *  hydration + IPC subscriptions wired). Views that key off the
   *  derived lifecycle state — most importantly `ComfyLifecycleView` —
   *  must gate their default render branches on this so they don't
   *  flash the 'stopped' card during the brief window between mount and
   *  hydration. Before `ready` flips, the maps are empty and lifecycle
   *  state would compute `'stopped'` even when an auto-launch is about
   *  to fire. */
  const ready = ref(false)

  const runningTabCount = computed(() => activeSessions.size + runningInstances.size)
  const hasErrors = computed(() => errorInstances.size > 0)

  // Track IPC unsubscribe functions for cleanup
  const cleanups: (() => void)[] = []

  function isRunning(installationId: string): boolean {
    return runningInstances.has(installationId)
  }

  function isLaunching(installationId: string): boolean {
    return launchingInstances.has(installationId)
  }

  function isStopping(installationId: string): boolean {
    return stoppingInstances.has(installationId)
  }

  function clearStoppingState(installationId: string): void {
    stoppingInstances.delete(installationId)
    const timeout = stoppingTimeouts.get(installationId)
    if (timeout) {
      clearTimeout(timeout)
      stoppingTimeouts.delete(installationId)
    }
  }

  /** Mark an install as stopping with a safety auto-clear, in case the
   *  matching `instance-stopped` is missed (window opened mid-stop, etc.).
   *  Idempotent — resets the timer rather than stacking timeouts. */
  function markStopping(installationId: string): void {
    stoppingInstances.add(installationId)
    const existing = stoppingTimeouts.get(installationId)
    if (existing) clearTimeout(existing)
    stoppingTimeouts.set(
      installationId,
      setTimeout(() => clearStoppingState(installationId), 30_000)
    )
  }

  function setActiveSession(installationId: string, label: string): void {
    activeSessions.set(installationId, { label: label || '' })
    errorInstances.delete(installationId)
  }

  function clearActiveSession(installationId?: string): void {
    if (installationId) {
      activeSessions.delete(installationId)
    } else {
      activeSessions.clear()
    }
  }

  function clearErrorInstance(installationId: string): void {
    errorInstances.delete(installationId)
    sessions.delete(installationId)
  }

  // Session buffer methods
  function startSession(installationId: string): void {
    sessions.set(installationId, { output: '', exited: false })
  }

  function getSession(installationId: string): SessionBuffer | undefined {
    return sessions.get(installationId)
  }

  function hasSession(installationId: string): boolean {
    return sessions.has(installationId)
  }

  function clearSession(installationId: string): void {
    sessions.delete(installationId)
  }

  function appendOutput(installationId: string, text: string): void {
    let session = sessions.get(installationId)
    if (!session) {
      session = { output: '', exited: false }
      sessions.set(installationId, session)
    }

    // Handle carriage returns (\r) used by tqdm-style progress bars.
    // A \r means "return to the start of the current line", so text after
    // a \r should replace everything after the last \n in the output.
    // Split on bare \r (not followed by \n) to handle tqdm-style progress bars.
    // Windows CRLF (\r\n) must be preserved as a normal newline.
    const parts = text.split(/\r(?!\n)/)
    for (let i = 0; i < parts.length; i++) {
      const segment = parts[i]!
      if (i === 0) {
        // First segment: always append (no preceding \r)
        session.output += segment
      } else if (segment.length > 0) {
        // After a bare \r: overwrite from the last newline
        const lastNewline = session.output.lastIndexOf('\n')
        session.output = session.output.slice(0, lastNewline + 1) + segment
      }
    }
  }

  /** Initialize IPC listeners. Call once from App.vue. */
  async function init(): Promise<void> {
    dispose()
    const instances = await window.api.getRunningInstances()
    for (const inst of instances) {
      runningInstances.set(inst.installationId, inst)
    }

    // Hydrate in-flight launches too — a window opened mid-launch missed the
    // one-shot `instance-launching` broadcast, so without this snapshot its
    // dashboard would show no "Starting…" pill. Skip ids already running (the
    // launch finished between the two snapshots).
    const launching = (await window.api.getLaunchingInstances?.()) ?? []
    for (const inst of launching) {
      if (!runningInstances.has(inst.installationId)) {
        launchingInstances.set(inst.installationId, { installationName: inst.installationName })
      }
    }

    // Hydrate in-flight stops so a window opened mid-stop shows "Stopping…".
    // No running-guard: an install briefly appears in both sets during the
    // stop, and stopping should win.
    const stopping = (await window.api.getStoppingInstances?.()) ?? []
    for (const id of stopping) markStopping(id)

    // Hydrate retained crashes so a freshly-opened dashboard shows error tiles
    // for crashes that happened before it existed. Op-failure errors are
    // renderer-owned and not covered here (see issue #900). Skip running /
    // launching ids — the crash buffer clears on relaunch, but guard
    // defensively so an in-flight launch shows "Starting…", not a stale crash.
    const crashes = (await window.api.getCrashInstances?.()) ?? []
    for (const c of crashes) {
      if (!runningInstances.has(c.installationId) && !launchingInstances.has(c.installationId)) {
        errorInstances.set(c.installationId, {
          installationName: c.installationName,
          exitCode: c.exitCode,
          signal: c.signal,
          lastStderr: c.lastStderr,
          crashedAtMs: c.crashedAtMs,
        })
      }
    }

    cleanups.push(
      window.api.onInstanceLaunching(
        (data: { installationId: string; installationName: string }) => {
          launchingInstances.set(data.installationId, { installationName: data.installationName })
          // A new launch supersedes any prior crash — clear the error so the
          // dashboard tile drops its red/error state (main already cleared its
          // crash buffer at launch start via `clearCrash`).
          errorInstances.delete(data.installationId)
        }
      ),
      window.api.onInstanceLaunchFailed((data: { installationId: string }) => {
        launchingInstances.delete(data.installationId)
      }),
      window.api.onInstanceStarted((data: RunningInstance) => {
        launchingInstances.delete(data.installationId)
        runningInstances.set(data.installationId, data)
        // Backstop in case the `instance-launching` broadcast was missed
        // (window opened mid-launch, etc.) — a running instance is not errored.
        errorInstances.delete(data.installationId)
      }),
      window.api.onInstanceStopped((data: { installationId: string }) => {
        runningInstances.delete(data.installationId)
        clearStoppingState(data.installationId)
      }),
      window.api.onInstanceStopping((data: { installationId: string }) => {
        markStopping(data.installationId)
      }),
      window.api.onComfyOutput((data: ComfyOutputData) => {
        appendOutput(data.installationId, data.text)
      }),
      window.api.onComfyExited((data: ComfyExitedData) => {
        const session = sessions.get(data.installationId)
        if (session) {
          session.exited = true
          const msg = data.crashed
            ? `Process crashed (exit code ${data.exitCode ?? 'unknown'})`
            : 'Process exited'
          session.output += `\n\n--- ${msg} ---\n`
        }
      }),
      // Crash error state is driven off the `instance-crashed` broadcast (not
      // the sender-only `comfy-exited`) so a dashboard window that didn't
      // launch the instance still turns its tile red live.
      window.api.onInstanceCrashed((data: ComfyExitedData) => {
        errorInstances.set(data.installationId, {
          installationName: data.installationName,
          exitCode: data.exitCode,
          signal: data.signal,
          lastStderr: data.lastStderr,
          crashedAtMs: data.crashedAtMs ?? Date.now()
        })
      })
    )

    ready.value = true
  }

  function dispose(): void {
    for (const fn of cleanups) fn()
    cleanups.length = 0
    for (const timeout of stoppingTimeouts.values()) clearTimeout(timeout)
    stoppingTimeouts.clear()
    ready.value = false
  }

  return {
    runningInstances,
    launchingInstances,
    activeSessions,
    errorInstances,
    sessions,
    ready,
    runningTabCount,
    hasErrors,
    isRunning,
    isLaunching,
    stoppingInstances,
    isStopping,
    setActiveSession,
    clearActiveSession,
    clearErrorInstance,
    startSession,
    getSession,
    hasSession,
    clearSession,
    appendOutput,
    init,
    dispose
  }
})
