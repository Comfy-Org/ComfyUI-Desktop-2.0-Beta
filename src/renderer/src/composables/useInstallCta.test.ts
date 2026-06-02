import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref, shallowRef, triggerRef } from 'vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    // Identity translator so labels are predictable in assertions.
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

// Wrap the session-state in a shallowRef so the `set*` helpers can
// trigger the composable's computed properties on real session-store
// mutations, not on incidental dep churn from the test.
const sessionState = vi.hoisted(() => ({
  running: new Set<string>(),
  launching: new Set<string>(),
}))
function setRunning(running: Set<string>): void {
  sessionState.running = running
  triggerRef(sessionStoreVersion)
}
function setLaunching(launching: Set<string>): void {
  sessionState.launching = launching
  triggerRef(sessionStoreVersion)
}
const sessionStoreVersion = shallowRef(0)
vi.mock('../stores/sessionStore', () => ({
  useSessionStore: () => ({
    isRunning: (id: string) => {
      // Touch the version ref so the computed re-runs when `set*`
      // triggers it.
      void sessionStoreVersion.value
      return sessionState.running.has(id)
    },
    isLaunching: (id: string) => {
      void sessionStoreVersion.value
      return sessionState.launching.has(id)
    },
  }),
}))

import { useInstallCta } from './useInstallCta'
import type { Installation } from '../types/ipc'

function installation(id: string): Installation {
  return { id, name: id } as Installation
}

beforeEach(() => {
  setRunning(new Set<string>())
  setLaunching(new Set<string>())
})

describe('useInstallCta', () => {
  // Centralizes the primary-CTA decision so the picker rows and the
  // settings footer can't drift apart (issue #755). Three states:
  // Start / Restart (here) / Switch (elsewhere).

  it('returns Start when the install is not running anywhere', () => {
    const cta = useInstallCta(ref(installation('inst-A')), {
      activeInstallationId: ref<string | null>(null),
    })
    expect(cta.runningAnywhere.value).toBe(false)
    expect(cta.runningInThisWindow.value).toBe(false)
    expect(cta.runningElsewhere.value).toBe(false)
    expect(cta.restartInPlace.value).toBe(false)
    expect(cta.label.value).toBe('Start')
  })

  it('returns Restart when the install is running in THIS host window', () => {
    sessionState.running.add('inst-A')
    const cta = useInstallCta(ref(installation('inst-A')), {
      activeInstallationId: ref<string | null>('inst-A'),
    })
    expect(cta.runningAnywhere.value).toBe(true)
    expect(cta.runningInThisWindow.value).toBe(true)
    expect(cta.runningElsewhere.value).toBe(false)
    expect(cta.restartInPlace.value).toBe(true)
    expect(cta.label.value).toBe('Restart')
  })

  it('returns Switch when the install is running in ANOTHER host window (issue #749)', () => {
    sessionState.running.add('inst-B')
    const cta = useInstallCta(ref(installation('inst-B')), {
      activeInstallationId: ref<string | null>('inst-A'),
    })
    expect(cta.runningAnywhere.value).toBe(true)
    expect(cta.runningInThisWindow.value).toBe(false)
    expect(cta.runningElsewhere.value).toBe(true)
    expect(cta.restartInPlace.value).toBe(false)
    expect(cta.label.value).toBe('Switch')
  })

  it('returns Switch for a running install on an install-less (dashboard) host', () => {
    // Dashboard host has no active install, so any running install reads
    // as "switch to its own window".
    sessionState.running.add('inst-A')
    const cta = useInstallCta(ref(installation('inst-A')), {
      activeInstallationId: ref<string | null>(null),
    })
    expect(cta.runningInThisWindow.value).toBe(false)
    expect(cta.runningElsewhere.value).toBe(true)
    expect(cta.label.value).toBe('Switch')
  })

  it('handles a null installation prop without throwing', () => {
    const cta = useInstallCta(ref<Installation | null>(null), {
      activeInstallationId: ref<string | null>('inst-A'),
    })
    expect(cta.runningAnywhere.value).toBe(false)
    expect(cta.runningInThisWindow.value).toBe(false)
    expect(cta.runningElsewhere.value).toBe(false)
    expect(cta.label.value).toBe('Start')
  })

  it('reactively flips Restart → Start when the session-store reports the install stopped', () => {
    setRunning(new Set<string>(['inst-A']))
    const inst = ref<Installation | null>(installation('inst-A'))
    const active = ref<string | null>('inst-A')
    const cta = useInstallCta(inst, { activeInstallationId: active })
    expect(cta.label.value).toBe('Restart')
    // Real driver: a session-store push from main flips
    // `sessionStore.isRunning(id)` to false. `setRunning` triggers the
    // mocked store's version ref so the composable's `runningAnywhere`
    // computed re-runs — this is what proves the composable subscribes
    // to the session store, not to an incidental ref the test held.
    setRunning(new Set<string>())
    expect(cta.label.value).toBe('Start')
  })

  it('reactively flips Restart → Switch when the host window detaches the install', () => {
    setRunning(new Set<string>(['inst-A']))
    const inst = ref<Installation | null>(installation('inst-A'))
    const active = ref<string | null>('inst-A')
    const cta = useInstallCta(inst, { activeInstallationId: active })
    expect(cta.label.value).toBe('Restart')
    // Host window detached → activeInstallationId clears, the running
    // install now reads as "running elsewhere".
    active.value = null
    expect(cta.label.value).toBe('Switch')
  })

  // Launching state — the install has been attached to a window but
  // `instance-started` has not yet fired (port not bound). The CTA
  // must already read as "session attached" or the user sees a Start
  // button in the very window the launch is happening in, and other
  // windows see a Start button that the main-side single-attach guard
  // would just reject.
  it('returns Restart when the install is LAUNCHING in this host window', () => {
    setLaunching(new Set<string>(['inst-A']))
    const cta = useInstallCta(ref(installation('inst-A')), {
      activeInstallationId: ref<string | null>('inst-A'),
    })
    expect(cta.runningAnywhere.value).toBe(true)
    expect(cta.runningInThisWindow.value).toBe(true)
    expect(cta.runningElsewhere.value).toBe(false)
    expect(cta.restartInPlace.value).toBe(true)
    expect(cta.label.value).toBe('Restart')
  })

  it('returns Switch when the install is LAUNCHING in another host window', () => {
    setLaunching(new Set<string>(['inst-B']))
    const cta = useInstallCta(ref(installation('inst-B')), {
      activeInstallationId: ref<string | null>('inst-A'),
    })
    expect(cta.runningAnywhere.value).toBe(true)
    expect(cta.runningInThisWindow.value).toBe(false)
    expect(cta.runningElsewhere.value).toBe(true)
    expect(cta.label.value).toBe('Switch')
  })

  it('keeps Restart across the launching → running handoff in the same window', () => {
    // `instance-launching` arrives first → composable should already
    // read Restart. Then `instance-started` arrives (launching clears,
    // running sets) — same label, no flicker through Start.
    setLaunching(new Set<string>(['inst-A']))
    const cta = useInstallCta(ref(installation('inst-A')), {
      activeInstallationId: ref<string | null>('inst-A'),
    })
    expect(cta.label.value).toBe('Restart')
    setLaunching(new Set<string>())
    setRunning(new Set<string>(['inst-A']))
    expect(cta.label.value).toBe('Restart')
  })
})
