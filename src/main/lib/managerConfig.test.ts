import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { _internals, ensureManagerConfig } from './managerConfig'

describe('ensureManagerConfig', () => {
  let tmpRoot: string

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-config-'))
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  function readModern(): string {
    return fs.readFileSync(_internals.modernConfigPath(tmpRoot), 'utf-8')
  }

  describe('fresh install', () => {
    it('writes the mirror block plus the default security level when mirrors are on', async () => {
      await ensureManagerConfig(tmpRoot, { useChineseMirrors: true })
      const written = readModern()
      expect(written).toContain('[default]')
      expect(written).toContain(`channel_url = ${_internals.MANAGER_MIRROR_CHANNEL_URL}`)
      expect(written).toContain('bypass_ssl = true')
      expect(written).toContain('network_mode = public')
      expect(written).toContain('security_level = normal')
    })

    it('writes the chosen security level alongside the mirror block', async () => {
      await ensureManagerConfig(tmpRoot, { useChineseMirrors: true, securityLevel: 'weak' })
      expect(readModern()).toContain('security_level = weak')
    })

    it('writes security level only (no mirror keys) when mirrors are off', async () => {
      await ensureManagerConfig(tmpRoot, { useChineseMirrors: false, securityLevel: 'strong' })
      const written = readModern()
      expect(written).toContain('security_level = strong')
      expect(written).not.toContain('channel_url')
      expect(written).not.toContain('bypass_ssl')
    })

    it('writes nothing when neither a mirror nor a security level is requested', async () => {
      await ensureManagerConfig(tmpRoot, { useChineseMirrors: false })
      expect(fs.existsSync(_internals.modernConfigPath(tmpRoot))).toBe(false)
    })

    it('creates intermediate directories', async () => {
      const target = _internals.modernConfigPath(tmpRoot)
      expect(fs.existsSync(path.dirname(target))).toBe(false)
      await ensureManagerConfig(tmpRoot, { useChineseMirrors: true })
      expect(fs.existsSync(target)).toBe(true)
    })
  })

  describe('existing modern config', () => {
    function seed(content: string): string {
      const target = _internals.modernConfigPath(tmpRoot)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, content, 'utf-8')
      return target
    }

    it('updates only security_level and preserves the rest of the file', async () => {
      seed('[default]\nchannel_url = https://my.custom.mirror/\nsecurity_level = normal\n')
      await ensureManagerConfig(tmpRoot, { useChineseMirrors: false, securityLevel: 'weak' })
      const written = readModern()
      expect(written).toContain('channel_url = https://my.custom.mirror/')
      expect(written).toContain('security_level = weak')
      expect(written).not.toContain('security_level = normal')
    })

    it('inserts security_level when the key is absent', async () => {
      seed('[default]\nchannel_url = https://my.custom.mirror/\n')
      await ensureManagerConfig(tmpRoot, { useChineseMirrors: false, securityLevel: 'strong' })
      const written = readModern()
      expect(written).toContain('channel_url = https://my.custom.mirror/')
      expect(written).toContain('security_level = strong')
    })

    it('leaves the file untouched when the user has not chosen a level', async () => {
      const original = '[default]\nchannel_url = https://my.custom.mirror/\n'
      seed(original)
      await ensureManagerConfig(tmpRoot, { useChineseMirrors: true })
      expect(readModern()).toBe(original)
    })

    it('ignores an invalid security level', async () => {
      const original = '[default]\nsecurity_level = normal\n'
      seed(original)
      // @ts-expect-error -- exercising runtime guard against a bad persisted value
      await ensureManagerConfig(tmpRoot, { useChineseMirrors: false, securityLevel: 'bogus' })
      expect(readModern()).toBe(original)
    })
  })

  it('skips seeding entirely when a legacy ComfyUI-Manager config exists', async () => {
    const legacyTarget = _internals.legacyConfigPath(tmpRoot)
    fs.mkdirSync(path.dirname(legacyTarget), { recursive: true })
    fs.writeFileSync(legacyTarget, '[default]\nchannel_url = legacy\n', 'utf-8')

    await ensureManagerConfig(tmpRoot, { useChineseMirrors: true, securityLevel: 'weak' })

    expect(fs.existsSync(_internals.modernConfigPath(tmpRoot))).toBe(false)
  })

  describe('path helpers', () => {
    it('targets the modern __manager path', () => {
      expect(_internals.modernConfigPath('/some/install')).toBe(
        path.join('/some/install', 'ComfyUI', 'user', '__manager', 'config.ini')
      )
    })

    it('targets the legacy ComfyUI-Manager path', () => {
      expect(_internals.legacyConfigPath('/some/install')).toBe(
        path.join('/some/install', 'ComfyUI', 'user', 'default', 'ComfyUI-Manager', 'config.ini')
      )
    })
  })

  describe('withSecurityLevel', () => {
    it('replaces an existing key', () => {
      expect(_internals.withSecurityLevel('[default]\nsecurity_level = normal\n', 'weak')).toBe(
        '[default]\nsecurity_level = weak\n'
      )
    })

    it('inserts under [default] when the key is missing', () => {
      expect(_internals.withSecurityLevel('[default]\nchannel_url = x\n', 'strong')).toBe(
        '[default]\nsecurity_level = strong\nchannel_url = x\n'
      )
    })

    it('creates a [default] section when none exists', () => {
      expect(_internals.withSecurityLevel('', 'normal')).toBe('[default]\nsecurity_level = normal\n')
    })
  })
})
