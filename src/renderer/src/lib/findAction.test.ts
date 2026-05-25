import { describe, expect, it } from 'vitest'
import { findActionById } from './findAction'
import type { ActionDef, DetailSection } from '../types/ipc'

function action(id: string, label = id): ActionDef {
  return { id, label, style: 'primary', enabled: true } as ActionDef
}

describe('findActionById', () => {
  it('returns null when nothing matches', () => {
    const sections: DetailSection[] = [{ tab: 'status', actions: [action('check-update')] }]
    expect(findActionById(sections, 'nonexistent')).toBeNull()
  })

  it('finds a top-level section action by id', () => {
    const sections: DetailSection[] = [
      { tab: 'status', actions: [action('launch'), action('delete')] },
      { tab: 'update', actions: [action('check-update')] },
    ]
    const result = findActionById(sections, 'delete')
    expect(result?.id).toBe('delete')
  })

  it('finds an action nested inside a channel-card field option (regression for #582)', () => {
    // The standalone source emits `update-comfyui` inside
    // `field.options[].data.actions[]` rather than at the section level.
    // A search of only `section.actions` would silently miss it — which
    // was the install-update pill autoAction bug.
    const sections: DetailSection[] = [
      {
        tab: 'update',
        fields: [
          {
            id: 'updateChannel',
            label: 'Update channel',
            value: 'stable',
            editType: 'channel-cards',
            options: [
              {
                value: 'stable',
                label: 'Stable',
                data: { actions: [action('update-comfyui'), action('copy-update')] },
              },
              {
                value: 'latest',
                label: 'Latest',
                data: { actions: [action('switch-channel')] },
              },
            ],
          },
        ],
        actions: [action('check-update')],
      },
    ]
    const result = findActionById(sections, 'update-comfyui')
    expect(result?.id).toBe('update-comfyui')
  })

  it('prefers the action on the install\'s currently-selected channel when the same id appears across channels', () => {
    // Both stable and latest expose `update-comfyui`; given the install
    // is on 'latest', the latest-channel action wins.
    const sections: DetailSection[] = [
      {
        tab: 'update',
        fields: [
          {
            id: 'updateChannel',
            label: 'Update channel',
            value: 'latest',
            editType: 'channel-cards',
            options: [
              {
                value: 'stable',
                label: 'Stable',
                data: { actions: [{ ...action('update-comfyui'), label: 'stable-update' }] },
              },
              {
                value: 'latest',
                label: 'Latest',
                data: { actions: [{ ...action('update-comfyui'), label: 'latest-update' }] },
              },
            ],
          },
        ],
      },
    ]
    const result = findActionById(sections, 'update-comfyui', 'latest')
    expect(result?.label).toBe('latest-update')
  })

  it('falls back to the first nested match when no channel preference is given', () => {
    const sections: DetailSection[] = [
      {
        tab: 'update',
        fields: [
          {
            id: 'updateChannel',
            label: 'Update channel',
            value: 'stable',
            editType: 'channel-cards',
            options: [
              {
                value: 'stable',
                label: 'Stable',
                data: { actions: [{ ...action('update-comfyui'), label: 'stable-update' }] },
              },
              {
                value: 'latest',
                label: 'Latest',
                data: { actions: [{ ...action('update-comfyui'), label: 'latest-update' }] },
              },
            ],
          },
        ],
      },
    ]
    const result = findActionById(sections, 'update-comfyui')
    expect(result?.label).toBe('stable-update')
  })

  it('top-level section actions win over nested ones with the same id', () => {
    // `check-update` is a top-level action; if a channel card ever
    // accidentally also defines one, the top-level wins because section
    // actions are the canonical surface.
    const sections: DetailSection[] = [
      {
        tab: 'update',
        actions: [{ ...action('check-update'), label: 'top-level' }],
        fields: [
          {
            id: 'updateChannel',
            label: 'Update channel',
            value: 'stable',
            editType: 'channel-cards',
            options: [
              {
                value: 'stable',
                label: 'Stable',
                data: { actions: [{ ...action('check-update'), label: 'nested' }] },
              },
            ],
          },
        ],
      },
    ]
    const result = findActionById(sections, 'check-update', 'stable')
    expect(result?.label).toBe('top-level')
  })
})
