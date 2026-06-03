import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref, shallowRef, type ShallowRef } from 'vue'

import { useCentralPillCoachmark, CENTRAL_PILL_HINT_SEEN_KEY } from './useCentralPillCoachmark'

type CoachmarkShowPayload = {
  title: string
  body: string
  dismissLabel: string
  leftX: number
  rightX: number
  bottomY: number
}

function makeBridge() {
  return {
    showCoachmark: vi.fn<(payload: CoachmarkShowPayload) => void>(),
    hideCoachmark: vi.fn<() => void>()
  }
}

/** A stand-in pill element whose `getBoundingClientRect` returns a fixed
 *  rect so anchor math is deterministic. */
function makePillRef(rect?: Partial<DOMRect>): ShallowRef<HTMLElement | null> {
  const el = {
    getBoundingClientRect: () =>
      ({ left: 100, right: 240, top: 0, bottom: 36, width: 140, height: 36 }) as DOMRect,
    ...rect
  } as unknown as HTMLElement
  return shallowRef(el)
}

describe('useCentralPillCoachmark', () => {
  let getSetting: ReturnType<typeof vi.fn>
  let setSetting: ReturnType<typeof vi.fn>

  beforeEach(() => {
    getSetting = vi.fn().mockResolvedValue(undefined)
    setSetting = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', {
      ...window,
      api: { getSetting, setSetting },
      requestAnimationFrame: (cb: FrameRequestCallback) => {
        cb(0)
        return 0
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('shows the coachmark on first instance entry when the gate passes', async () => {
    const bridge = makeBridge()
    const cm = useCentralPillCoachmark({
      bridge,
      isInstallLess: ref(false),
      isFirstUseLockdown: ref(false),
      installPillRef: makePillRef(),
      title: 'T',
      body: 'Switch & manage instances here.',
      dismissLabel: 'Got it'
    })

    await cm.maybeShow()

    expect(bridge.showCoachmark).toHaveBeenCalledTimes(1)
    const payload = bridge.showCoachmark.mock.calls[0]?.[0]
    if (!payload) throw new Error('showCoachmark was not called')
    expect(payload.title).toBe('T')
    expect(payload.body).toBe('Switch & manage instances here.')
    expect(payload.dismissLabel).toBe('Got it')
    // Anchored below the pill, centered on it.
    expect(payload.leftX).toBe(100)
    expect(payload.rightX).toBe(240)
    expect(payload.bottomY).toBe(36)
  })

  it('does NOT show while a loading-lockdown (progress / connect screen) is up', async () => {
    const bridge = makeBridge()
    const cm = useCentralPillCoachmark({
      bridge,
      isInstallLess: ref(false),
      isFirstUseLockdown: ref(false),
      isLoadingLockdown: ref(true),
      installPillRef: makePillRef(),
      title: 'T',
      body: 'hint',
      dismissLabel: 'Got it'
    })

    await cm.maybeShow()

    expect(bridge.showCoachmark).not.toHaveBeenCalled()
  })

  it('exposes isShowing — false until shown, true while open, false after dismiss', async () => {
    const bridge = makeBridge()
    const cm = useCentralPillCoachmark({
      bridge,
      isInstallLess: ref(false),
      isFirstUseLockdown: ref(false),
      installPillRef: makePillRef(),
      title: 'T',
      body: 'hint',
      dismissLabel: 'Got it'
    })

    expect(cm.isShowing.value).toBe(false)
    await cm.maybeShow()
    expect(cm.isShowing.value).toBe(true)
    await cm.dismiss()
    expect(cm.isShowing.value).toBe(false)
  })

  it('does NOT show on an install-less host (the dashboard IS the picker)', async () => {
    const bridge = makeBridge()
    const cm = useCentralPillCoachmark({
      bridge,
      isInstallLess: ref(true),
      isFirstUseLockdown: ref(false),
      installPillRef: makePillRef(),
      title: 'T',
      body: 'hint',
      dismissLabel: 'Got it'
    })

    await cm.maybeShow()

    expect(bridge.showCoachmark).not.toHaveBeenCalled()
  })

  it('does NOT show during the first-use takeover lockdown', async () => {
    const bridge = makeBridge()
    const cm = useCentralPillCoachmark({
      bridge,
      isInstallLess: ref(false),
      isFirstUseLockdown: ref(true),
      installPillRef: makePillRef(),
      title: 'T',
      body: 'hint',
      dismissLabel: 'Got it'
    })

    await cm.maybeShow()

    expect(bridge.showCoachmark).not.toHaveBeenCalled()
  })

  it('does NOT show when the seen flag is already persisted', async () => {
    getSetting.mockImplementation((key: string) =>
      key === CENTRAL_PILL_HINT_SEEN_KEY ? Promise.resolve(true) : Promise.resolve(undefined)
    )
    const bridge = makeBridge()
    const cm = useCentralPillCoachmark({
      bridge,
      isInstallLess: ref(false),
      isFirstUseLockdown: ref(false),
      installPillRef: makePillRef(),
      title: 'T',
      body: 'hint',
      dismissLabel: 'Got it'
    })

    await cm.maybeShow()

    expect(getSetting).toHaveBeenCalledWith(CENTRAL_PILL_HINT_SEEN_KEY)
    expect(bridge.showCoachmark).not.toHaveBeenCalled()
  })

  it('persists the seen flag and hides the popup on dismiss (once ever)', async () => {
    const bridge = makeBridge()
    const cm = useCentralPillCoachmark({
      bridge,
      isInstallLess: ref(false),
      isFirstUseLockdown: ref(false),
      installPillRef: makePillRef(),
      title: 'T',
      body: 'hint',
      dismissLabel: 'Got it'
    })

    await cm.maybeShow()
    expect(bridge.showCoachmark).toHaveBeenCalledTimes(1)

    await cm.dismiss()

    expect(setSetting).toHaveBeenCalledWith(CENTRAL_PILL_HINT_SEEN_KEY, true)
    expect(bridge.hideCoachmark).toHaveBeenCalledTimes(1)
  })

  it('is idempotent — a second dismiss does not re-persist or re-hide', async () => {
    const bridge = makeBridge()
    const cm = useCentralPillCoachmark({
      bridge,
      isInstallLess: ref(false),
      isFirstUseLockdown: ref(false),
      installPillRef: makePillRef(),
      title: 'T',
      body: 'hint',
      dismissLabel: 'Got it'
    })

    await cm.maybeShow()
    await cm.dismiss()
    await cm.dismiss()

    expect(setSetting).toHaveBeenCalledTimes(1)
    expect(bridge.hideCoachmark).toHaveBeenCalledTimes(1)
  })

  it('does not show again within the same session after a dismiss', async () => {
    const bridge = makeBridge()
    const cm = useCentralPillCoachmark({
      bridge,
      isInstallLess: ref(false),
      isFirstUseLockdown: ref(false),
      installPillRef: makePillRef(),
      title: 'T',
      body: 'hint',
      dismissLabel: 'Got it'
    })

    await cm.maybeShow()
    await cm.dismiss()
    bridge.showCoachmark.mockClear()

    await cm.maybeShow()

    expect(bridge.showCoachmark).not.toHaveBeenCalled()
  })

  it('treats opening the pill drawer as "seen" — persists and stops showing', async () => {
    const bridge = makeBridge()
    const cm = useCentralPillCoachmark({
      bridge,
      isInstallLess: ref(false),
      isFirstUseLockdown: ref(false),
      installPillRef: makePillRef(),
      title: 'T',
      body: 'hint',
      dismissLabel: 'Got it'
    })

    await cm.maybeShow()
    // Pill click counts as acknowledgement.
    await cm.acknowledgeViaPillOpen()

    expect(setSetting).toHaveBeenCalledWith(CENTRAL_PILL_HINT_SEEN_KEY, true)
    expect(bridge.hideCoachmark).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the pill ref is not mounted yet', async () => {
    const bridge = makeBridge()
    const cm = useCentralPillCoachmark({
      bridge,
      isInstallLess: ref(false),
      isFirstUseLockdown: ref(false),
      installPillRef: shallowRef<HTMLElement | null>(null),
      title: 'T',
      body: 'hint',
      dismissLabel: 'Got it'
    })

    await cm.maybeShow()

    expect(bridge.showCoachmark).not.toHaveBeenCalled()
  })

  it('no-ops gracefully when the bridge is undefined', async () => {
    const cm = useCentralPillCoachmark({
      bridge: undefined,
      isInstallLess: ref(false),
      isFirstUseLockdown: ref(false),
      installPillRef: makePillRef(),
      title: 'T',
      body: 'hint',
      dismissLabel: 'Got it'
    })

    await expect(cm.maybeShow()).resolves.toBeUndefined()
    await expect(cm.dismiss()).resolves.toBeUndefined()
  })
})
