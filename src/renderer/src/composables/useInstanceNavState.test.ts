import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref, shallowRef, triggerRef } from 'vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}))

const sessionState = vi.hoisted(() => ({
  running: new Set<string>(),
  launching: new Set<string>(),
}))
const sessionStoreVersion = shallowRef(0)
function setRunning(running: Set<string>): void {
  sessionState.running = running
  triggerRef(sessionStoreVersion)
}
vi.mock('../stores/sessionStore', () => ({
  useSessionStore: () => ({
    isRunning: (id: string) => {
      void sessionStoreVersion.value
      return sessionState.running.has(id)
    },
    isLaunching: (id: string) => {
      void sessionStoreVersion.value
      return sessionState.launching.has(id)
    },
  }),
}))

import { useInstanceNavState } from './useInstanceNavState'
import { decideNavigation, NAV_LABEL } from '../../../shared/navigation/navDecision'
import type { Installation } from '../types/ipc'
import type { Category, ViewKind } from '../../../shared/viewKind'

function installation(id: string, sourceCategory: string): Installation {
  return { id, name: id, sourceCategory } as Installation
}

beforeEach(() => {
  setRunning(new Set<string>())
})

describe('useInstanceNavState — run-state derivation', () => {
  it('classifies the running host self install as self', () => {
    setRunning(new Set(['A']))
    const navState = useInstanceNavState(ref(installation('A', 'local')), {
      currentView: 'instance' as ViewKind,
      currentCategory: 'local' as Category,
      activeInstallationId: 'A',
    })
    expect(navState.targetRun.value).toBe('self')
    expect(navState.isTargetCurrentHost.value).toBe(true)
  })

  it('reads an active-but-not-yet-running host install as stopped (CTA stays "Start")', () => {
    const navState = useInstanceNavState(ref(installation('A', 'local')), {
      currentView: 'instance' as ViewKind,
      currentCategory: 'local' as Category,
      activeInstallationId: 'A',
    })
    expect(navState.targetRun.value).toBe('stopped')
  })

  it('classifies a stopped non-host install as stopped', () => {
    const navState = useInstanceNavState(ref(installation('B', 'local')), {
      currentView: 'instance' as ViewKind,
      currentCategory: 'local' as Category,
      activeInstallationId: 'A',
    })
    expect(navState.targetRun.value).toBe('stopped')
  })

  it('classifies an install running in another window as running-elsewhere', () => {
    setRunning(new Set(['B']))
    const navState = useInstanceNavState(ref(installation('B', 'local')), {
      currentView: 'instance' as ViewKind,
      currentCategory: 'local' as Category,
      activeInstallationId: 'A',
    })
    expect(navState.targetRun.value).toBe('running-elsewhere')
  })

  it('remote target routes like a cloud target (non-local URL backend)', () => {
    const navState = useInstanceNavState(ref(installation('R', 'remote')), {
      currentView: 'cloud' as ViewKind,
      currentCategory: 'remote' as Category,
      activeInstallationId: null,
    })
    // A remote connection is a non-local URL backend exactly like Cloud — the
    // remote⇒cloud fold applies to the TARGET, so it lands the cloud rows.
    expect(navState.targetClass.value).toBe('cloud')
    expect(navState.targetKind.value).toBe('cloud')
    expect(navState.currentClass.value).toBe('cloud')
  })

  it('reports a dashboard host as a chooser with null class', () => {
    const navState = useInstanceNavState(ref(installation('A', 'local')), {
      currentView: 'dashboard' as ViewKind,
      currentCategory: null,
      activeInstallationId: null,
    })
    expect(navState.isCurrentChooser.value).toBe(true)
    expect(navState.currentClass.value).toBeNull()
  })
})

describe('useInstanceNavState → decideNavigation (end to end)', () => {
  it('instance host picking a stopped local instance → switch in place', () => {
    const navState = useInstanceNavState(ref(installation('B', 'local')), {
      currentView: 'instance' as ViewKind,
      currentCategory: 'local' as Category,
      activeInstallationId: 'A',
    })
    const decision = decideNavigation(navState.navInput('primary'))
    expect(decision).toMatchObject({ window: 'same', verb: 'switch' })
  })

  it('dashboard host picking a stopped cloud install → Open Cloud + new-window caret', () => {
    const navState = useInstanceNavState(ref(installation('cloud', 'cloud')), {
      currentView: 'dashboard' as ViewKind,
      currentCategory: null,
      activeInstallationId: null,
    })
    const primaryDecision = decideNavigation(navState.navInput('primary'))
    expect(primaryDecision).toMatchObject({ verb: 'switch', primaryLabel: NAV_LABEL.openCloud })
    const caretDecision = decideNavigation(navState.navInput('new-window'))
    expect(caretDecision).toMatchObject({ window: 'new', verb: 'open-new', primaryLabel: NAV_LABEL.openInNewWindow })
  })

  it('cloud host picking a stopped instance → opens in a new window', () => {
    const navState = useInstanceNavState(ref(installation('B', 'local')), {
      currentView: 'cloud' as ViewKind,
      currentCategory: 'cloud' as Category,
      activeInstallationId: 'cloud',
    })
    const decision = decideNavigation(navState.navInput('primary'))
    expect(decision).toMatchObject({ window: 'new', verb: 'open-new' })
  })

  it('cloud host picking a stopped REMOTE connection → opens in a new window (not a dead no-op)', () => {
    const navState = useInstanceNavState(ref(installation('R', 'remote')), {
      currentView: 'cloud' as ViewKind,
      currentCategory: 'cloud' as Category,
      activeInstallationId: 'cloud',
    })
    const decision = decideNavigation(navState.navInput('primary'))
    expect(decision).toMatchObject({ window: 'new', verb: 'open-new', primaryLabel: NAV_LABEL.openInNewWindow })
  })

  it('instance host → stopped REMOTE routes identically to stopped Cloud (no in-place 3-way)', () => {
    const sources = { currentView: 'instance' as ViewKind, currentCategory: 'local' as Category, activeInstallationId: 'A' }
    const remote = decideNavigation(useInstanceNavState(ref(installation('R', 'remote')), sources).navInput('primary'))
    const cloud = decideNavigation(useInstanceNavState(ref(installation('C', 'cloud')), sources).navInput('primary'))
    // Case-4 regression: a remote must NOT get the local→local in-place "Switch"
    // 3-way — it opens in a new window (A keeps running), exactly like cloud.
    expect(remote).toMatchObject({ window: 'new', verb: 'open-new' })
    expect(remote).toEqual(cloud)
  })
})
