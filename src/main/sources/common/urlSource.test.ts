// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
}))

import { createUrlSource } from './urlSource'
import type { InstallationRecord } from '../../installations'

function makeInstall(): InstallationRecord {
  return {
    id: 'inst-1',
    name: 'My Connection',
    createdAt: new Date().toISOString(),
    sourceId: 'x',
    remoteUrl: 'https://example.com/',
    status: 'installed',
  } as unknown as InstallationRecord
}

function detailActionIds(source: ReturnType<typeof createUrlSource>): string[] {
  const sections = source.getDetailSections(makeInstall()) as Record<string, unknown>[]
  const ids: string[] = []
  for (const section of sections) {
    const actions = section.actions as Record<string, unknown>[] | undefined
    if (!actions) continue
    for (const a of actions) if (a.id) ids.push(a.id as string)
  }
  return ids
}

describe('createUrlSource â€” rename action', () => {
  it('omits the rename action for the cloud category (issue #922)', () => {
    const cloud = createUrlSource({
      id: 'cloud',
      labelKey: 'cloud.label',
      descKey: 'cloud.desc',
      category: 'cloud',
      defaultUrl: 'https://cloud.comfy.org/',
    })
    expect(detailActionIds(cloud)).not.toContain('rename')
  })

  it('keeps the rename action for the remote category', () => {
    const remote = createUrlSource({
      id: 'remote',
      labelKey: 'remote.label',
      descKey: 'remote.desc',
      category: 'remote',
      defaultUrl: 'http://localhost:8188',
    })
    expect(detailActionIds(remote)).toContain('rename')
  })
})
