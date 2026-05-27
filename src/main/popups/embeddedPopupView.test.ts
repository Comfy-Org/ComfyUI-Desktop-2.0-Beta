import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The primitive only imports `WebContentsView` from electron, but vitest
// can't load the native binding so the module mock has to be in place
// before the import.
type FakeListener = (...args: unknown[]) => void

interface FakeWebContents {
  id: number
  destroyed: boolean
  listeners: Map<string, FakeListener[]>
  loadURLCalls: string[]
  loadFileCalls: string[]
  isDestroyed: () => boolean
  on: (event: string, fn: FakeListener) => void
  once: (event: string, fn: FakeListener) => void
  removeListener: (event: string, fn: FakeListener) => void
  loadURL: (url: string) => Promise<void>
  loadFile: (file: string) => Promise<void>
  send: (channel: string, payload?: unknown) => void
  focus: () => void
  close: () => void
  emit: (event: string, ...args: unknown[]) => void
}

interface FakeWebContentsView {
  webContents: FakeWebContents
  bounds: Electron.Rectangle
  visible: boolean
  background: string
  setBackgroundColor: (c: string) => void
  setVisible: (v: boolean) => void
  setBounds: (b: Electron.Rectangle) => void
  getBounds: () => Electron.Rectangle
}

interface FakeBrowserWindow {
  id: number
  destroyed: boolean
  focusCalls: number
  childViews: FakeWebContentsView[]
  listeners: Map<string, FakeListener[]>
  contentView: {
    addChildView: (v: FakeWebContentsView) => void
    removeChildView: (v: FakeWebContentsView) => void
  }
  isDestroyed: () => boolean
  focus: () => void
  on: (event: string, fn: FakeListener) => void
  once: (event: string, fn: FakeListener) => void
  removeListener: (event: string, fn: FakeListener) => void
  emit: (event: string, ...args: unknown[]) => void
}

let nextWindowId = 100
function makeBrowserWindow(): FakeBrowserWindow {
  const listeners = new Map<string, FakeListener[]>()
  const win: FakeBrowserWindow = {
    id: nextWindowId++,
    destroyed: false,
    focusCalls: 0,
    childViews: [],
    listeners,
    contentView: {
      addChildView: (v) => { win.childViews.push(v) },
      removeChildView: (v) => {
        const idx = win.childViews.indexOf(v)
        if (idx !== -1) win.childViews.splice(idx, 1)
      },
    },
    isDestroyed: () => win.destroyed,
    focus: () => { win.focusCalls++ },
    on: (event, fn) => {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
    },
    once: (event, fn) => {
      const wrapped: FakeListener = (...args) => {
        win.removeListener(event, wrapped)
        fn(...args)
      }
      win.on(event, wrapped)
    },
    removeListener: (event, fn) => {
      const list = listeners.get(event)
      if (!list) return
      const idx = list.indexOf(fn)
      if (idx !== -1) list.splice(idx, 1)
    },
    emit: (event, ...args) => {
      const list = listeners.get(event)
      if (!list) return
      for (const fn of [...list]) fn(...args)
    },
  }
  return win
}

// vi.mock is hoisted above all imports, so the factory cannot capture
// `FakeWebContentsViewCtor` defined later in the module — define the
// constructor inside the factory itself.
vi.mock('electron', () => {
  let nextId = 1
  class Ctor {
    webContents = {
      id: nextId++,
      destroyed: false,
      _listeners: new Map<string, FakeListener[]>(),
      loadURLCalls: [] as string[],
      loadFileCalls: [] as string[],
      isDestroyed(): boolean { return this.destroyed },
      on(event: string, fn: FakeListener): void {
        const list = this._listeners.get(event) ?? []
        list.push(fn)
        this._listeners.set(event, list)
      },
      once(event: string, fn: FakeListener): void {
        const wrapped: FakeListener = (...args) => {
          this.removeListener(event, wrapped)
          fn(...args)
        }
        this.on(event, wrapped)
      },
      removeListener(event: string, fn: FakeListener): void {
        const list = this._listeners.get(event)
        if (!list) return
        const idx = list.indexOf(fn)
        if (idx !== -1) list.splice(idx, 1)
      },
      async loadURL(url: string): Promise<void> { this.loadURLCalls.push(url) },
      async loadFile(file: string): Promise<void> { this.loadFileCalls.push(file) },
      send(): void {},
      focus(): void {},
      close(): void { this.emit('destroyed') },
      emit(event: string, ...args: unknown[]): void {
        const list = this._listeners.get(event)
        if (!list) return
        for (const fn of [...list]) fn(...args)
      },
    }
    bounds: Electron.Rectangle = { x: 0, y: 0, width: 0, height: 0 }
    visible = true
    background = ''
    setBackgroundColor(c: string): void { this.background = c }
    setVisible(v: boolean): void { this.visible = v }
    setBounds(b: Electron.Rectangle): void { this.bounds = b }
    getBounds(): Electron.Rectangle { return this.bounds }
  }
  // `embeddedPopupView.ts` now imports `_registerExtraBroadcastTarget` from
  // `../lib/ipc/broadcast`, which itself imports `BrowserWindow` from
  // electron at module scope. Provide a minimal stub so module evaluation
  // doesn't fault; the broadcast helper itself isn't exercised in these
  // tests (no call path triggers a broadcast).
  return {
    WebContentsView: Ctor,
    BrowserWindow: { getAllWindows: () => [] },
  }
})

import { EmbeddedPopupView } from './embeddedPopupView'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

function makePopup(opts: Partial<{
  hideOnParentEvents: ReadonlyArray<'blur' | 'will-move' | 'move' | 'resize'>
  hideOnPopupBlur: boolean
  onParentClosed: () => void
  onDestroyed: () => void
}> = {}): { view: EmbeddedPopupView; parent: FakeBrowserWindow } {
  const parent = makeBrowserWindow()
  const view = new EmbeddedPopupView({
    parent: parent as unknown as Electron.BrowserWindow,
    htmlName: 'comfyTitlePopup',
    preloadName: 'comfyTitlePopupPreload.js',
    initialBounds: { x: 0, y: 0, width: 200, height: 100 },
    ...opts,
  })
  return { view, parent }
}

describe('EmbeddedPopupView', () => {
  it('attaches a transparent, hidden child view at the requested bounds', () => {
    const { view, parent } = makePopup()
    const child = view.popup as unknown as FakeWebContentsView
    expect(parent.childViews).toContain(child)
    expect(child.background).toBe('#00000000')
    expect(child.visible).toBe(false)
    expect(child.bounds).toEqual({ x: 0, y: 0, width: 200, height: 100 })
  })

  it('snapshots ids so destroyed-window handlers don\'t touch the popup webContents', () => {
    const { view, parent } = makePopup()
    expect(view.parentWindowId).toBe(parent.id)
    expect(view.popupWebContentsId).toBe(view.popup.webContents.id)
  })

  it('loads the dev URL when ELECTRON_RENDERER_URL is set', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173/')
    try {
      const { view } = makePopup()
      const wc = view.popup.webContents as unknown as FakeWebContents
      expect(wc.loadURLCalls).toEqual(['http://localhost:5173/comfyTitlePopup.html'])
      expect(wc.loadFileCalls).toEqual([])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('loads the packaged HTML when ELECTRON_RENDERER_URL is unset', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', '')
    try {
      const { view } = makePopup()
      const wc = view.popup.webContents as unknown as FakeWebContents
      expect(wc.loadURLCalls).toEqual([])
      expect(wc.loadFileCalls).toHaveLength(1)
      expect(wc.loadFileCalls[0]).toMatch(/comfyTitlePopup\.html$/)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  describe('showOnTop', () => {
    it('re-stacks the popup as the most recent child and flips it visible', () => {
      const { view, parent } = makePopup()
      const child = view.popup as unknown as FakeWebContentsView
      // Insert another fake child after construction so the popup is no
      // longer at the end of the stack — showOnTop must remove + re-add
      // it so it paints above any later-attached views.
      const sibling = { tag: 'sibling' } as unknown as FakeWebContentsView
      parent.contentView.addChildView(sibling)
      expect(parent.childViews[parent.childViews.length - 1]).toBe(sibling)
      view.showOnTop()
      expect(parent.childViews[parent.childViews.length - 1]).toBe(child)
      expect(child.visible).toBe(true)
      expect(view.isOpen).toBe(true)
    })

    it('focuses the popup webContents only when asked', () => {
      const { view } = makePopup()
      const wc = view.popup.webContents as unknown as FakeWebContents
      let focused = 0
      wc.focus = () => { focused++ }
      view.showOnTop()
      expect(focused).toBe(0)
      view.showOnTop({ focus: true })
      expect(focused).toBe(1)
    })

    it('cancels any pending show-fallback timer', () => {
      const { view } = makePopup()
      let fired = 0
      view.scheduleShowFallback(50, () => { fired++ })
      view.showOnTop()
      vi.advanceTimersByTime(100)
      expect(fired).toBe(0)
      expect(view.pendingShowTimer).toBeNull()
    })
  })

  describe('hide', () => {
    it('flips the popup invisible and clears isOpen', () => {
      const { view } = makePopup()
      view.showOnTop()
      view.hide()
      const child = view.popup as unknown as FakeWebContentsView
      expect(child.visible).toBe(false)
      expect(view.isOpen).toBe(false)
    })

    it('is a no-op when neither open nor pending', () => {
      const { view, parent } = makePopup()
      const before = parent.focusCalls
      view.hide({ focusParent: true })
      expect(parent.focusCalls).toBe(before)
    })

    it('focuses the parent window when focusParent is true', () => {
      const { view, parent } = makePopup()
      view.showOnTop()
      view.hide({ focusParent: true })
      expect(parent.focusCalls).toBe(1)
    })

    it('cancels any pending show-fallback timer (so a late hide doesn\'t pop the popup back open)', () => {
      const { view } = makePopup()
      let fired = 0
      view.scheduleShowFallback(50, () => { fired++ })
      view.hide()
      vi.advanceTimersByTime(100)
      expect(fired).toBe(0)
    })

    it('fires onHide on every actual transition (manual and auto-dismiss paths)', () => {
      let hideCount = 0
      const parent = makeBrowserWindow()
      const view = new EmbeddedPopupView({
        parent: parent as unknown as Electron.BrowserWindow,
        htmlName: 'comfyTitlePopup',
        preloadName: 'comfyTitlePopupPreload.js',
        initialBounds: { x: 0, y: 0, width: 200, height: 100 },
        hideOnParentEvents: ['blur'],
        onHide: () => { hideCount++ },
      })
      // No-op hide doesn't fire the callback.
      view.hide()
      expect(hideCount).toBe(0)
      // Manual hide after show fires once.
      view.showOnTop()
      view.hide()
      expect(hideCount).toBe(1)
      // Auto-dismiss via the parent blur listener fires once.
      view.showOnTop()
      parent.emit('blur')
      expect(hideCount).toBe(2)
    })
  })

  describe('scheduleShowFallback', () => {
    it('runs the callback after the timeout', () => {
      const { view } = makePopup()
      let fired = 0
      view.scheduleShowFallback(50, () => { fired++ })
      vi.advanceTimersByTime(49)
      expect(fired).toBe(0)
      vi.advanceTimersByTime(1)
      expect(fired).toBe(1)
      expect(view.pendingShowTimer).toBeNull()
    })

    it('replaces a prior pending timer', () => {
      const { view } = makePopup()
      let firstFired = 0
      let secondFired = 0
      view.scheduleShowFallback(50, () => { firstFired++ })
      view.scheduleShowFallback(50, () => { secondFired++ })
      vi.advanceTimersByTime(50)
      expect(firstFired).toBe(0)
      expect(secondFired).toBe(1)
    })
  })

  describe('parent dismiss listeners', () => {
    it('hides the popup when one of hideOnParentEvents fires', () => {
      const { view, parent } = makePopup({ hideOnParentEvents: ['blur', 'will-move'] })
      view.showOnTop()
      parent.emit('blur')
      expect(view.isOpen).toBe(false)
    })

    it('hides the popup when the popup webContents loses focus', () => {
      const { view } = makePopup({ hideOnPopupBlur: true })
      view.showOnTop()
      const wc = view.popup.webContents as unknown as FakeWebContents
      wc.emit('blur')
      expect(view.isOpen).toBe(false)
    })

    it('removes parent listeners when the popup webContents is destroyed', () => {
      const { parent } = makePopup({ hideOnParentEvents: ['blur'] })
      const popupView = parent.childViews[0] as FakeWebContentsView
      const wc = popupView.webContents
      const before = parent.listeners.get('blur')?.length ?? 0
      wc.emit('destroyed')
      const after = parent.listeners.get('blur')?.length ?? 0
      expect(after).toBeLessThan(before)
    })
  })

  describe('teardown', () => {
    it('runs onParentClosed and removes the child view when the parent closes', () => {
      let cleanup = 0
      const { view, parent } = makePopup({ onParentClosed: () => { cleanup++ } })
      const child = view.popup as unknown as FakeWebContentsView
      parent.emit('closed')
      expect(cleanup).toBe(1)
      expect(parent.childViews).not.toContain(child)
    })

    it('runs onDestroyed when the popup webContents is destroyed independently', () => {
      let dropped = 0
      const { view } = makePopup({ onDestroyed: () => { dropped++ } })
      const wc = view.popup.webContents as unknown as FakeWebContents
      wc.emit('destroyed')
      expect(dropped).toBe(1)
    })
  })

  it('isDestroyed reflects either side being torn down', () => {
    const { view, parent } = makePopup()
    expect(view.isDestroyed()).toBe(false)
    parent.destroyed = true
    expect(view.isDestroyed()).toBe(true)
    parent.destroyed = false
    const wc = view.popup.webContents as unknown as FakeWebContents
    wc.destroyed = true
    expect(view.isDestroyed()).toBe(true)
  })
})
