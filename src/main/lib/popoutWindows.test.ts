import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./terminal', () => ({ disposeTerminal: vi.fn() }))
vi.mock('./logsPopoutWindow', () => ({
  closeLogsPopout: vi.fn(),
  closeAllLogsPopouts: vi.fn(),
}))
vi.mock('./terminalPopoutWindow', () => ({
  closeTerminalPopout: vi.fn(),
  closeAllTerminalPopouts: vi.fn(),
}))

import { closeInstallPopouts, closeAllPopouts, releaseInstallTerminalForFsOp } from './popoutWindows'
import { disposeTerminal } from './terminal'
import { closeLogsPopout, closeAllLogsPopouts } from './logsPopoutWindow'
import { closeTerminalPopout, closeAllTerminalPopouts } from './terminalPopoutWindow'

describe('popoutWindows', () => {
  beforeEach(() => vi.clearAllMocks())

  it('closeInstallPopouts closes both surfaces for the install', () => {
    closeInstallPopouts('inst-a')
    expect(closeTerminalPopout).toHaveBeenCalledWith('inst-a')
    expect(closeLogsPopout).toHaveBeenCalledWith('inst-a')
    expect(disposeTerminal).not.toHaveBeenCalled()
  })

  it('closeAllPopouts closes every pop-out window', () => {
    closeAllPopouts()
    expect(closeAllTerminalPopouts).toHaveBeenCalledTimes(1)
    expect(closeAllLogsPopouts).toHaveBeenCalledTimes(1)
  })

  it('releaseInstallTerminalForFsOp closes pop-outs then kills the shell', () => {
    releaseInstallTerminalForFsOp('inst-a')
    expect(closeTerminalPopout).toHaveBeenCalledWith('inst-a')
    expect(closeLogsPopout).toHaveBeenCalledWith('inst-a')
    expect(disposeTerminal).toHaveBeenCalledWith('inst-a')
  })
})
