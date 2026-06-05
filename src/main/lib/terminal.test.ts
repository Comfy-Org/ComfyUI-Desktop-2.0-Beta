import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Fake node-pty machinery. Defined inside vi.hoisted so the (also hoisted)
 * vi.mock factory can reference it. Lets a test drive output/exit and inspect
 * what was written, without spawning a real shell.
 */
const { spawned, spawn } = vi.hoisted(() => {
  class FakePty {
    dataCb: ((d: string) => void) | undefined
    exitCb: (() => void) | undefined
    written: string[] = []
    killed = false
    cols: number
    rows: number

    constructor(cols: number, rows: number) {
      this.cols = cols
      this.rows = rows
    }

    onData(cb: (d: string) => void) {
      this.dataCb = cb
      return { dispose() {} }
    }
    onExit(cb: () => void) {
      this.exitCb = cb
      return { dispose() {} }
    }
    write(d: string) {
      this.written.push(d)
    }
    resize(cols: number, rows: number) {
      this.cols = cols
      this.rows = rows
    }
    kill() {
      this.killed = true
      // node-pty fires onExit asynchronously after kill().
      queueMicrotask(() => this.exitCb?.())
    }

    emitData(d: string) {
      this.dataCb?.(d)
    }
    emitExit() {
      this.exitCb?.()
    }
  }

  const spawnedList: FakePty[] = []
  const spawnFn = vi.fn(
    (_file: string, _args: string[], opts: { cols: number; rows: number }) => {
      const p = new FakePty(opts.cols, opts.rows)
      spawnedList.push(p)
      return p
    },
  )
  return { spawned: spawnedList, spawn: spawnFn }
})

vi.mock('node-pty', () => ({ default: { spawn } }))

vi.mock('../installations', () => ({
  get: vi.fn(async (id: string) => ({ id, name: id, installPath: `/installs/${id}` })),
}))

import {
  subscribeTerminal,
  writeTerminal,
  restartTerminal,
  getTerminalRestore,
  _resetTerminalsForTest,
} from './terminal'

interface FakeWebContents {
  sent: { channel: string; payload: unknown }[]
  destroyedCb?: () => void
  send: (channel: string, payload: unknown) => void
  once: (event: string, cb: () => void) => void
  isDestroyed: () => boolean
}

function makeWebContents(): FakeWebContents {
  const wc: FakeWebContents = {
    sent: [],
    send(channel, payload) {
      this.sent.push({ channel, payload })
    },
    once(event, cb) {
      if (event === 'destroyed') this.destroyedCb = cb
    },
    isDestroyed: () => false,
  }
  return wc
}

// The manager only uses WebContents.send/once/isDestroyed, so the fake is enough.
function asWc(wc: FakeWebContents) {
  return wc as unknown as Parameters<typeof subscribeTerminal>[1]
}

/** Nth spawned fake pty, asserting it exists (satisfies noUncheckedIndexedAccess). */
function ptyAt(i: number) {
  const p = spawned[i]
  if (!p) throw new Error(`No pty spawned at index ${i}`)
  return p
}

describe('terminal manager', () => {
  beforeEach(() => {
    _resetTerminalsForTest()
    spawned.length = 0
    spawn.mockClear()
  })

  it('spawns a shell on first subscribe and reports it alive', async () => {
    const wc = makeWebContents()
    const restore = await subscribeTerminal('inst-a', asWc(wc))

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(restore.exited).toBe(false)
    // Init commands (venv activate + pip alias) are written into the shell.
    expect(ptyAt(0).written.length).toBeGreaterThanOrEqual(2)
  })

  it('streams output to subscribers and retains scrollback', async () => {
    const wc = makeWebContents()
    await subscribeTerminal('inst-a', asWc(wc))

    ptyAt(0).emitData('hello ')
    ptyAt(0).emitData('world')

    const outputs = wc.sent.filter((m) => m.channel === 'terminal-output')
    expect(outputs.map((m) => (m.payload as { data: string }).data)).toEqual([
      'hello ',
      'world',
    ])
    expect(getTerminalRestore('inst-a')?.buffer.join('')).toBe('hello world')
  })

  it('marks the session exited and notifies subscribers when the shell is killed', async () => {
    const wc = makeWebContents()
    await subscribeTerminal('inst-a', asWc(wc))

    ptyAt(0).emitExit()

    expect(wc.sent.some((m) => m.channel === 'terminal-exited')).toBe(true)
    expect(getTerminalRestore('inst-a')?.exited).toBe(true)
  })

  it('drops writes after exit instead of throwing (the legacy dead-pty bug)', async () => {
    const wc = makeWebContents()
    await subscribeTerminal('inst-a', asWc(wc))
    ptyAt(0).emitExit()

    expect(() => writeTerminal('inst-a', 'ls\r')).not.toThrow()
    // Nothing reached the dead shell.
    expect(ptyAt(0).written.filter((w) => w === 'ls\r')).toHaveLength(0)
  })

  it('respawns a fresh shell on restart after the user killed it', async () => {
    const wc = makeWebContents()
    await subscribeTerminal('inst-a', asWc(wc))
    ptyAt(0).emitExit()

    const restore = await restartTerminal('inst-a')

    expect(spawn).toHaveBeenCalledTimes(2)
    expect(restore.exited).toBe(false)
    // The new shell accepts input.
    writeTerminal('inst-a', 'echo hi\r')
    expect(ptyAt(1).written).toContain('echo hi\r')
  })

  it('clears stale scrollback when respawning after exit', async () => {
    const wc = makeWebContents()
    await subscribeTerminal('inst-a', asWc(wc))
    ptyAt(0).emitData('old-session-output')
    expect(getTerminalRestore('inst-a')?.buffer.join('')).toContain(
      'old-session-output',
    )

    ptyAt(0).emitExit()

    // Re-subscribing respawns the shell; the dead session's scrollback is gone.
    const restore = await subscribeTerminal('inst-a', asWc(wc))

    expect(spawn).toHaveBeenCalledTimes(2)
    expect(restore.exited).toBe(false)
    expect(restore.buffer.join('')).not.toContain('old-session-output')
  })

  it('does not fire a spurious exit when restarting a live shell', async () => {
    const wc = makeWebContents()
    await subscribeTerminal('inst-a', asWc(wc))

    await restartTerminal('inst-a')
    // Let the killed old pty's async onExit microtask run.
    await Promise.resolve()
    await Promise.resolve()

    expect(wc.sent.some((m) => m.channel === 'terminal-exited')).toBe(false)
    expect(getTerminalRestore('inst-a')?.exited).toBe(false)
  })

  it('keeps sessions isolated per installation', async () => {
    const wcA = makeWebContents()
    const wcB = makeWebContents()
    await subscribeTerminal('inst-a', asWc(wcA))
    await subscribeTerminal('inst-b', asWc(wcB))

    ptyAt(0).emitData('from-a')

    expect(wcA.sent.some((m) => m.channel === 'terminal-output')).toBe(true)
    expect(wcB.sent.some((m) => m.channel === 'terminal-output')).toBe(false)
  })
})
