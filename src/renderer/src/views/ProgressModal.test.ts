import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import ProgressModal from './ProgressModal.vue'
import { useProgressStore } from '../stores/progressStore'
import type { Operation } from '../stores/progressStore'
import type { ActionResult, PortConflictInfo } from '../types/ipc'

// Each spec snaps a synthetic op into `progressStore.operations` to lock
// a precise state and assert what renders, bypassing `startOperation`.
const messages = {
  en: {
    common: {
      copy: 'Copy',
      cancel: 'Cancel',
      back: 'Back',
    },
    dashboard: {
      confirmStopLocal: {
        title: 'Return to Dashboard?',
        message: 'This will stop the current ComfyUI.',
        confirmLabel: 'Return to Dashboard',
      },
    },
    progress: {
      working: 'Working…',
      starting: 'Starting…',
      cancelling: 'Cancelling…',
      completedSuccess: 'Completed successfully',
      completedError: 'Operation failed',
      completedCancelled: 'Operation was cancelled',
      returnToDashboard: 'Return to Dashboard',
      reboot: 'Reboot',
      phaseLabel: {
        download: 'Downloading ComfyUI…',
      },
    },
    launch: {
      viewLogs: 'View logs',
    },
    errors: {
      portConflictTitle: 'Port already in use',
      portConflictUsePort: 'Use next available port',
      portConflictKill: 'Stop process and retry',
    },
  },
}

function createTestI18n() {
  return createI18n({ legacy: false, locale: 'en', messages })
}

interface MockApi {
  onInstallProgress: ReturnType<typeof vi.fn>
  onComfyOutput: ReturnType<typeof vi.fn>
  onErrorDetail: ReturnType<typeof vi.fn>
  cancelOperation: ReturnType<typeof vi.fn>
  stopComfyUI: ReturnType<typeof vi.fn>
  runAction: ReturnType<typeof vi.fn>
  killPortProcess: ReturnType<typeof vi.fn>
  returnToDashboard: ReturnType<typeof vi.fn>
  getInstallations: ReturnType<typeof vi.fn>
  onInstallationsChanged: ReturnType<typeof vi.fn>
  onInstallationsVersionsUpdated: ReturnType<typeof vi.fn>
}

function installMockApi(overrides: Partial<MockApi> = {}): MockApi {
  const api: MockApi = {
    onInstallProgress: vi.fn(() => () => {}),
    onComfyOutput: vi.fn(() => () => {}),
    onErrorDetail: vi.fn(() => () => {}),
    cancelOperation: vi.fn().mockResolvedValue(undefined),
    stopComfyUI: vi.fn().mockResolvedValue(undefined),
    runAction: vi.fn().mockResolvedValue({ ok: true }),
    killPortProcess: vi.fn().mockResolvedValue({ ok: true }),
    returnToDashboard: vi.fn().mockResolvedValue(true),
    getInstallations: vi.fn().mockResolvedValue([]),
    onInstallationsChanged: vi.fn(() => () => {}),
    onInstallationsVersionsUpdated: vi.fn(() => () => {}),
    ...overrides,
  }
  ;(window as unknown as { api: MockApi }).api = api
  return api
}

/** Snap a synthetic op into the store. Must be called AFTER mount — the
 *  store's setup calls `useI18n()`, which needs the app context. */
function snapOp(installationId: string, patch: Partial<Operation> = {}): Operation {
  const store = useProgressStore()
  const op: Operation = {
    title: 'Deleting — My Install',
    returnTo: 'list',
    opKind: 'destructive',
    destroysInstance: false,
    chainSpan: null,
    steps: null,
    activePhase: null,
    activePercent: -1,
    lastStatus: {},
    flatStatus: 'Working…',
    flatPercent: -1,
    terminalOutput: '',
    done: false,
    error: null,
    finished: false,
    cancelRequested: false,
    result: null,
    unsubProgress: null,
    unsubOutput: null,
    apiCall: null,
    _globalFloor: 0,
    ...patch,
  }
  store.operations.set(installationId, op)
  return op
}

/** Mount with `installationId: null` so nothing renders yet, giving an
 *  active i18n context for `snapOp` before flipping `installation-id`. */
function mountProgress() {
  return mount(ProgressModal, {
    props: { installationId: null },
    global: { plugins: [createTestI18n()] },
  })
}

/** Mount, snap an op, then surface it via `installation-id`. Returns
 *  body-scoped accessors because the takeover teleports its tree to
 *  `document.body`, where `wrapper.find()` can't see it. */
async function mountWithOp(
  installationId: string,
  patch: Partial<Operation> = {},
): Promise<{
  wrapper: ReturnType<typeof mountProgress>
  body: BodyHelpers
}> {
  const wrapper = mountProgress()
  snapOp(installationId, patch)
  await wrapper.setProps({ installationId })
  await flushPromises()
  return { wrapper, body: makeBodyHelpers() }
}

interface BodyHelpers {
  exists: (selector: string) => boolean
  text: () => string
  selectorText: (selector: string) => string
  classList: (selector: string) => string[]
  click: (selector: string) => Promise<boolean>
  buttonByText: (snippet: string) => HTMLButtonElement | null
}

function makeBodyHelpers(): BodyHelpers {
  return {
    exists: (selector) => document.body.querySelector(selector) !== null,
    text: () => document.body.textContent ?? '',
    selectorText: (selector) =>
      document.body.querySelector(selector)?.textContent ?? '',
    classList: (selector) => {
      const el = document.body.querySelector(selector)
      return el ? Array.from(el.classList) : []
    },
    click: async (selector) => {
      const el = document.body.querySelector(selector) as HTMLElement | null
      if (!el) return false
      el.click()
      await flushPromises()
      return true
    },
    buttonByText: (snippet) => {
      const buttons = Array.from(document.body.querySelectorAll('button'))
      return (
        (buttons.find((b) => b.textContent?.includes(snippet)) as
          | HTMLButtonElement
          | undefined) ?? null
      )
    },
  }
}

afterEach(() => {
  // The teleported takeover survives wrapper unmount; wipe it so the
  // next spec starts on a clean DOM.
  document.body.innerHTML = ''
})

describe('ProgressModal — brand branch state transitions', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    installMockApi()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders in-flight state with a Return to Dashboard button and no banner', async () => {
    const { body } = await mountWithOp('inst-1', {
      flatStatus: 'Deleting installation…',
      flatPercent: 42,
    })

    expect(body.exists('.brand-progress__banner')).toBe(false)
    expect(body.exists('.brand-progress__error-message')).toBe(false)
    expect(body.exists('.brand-progress__bar')).toBe(true)

    expect(body.exists('.brand-progress__footer')).toBe(true)
    expect(body.selectorText('.brand-progress__footer')).toContain('Return to Dashboard')
    expect(body.selectorText('.brand-progress__footer')).not.toContain('Minimize')
    expect(body.selectorText('.brand-progress__footer')).not.toContain('Reboot')
  })

  it('renders the success banner on a finished+ok op and auto-closes after the grace delay', async () => {
    const { wrapper, body } = await mountWithOp('inst-1', {
      finished: true,
      result: { ok: true } as ActionResult,
    })

    expect(body.exists('.brand-progress__banner')).toBe(true)
    expect(body.classList('.brand-progress__banner')).toContain('brand-progress__banner--success')
    expect(body.selectorText('.brand-progress__banner')).toContain('Completed successfully')

    // No action buttons during auto-close; the footer band stays mounted
    // (it hosts the logs accordion), so assert on the buttons specifically.
    expect(body.exists('.brand-progress__footer-btn')).toBe(false)

    // Auto-close fires after ~700ms and emits `close`.
    vi.advanceTimersByTime(800)
    await flushPromises()
    expect(wrapper.emitted('close')?.length).toBeGreaterThan(0)
  })

  it('renders the cancelled banner with no buttons and auto-closes', async () => {
    const { wrapper, body } = await mountWithOp('inst-1', {
      finished: true,
      cancelRequested: true,
      result: { cancelled: true } as ActionResult,
    })

    expect(body.exists('.brand-progress__banner')).toBe(true)
    expect(body.classList('.brand-progress__banner')).toContain('brand-progress__banner--cancelled')
    expect(body.selectorText('.brand-progress__banner')).toContain('Operation was cancelled')
    expect(body.exists('.brand-progress__footer-btn')).toBe(false)

    vi.advanceTimersByTime(800)
    await flushPromises()
    expect(wrapper.emitted('close')?.length).toBeGreaterThan(0)
  })

  it('renders the error banner + error message + Back + Reboot, and does NOT auto-close', async () => {
    const { wrapper, body } = await mountWithOp('inst-1', {
      finished: true,
      error: 'Disk write failed: ENOSPC',
    })

    expect(body.exists('.brand-progress__banner')).toBe(true)
    expect(body.classList('.brand-progress__banner')).toContain('brand-progress__banner--error')
    expect(body.selectorText('.brand-progress__banner')).toContain('Operation failed')

    expect(body.exists('.brand-progress__error-message')).toBe(true)
    expect(body.selectorText('.brand-progress__error-message')).toContain(
      'Disk write failed: ENOSPC',
    )
    // Test-id exposes the element for e2e overflow assertions.
    expect(body.exists('[data-testid="progress-error-message"]')).toBe(true)

    expect(body.exists('.brand-progress__error-copy')).toBe(true)

    // Error CTAs live in the centered hero stack, not the footer.
    expect(body.exists('.brand-progress__error-actions')).toBe(true)
    expect(body.selectorText('.brand-progress__error-actions')).toContain('Reboot')
    expect(body.selectorText('.brand-progress__error-actions')).toContain('Back')
    expect(body.selectorText('.brand-progress__footer')).not.toContain('Reboot')

    // Errors stay mounted, so no close emit even past the grace window.
    vi.advanceTimersByTime(2000)
    await flushPromises()
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('renders the port-conflict banner and dual-action footer for an unresolved port collision', async () => {
    const portConflict: PortConflictInfo = {
      port: 8188,
      nextPort: 8189,
      isComfy: true,
    }
    const { wrapper, body } = await mountWithOp('inst-1', {
      finished: true,
      error: null,
      result: {
        ok: false,
        message: 'Port 8188 is already in use by Comfy Desktop',
        portConflict,
      } as ActionResult,
    })

    // Banner swaps to the port-specific copy instead of the generic
    // "Operation failed" string used for regular errors.
    expect(body.exists('.brand-progress__banner')).toBe(true)
    expect(body.selectorText('.brand-progress__banner')).toContain('Port already in use')
    expect(body.selectorText('.brand-progress__banner')).not.toContain('Operation failed')

    // Detail line carries the server-side message (with port filled in).
    expect(body.selectorText('.brand-progress__error-message')).toContain(
      'Port 8188 is already in use',
    )

    // Footer carries Return-to-Dashboard alongside Use-Port + Kill-Process
    // so the user is never stuck on the conflict screen.
    expect(body.exists('.brand-progress__footer')).toBe(true)
    expect(body.selectorText('.brand-progress__footer')).toContain('Return to Dashboard')
    expect(body.selectorText('.brand-progress__footer')).toContain('Use next available port')
    expect(body.selectorText('.brand-progress__footer')).toContain('Stop process and retry')

    // Port conflict is explicitly excluded from auto-close so the user
    // has time to pick a resolution.
    vi.advanceTimersByTime(2000)
    await flushPromises()
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('renders only the Use-Port action when the conflicting process is not a Comfy instance', async () => {
    const portConflict: PortConflictInfo = {
      port: 8188,
      nextPort: 8189,
      isComfy: false,
    }
    const { body } = await mountWithOp('inst-1', {
      finished: true,
      result: {
        ok: false,
        message: 'Port 8188 is already in use',
        portConflict,
      } as ActionResult,
    })

    expect(body.selectorText('.brand-progress__footer')).toContain('Use next available port')
    // Kill-Process is only shown when the offender is itself a Comfy
    // process — there's nothing safe to suggest killing otherwise.
    expect(body.selectorText('.brand-progress__footer')).not.toContain('Stop process and retry')
    // Return-to-Dashboard is always present so non-Comfy conflicts still
    // have a non-destructive escape.
    expect(body.selectorText('.brand-progress__footer')).toContain('Return to Dashboard')
  })

  it('renders only Return to Dashboard when a port conflict has no suggested fix', async () => {
    // Worst-case: main couldn't find a next port and the offender isn't
    // ComfyUI. Without the back button the user is stuck on the takeover.
    const portConflict: PortConflictInfo = {
      port: 8188,
      isComfy: false,
    }
    const { body } = await mountWithOp('inst-1', {
      finished: true,
      result: {
        ok: false,
        message: 'Port 8188 is already in use',
        portConflict,
      } as ActionResult,
    })

    expect(body.exists('.brand-progress__footer')).toBe(true)
    expect(body.selectorText('.brand-progress__footer')).toContain('Return to Dashboard')
    expect(body.selectorText('.brand-progress__footer')).not.toContain('Use next available port')
    expect(body.selectorText('.brand-progress__footer')).not.toContain('Stop process and retry')

    const api = (window as unknown as { api: MockApi }).api
    expect(await body.click('.brand-progress__footer-bar button')).toBe(true)
    expect(api.returnToDashboard).toHaveBeenCalledTimes(1)
  })

  it('renders Cancel (not Return to Dashboard) in flight for destroy ops', async () => {
    const { body } = await mountWithOp('inst-1', {
      destroysInstance: true,
      flatStatus: 'Deleting installation…',
      flatPercent: 30,
    })
    expect(body.exists('.brand-progress__footer')).toBe(true)
    expect(body.selectorText('.brand-progress__footer')).toContain('Cancel')
    expect(body.selectorText('.brand-progress__footer')).not.toContain('Return to Dashboard')
  })

  it('renders Back (no Reboot) on a destroy op error', async () => {
    const { body } = await mountWithOp('inst-1', {
      destroysInstance: true,
      finished: true,
      error: 'Partial delete failed',
    })
    // Destroy ops can't be rebooted, so only Back renders (as primary)
    // in the centered error-actions row.
    expect(body.exists('.brand-progress__error-actions')).toBe(true)
    expect(body.selectorText('.brand-progress__error-actions')).toContain('Back')
    expect(body.selectorText('.brand-progress__error-actions')).not.toContain('Reboot')
  })

  it('cancels the in-flight destroy op and emits close when Cancel is clicked', async () => {
    const { wrapper, body } = await mountWithOp('inst-1', {
      destroysInstance: true,
      flatStatus: 'Deleting installation…',
      flatPercent: 30,
    })
    const cancelBtn = body.buttonByText('Cancel')
    expect(cancelBtn).not.toBeNull()
    cancelBtn!.click()
    await flushPromises()
    expect(wrapper.emitted('close')?.length).toBeGreaterThan(0)
    const store = useProgressStore()
    const op = store.operations.get('inst-1')
    expect(op?.cancelRequested).toBe(true)
  })

  it('auto-detaches the host on destroy-op success before the takeover auto-closes', async () => {
    const { wrapper } = await mountWithOp('inst-1', {
      destroysInstance: true,
      finished: true,
      result: { ok: true, navigate: 'list' } as ActionResult,
    })
    vi.advanceTimersByTime(800)
    await flushPromises()
    expect(wrapper.emitted('close')?.length).toBeGreaterThan(0)
    const api = (window as unknown as { api: MockApi }).api
    expect(api.returnToDashboard).toHaveBeenCalled()
  })

  it('emits close, cancels the in-flight op, and calls returnToDashboard when the in-flight Return button is clicked', async () => {
    const { wrapper, body } = await mountWithOp('inst-1', {
      flatStatus: 'Deleting installation…',
      flatPercent: 42,
    })

    const returnBtn = body.buttonByText('Return to Dashboard')
    expect(returnBtn).not.toBeNull()
    returnBtn!.click()
    await flushPromises()

    expect(wrapper.emitted('close')?.length).toBeGreaterThan(0)
    // No installation in the store for inst-1 so the confirm is skipped
    // and the in-flight op is cancelled.
    const store = useProgressStore()
    const op = store.operations.get('inst-1')
    expect(op?.cancelRequested).toBe(true)
    const api = (window as unknown as { api: MockApi }).api
    expect(api.returnToDashboard).toHaveBeenCalled()
  })

  it('uses friendlyCaption (not launchCaption) for non-launch ops', async () => {
    // Resolves through `progress.phaseLabel.download`, not the launch caption.
    const { body } = await mountWithOp('inst-1', {
      opKind: 'destructive',
      steps: [
        { phase: 'download', label: 'Download' },
        { phase: 'cleanup', label: 'Cleanup' },
      ],
      activePhase: 'download',
      activePercent: 25,
      lastStatus: { download: '312 / 2100 MB · 18 MB/s · ~2m remaining' },
    })

    expect(body.text()).toContain('Downloading ComfyUI…')
    // Launch-only narrative phrases must never show for non-launch ops.
    expect(body.text()).not.toContain('Mounting model libraries')
    expect(body.text()).not.toContain('Security scan')
  })

  it('uses registered step label as the headline and hides the substatus when no rich detail was sent', async () => {
    // Adopt/migration flow path: main registers steps with friendly
    // labels but emits `sendProgress(phase, { percent })` without a
    // `status` string. Without this guard the headline fell through to
    // the raw phase id ("source") and the substatus duplicated it.
    const { body } = await mountWithOp('inst-1', {
      opKind: 'install',
      steps: [{ phase: 'source', label: 'Stage ComfyUI source' }],
      activePhase: 'source',
      activePercent: 10,
      // progressStore writes `data.status || data.phase`, so the raw id
      // is what lands here when main sends no status string.
      lastStatus: { source: 'source' },
    })

    expect(body.text()).toContain('Stage ComfyUI source')
    expect(body.exists('.brand-progress__substatus')).toBe(false)
  })

  it('surfaces the rich main-side detail as a substatus under the curated headline', async () => {
    const { body } = await mountWithOp('inst-1', {
      opKind: 'install',
      steps: [{ phase: 'download', label: 'Download' }],
      activePhase: 'download',
      activePercent: 50,
      lastStatus: { download: '1050 / 2100 MB · 22 MB/s · ~1m remaining' },
    })

    expect(body.text()).toContain('Downloading ComfyUI…')
    // Substatus: `formattedSubStatus` locale-groups byte counts >= 4 digits
    // (`2100 MB` → `2,100 MB`); `1050` stays since it's followed by `/`.
    expect(body.exists('.brand-progress__substatus')).toBe(true)
    const subText = body.selectorText('.brand-progress__substatus')
    expect(subText).toContain('1050 / 2,100 MB')
    expect(subText).toContain('22 MB/s')
    expect(subText).toContain('~1m remaining')
  })
})

describe('ProgressModal — unified bar (install→launch chained 0→100)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    installMockApi()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function barWidth(): string {
    const el = document.body.querySelector('.brand-progress__bar-fill') as HTMLElement | null
    return el?.style.width ?? ''
  }
  function barPercent(): number {
    const m = barWidth().match(/^([\d.]+)%$/)
    return m ? Number(m[1]) : NaN
  }

  it('caps unifiedPercent at 70% for a chainSpan=install op even at 100% real progress', async () => {
    // The install leg maps its 0→100% into the bar's 0–70% slot, leaving
    // 30% for launch so the bar doesn't saturate mid-install.
    await mountWithOp('inst-chain-install', {
      opKind: 'install',
      chainSpan: 'install',
      steps: [{ phase: 'download', label: 'Download' }],
      activePhase: 'download',
      activePercent: 100,
      _globalFloor: 100,
    })
    expect(barPercent()).toBeCloseTo(70, 1)
  })

  it('renders the unified bar for launch ops (no separate stepper)', async () => {
    // Launch ops render the same bar element as install ops; only the
    // caption swaps to the rolling launchCaption.
    const { body } = await mountWithOp('inst-launch-bar', {
      opKind: 'launch',
      chainSpan: 'launch',
    })
    expect(body.exists('.brand-progress__bar')).toBe(true)
    expect(body.exists('.brand-progress__bar-fill')).toBe(true)
  })

  it('starts a chainSpan=launch op in the 70% region', async () => {
    // Launch leg → 70 + launchPercent*0.3; at start launchPercent ~= 0,
    // so the bar reads ~70% with no discontinuity from install.
    await mountWithOp('inst-chain-launch', {
      opKind: 'launch',
      chainSpan: 'launch',
    })
    expect(barPercent()).toBeGreaterThanOrEqual(70)
    expect(barPercent()).toBeLessThan(75)
  })

  it('rolls launchCaption through phases on the 900ms caption timer', async () => {
    // Each 900ms tick bumps captionFloor by 1 so every narrative phase gets
    // airtime even when stdout races ahead.
    const { body } = await mountWithOp('inst-launch-roll', { opKind: 'launch' })

    expect(body.selectorText('.brand-progress__caption')).toContain('security')
    vi.advanceTimersByTime(900 + 50)
    await flushPromises()
    expect(body.selectorText('.brand-progress__caption')).toMatch(/mount|librar/i)
  })

  it('snaps unifiedPercent toward 100 for chainSpan=launch when stdout signals server-ready', async () => {
    // The snap-to-100 fires only when both `launchActiveIndex === 4` and
    // `stdoutStep === 4`. The 1-per-tick clamp means captionFloor must
    // catch up first, so advance the timer before injecting the stdout
    // signal (mutating after mount mirrors production's IPC chunks).
    await mountWithOp('inst-launch-ready', {
      opKind: 'launch',
      chainSpan: 'launch',
      terminalOutput: '',
    })
    // Five ticks → captionFloor reaches 4.
    vi.advanceTimersByTime(900 * 5 + 100)
    await flushPromises()
    // Server-ready signal flips stdoutStep to 4 → unifiedPercent = 100.
    const store = useProgressStore()
    const op = store.operations.get('inst-launch-ready')!
    op.terminalOutput = 'Uvicorn running on http://127.0.0.1:8188\n'
    await flushPromises()
    // One launch-percent tick so the bar catches the new active index.
    vi.advanceTimersByTime(300)
    await flushPromises()
    expect(barPercent()).toBeCloseTo(100, 1)
  })

  it('uses friendlyCaption (not launchCaption) for non-launch ops', async () => {
    const { body } = await mountWithOp('inst-install-only', {
      opKind: 'install',
      steps: [{ phase: 'download', label: 'Download' }],
      activePhase: 'download',
      activePercent: 40,
    })
    // Install op with `activePhase=download` shows the curated
    // `progress.phaseLabel.download`, not the launch rolling caption.
    const caption = body.selectorText('.brand-progress__caption')
    expect(caption).toContain('Downloading')
    expect(caption).not.toMatch(/security scan|mount.*librar/i)
  })
})

describe('ProgressModal — error message styling (regression for #582)', () => {
  // jsdom can't compute layout, so parse the .vue `<style>` directly to
  // assert `.brand-progress__error-message` keeps its `max-height` +
  // `overflow-y` rules that stop long tracebacks stretching the takeover.

  // Resolved against cwd (not import.meta.url, which jsdom can mangle).
  const vueSource = readFileSync(
    path.resolve('src/renderer/src/views/ProgressModal.vue'),
    'utf8',
  )

  function extractRule(selector: string): string {
    // Anchor on a line start so we match the base rule, not a descendant override.
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`)
    const match = vueSource.match(re)
    if (!match) throw new Error(`CSS rule for "${selector}" not found in ProgressModal.vue`)
    return match[1]
  }

  it('bounds .brand-progress__error-message height so long errors do not stretch the takeover', () => {
    const body = extractRule('.brand-progress__error-message')
    expect(body).toMatch(/max-height:/)
    expect(body).toMatch(/overflow-y:\s*auto/)
  })
})
