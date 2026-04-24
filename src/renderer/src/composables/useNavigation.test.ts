import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { useNavigation } from './useNavigation'
import type { Installation } from '../types/ipc'

const fakeInstallation: Installation = {
  id: 'inst-1',
  name: 'Test',
  sourceLabel: 'Standalone',
  sourceCategory: 'local',
}

function freshNav() {
  // Reset shared state by dismissing all overlays and switching to dashboard.
  const nav = useNavigation()
  nav.dismissAll()
  nav.switchTab('dashboard')
  return nav
}

describe('useNavigation', () => {
  let nav: ReturnType<typeof useNavigation>

  beforeEach(() => {
    nav = freshNav()
  })

  // --- Tab switching ---

  it('defaults to dashboard tab', () => {
    expect(nav.activeTab.value).toBe('dashboard')
  })

  it('switches tabs', () => {
    nav.switchTab('settings')
    expect(nav.activeTab.value).toBe('settings')
  })

  // --- Present / dismiss ---

  it('presents an overlay', () => {
    nav.present('detail', {
      installation: fakeInstallation,
      initialTab: 'status',
      autoAction: null,
    })
    expect(nav.overlays.value).toHaveLength(1)
    expect(nav.overlays.value[0]!.key).toBe('detail')
    expect(nav.overlays.value[0]!.mode).toBe('modal')
    expect(nav.topOverlay.value?.key).toBe('detail')
  })

  it('isOpen returns true for presented overlays', () => {
    expect(nav.isOpen('detail')).toBe(false)
    nav.present('detail', {
      installation: fakeInstallation,
    })
    expect(nav.isOpen('detail')).toBe(true)
  })

  it('dismisses an overlay by key', () => {
    nav.present('detail', { installation: fakeInstallation })
    nav.dismiss('detail')
    expect(nav.overlays.value).toHaveLength(0)
    expect(nav.isOpen('detail')).toBe(false)
  })

  it('dismisses the top overlay', () => {
    nav.present('detail', { installation: fakeInstallation })
    nav.present('console', { installationId: 'inst-1' })
    nav.dismissTop()
    expect(nav.overlays.value).toHaveLength(1)
    expect(nav.overlays.value[0]!.key).toBe('detail')
  })

  it('dismissAll clears all overlays', () => {
    nav.present('detail', { installation: fakeInstallation })
    nav.present('console', { installationId: 'inst-1' })
    nav.dismissAll()
    expect(nav.overlays.value).toHaveLength(0)
  })

  // --- Strategies ---

  it('push deduplicates by key', () => {
    nav.present('detail', {
      installation: fakeInstallation,
      initialTab: 'status',
    })
    nav.present('detail', {
      installation: { ...fakeInstallation, id: 'inst-2' },
      initialTab: 'updates',
    })
    expect(nav.overlays.value).toHaveLength(1)
    expect(nav.overlays.value[0]!.props).toHaveProperty('initialTab', 'updates')
  })

  it('replace-top replaces the top entry', () => {
    nav.present('detail', { installation: fakeInstallation })
    nav.present('console', { installationId: 'inst-1' })
    nav.present('progress', { installationId: 'inst-1' }, { strategy: 'replace-top' })
    expect(nav.overlays.value).toHaveLength(2)
    expect(nav.overlays.value[0]!.key).toBe('detail')
    expect(nav.overlays.value[1]!.key).toBe('progress')
  })

  it('replace-all replaces entire stack', () => {
    nav.present('detail', { installation: fakeInstallation })
    nav.present('console', { installationId: 'inst-1' })
    nav.present('progress', { installationId: 'inst-1' }, { strategy: 'replace-all' })
    expect(nav.overlays.value).toHaveLength(1)
    expect(nav.overlays.value[0]!.key).toBe('progress')
  })

  // --- Mode ---

  it('respects mode option', () => {
    nav.present('detail', { installation: fakeInstallation }, { mode: 'fullscreen' })
    expect(nav.overlays.value[0]!.mode).toBe('fullscreen')
  })

  // --- Patch ---

  it('patches overlay props', () => {
    nav.present('detail', {
      installation: fakeInstallation,
      initialTab: 'status',
      autoAction: null,
    })
    nav.patchOverlay('detail', { initialTab: 'updates' })
    expect(nav.overlays.value[0]!.props).toHaveProperty('initialTab', 'updates')
  })

  it('patch is a no-op for missing keys', () => {
    nav.patchOverlay('detail', { initialTab: 'updates' })
    expect(nav.overlays.value).toHaveLength(0)
  })

  // --- Controller registry ---

  it('registerController + invokeWhenReady (already registered)', async () => {
    const controller = { refresh: vi.fn() }
    nav.registerController('list', controller)
    await nav.invokeWhenReady('list', (c) => c.refresh())
    expect(controller.refresh).toHaveBeenCalled()
  })

  it('invokeWhenReady waits for nextTick registration', async () => {
    const controller = { loadSettings: vi.fn() }
    const promise = nav.invokeWhenReady('settings', (c) => c.loadSettings())
    // Register after invokeWhenReady was called but before the tick settles.
    await nextTick()
    nav.registerController('settings', controller)
    await promise
    expect(controller.loadSettings).toHaveBeenCalled()
  })

  it('invokeWhenReady queues and flushes on late registration', async () => {
    const controller = { open: vi.fn() }
    // Fire invokeWhenReady — controller is not registered yet.
    const promise = nav.invokeWhenReady('new-install', (c) => c.open())
    await nextTick()
    // Still not registered — should be queued.
    expect(controller.open).not.toHaveBeenCalled()
    // Now register — should flush the queue.
    nav.registerController('new-install', controller)
    await promise
    expect(controller.open).toHaveBeenCalled()
  })

  it('unregisters controller with null', () => {
    const controller = { refresh: vi.fn() }
    nav.registerController('list', controller)
    nav.registerController('list', null)
    // invokeWhenReady should not find it synchronously.
    let called = false
    nav.invokeWhenReady('list', () => { called = true })
    expect(called).toBe(false)
  })

  // --- Edge cases ---

  it('dismissTop on empty stack is a no-op', () => {
    expect(() => nav.dismissTop()).not.toThrow()
    expect(nav.overlays.value).toHaveLength(0)
  })

  it('topOverlay is null when stack is empty', () => {
    expect(nav.topOverlay.value).toBeNull()
  })

  it('propless overlays work', () => {
    nav.present('new-install', {})
    expect(nav.overlays.value).toHaveLength(1)
    expect(nav.overlays.value[0]!.key).toBe('new-install')
  })
})
