import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref, shallowRef, triggerRef } from 'vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    // Identity translator so labels are predictable in assertions.
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

// A shallowRef version lets `set*` retrigger the composable's computeds.
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
      // Touch the version ref so the computed re-runs on `set*`.
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
    // Proves the composable subscribes to the session store, not a test-held ref.
    setRunning(new Set<string>())
    expect(cta.label.value).toBe('Start')
  })

  it('reactively flips Restart → Switch when the host window detaches the install', () => {
    setRunning(new Set<string>(['inst-A']))
    const inst = ref<Installation | null>(installation('inst-A'))
    const active = ref<string | null>('inst-A')
    const cta = useInstallCta(inst, { activeInstallationId: active })
    expect(cta.label.value).toBe('Restart')
    // Detaching clears activeInstallationId, so it now reads as running elsewhere.
    active.value = null
    expect(cta.label.value).toBe('Switch')
  })

  // Launching counts as an attached session, so the launching window reads
  // Restart (not Start) before `instance-started` fires.
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
    // launching → running must stay Restart with no flicker through Start.
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
