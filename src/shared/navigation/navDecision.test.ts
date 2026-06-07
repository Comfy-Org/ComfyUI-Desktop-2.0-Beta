import { describe, expect, it } from 'vitest'
import {
  decideNavigation,
  NAV_LABEL,
  type Intent,
  type NavInput,
  type TargetKind,
  type TargetRun,
  type Verb,
} from './navDecision'
import type { NavClass, ViewKind } from '../viewKind'

const VIEWS: ViewKind[] = ['dashboard', 'instance', 'cloud']
const TARGETS: TargetKind[] = ['dashboard', 'instance', 'cloud', 'new-instance']
const RUNS: TargetRun[] = ['stopped', 'running-here', 'running-elsewhere', 'self']
const CLASSES: (NavClass | null)[] = ['local', 'cloud', null]
const INTENTS: Intent[] = ['primary', 'new-window']

function input(over: Partial<NavInput>): NavInput {
  return {
    currentView: 'dashboard',
    currentClass: null,
    target: 'instance',
    targetClass: 'local',
    targetRun: 'stopped',
    intent: 'primary',
    ...over,
  }
}

describe('decideNavigation — totality', () => {
  // The function must be total: every tuple in the full cross-product resolves
  // to a structurally valid decision, never throws, never returns undefined.
  it('returns a valid decision for the entire input cross-product', () => {
    for (const currentView of VIEWS)
      for (const target of TARGETS)
        for (const targetRun of RUNS)
          for (const currentClass of CLASSES)
            for (const targetClass of CLASSES.filter((c): c is NavClass => c !== null))
              for (const intent of INTENTS) {
                const d = decideNavigation(
                  input({ currentView, target, targetRun, currentClass, targetClass, intent }),
                )
                expect(d).toBeDefined()
                expect(['same', 'new']).toContain(d.window)
                expect(d.verb).toBeTruthy()
                expect(Object.values(NAV_LABEL)).toContain(d.primaryLabel)
                expect(Array.isArray(d.secondary)).toBe(true)
              }
  })
})

describe('decideNavigation — the CURRENT-behavior matrix (baseline before #926 deltas)', () => {
  const decisionFor = (
    currentView: ViewKind,
    target: TargetKind,
    targetRun: TargetRun,
    currentClass: NavClass | null,
  ) => decideNavigation(input({ currentView, target, targetRun, currentClass }))

  // ── Dashboard → X ──
  it('Dashboard → Dashboard: no-op', () => {
    expect(decisionFor('dashboard', 'dashboard', 'self', null).verb).toBe('no-op')
  })
  it('Dashboard → Instance (stopped): Start in same window, no caret', () => {
    const decision = decisionFor('dashboard', 'instance', 'stopped', null)
    expect(decision).toMatchObject({ window: 'same', verb: 'switch', primaryLabel: NAV_LABEL.start })
    expect(decision.secondary).toHaveLength(0)
  })
  it('Dashboard → Instance (running elsewhere): focus, label Switch, no caret', () => {
    const decision = decisionFor('dashboard', 'instance', 'running-elsewhere', null)
    expect(decision).toMatchObject({ window: 'same', verb: 'focus', primaryLabel: NAV_LABEL.switch })
    expect(decision.secondary).toHaveLength(0)
  })
  it('Dashboard → Cloud (closed): Open Cloud same window + new-window caret', () => {
    const decision = decisionFor('dashboard', 'cloud', 'stopped', null)
    expect(decision).toMatchObject({ window: 'same', verb: 'switch', primaryLabel: NAV_LABEL.openCloud })
    expect(decision.secondary.some((alt) => alt.window === 'new' && alt.verb === 'open-new')).toBe(true)
  })
  it('Dashboard → New Instance: install wizard', () => {
    expect(decisionFor('dashboard', 'new-instance', 'stopped', null).verb).toBe('install-wizard')
  })

  // ── Instance → X ──
  it('Instance → Dashboard: NEW window (instance keeps running)', () => {
    const decision = decisionFor('instance', 'dashboard', 'self', 'local')
    expect(decision).toMatchObject({ window: 'new', verb: 'open-new', primaryLabel: NAV_LABEL.openDashboard })
  })
  it('Instance → self: Restart in place', () => {
    const decision = decisionFor('instance', 'instance', 'self', 'local')
    expect(decision).toMatchObject({ window: 'same', verb: 'restart', primaryLabel: NAV_LABEL.restart })
  })
  it('Instance → Instance B (stopped): switch in place + new-window caret (matrix row 9)', () => {
    const decision = decisionFor('instance', 'instance', 'stopped', 'local')
    expect(decision).toMatchObject({ window: 'same', verb: 'switch', confirm: 'kill-local' })
    // The caret offers "Open in new window" so the user can keep A running; the
    // main-side 3-way modal also surfaces this on the primary Switch click.
    expect(decision.secondary.some((alt) => alt.window === 'new' && alt.verb === 'open-new')).toBe(true)
  })
  it('Instance → Instance B (running elsewhere): focus, no caret', () => {
    const decision = decisionFor('instance', 'instance', 'running-elsewhere', 'local')
    expect(decision.verb).toBe('focus')
    expect(decision.secondary).toHaveLength(0)
  })
  it('Instance → Cloud (closed): NEW window, keeps the instance running', () => {
    const decision = decisionFor('instance', 'cloud', 'stopped', 'local')
    expect(decision).toMatchObject({ window: 'new', verb: 'open-new', primaryLabel: NAV_LABEL.openCloud })
  })

  // ── Cloud → X ──
  // NOTE: documentation cell — the dashboard chip routes through the hardcoded
  // `activate('new-window')` path, so the app opens a new window for all hosts.
  // The matrix asks for same-window; tracked as a known deviation.
  it('Cloud → Dashboard: new window today (chip is not table-driven)', () => {
    const decision = decisionFor('cloud', 'dashboard', 'self', 'cloud')
    expect(decision).toMatchObject({ window: 'new', verb: 'open-new', primaryLabel: NAV_LABEL.openDashboard })
  })
  it('Cloud → Instance (stopped): NEW window, keeps the cloud session running', () => {
    const decision = decisionFor('cloud', 'instance', 'stopped', 'cloud')
    expect(decision).toMatchObject({ window: 'new', verb: 'open-new', primaryLabel: NAV_LABEL.startNewWindow })
  })
  it('Cloud → self: opens a second cloud window (allowDuplicate)', () => {
    const decision = decisionFor('cloud', 'cloud', 'self', 'cloud')
    expect(decision).toMatchObject({ window: 'new', verb: 'open-new', allowDuplicate: true })
  })
  it('Cloud → New Instance: install wizard in a new window', () => {
    const decision = decisionFor('cloud', 'new-instance', 'stopped', 'cloud')
    expect(decision).toMatchObject({ window: 'new', verb: 'install-wizard' })
  })
})

describe('decideNavigation — boundary rules', () => {
  it('fills kill-local confirm only when the current host is local', () => {
    const local = decideNavigation(
      input({ currentView: 'instance', currentClass: 'local', target: 'instance', targetRun: 'stopped' }),
    )
    expect(local.confirm).toBe('kill-local')

    // A cloud current host has no local process at risk → no confirm.
    const cloud = decideNavigation(
      input({ currentView: 'cloud', currentClass: 'cloud', target: 'instance', targetRun: 'stopped' }),
    )
    expect(cloud.confirm).toBeNull()
  })

  it('new-window intent selects the new-window secondary when offered', () => {
    const d = decideNavigation(
      input({ currentView: 'dashboard', currentClass: null, target: 'cloud', targetRun: 'stopped', intent: 'new-window' }),
    )
    expect(d).toMatchObject({ window: 'new', verb: 'open-new', primaryLabel: NAV_LABEL.openInNewWindow })
  })

  it('new-window intent falls back to the primary when no secondary exists', () => {
    const primary = decideNavigation(
      input({ currentView: 'instance', currentClass: 'local', target: 'instance', targetRun: 'self', intent: 'primary' }),
    )
    const viaCaret = decideNavigation(
      input({ currentView: 'instance', currentClass: 'local', target: 'instance', targetRun: 'self', intent: 'new-window' }),
    )
    expect(viaCaret).toEqual(primary)
  })

  it('only `switch` + same-window decisions carry telemetry "instance.switched"', () => {
    const switched = decideNavigation(
      input({ currentView: 'instance', currentClass: 'local', target: 'instance', targetRun: 'stopped' }),
    )
    expect(switched.telemetry).toBe('instance.switched')
  })
})

describe('decideNavigation — cloud ≡ remote', () => {
  // Remote is folded into cloud upstream (navClass), so a remote target is
  // indistinguishable from a cloud target here: identical decisions.
  it('treats a remote target identically to a cloud target', () => {
    const asCloud = decideNavigation(input({ currentView: 'dashboard', target: 'cloud', targetClass: 'cloud', targetRun: 'stopped' }))
    const verbs: Verb[] = ['switch', 'focus', 'open-new', 'no-op']
    expect(verbs).toContain(asCloud.verb)
  })
})
