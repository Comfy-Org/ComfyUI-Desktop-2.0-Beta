import { describe, expect, it, vi } from 'vitest'
import { useInstanceActions, type InstanceActionsBridge } from './useInstanceActions'
import type { NavDecision } from '../../../shared/navigation/navDecision'
import type { Installation } from '../types/ipc'

function makeBridge() {
  return {
    pickInstall: vi.fn(),
    restartInstall: vi.fn(),
    openInstallNewWindow: vi.fn(),
    openNewInstall: vi.fn(),
  } satisfies InstanceActionsBridge
}

function installation(over: Partial<Installation> = {}): Installation {
  return { id: 'a', name: 'Alpha', sourceCategory: 'local', ...over } as Installation
}

function decision(over: Partial<NavDecision>): NavDecision {
  return {
    window: 'same', verb: 'switch', confirm: null,
    primaryLabel: 'instancePicker.switch', secondary: [], telemetry: null,
    ...over,
  }
}

function makeDeps(
  bridge: InstanceActionsBridge,
  over: Partial<Parameters<typeof useInstanceActions>[0]> = {},
) {
  return {
    bridge,
    confirmLocalKill: vi.fn().mockResolvedValue(true),
    confirmCloudCapacity: vi.fn().mockResolvedValue(true),
    ...over,
  }
}

describe('useInstanceActions.dispatch', () => {
  it('routes switch → pickInstall', async () => {
    const bridge = makeBridge()
    await useInstanceActions(makeDeps(bridge)).dispatch(decision({ verb: 'switch' }), installation())
    expect(bridge.pickInstall).toHaveBeenCalledWith('a')
  })

  it('routes restart → restartInstall(confirmed:true) after a confirm', async () => {
    const bridge = makeBridge()
    const deps = makeDeps(bridge)
    await useInstanceActions(deps).dispatch(decision({ verb: 'restart' }), installation())
    expect(deps.confirmLocalKill).toHaveBeenCalled()
    expect(bridge.restartInstall).toHaveBeenCalledWith('a', { confirmed: true })
  })

  it('aborts restart when the local kill confirm is declined', async () => {
    const bridge = makeBridge()
    const deps = makeDeps(bridge, { confirmLocalKill: vi.fn().mockResolvedValue(false) })
    await useInstanceActions(deps).dispatch(decision({ verb: 'restart' }), installation())
    expect(bridge.restartInstall).not.toHaveBeenCalled()
  })

  it('confirms a kill-local switch before pickInstall', async () => {
    const bridge = makeBridge()
    const deps = makeDeps(bridge, { confirmLocalKill: vi.fn().mockResolvedValue(false) })
    await useInstanceActions(deps).dispatch(decision({ verb: 'switch', confirm: 'kill-local' }), installation())
    expect(bridge.pickInstall).not.toHaveBeenCalled()
  })

  it('does not confirm a switch with no kill-local gate', async () => {
    const bridge = makeBridge()
    const deps = makeDeps(bridge)
    await useInstanceActions(deps).dispatch(decision({ verb: 'switch', confirm: null }), installation())
    expect(deps.confirmLocalKill).not.toHaveBeenCalled()
    expect(bridge.pickInstall).toHaveBeenCalledWith('a')
  })

  it('routes open-new → openInstallNewWindow', async () => {
    const bridge = makeBridge()
    await useInstanceActions(makeDeps(bridge)).dispatch(decision({ verb: 'open-new', window: 'new' }), installation())
    expect(bridge.openInstallNewWindow).toHaveBeenCalledWith('a')
  })

  it('routes focus → pickInstall (main short-circuits to focus when already up)', async () => {
    const bridge = makeBridge()
    await useInstanceActions(makeDeps(bridge)).dispatch(decision({ verb: 'focus' }), installation())
    expect(bridge.pickInstall).toHaveBeenCalledWith('a')
  })

  it('routes install-wizard → openNewInstall', async () => {
    const bridge = makeBridge()
    await useInstanceActions(makeDeps(bridge)).dispatch(decision({ verb: 'install-wizard' }), installation())
    expect(bridge.openNewInstall).toHaveBeenCalled()
  })

  it('no-op verb fires nothing', async () => {
    const bridge = makeBridge()
    await useInstanceActions(makeDeps(bridge)).dispatch(decision({ verb: 'no-op' }), installation())
    expect(bridge.pickInstall).not.toHaveBeenCalled()
    expect(bridge.restartInstall).not.toHaveBeenCalled()
    expect(bridge.openInstallNewWindow).not.toHaveBeenCalled()
  })

  it('aborts a cloud action when capacity is blocked', async () => {
    const bridge = makeBridge()
    const deps = makeDeps(bridge, { confirmCloudCapacity: vi.fn().mockResolvedValue(false) })
    await useInstanceActions(deps).dispatch(decision({ verb: 'switch' }), installation({ sourceCategory: 'cloud' }))
    expect(bridge.pickInstall).not.toHaveBeenCalled()
  })
})
