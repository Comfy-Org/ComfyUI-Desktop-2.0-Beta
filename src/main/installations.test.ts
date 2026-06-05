// @vitest-environment node
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { InstallationRecord } from './installations'

let tmpRoot = ''
let userDataPath = ''

async function loadInstallations() {
  return await import('./installations')
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'comfyui-desktop-2-installations-'))
  userDataPath = path.join(tmpRoot, 'user-data')
  fs.mkdirSync(userDataPath, { recursive: true })

  vi.resetModules()
  vi.restoreAllMocks()
  vi.doMock('electron', () => ({
    app: {
      getPath: () => userDataPath,
    },
  }))
  // Force win32 so the XDG branches in paths.ts don't kick in on a Linux runner.
  vi.stubGlobal('process', {
    ...process,
    platform: 'win32',
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

const localCategoryFor = (sourceId: string): string | undefined => {
  if (sourceId === 'standalone' || sourceId === 'portable') return 'local'
  if (sourceId === 'cloud') return 'cloud'
  if (sourceId === 'desktop') return 'desktop'
  return undefined
}
const resolveCategory = (inst: InstallationRecord) => localCategoryFor(inst.sourceId)

describe('installations.markLaunched', () => {
  it('writes both lastLaunchedAt and lastLaunchedAtByCategory[category]', async () => {
    const installations = await loadInstallations()
    const before = Date.now()
    const entry = await installations.add({
      name: 'Local A',
      installPath: path.join(tmpRoot, 'a'),
      sourceId: 'standalone',
      status: 'installed',
    })

    const updated = await installations.markLaunched(entry.id, resolveCategory)
    expect(updated).not.toBeNull()
    expect(typeof updated!.lastLaunchedAt).toBe('number')
    expect(updated!.lastLaunchedAt!).toBeGreaterThanOrEqual(before)
    expect(updated!.lastLaunchedAtByCategory).toEqual({ local: updated!.lastLaunchedAt })

    // Persisted to disk, not just returned in memory.
    const reloaded = await installations.get(entry.id)
    expect(reloaded!.lastLaunchedAt).toBe(updated!.lastLaunchedAt)
    expect(reloaded!.lastLaunchedAtByCategory).toEqual({ local: updated!.lastLaunchedAt })
  })

  it('preserves prior per-category timestamps for other categories', async () => {
    const installations = await loadInstallations()
    const entry = await installations.add({
      name: 'Multi A',
      installPath: path.join(tmpRoot, 'multi-a'),
      sourceId: 'standalone',
      status: 'installed',
      lastLaunchedAtByCategory: { cloud: 100, desktop: 200 },
    })

    const updated = await installations.markLaunched(entry.id, resolveCategory)
    expect(updated!.lastLaunchedAtByCategory).toMatchObject({
      cloud: 100,
      desktop: 200,
      local: updated!.lastLaunchedAt,
    })
  })

  it('omits the per-category map when the resolver returns undefined', async () => {
    const installations = await loadInstallations()
    const entry = await installations.add({
      name: 'No Category',
      installPath: path.join(tmpRoot, 'no-cat'),
      // Unrecognised source → resolver returns undefined → only the global
      // timestamp is stamped.
      sourceId: 'mystery',
      status: 'installed',
    })

    const updated = await installations.markLaunched(entry.id, resolveCategory)
    expect(typeof updated!.lastLaunchedAt).toBe('number')
    expect(updated!.lastLaunchedAtByCategory).toBeUndefined()
  })

  it('omits the per-category map when no resolver is provided', async () => {
    const installations = await loadInstallations()
    const entry = await installations.add({
      name: 'No Resolver',
      installPath: path.join(tmpRoot, 'no-res'),
      sourceId: 'standalone',
      status: 'installed',
    })

    const updated = await installations.markLaunched(entry.id)
    expect(typeof updated!.lastLaunchedAt).toBe('number')
    expect(updated!.lastLaunchedAtByCategory).toBeUndefined()
  })

  it('passes the freshly-loaded record to the resolver', async () => {
    const installations = await loadInstallations()
    const entry = await installations.add({
      name: 'Resolver Probe',
      installPath: path.join(tmpRoot, 'probe'),
      sourceId: 'standalone',
      status: 'installed',
    })

    let received: InstallationRecord | null = null
    await installations.markLaunched(entry.id, (inst) => {
      received = inst
      return 'local'
    })
    expect(received).not.toBeNull()
    expect(received!.id).toBe(entry.id)
    expect(received!.sourceId).toBe('standalone')
  })

  it('emits an installationEvents `updated` event on success', async () => {
    const installations = await loadInstallations()
    const entry = await installations.add({
      name: 'Event A',
      installPath: path.join(tmpRoot, 'event-a'),
      sourceId: 'standalone',
      status: 'installed',
    })

    const seen: InstallationRecord[] = []
    installations.installationEvents.on('updated', (rec: InstallationRecord) => seen.push(rec))

    await installations.markLaunched(entry.id, resolveCategory)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.id).toBe(entry.id)
    expect(seen[0]!.lastLaunchedAtByCategory).toEqual({ local: seen[0]!.lastLaunchedAt })
  })

  it('returns null and emits nothing when the install id does not exist', async () => {
    const installations = await loadInstallations()
    const seen: InstallationRecord[] = []
    installations.installationEvents.on('updated', (rec: InstallationRecord) => seen.push(rec))

    const updated = await installations.markLaunched('inst-does-not-exist', resolveCategory)
    expect(updated).toBeNull()
    expect(seen).toHaveLength(0)
  })
})

describe('installations.add (id uniqueness)', () => {
  // `inst-${Date.now()}` collided for same-millisecond `add()` calls, aliasing
  // records under one id; the fix appends a per-process counter.
  it('produces a distinct id for each add(), even back-to-back inside the same millisecond', async () => {
    const installations = await loadInstallations()
    // Pin Date.now so all 5 add() calls hit the same-ms collision path.
    const fixed = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(fixed)
    const records = []
    for (let i = 0; i < 5; i++) {
      records.push(
        await installations.add({
          name: `Same-ms ${i}`,
          installPath: path.join(tmpRoot, `same-ms-${i}`),
          sourceId: 'standalone',
          status: 'installed',
        }),
      )
    }
    const ids = records.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('installations.getRecent', () => {
  it('returns null when no installs have been launched', async () => {
    const installations = await loadInstallations()
    expect(await installations.getRecent()).toBeNull()

    await installations.add({
      name: 'Never Launched',
      installPath: path.join(tmpRoot, 'never'),
      sourceId: 'standalone',
      status: 'installed',
    })
    expect(await installations.getRecent()).toBeNull()
  })

  it('returns the install with the largest global lastLaunchedAt', async () => {
    const installations = await loadInstallations()
    const a = await installations.add({
      name: 'A',
      installPath: path.join(tmpRoot, 'a'),
      sourceId: 'standalone',
      status: 'installed',
      lastLaunchedAt: 100,
    })
    const b = await installations.add({
      name: 'B',
      installPath: path.join(tmpRoot, 'b'),
      sourceId: 'standalone',
      status: 'installed',
      lastLaunchedAt: 500,
    })
    await installations.add({
      name: 'C',
      installPath: path.join(tmpRoot, 'c'),
      sourceId: 'standalone',
      status: 'installed',
      lastLaunchedAt: 300,
    })

    const recent = await installations.getRecent()
    expect(recent!.id).toBe(b.id)
    expect(recent!.id).not.toBe(a.id)
  })
})

describe('installations.load (useSharedPaths → useSharedModels/useSharedInputOutput migration)', () => {
  function writeRawInstallations(records: Record<string, unknown>[]): string {
    // On win32 `dataDir()` is the Electron userData path directly (no `data/`).
    fs.mkdirSync(userDataPath, { recursive: true })
    const file = path.join(userDataPath, 'installations.json')
    fs.writeFileSync(file, JSON.stringify(records))
    return file
  }

  it('translates legacy useSharedPaths: true → both new flags true', async () => {
    writeRawInstallations([
      {
        id: 'legacy-on',
        name: 'Legacy On',
        installPath: path.join(tmpRoot, 'on'),
        sourceId: 'standalone',
        status: 'installed',
        createdAt: new Date().toISOString(),
        useSharedPaths: true,
      },
    ])
    const installations = await loadInstallations()
    const list = await installations.list()
    const rec = list.find((r) => r.id === 'legacy-on')!
    expect(rec.useSharedModels).toBe(true)
    expect(rec.useSharedInputOutput).toBe(true)
    expect(rec).not.toHaveProperty('useSharedPaths')
  })

  it('translates legacy useSharedPaths: false → useSharedModels: true, useSharedInputOutput: false', async () => {
    // The migration forces `useSharedModels: true` regardless of the legacy
    // value (isolating paths meant input/output, not the model library).
    writeRawInstallations([
      {
        id: 'legacy-off',
        name: 'Legacy Off',
        installPath: path.join(tmpRoot, 'off'),
        sourceId: 'standalone',
        status: 'installed',
        createdAt: new Date().toISOString(),
        useSharedPaths: false,
      },
    ])
    const installations = await loadInstallations()
    const list = await installations.list()
    const rec = list.find((r) => r.id === 'legacy-off')!
    expect(rec.useSharedModels).toBe(true)
    expect(rec.useSharedInputOutput).toBe(false)
    expect(rec).not.toHaveProperty('useSharedPaths')
  })

  it('leaves records without useSharedPaths untouched (no implicit migration)', async () => {
    // Records already on the new schema must round-trip without the
    // migration adding fields that weren't there before.
    writeRawInstallations([
      {
        id: 'modern',
        name: 'Modern',
        installPath: path.join(tmpRoot, 'modern'),
        sourceId: 'standalone',
        status: 'installed',
        createdAt: new Date().toISOString(),
        useSharedModels: false,
      },
    ])
    const installations = await loadInstallations()
    const list = await installations.list()
    const rec = list.find((r) => r.id === 'modern')!
    expect(rec.useSharedModels).toBe(false)
    expect(rec.useSharedInputOutput).toBeUndefined()
    expect(rec).not.toHaveProperty('useSharedPaths')
  })

  it('strips legacy useSharedPaths from disk on next write', async () => {
    const file = writeRawInstallations([
      {
        id: 'legacy-strip',
        name: 'Legacy Strip',
        installPath: path.join(tmpRoot, 'strip'),
        sourceId: 'standalone',
        status: 'installed',
        createdAt: new Date().toISOString(),
        useSharedPaths: true,
      },
    ])
    const installations = await loadInstallations()
    // Update triggers a save, which re-serializes the migrated record.
    await installations.update('legacy-strip', { name: 'Renamed' })
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>[]
    const persisted = raw.find((r) => r['id'] === 'legacy-strip')!
    expect(persisted).not.toHaveProperty('useSharedPaths')
    expect(persisted['useSharedModels']).toBe(true)
    expect(persisted['useSharedInputOutput']).toBe(true)
  })
})

describe('installations.getRecentByCategory', () => {
  it('returns null when there are no installs', async () => {
    const installations = await loadInstallations()
    expect(await installations.getRecentByCategory('local', resolveCategory)).toBeNull()
  })

  it('returns null when no install in the category has been launched', async () => {
    const installations = await loadInstallations()
    await installations.add({
      name: 'Never Local',
      installPath: path.join(tmpRoot, 'nl'),
      sourceId: 'standalone',
      status: 'installed',
    })
    await installations.add({
      name: 'Cloud With Stamp',
      installPath: path.join(tmpRoot, 'cs'),
      sourceId: 'cloud',
      status: 'installed',
      lastLaunchedAt: 9999,
    })

    expect(await installations.getRecentByCategory('local', resolveCategory)).toBeNull()
  })

  it('picks the install with the largest lastLaunchedAtByCategory[category] within the category', async () => {
    const installations = await loadInstallations()
    await installations.add({
      name: 'Local Old',
      installPath: path.join(tmpRoot, 'lo'),
      sourceId: 'standalone',
      status: 'installed',
      lastLaunchedAt: 200,
      lastLaunchedAtByCategory: { local: 200 },
    })
    const winner = await installations.add({
      name: 'Local New',
      installPath: path.join(tmpRoot, 'ln'),
      sourceId: 'portable',
      status: 'installed',
      lastLaunchedAt: 400,
      lastLaunchedAtByCategory: { local: 400 },
    })
    // Cloud install with a much higher timestamp must NOT win the local query.
    await installations.add({
      name: 'Cloud High',
      installPath: path.join(tmpRoot, 'ch'),
      sourceId: 'cloud',
      status: 'installed',
      lastLaunchedAt: 9999,
      lastLaunchedAtByCategory: { cloud: 9999 },
    })

    const recent = await installations.getRecentByCategory('local', resolveCategory)
    expect(recent!.id).toBe(winner.id)
  })

  it('falls back to global lastLaunchedAt for installs without a per-category entry', async () => {
    const installations = await loadInstallations()
    // Legacy install: only the global field set.
    const legacy = await installations.add({
      name: 'Legacy Local',
      installPath: path.join(tmpRoot, 'leg'),
      sourceId: 'standalone',
      status: 'installed',
      lastLaunchedAt: 500,
    })
    // Newer install with a per-category entry, but lower timestamp.
    await installations.add({
      name: 'Newer Local',
      installPath: path.join(tmpRoot, 'new'),
      sourceId: 'portable',
      status: 'installed',
      lastLaunchedAt: 100,
      lastLaunchedAtByCategory: { local: 100 },
    })

    const recent = await installations.getRecentByCategory('local', resolveCategory)
    expect(recent!.id).toBe(legacy.id)
  })

  it('prefers the per-category timestamp over the global one when both exist', async () => {
    const installations = await loadInstallations()
    // Even though A's global timestamp is lower, its per-category entry is higher.
    const winner = await installations.add({
      name: 'A',
      installPath: path.join(tmpRoot, 'a'),
      sourceId: 'standalone',
      status: 'installed',
      lastLaunchedAt: 100,
      lastLaunchedAtByCategory: { local: 1000 },
    })
    await installations.add({
      name: 'B',
      installPath: path.join(tmpRoot, 'b'),
      sourceId: 'standalone',
      status: 'installed',
      lastLaunchedAt: 500,
      lastLaunchedAtByCategory: { local: 500 },
    })

    const recent = await installations.getRecentByCategory('local', resolveCategory)
    expect(recent!.id).toBe(winner.id)
  })

  it('ignores installs in other categories even when their per-category map mentions ours', async () => {
    const installations = await loadInstallations()
    // A cloud install whose per-category map has a stray `local` key must still
    // be filtered out, since the resolver says it's 'cloud'.
    await installations.add({
      name: 'Stray Cloud',
      installPath: path.join(tmpRoot, 'stray'),
      sourceId: 'cloud',
      status: 'installed',
      lastLaunchedAt: 9999,
      lastLaunchedAtByCategory: { local: 9999, cloud: 9999 },
    })
    const winner = await installations.add({
      name: 'Real Local',
      installPath: path.join(tmpRoot, 'real'),
      sourceId: 'standalone',
      status: 'installed',
      lastLaunchedAt: 1,
      lastLaunchedAtByCategory: { local: 1 },
    })

    const recent = await installations.getRecentByCategory('local', resolveCategory)
    expect(recent!.id).toBe(winner.id)
  })

  it('updates getRecentByCategory after a markLaunched call', async () => {
    const installations = await loadInstallations()
    const a = await installations.add({
      name: 'A',
      installPath: path.join(tmpRoot, 'a'),
      sourceId: 'standalone',
      status: 'installed',
      lastLaunchedAt: 100,
      lastLaunchedAtByCategory: { local: 100 },
    })
    const b = await installations.add({
      name: 'B',
      installPath: path.join(tmpRoot, 'b'),
      sourceId: 'standalone',
      status: 'installed',
      lastLaunchedAt: 200,
      lastLaunchedAtByCategory: { local: 200 },
    })

    expect((await installations.getRecentByCategory('local', resolveCategory))!.id).toBe(b.id)

    // markLaunched(a) should bump A above B.
    await installations.markLaunched(a.id, resolveCategory)
    expect((await installations.getRecentByCategory('local', resolveCategory))!.id).toBe(a.id)
  })
})

describe('installations.hasNameConflict', () => {
  it('is false when no other install shares the name', async () => {
    const installations = await loadInstallations()
    const a = await installations.add({
      name: 'Alpha',
      installPath: path.join(tmpRoot, 'a'),
      sourceId: 'standalone',
      status: 'installed',
    })
    expect(await installations.hasNameConflict(a.id, 'Beta')).toBe(false)
  })

  it('is true when another install already uses the name', async () => {
    const installations = await loadInstallations()
    await installations.add({
      name: 'Taken',
      installPath: path.join(tmpRoot, 'a'),
      sourceId: 'standalone',
      status: 'installed',
    })
    const b = await installations.add({
      name: 'Free',
      installPath: path.join(tmpRoot, 'b'),
      sourceId: 'standalone',
      status: 'installed',
    })
    expect(await installations.hasNameConflict(b.id, 'Taken')).toBe(true)
  })

  it('ignores the install being renamed (renaming to its own name is not a conflict)', async () => {
    const installations = await loadInstallations()
    const a = await installations.add({
      name: 'Self',
      installPath: path.join(tmpRoot, 'a'),
      sourceId: 'standalone',
      status: 'installed',
    })
    expect(await installations.hasNameConflict(a.id, 'Self')).toBe(false)
  })
})

describe('installations.enforceCloudName', () => {
  it('resets a renamed Cloud entry back to the canonical name', async () => {
    const installations = await loadInstallations()
    const cloud = await installations.add({
      name: 'My Renamed Cloud',
      installPath: path.join(tmpRoot, 'cloud'),
      sourceId: installations.CLOUD_SOURCE_ID,
      status: 'installed',
    })
    await installations.enforceCloudName()
    const rec = (await installations.list()).find((r) => r.id === cloud.id)!
    expect(rec.name).toBe(installations.CLOUD_INSTALL_NAME)
  })

  it('leaves a Cloud entry that already has the canonical name untouched', async () => {
    const installations = await loadInstallations()
    const cloud = await installations.add({
      name: installations.CLOUD_INSTALL_NAME,
      installPath: path.join(tmpRoot, 'cloud'),
      sourceId: installations.CLOUD_SOURCE_ID,
      status: 'installed',
    })
    await installations.enforceCloudName()
    const rec = (await installations.list()).find((r) => r.id === cloud.id)!
    expect(rec.name).toBe(installations.CLOUD_INSTALL_NAME)
  })

  it('does not touch non-Cloud installs', async () => {
    const installations = await loadInstallations()
    const local = await installations.add({
      name: 'My Local',
      installPath: path.join(tmpRoot, 'local'),
      sourceId: 'standalone',
      status: 'installed',
    })
    await installations.enforceCloudName()
    const rec = (await installations.list()).find((r) => r.id === local.id)!
    expect(rec.name).toBe('My Local')
  })

  it('is a no-op when there is no Cloud entry', async () => {
    const installations = await loadInstallations()
    await expect(installations.enforceCloudName()).resolves.toBeUndefined()
  })
})
