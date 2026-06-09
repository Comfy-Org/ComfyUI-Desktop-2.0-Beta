import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let testStateDir = ''

// Mock paths.ts directly: stateDir() reads XDG_STATE_HOME on Linux, bypassing
// the electron.app.getPath mock and breaking CI.
vi.mock('./paths', () => ({
  stateDir: () => testStateDir
}))

vi.mock('electron', () => ({
  app: { getPath: () => testStateDir }
}))

let quitInProgress = false
vi.mock('./quit-state', () => ({
  isQuitInProgress: () => quitInProgress
}))

import {
  _resetLastSessionCacheForTest,
  clearLastActiveSurface,
  flushLastSession,
  flushLastSessionSync,
  getLastActiveSurface,
  recordDashboardSurface,
  recordInstanceSurface
} from './lastSession'

const statePath = (): string => path.join(testStateDir, 'last-session.json')

beforeEach(() => {
  testStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'last-session-'))
  quitInProgress = false
  _resetLastSessionCacheForTest()
})

afterEach(() => {
  fs.rmSync(testStateDir, { recursive: true, force: true })
})

describe('getLastActiveSurface', () => {
  it('returns null when no state file exists', () => {
    expect(getLastActiveSurface()).toBeNull()
  })

  it('reads a persisted instance surface from disk', () => {
    fs.writeFileSync(statePath(), JSON.stringify({ kind: 'instance', installationId: 'inst-A' }))
    expect(getLastActiveSurface()).toEqual({ kind: 'instance', installationId: 'inst-A' })
  })

  it('reads a persisted dashboard surface from disk', () => {
    fs.writeFileSync(statePath(), JSON.stringify({ kind: 'dashboard' }))
    expect(getLastActiveSurface()).toEqual({ kind: 'dashboard' })
  })

  it('returns null for a malformed instance record (missing id)', () => {
    fs.writeFileSync(statePath(), JSON.stringify({ kind: 'instance' }))
    expect(getLastActiveSurface()).toBeNull()
  })

  it('returns null for unparseable JSON', () => {
    fs.writeFileSync(statePath(), 'not json')
    expect(getLastActiveSurface()).toBeNull()
  })
})

describe('recordInstanceSurface / recordDashboardSurface', () => {
  it('records and flushes an instance surface to disk', async () => {
    recordInstanceSurface('inst-B')
    expect(getLastActiveSurface()).toEqual({ kind: 'instance', installationId: 'inst-B' })
    await flushLastSession()
    expect(JSON.parse(fs.readFileSync(statePath(), 'utf-8'))).toEqual({
      kind: 'instance',
      installationId: 'inst-B'
    })
  })

  it('records and flushes a dashboard surface to disk', async () => {
    recordDashboardSurface()
    expect(getLastActiveSurface()).toEqual({ kind: 'dashboard' })
    await flushLastSession()
    expect(JSON.parse(fs.readFileSync(statePath(), 'utf-8'))).toEqual({ kind: 'dashboard' })
  })

  it('overwrites a prior surface', () => {
    recordInstanceSurface('inst-C')
    recordDashboardSurface()
    expect(getLastActiveSurface()).toEqual({ kind: 'dashboard' })
    recordInstanceSurface('inst-D')
    expect(getLastActiveSurface()).toEqual({ kind: 'instance', installationId: 'inst-D' })
  })

  it('skips recording while a quit is in progress', () => {
    quitInProgress = true
    recordInstanceSurface('inst-Q')
    recordDashboardSurface()
    expect(getLastActiveSurface()).toBeNull()
  })
})

describe('flushLastSessionSync', () => {
  it('synchronously persists a recorded instance surface', () => {
    recordInstanceSurface('inst-F')
    flushLastSessionSync()
    expect(JSON.parse(fs.readFileSync(statePath(), 'utf-8'))).toEqual({
      kind: 'instance',
      installationId: 'inst-F'
    })
  })

  it('synchronously removes the file when state was cleared', () => {
    recordInstanceSurface('inst-G')
    flushLastSessionSync()
    expect(fs.existsSync(statePath())).toBe(true)
    clearLastActiveSurface()
    flushLastSessionSync()
    expect(fs.existsSync(statePath())).toBe(false)
  })

  it('is a no-op when nothing was recorded', () => {
    flushLastSessionSync()
    expect(fs.existsSync(statePath())).toBe(false)
  })
})

describe('clearLastActiveSurface', () => {
  it('drops in-memory state and removes the file on flush', async () => {
    recordInstanceSurface('inst-E')
    await flushLastSession()
    expect(fs.existsSync(statePath())).toBe(true)

    clearLastActiveSurface()
    expect(getLastActiveSurface()).toBeNull()
    await flushLastSession()
    expect(fs.existsSync(statePath())).toBe(false)
  })
})
