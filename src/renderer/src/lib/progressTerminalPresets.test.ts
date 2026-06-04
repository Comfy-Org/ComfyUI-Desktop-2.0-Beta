import { describe, expect, it } from 'vitest'
import {
  SUCCESS_ACTION_GO_DASHBOARD,
  SUCCESS_ACTION_OPEN_INSTANCE,
  successTerminalGoDashboardOrOpen,
} from './progressTerminalPresets'

// The panel-side success-choice handler switches on these action ids, so their stability is a contract.
describe('successTerminalGoDashboardOrOpen', () => {
  it('returns Go to Dashboard as the first action and Open Instance as the primary CTA', () => {
    const t = successTerminalGoDashboardOrOpen({
      dashboardLabel: 'Go to Dashboard',
      openLabel: 'Open Instance',
    })
    expect(t.actions).toHaveLength(2)
    expect(t.actions[0]).toMatchObject({
      id: SUCCESS_ACTION_GO_DASHBOARD,
      label: 'Go to Dashboard',
      variant: 'ghost',
    })
    expect(t.actions[1]).toMatchObject({
      id: SUCCESS_ACTION_OPEN_INSTANCE,
      label: 'Open Instance',
      variant: 'primary',
    })
  })

  it('forwards an explicit title through unchanged', () => {
    const t = successTerminalGoDashboardOrOpen({
      title: 'Update complete',
      dashboardLabel: 'Dashboard',
      openLabel: 'Open',
    })
    expect(t.title).toBe('Update complete')
  })

  it('omits title when not supplied so ProgressModal can fall back to its default headline', () => {
    const t = successTerminalGoDashboardOrOpen({
      dashboardLabel: 'Dashboard',
      openLabel: 'Open',
    })
    expect(t.title).toBeUndefined()
  })

  it('exports stable action ids that the panel host switches on', () => {
    expect(SUCCESS_ACTION_GO_DASHBOARD).toBe('go-dashboard')
    expect(SUCCESS_ACTION_OPEN_INSTANCE).toBe('open-instance')
  })
})
