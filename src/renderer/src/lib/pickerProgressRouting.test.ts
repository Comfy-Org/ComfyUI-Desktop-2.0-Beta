import { describe, expect, it } from 'vitest'
import { resolveProgressRouting } from './pickerProgressRouting'
import type { ShowProgressOpts } from '../types/ipc'

/**
 * Each scenario below names a real bug we hit during the picker-progress
 * implementation. The resolver was reworked multiple times because the
 * original policy keyed on `triggersInstanceStart` (which Update on a
 * running install also sets, as a side-effect of its auto-relaunch
 * step) — the regression cluster below is what catches that mistake
 * if anyone reaches for the same shortcut again.
 */
function opts(overrides: Partial<ShowProgressOpts> = {}): ShowProgressOpts {
  return {
    installationId: 'inst-target',
    title: 'Update ComfyUI — Target',
    apiCall: async () => ({ ok: true }),
    actionId: 'update-comfyui',
    opKind: 'update',
    ...overrides,
  }
}

describe('resolveProgressRouting — same vs target host', () => {
  it('routes same-host when the picker host already owns the target install', () => {
    const r = resolveProgressRouting(opts({ installationId: 'inst-A' }), 'inst-A')
    expect(r.routing).toBe('same-host')
  })

  it('routes target-host when picker host differs from the target install', () => {
    const r = resolveProgressRouting(opts({ installationId: 'inst-B' }), 'inst-A')
    expect(r.routing).toBe('target-host')
  })

  it('routes target-host when the picker has no host install (dashboard chooser invocation)', () => {
    const r = resolveProgressRouting(opts({ installationId: 'inst-B' }), null)
    expect(r.routing).toBe('target-host')
  })
})

describe('resolveProgressRouting — successChoice gating', () => {
  it('offers successChoice for plain Update on a stopped install', () => {
    const r = resolveProgressRouting(
      opts({ actionId: 'update-comfyui', triggersInstanceStart: false }),
      'inst-target',
    )
    expect(r.successChoice).toBe(true)
  })

  // The bug that motivated this whole test file: `useComfyUISettings`
  // step 9 sets `triggersInstanceStart: true` for an Update against a
  // running install because the apiCall self-relaunches comfy after
  // applying the update. An earlier resolver suppressed `successChoice`
  // on `triggersInstanceStart`, which meant same-instance Update on a
  // running install lost its terminal-state screen and auto-closed
  // mid-relaunch — user saw "stuck at 100% then vanishes". The fix
  // discriminates on `actionId`, not on the auto-relaunch side-effect.
  it('keeps successChoice for Update on a running install (the auto-relaunch must not suppress)', () => {
    const r = resolveProgressRouting(
      opts({
        actionId: 'update-comfyui',
        triggersInstanceStart: true,
      }),
      'inst-target',
    )
    expect(r.successChoice).toBe(true)
  })

  it('keeps successChoice for copy-update and switch-channel', () => {
    expect(resolveProgressRouting(opts({ actionId: 'copy-update' }), 'inst-target').successChoice)
      .toBe(true)
    expect(resolveProgressRouting(opts({ actionId: 'switch-channel' }), 'inst-target').successChoice)
      .toBe(true)
  })

  it('keeps successChoice for snapshot-save', () => {
    const r = resolveProgressRouting(opts({ actionId: 'snapshot-save', opKind: 'snapshot' }), 'inst-target')
    expect(r.successChoice).toBe(true)
  })

  it('suppresses successChoice for actionId launch (user is going to land in Comfy regardless)', () => {
    const r = resolveProgressRouting(
      opts({ actionId: 'launch', opKind: 'launch', triggersInstanceStart: true }),
      'inst-target',
    )
    expect(r.successChoice).toBe(false)
  })

  it('suppresses successChoice for actionId restart', () => {
    const r = resolveProgressRouting(
      opts({ actionId: 'restart', opKind: 'launch', triggersInstanceStart: true }),
      'inst-target',
    )
    expect(r.successChoice).toBe(false)
  })
})

describe('resolveProgressRouting — destructive ops', () => {
  // Spec carve-out: destroying an install we're about to remove must
  // stay in the current host. Spawning a window for an install that's
  // about to vanish would race the registry teardown and leave a
  // ghost.
  it('forces same-host for destructive ops even when picker is on a different host', () => {
    const r = resolveProgressRouting(
      opts({
        installationId: 'inst-B',
        actionId: 'delete',
        opKind: 'destructive',
        destroysInstance: true,
      }),
      'inst-A',
    )
    expect(r.routing).toBe('same-host')
  })

  it('suppresses successChoice for destructive ops (nothing to open afterwards)', () => {
    const r = resolveProgressRouting(
      opts({
        actionId: 'delete',
        opKind: 'destructive',
        destroysInstance: true,
      }),
      'inst-target',
    )
    expect(r.successChoice).toBe(false)
  })
})
