import { createTestingPinia } from '@pinia/testing'
import { setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}))

vi.mock('./useModal', () => ({
  useModal: () => ({
    confirm: vi.fn(),
    prompt: vi.fn(),
    select: vi.fn(),
    confirmWithOptions: vi.fn(),
    alert: vi.fn(),
  }),
}))

vi.mock('./useActionGuard', () => ({
  useActionGuard: () => ({
    checkBeforeAction: vi.fn().mockResolvedValue('proceed'),
  }),
}))

vi.mock('./useMigrateAction', () => ({
  useMigrateAction: () => ({
    confirmMigration: vi.fn(),
  }),
}))

vi.mock('../lib/telemetry', () => ({
  emitTelemetryAction: vi.fn(),
  toErrorBucket: () => 'other',
}))

import { useComfyUISettings } from './useComfyUISettings'
import type { DetailSection, Installation } from '../types/ipc'

function makeInstall(id: string, name: string): Installation {
  return {
    id,
    name,
    sourceLabel: 'standalone',
    sourceCategory: 'local',
    status: 'installed',
    installPath: `/tmp/${id}`,
  } as Installation
}

function makeSection(installName: string): DetailSection {
  // Stamp the section title with the install name so test assertions
  // can distinguish "install A's payload" from "install B's payload".
  return {
    tab: 'status',
    title: `Sections for ${installName}`,
    fields: [],
  } as DetailSection
}

interface MockApi {
  getDetailSections: ReturnType<typeof vi.fn>
  getDiskSpace: ReturnType<typeof vi.fn>
}

function installMockApi(overrides: Partial<MockApi> = {}): MockApi {
  const api: MockApi = {
    getDetailSections: vi.fn().mockResolvedValue([]),
    getDiskSpace: vi.fn().mockResolvedValue(null),
    ...overrides,
  }
  ;(window as unknown as { api: MockApi }).api = api
  return api
}

describe('useComfyUISettings — staleness clearing (regression for #582)', () => {
  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }))
  })

  it('clears sections + diskSpace synchronously when the install id changes so the old install\'s data does not flash', async () => {
    // Two installs with distinct section payloads. The IPC for install B
    // is held open until we explicitly resolve it — this models the
    // real disk-bound delay in `getDetailSections` for an install with
    // many snapshots.
    let resolveB: ((value: DetailSection[]) => void) | null = null
    const sectionsB = new Promise<DetailSection[]>((resolve) => {
      resolveB = resolve
    })

    const api = installMockApi({
      getDetailSections: vi.fn((id: string) => {
        if (id === 'a') return Promise.resolve([makeSection('A')])
        if (id === 'b') return sectionsB
        return Promise.resolve([])
      }),
    })

    const installation = ref<Installation | null>(makeInstall('a', 'A'))
    const onShowProgress = vi.fn()

    const scope = effectScope()
    let composable!: ReturnType<typeof useComfyUISettings>
    scope.run(() => {
      composable = useComfyUISettings({ installation, onShowProgress })
    })

    // Initial load (install A) resolves immediately.
    await nextTick()
    await Promise.resolve() // flush microtasks for the await chain in loadAll
    await Promise.resolve()
    expect(composable.sections.value.map((s) => s.title)).toEqual([
      'Sections for A',
    ])

    // Now switch to install B. The watcher fires `reload(B)` which
    // calls `loadAll('b', ...)`. The fix clears `sections.value`
    // BEFORE awaiting, so the next microtask should already see an
    // empty sections array (and `loading: true`).
    installation.value = makeInstall('b', 'B')
    await nextTick()

    expect(composable.loading.value).toBe(true)
    expect(composable.sections.value).toEqual([])
    expect(composable.diskSpace.value).toBeNull()

    // Resolve install B's IPC; sections + loading flip to the new
    // payload.
    resolveB!([makeSection('B')])
    await Promise.resolve()
    await Promise.resolve()
    await nextTick()

    expect(composable.loading.value).toBe(false)
    expect(composable.sections.value.map((s) => s.title)).toEqual([
      'Sections for B',
    ])
    expect(api.getDetailSections).toHaveBeenCalledTimes(2)
    scope.stop()
  })

  it('clears sections when the installation prop is set to null', async () => {
    installMockApi({
      getDetailSections: vi.fn().mockResolvedValue([makeSection('A')]),
    })
    const installation = ref<Installation | null>(makeInstall('a', 'A'))
    const onShowProgress = vi.fn()

    const scope = effectScope()
    let composable!: ReturnType<typeof useComfyUISettings>
    scope.run(() => {
      composable = useComfyUISettings({ installation, onShowProgress })
    })

    await nextTick()
    await Promise.resolve()
    await Promise.resolve()
    expect(composable.sections.value.length).toBeGreaterThan(0)

    installation.value = null
    await nextTick()
    expect(composable.sections.value).toEqual([])
    expect(composable.diskSpace.value).toBeNull()
    scope.stop()
  })

  it('does NOT clear sections on a same-install reload (only on install switches)', async () => {
    // Same-install reloads happen after `updateField` / action completion.
    // Blanking the pane in that case would be a regression — the user
    // would see Loading… flash for an edit they didn't expect to clear
    // the view. Switching installs is the only trigger for the clear.
    let getCallCount = 0
    installMockApi({
      getDetailSections: vi.fn(() => {
        getCallCount++
        return Promise.resolve([makeSection(`A-call-${getCallCount}`)])
      }),
    })
    const installation = ref<Installation | null>(makeInstall('a', 'A'))
    const onShowProgress = vi.fn()

    const scope = effectScope()
    let composable!: ReturnType<typeof useComfyUISettings>
    scope.run(() => {
      composable = useComfyUISettings({ installation, onShowProgress })
    })

    await nextTick()
    await Promise.resolve()
    await Promise.resolve()
    expect(composable.sections.value.map((s) => s.title)).toEqual(['Sections for A-call-1'])

    // Second reload for the SAME install. Should NOT blank the pane
    // mid-flight; sections.value stays at the previous payload until
    // the new one arrives.
    await composable.reload()
    expect(composable.sections.value.length).toBeGreaterThan(0)
    expect(composable.sections.value.map((s) => s.title)).toEqual(['Sections for A-call-2'])

    scope.stop()
  })

  it('discards an out-of-order older response (A → B → A returning B late)', async () => {
    // Three resolvers — A1 resolves immediately, then we switch to B
    // (resolveB held open), then back to A2 (immediate). When B finally
    // resolves AFTER A2, its sections must NOT overwrite A2's payload.
    let resolveB: ((value: DetailSection[]) => void) | null = null
    const sectionsB = new Promise<DetailSection[]>((resolve) => {
      resolveB = resolve
    })
    const api = installMockApi({
      getDetailSections: vi.fn((id: string) => {
        if (id === 'a') return Promise.resolve([makeSection('A')])
        if (id === 'b') return sectionsB
        return Promise.resolve([])
      }),
    })

    const installation = ref<Installation | null>(makeInstall('a', 'A'))
    const scope = effectScope()
    let composable!: ReturnType<typeof useComfyUISettings>
    scope.run(() => {
      composable = useComfyUISettings({ installation, onShowProgress: vi.fn() })
    })

    await nextTick()
    await Promise.resolve()
    await Promise.resolve()

    // Switch to B — fetch held open.
    installation.value = makeInstall('b', 'B')
    await nextTick()

    // Switch back to A — A's IPC resolves immediately, sections=A.
    installation.value = makeInstall('a', 'A')
    await nextTick()
    await Promise.resolve()
    await Promise.resolve()
    expect(composable.sections.value.map((s) => s.title)).toEqual(['Sections for A'])
    expect(composable.loading.value).toBe(false)

    // Now resolve B late. The request-sequence guard must drop the
    // result so it never overwrites A's payload or flips loading.
    resolveB!([makeSection('B')])
    await Promise.resolve()
    await Promise.resolve()
    await nextTick()

    expect(composable.sections.value.map((s) => s.title)).toEqual(['Sections for A'])
    expect(composable.loading.value).toBe(false)
    expect(api.getDetailSections).toHaveBeenCalledTimes(3)
    scope.stop()
  })
})
