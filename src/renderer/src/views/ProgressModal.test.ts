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

/**
 * Vitest coverage for ProgressModal's brand-branch state machine. Each
 * spec drives a synthetic op through `progressStore.operations` (rather
 * than going through `startOperation` + a real `apiCall`) so we can
 * snap the op to a precise state and assert what renders. The branches
 * under test:
 *
 *   - in-flight                     → bar + caption + Return-to-Dashboard
 *   - finished success              → success banner + auto-close
 *   - finished error                → error banner + message + Copy +
 *                                     Reboot + Return-to-Dashboard
 *   - finished cancelled            → cancelled banner + auto-close
 *   - finished port conflict        → port banner + dual-action footer
 *
 * Gating rules are centralized in `isPortConflictOpen` and
 * `finishedErrorMessage` computeds; these specs are the regression
 * harness for those.
 */

// Minimal i18n catalog mirroring the keys the brand branch reads. We
// only need exact-match strings for assertions; missing keys fall back
// to the dotted path which we'd see in failed assertions anyway.
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

/**
 * Snap a synthetic op into the progress store. Bypasses
 * `startOperation`'s apiCall machinery so a spec can lock the op to a
 * precise state and assert what the template renders. The fields here
 * match `Operation` 1:1.
 *
 * Must be called AFTER the component is mounted — the store's setup
 * function calls `useI18n()`, which only works inside an active app
 * context. The component mount installs that context.
 */
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

/**
 * Mount with `installationId: null` so the component renders nothing
 * on first mount — no template branch reaches `currentOp`, so the
 * `useI18n()` call inside `useProgressStore.startOperation` never
 * fires. We can then snap an op into the store via `snapOp` and flip
 * `installation-id` to surface it, all inside the app's i18n context.
 */
function mountProgress() {
  return mount(ProgressModal, {
    props: { installationId: null },
    global: { plugins: [createTestI18n()] },
  })
}

/**
 * Helper that runs the full mount-then-snap dance for a single spec:
 * (1) mount with `installationId: null` so the template doesn't reach
 *     the store yet — that gives us an active i18n context.
 * (2) snap the op into the store while still inside that context.
 * (3) flip `installation-id` on the props so the template now finds
 *     the op and renders the matching state.
 *
 * Returns the wrapper plus convenience accessors that look against
 * `document.body` instead of the wrapper root. ProgressModal's
 * `BrandTakeoverLayout` teleports the rendered tree to body, so
 * `wrapper.find()` / `wrapper.text()` would return nothing for any
 * content inside the takeover.
 */
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
  // Teleported takeover stays attached to `document.body` across
  // wrapper unmounts — wipe it manually so the next spec starts on a
  // clean DOM and `body.text()` only sees the current spec's render.
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

    // No action buttons during the auto-close window — success self-dismisses.
    // The footer band itself stays mounted (it also hosts the logs accordion
    // after the redesign), so assert on the buttons specifically.
    expect(body.exists('.brand-progress__footer-btn')).toBe(false)

    // The auto-close watcher fires after ~700ms; advancing timers should
    // emit a `close` event so the host can tear down the takeover.
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
    // Test-id exposes the element for e2e selectors that need to assert
    // overflow / scrollability against the real layout (jsdom can't
    // compute scroll height).
    expect(body.exists('[data-testid="progress-error-message"]')).toBe(true)

    // Inline Copy button rides alongside the message body.
    expect(body.exists('.brand-progress__error-copy')).toBe(true)

    // Error CTAs now live in the centered hero stack (directly under the
    // error message), not the bottom-left footer — Back (ghost) on the
    // left, Reboot (primary) on the right.
    expect(body.exists('.brand-progress__error-actions')).toBe(true)
    expect(body.selectorText('.brand-progress__error-actions')).toContain('Reboot')
    expect(body.selectorText('.brand-progress__error-actions')).toContain('Back')
    expect(body.selectorText('.brand-progress__footer')).not.toContain('Reboot')

    // Errors stay mounted so the user can read / copy. Verify no close
    // emit fires even after we advance well past the grace window.
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
    // Stepped destructive op with the `download` phase active — should
    // resolve through `progress.phaseLabel.download`, NOT through the
    // launch caption pipeline ("Mounting model libraries…" etc.).
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
    // The launch-only narrative phrases must NEVER show up for non-
    // launch ops — this was the regression that motivated Phase 2.2.
    expect(body.text()).not.toContain('Mounting model libraries')
    expect(body.text()).not.toContain('Security scan')
  })

  it('surfaces the rich main-side detail as a substatus under the curated headline', async () => {
    const { body } = await mountWithOp('inst-1', {
      opKind: 'install',
      steps: [{ phase: 'download', label: 'Download' }],
      activePhase: 'download',
      activePercent: 50,
      lastStatus: { download: '1050 / 2100 MB · 22 MB/s · ~1m remaining' },
    })

    // Headline (curated label).
    expect(body.text()).toContain('Downloading ComfyUI…')
    // Substatus (rich main-side detail with bytes/speed/ETA). The view
    // runs `formattedSubStatus` over the raw string so byte counts >= 4
    // digits get locale grouping (`2100 MB` → `2,100 MB`) for readability.
    // `1050` stays as-is because it's followed by `/`, not a byte unit.
    expect(body.exists('.brand-progress__substatus')).toBe(true)
    const subText = body.selectorText('.brand-progress__substatus')
    expect(subText).toContain('1050 / 2,100 MB')
    expect(subText).toContain('22 MB/s')
    expect(subText).toContain('~1m remaining')
  })
})

describe('ProgressModal — unified bar (install→launch chained 0→100)', () => {
  beforeEach(() => {
    // Match the helpers the rest of this file's specs already use —
    // `createPinia` + `installMockApi` are what `beforeEach` at the top
    // of the brand-branch describe block runs.
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
    // The install leg of an install→launch chain maps its full 0→100%
    // into the unified bar's 0–70% slot, leaving the remaining 30% for
    // the launch leg. This is what stops the bar from saturating at 100
    // mid-install and then stalling there through the launch tail.
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
    // The single 0→100% bar spans the whole install→launch journey.
    // Launch ops render the SAME bar element as install ops — only the
    // caption underneath swaps to the rolling launchCaption.
    const { body } = await mountWithOp('inst-launch-bar', {
      opKind: 'launch',
      chainSpan: 'launch',
    })
    expect(body.exists('.brand-progress__bar')).toBe(true)
    expect(body.exists('.brand-progress__bar-fill')).toBe(true)
  })

  it('starts a chainSpan=launch op in the 70% region', async () => {
    // Launch leg of the chain → 70 + launchPercent*0.3. At
    // launchActiveIndex=0 and zero elapsed, launchPercent ~= 0, so the
    // bar reads ~70%. No discontinuity from where install left off.
    await mountWithOp('inst-chain-launch', {
      opKind: 'launch',
      chainSpan: 'launch',
    })
    expect(barPercent()).toBeGreaterThanOrEqual(70)
    expect(barPercent()).toBeLessThan(75)
  })

  it('rolls launchCaption through phases on the 900ms caption timer', async () => {
    // Standalone launch: each 900ms tick bumps captionFloor by 1, which
    // is what guarantees the narrative phases ("security scan", "mount
    // libraries") each get airtime even on fast machines where stdout
    // races ahead. The clamp logic lives in `launchActiveIndex`.
    const { body } = await mountWithOp('inst-launch-roll', { opKind: 'launch' })

    // Tick 0: securityScan.
    expect(body.selectorText('.brand-progress__caption')).toContain('security')
    vi.advanceTimersByTime(900 + 50)
    await flushPromises()
    // Tick 1: mountLibraries.
    expect(body.selectorText('.brand-progress__caption')).toMatch(/mount|librar/i)
  })

  it('snaps unifiedPercent toward 100 for chainSpan=launch when stdout signals server-ready', async () => {
    // Production sequence: launch starts → narrative phases tick along
    // on the 900ms timer → eventually "Uvicorn running on" arrives in
    // stdout. The snap-to-100 fires when BOTH `launchActiveIndex === 4`
    // AND `stdoutStep === 4`.
    //
    // The 1-per-tick clamp in `launchActiveIndex` means stdout alone
    // can't fast-forward to row 4 — captionFloor has to catch up.
    // So we let the timer advance the floor first, then inject the
    // stdout signal that fires the snap.
    //
    // (Watcher has no `{ immediate: true }`, so seeding `terminalOutput`
    // at mount-time wouldn't fire the regex. Mutating after mount is
    // what production's IPC chunks do.)
    await mountWithOp('inst-launch-ready', {
      opKind: 'launch',
      chainSpan: 'launch',
      terminalOutput: '',
    })
    // Five timer ticks → captionFloor reaches 4 (startingServer).
    vi.advanceTimersByTime(900 * 5 + 100)
    await flushPromises()
    // Now feed the server-ready signal — stdoutStep flips to 4. Combined
    // with captionFloor=4 the active index lands at 4 and launchPercent
    // shortcuts to 100 → unifiedPercent = 70 + 30 = 100.
    const store = useProgressStore()
    const op = store.operations.get('inst-launch-ready')!
    op.terminalOutput = 'Uvicorn running on http://127.0.0.1:8188\n'
    await flushPromises()
    // One extra tick of the 250ms launch-percent ticker so the bar's
    // reactive readout catches the new active index.
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
    // The caption row is shared between launch and non-launch ops; the
    // content is what differs. For an install op with `activePhase=download`
    // we expect the curated `progress.phaseLabel.download` ("Downloading
    // ComfyUI…"), NOT the launch rolling caption.
    const caption = body.selectorText('.brand-progress__caption')
    expect(caption).toContain('Downloading')
    expect(caption).not.toMatch(/security scan|mount.*librar/i)
  })
})

describe('ProgressModal — error message styling (regression for #582)', () => {
  // jsdom doesn't compute layout, so we can't assert via
  // `getComputedStyle().maxHeight` against the rendered element. Instead
  // we parse the .vue file's `<style>` block directly and assert the
  // `.brand-progress__error-message` rule still carries the `max-height`
  // + `overflow-y` declarations introduced to stop long tracebacks from
  // stretching the takeover.
  //
  // Without this guard the only signal a future refactor would have is a
  // visual e2e diff — too easy to miss in a CSS-only PR.

  // Resolved against the workspace root (cwd at test time) so this
  // doesn't depend on import.meta.url (vitest jsdom mode can hand back
  // a non-file URL there).
  const vueSource = readFileSync(
    path.resolve('src/renderer/src/views/ProgressModal.vue'),
    'utf8',
  )

  function extractRule(selector: string): string {
    // Anchor on a line start so we match the base rule rather than a
    // descendant override (e.g. `.foo .bar { ... }` would otherwise win
    // over `.bar { ... }` because it appears first in the file).
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
