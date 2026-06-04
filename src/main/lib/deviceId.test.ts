import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'

// Mock paths.ts directly: configDir() reads XDG_CONFIG_HOME on Linux, bypassing
// the electron.app.getPath mock and breaking CI.
let testUserData = ''

vi.mock('./paths', () => ({
  configDir: () => testUserData
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => testUserData,
    isPackaged: false,
    on: () => {}
  }
}))

let mockSystemUuid: string | undefined = 'aabbccdd-eeff-0011-2233-445566778899'

vi.mock('systeminformation', () => ({
  default: {
    system: () => Promise.resolve({ uuid: mockSystemUuid })
  }
}))

const SALT = 'comfy-installation-id-v1'

function expectedIdFor(machineId: string): string {
  return createHash('sha256').update(`${machineId}:${SALT}`).digest('hex')
}

import type * as DeviceIdModule from './deviceId'

describe('deviceId', () => {
  let mod: typeof DeviceIdModule

  beforeEach(async () => {
    testUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'deviceid-test-'))
    mockSystemUuid = 'aabbccdd-eeff-0011-2233-445566778899'
    vi.resetModules()
    mod = await import('./deviceId')
    mod._resetForTest()
  })

  afterEach(() => {
    try {
      fs.rmSync(testUserData, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  describe('initDeviceId — fresh install (no existing file)', () => {
    it('derives installation_id from machine_id and writes device-id.txt', async () => {
      const { legacyId } = await mod.initDeviceId()
      expect(legacyId).toBeNull()
      expect(mod.getIdClass()).toBe('machine_derived')

      const expected = expectedIdFor('aabbccdd-eeff-0011-2233-445566778899')
      expect(mod.getDeviceId()).toBe(expected)

      const onDisk = fs.readFileSync(path.join(testUserData, 'device-id.txt'), 'utf-8').trim()
      expect(onDisk).toBe(expected)
    })
  })

  describe('initDeviceId — existing file matches', () => {
    it('is idempotent: re-init returns the same id and no legacyId', async () => {
      const expected = expectedIdFor('aabbccdd-eeff-0011-2233-445566778899')
      fs.writeFileSync(path.join(testUserData, 'device-id.txt'), expected)

      const { legacyId } = await mod.initDeviceId()
      expect(legacyId).toBeNull()
      expect(mod.getDeviceId()).toBe(expected)
      expect(mod.getIdClass()).toBe('machine_derived')
    })
  })

  describe('initDeviceId — legacy random UUID present', () => {
    it('returns the legacy id for one-shot migration and overwrites with the new id', async () => {
      const legacyUuid = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
      fs.writeFileSync(path.join(testUserData, 'device-id.txt'), legacyUuid)

      const { legacyId } = await mod.initDeviceId()
      expect(legacyId).toBe(legacyUuid)

      const expected = expectedIdFor('aabbccdd-eeff-0011-2233-445566778899')
      expect(mod.getDeviceId()).toBe(expected)
      const onDisk = fs.readFileSync(path.join(testUserData, 'device-id.txt'), 'utf-8').trim()
      expect(onDisk).toBe(expected)
    })

    it('does NOT re-fire the migration if the guard file is present', async () => {
      const legacyUuid = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
      fs.writeFileSync(path.join(testUserData, 'device-id.txt'), legacyUuid)
      // Prior boot already issued the alias.
      fs.writeFileSync(
        path.join(testUserData, 'identity-migration-completed'),
        new Date().toISOString()
      )

      const { legacyId } = await mod.initDeviceId()
      expect(legacyId).toBeNull()

      // The id still gets corrected (guard only suppresses the alias).
      const expected = expectedIdFor('aabbccdd-eeff-0011-2233-445566778899')

      expect(mod.getDeviceId()).toBe(expected)
    })
  })

  describe('initDeviceId — existing file is a different hash', () => {
    it('updates silently with no legacyId (treats as salt rotation or cross-machine copy)', async () => {
      const otherHash = 'a'.repeat(64)
      fs.writeFileSync(path.join(testUserData, 'device-id.txt'), otherHash)

      const { legacyId } = await mod.initDeviceId()
      expect(legacyId).toBeNull()

      const expected = expectedIdFor('aabbccdd-eeff-0011-2233-445566778899')
      expect(mod.getDeviceId()).toBe(expected)
    })
  })

  describe('initDeviceId — machine_id derivation fails', () => {
    it('falls back to a random UUID with idClass=random_fallback', async () => {
      mockSystemUuid = undefined
      const { legacyId } = await mod.initDeviceId()
      expect(legacyId).toBeNull()
      expect(mod.getIdClass()).toBe('random_fallback')
      expect(mod.getDeviceId()).toMatch(/^[0-9a-f]{64}$/i)
    })

    it('rejects placeholder firmware UUIDs and falls back', async () => {
      mockSystemUuid = '00000000-0000-0000-0000-000000000000'
      const { legacyId } = await mod.initDeviceId()
      expect(legacyId).toBeNull()
      expect(mod.getIdClass()).toBe('random_fallback')
    })
  })

  describe('initDeviceId — concurrent calls', () => {
    it('returns the same promise for concurrent callers', async () => {
      const a = mod.initDeviceId()
      const b = mod.initDeviceId()
      expect(a).toBe(b)
      const [resA, resB] = await Promise.all([a, b])
      expect(resA).toEqual(resB)
    })
  })

  describe('markIdentityMigrationCompleted', () => {
    it('writes the guard file', async () => {
      await mod.initDeviceId()
      mod.markIdentityMigrationCompleted()
      expect(fs.existsSync(path.join(testUserData, 'identity-migration-completed'))).toBe(true)
    })
  })

  describe('getDeviceId — degraded path (called before initDeviceId)', () => {
    it('reads on-disk id and flags it as random_fallback', () => {
      const seeded = 'seeded-id-value'
      fs.writeFileSync(path.join(testUserData, 'device-id.txt'), seeded)
      const id = mod.getDeviceId()
      expect(id).toBe(seeded)
      expect(mod.getIdClass()).toBe('random_fallback')
    })

    it('produces a random UUID when no file exists and flags it as random_fallback', () => {
      const id = mod.getDeviceId()
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
      expect(mod.getIdClass()).toBe('random_fallback')
    })
  })
})
