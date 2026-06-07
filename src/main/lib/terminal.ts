import pty from 'node-pty'
import type { WebContents } from 'electron'
import * as installations from '../installations'
import { getActiveVenvDir, getActiveUvPath } from './pythonEnv'

/**
 * Interactive per-installation shell sessions.
 *
 * Each installation gets at most one long-lived PTY, shared across every
 * surface that subscribes to it: the desktop Settings "Console" tab and the
 * ComfyUI frontend's bottom-panel terminal (across all of an install's
 * windows). One shell, one scrollback — so the same session is visible
 * everywhere and there's no confusion about which terminal is which.
 *
 * The session is independent of the ComfyUI server: it stays usable whether
 * ComfyUI is running or stopped (e.g. to pip-install something before a
 * reboot). When the user kills the shell (typing `exit`), the session is
 * marked exited and subscribers are notified; it is NOT silently respawned.
 * Callers restart it explicitly via {@link restartTerminal} (the desktop
 * Restart button, or the frontend re-opening the tab).
 */

const MAX_BUFFER_CHUNKS = 1000
const DEFAULT_SIZE = { cols: 80, rows: 30 }

export interface TerminalRestore {
  buffer: string[]
  size: { cols: number; rows: number }
  exited: boolean
}

function getDefaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC?.toLowerCase().includes('cmd')
      ? 'powershell.exe'
      : process.env.COMSPEC || 'powershell.exe'
  }
  return process.env.SHELL || '/bin/bash'
}

/** Commands written into a fresh shell: activate the install's venv and make
 *  `pip` route through the bundled uv, mirroring legacy desktop. A final clear
 *  hides the activation echo so the session opens on a clean prompt. */
function initCommands(venvDir: string, uvPath: string): string[] {
  if (process.platform === 'win32') {
    return [
      `& "${venvDir}\\Scripts\\Activate.ps1"`,
      `function pip { & "${uvPath}" pip $args }`,
      'Clear-Host',
    ]
  }
  return [
    `source "${venvDir}/bin/activate"`,
    `alias pip='"${uvPath}" pip'`,
    'clear',
  ]
}

class InstallTerminal {
  readonly installationId: string
  #pty: pty.IPty | undefined
  #exited = true
  readonly sessionBuffer: string[] = []
  readonly size = { ...DEFAULT_SIZE }
  readonly subscribers = new Set<WebContents>()

  constructor(installationId: string) {
    this.installationId = installationId
  }

  get exited(): boolean {
    return this.#exited || this.#pty === undefined
  }

  /** Spawn the shell if it isn't alive. Safe to call repeatedly. */
  async ensureAlive(): Promise<void> {
    if (this.#pty && !this.#exited) return
    await this.#spawn()
  }

  /** Kill any existing shell and start a fresh one. Clears scrollback. */
  async restart(): Promise<void> {
    this.#killPty()
    await this.#spawn()
  }

  write(data: string): void {
    if (this.#exited || !this.#pty) return
    this.#pty.write(data)
  }

  resize(cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return
    this.size.cols = Math.max(1, Math.floor(cols))
    this.size.rows = Math.max(1, Math.floor(rows))
    if (this.#exited || !this.#pty) return
    try {
      this.#pty.resize(this.size.cols, this.size.rows)
    } catch {
      // pty may have died between the exited check and here; ignore.
    }
  }

  restore(): TerminalRestore {
    return {
      buffer: [...this.sessionBuffer],
      size: { ...this.size },
      exited: this.exited,
    }
  }

  subscribe(wc: WebContents): void {
    if (this.subscribers.has(wc)) return
    this.subscribers.add(wc)
    wc.once('destroyed', () => this.subscribers.delete(wc))
  }

  unsubscribe(wc: WebContents): void {
    this.subscribers.delete(wc)
  }

  dispose(): void {
    this.#killPty()
    this.subscribers.clear()
    this.sessionBuffer.length = 0
  }

  async #spawn(): Promise<void> {
    const inst = await installations.get(this.installationId)
    if (!inst || !inst.installPath) {
      throw new Error(`Installation not found: ${this.installationId}`)
    }
    // A fresh shell starts with a fresh scrollback; otherwise a respawn after
    // the user typed `exit` would leak the dead session's buffer into restore.
    this.sessionBuffer.length = 0
    const venvDir = getActiveVenvDir(inst)
    const uvPath = getActiveUvPath(inst)
    const instance = pty.spawn(getDefaultShell(), [], {
      name: 'xterm-256color',
      cols: this.size.cols,
      rows: this.size.rows,
      cwd: inst.installPath,
      env: process.env as Record<string, string>,
    })

    this.#pty = instance
    this.#exited = false

    instance.onData((data) => {
      // Ignore stray output from a shell we've already replaced (restart race).
      if (this.#pty !== instance) return
      this.sessionBuffer.push(data)
      if (this.sessionBuffer.length > MAX_BUFFER_CHUNKS) this.sessionBuffer.shift()
      this.#broadcast('terminal-output', { installationId: this.installationId, data })
    })

    instance.onExit(() => {
      // A restart kills the old pty and spawns a new one; the old pty's async
      // exit must not clobber the live session or fire a spurious "exited".
      if (this.#pty !== instance) return
      this.#exited = true
      this.#pty = undefined
      this.#broadcast('terminal-exited', { installationId: this.installationId })
    })

    for (const cmd of initCommands(venvDir, uvPath)) {
      instance.write(`${cmd}\r`)
    }
  }

  #killPty(): void {
    const instance = this.#pty
    this.#pty = undefined
    this.#exited = true
    if (!instance) return
    try {
      instance.kill()
    } catch {
      // Already dead; nothing to do.
    }
  }

  #broadcast(channel: string, payload: unknown): void {
    for (const wc of this.subscribers) {
      if (wc.isDestroyed()) {
        this.subscribers.delete(wc)
        continue
      }
      wc.send(channel, payload)
    }
  }
}

const terminals = new Map<string, InstallTerminal>()

function getOrCreate(installationId: string): InstallTerminal {
  let term = terminals.get(installationId)
  if (!term) {
    term = new InstallTerminal(installationId)
    terminals.set(installationId, term)
  }
  return term
}

/** Subscribe a renderer to an install's shell, spawning it if needed, and
 *  return the scrollback/size/exited state so the caller can repaint. */
export async function subscribeTerminal(
  installationId: string,
  wc: WebContents,
): Promise<TerminalRestore> {
  const term = getOrCreate(installationId)
  await term.ensureAlive()
  term.subscribe(wc)
  return term.restore()
}

export function unsubscribeTerminal(installationId: string, wc: WebContents): void {
  terminals.get(installationId)?.unsubscribe(wc)
}

export function writeTerminal(installationId: string, data: string): void {
  terminals.get(installationId)?.write(data)
}

export function resizeTerminal(installationId: string, cols: number, rows: number): void {
  terminals.get(installationId)?.resize(cols, rows)
}

export async function restartTerminal(installationId: string): Promise<TerminalRestore> {
  const term = getOrCreate(installationId)
  await term.restart()
  return term.restore()
}

export function getTerminalRestore(installationId: string): TerminalRestore | null {
  return terminals.get(installationId)?.restore() ?? null
}

/** Tear down an install's shell entirely (e.g. when it's deleted). */
export function disposeTerminal(installationId: string): void {
  const term = terminals.get(installationId)
  if (!term) return
  term.dispose()
  terminals.delete(installationId)
}

/** Test-only: drop all sessions without spawning anything. */
export function _resetTerminalsForTest(): void {
  for (const term of terminals.values()) term.dispose()
  terminals.clear()
}
