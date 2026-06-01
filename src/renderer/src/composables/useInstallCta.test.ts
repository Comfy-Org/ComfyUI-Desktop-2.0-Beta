import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    // Identity translator so labels are predictable in assertions.
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

const sessionState = vi.hoisted(() => ({
  running: new Set<string>(),
}))
vi.mock('../stores/sessionStore', () => ({
  useSessionStore: () => ({
    isRunning: (id: string) => sessionState.running.has(id),
  }),
}))

import { useInstallCta } from './useInstallCta'
import type { Installation } from '../types/ipc'

function installation(id: string): Installation {
  return { id, name: id } as Installation
}

beforeEach(() => {
  sessionState.running.clear()
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

  it('reactively flips Restart → Start when the session stops', () => {
    sessionState.running.add('inst-A')
    const inst = ref<Installation | null>(installation('inst-A'))
    const active = ref<string | null>('inst-A')
    const cta = useInstallCta(inst, { activeInstallationId: active })
    expect(cta.label.value).toBe('Restart')
    sessionState.running.delete('inst-A')
    // Touch a dependency to retrigger the computed (the Set delete is
    // not reactive); swap the installation ref to force re-evaluation.
    inst.value = installation('inst-A')
    expect(cta.label.value).toBe('Start')
  })
})
