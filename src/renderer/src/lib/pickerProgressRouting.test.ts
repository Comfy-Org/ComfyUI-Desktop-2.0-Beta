import { describe, expect, it } from 'vitest'
import { resolveProgressRouting } from './pickerProgressRouting'
import type { ShowProgressOpts } from '../types/ipc'

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

describe('resolveProgressRouting — same vs inline vs target', () => {
  it('routes inline-picker when the picker host already owns the target install (same-instance ops use inline too)', () => {
    const r = resolveProgressRouting(opts({ installationId: 'inst-A' }), 'inst-A')
    expect(r.routing).toBe('inline-picker')
  })

  it('routes inline-picker when picker host differs from the target install (bug fix: was opening new window for B)', () => {
    const r = resolveProgressRouting(opts({ installationId: 'inst-B' }), 'inst-A')
    expect(r.routing).toBe('inline-picker')
  })

  it('routes inline-picker when the picker has no host install (dashboard chooser invocation)', () => {
    const r = resolveProgressRouting(opts({ installationId: 'inst-B' }), null)
    expect(r.routing).toBe('inline-picker')
  })

  it('routes target-host for launch (intentional navigation to the target window)', () => {
    const r = resolveProgressRouting(
      opts({ actionId: 'launch', opKind: 'launch', triggersInstanceStart: true, installationId: 'inst-B' }),
      'inst-A',
    )
    expect(r.routing).toBe('target-host')
  })

  it('routes target-host for restart (intentional navigation)', () => {
    const r = resolveProgressRouting(
      opts({ actionId: 'restart', opKind: 'launch', triggersInstanceStart: true, installationId: 'inst-B' }),
      'inst-A',
    )
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

  // successChoice discriminates on actionId, not triggersInstanceStart, since
  // Update on a running install sets that flag as an auto-relaunch side-effect.
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

  it('keeps successChoice for cross-instance Update (inline-picker path)', () => {
    const r = resolveProgressRouting(
      opts({ actionId: 'update-comfyui', installationId: 'inst-B' }),
      'inst-A',
    )
    expect(r.routing).toBe('inline-picker')
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
