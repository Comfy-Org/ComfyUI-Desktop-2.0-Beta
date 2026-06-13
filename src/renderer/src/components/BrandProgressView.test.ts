import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import BrandProgressView from './BrandProgressView.vue'
import type { ProgressStepVM } from '../lib/progressViewModel'

const step = (
  phase: string,
  status: ProgressStepVM['status'],
  detail: string | null = null,
  isError = false
): ProgressStepVM => ({ phase, label: phase, status, detail, subPercent: null, isError })

const ROW_H = 46
const CENTER_SLOT = 1 // Math.floor(VISIBLE_ROWS / 2) with VISIBLE_ROWS = 3

/** The row index the track is translated to centre (from the translateY style). */
function centeredIndex(wrapper: ReturnType<typeof mount>): number {
  const transform = wrapper.find('.bpv__track').attributes('style') ?? ''
  const px = Number(/translateY\((-?\d+(?:\.\d+)?)px\)/.exec(transform)?.[1] ?? NaN)
  // translateY = (CENTER_SLOT - activeIndex) * ROW_H  ⇒  activeIndex = CENTER_SLOT - px/ROW_H
  return CENTER_SLOT - px / ROW_H
}

describe('BrandProgressView', () => {
  it('renders a row per step with its status class', () => {
    const wrapper = mount(BrandProgressView, {
      props: { steps: [step('a', 'done'), step('b', 'active'), step('c', 'pending')] }
    })
    const rows = wrapper.findAll('.bpv__row')
    expect(rows).toHaveLength(3)
    expect(rows[0]!.classes()).toContain('is-done')
    expect(rows[1]!.classes()).toContain('is-active')
    expect(rows[1]!.classes()).toContain('is-focused')
    expect(rows[2]!.classes()).toContain('is-pending')
  })

  it('centres the active row', () => {
    const wrapper = mount(BrandProgressView, {
      props: { steps: [step('a', 'done'), step('b', 'done'), step('c', 'active'), step('d', 'pending')] }
    })
    expect(centeredIndex(wrapper)).toBe(2)
  })

  it('anchors to the FIRST row when no row is active yet (the steps-but-no-phase gap)', () => {
    // Regression guard: an empty-active list must NOT centre the last row and
    // then jerk back to the first when the first real phase fires.
    const wrapper = mount(BrandProgressView, {
      props: { steps: [step('a', 'pending'), step('b', 'pending'), step('c', 'pending')] }
    })
    expect(centeredIndex(wrapper)).toBe(0)
  })

  it('anchors to the LAST row when every step is done (finished)', () => {
    const wrapper = mount(BrandProgressView, {
      props: { steps: [step('a', 'done'), step('b', 'done'), step('c', 'done')] }
    })
    expect(centeredIndex(wrapper)).toBe(2)
  })

  it('shows detail only on the active row', () => {
    const wrapper = mount(BrandProgressView, {
      props: {
        steps: [step('a', 'done', 'old'), step('b', 'active', '3 / 7 · node'), step('c', 'pending', 'next')]
      }
    })
    const details = wrapper.findAll('.bpv__detail')
    expect(details).toHaveLength(1)
    expect(details[0]!.text()).toBe('3 / 7 · node')
  })

  it('renders nothing when there are no steps', () => {
    const wrapper = mount(BrandProgressView, { props: { steps: [] } })
    expect(wrapper.find('.bpv').exists()).toBe(false)
  })

  it('renders the error detail styling + icon when isError is true', () => {
    const wrapper = mount(BrandProgressView, {
      props: { steps: [step('a', 'active', 'download failed', true)] }
    })
    const detail = wrapper.get('.bpv__detail')
    expect(detail.classes()).toContain('is-error')
    expect(detail.find('.bpv__detail-icon').exists()).toBe(true)
    expect(detail.text()).toContain('download failed')
  })

  it('omits the error icon on a non-error detail', () => {
    const wrapper = mount(BrandProgressView, {
      props: { steps: [step('a', 'active', '3 / 7 · node')] }
    })
    const detail = wrapper.get('.bpv__detail')
    expect(detail.classes()).not.toContain('is-error')
    expect(detail.find('.bpv__detail-icon').exists()).toBe(false)
  })
})
