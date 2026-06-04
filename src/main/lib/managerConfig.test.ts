import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { _internals, ensureManagerMirrorConfig } from './managerConfig'

describe('ensureManagerMirrorConfig', () => {
  let tmpRoot: string

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-config-'))
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('writes the mirror config at the modern Manager config path', async () => {
    await ensureManagerMirrorConfig(tmpRoot)
    const target = _internals.modernConfigPath(tmpRoot)
    expect(fs.existsSync(target)).toBe(true)
    const written = fs.readFileSync(target, 'utf-8')
    expect(written).toContain('[default]')
    expect(written).toContain(`channel_url = ${_internals.MANAGER_MIRROR_CHANNEL_URL}`)
    expect(written).toContain('bypass_ssl = true')
    expect(written).toContain('network_mode = public')
    expect(written).toContain('security_level = normal')
  })

  it('creates intermediate directories when they do not exist', async () => {
    const target = _internals.modernConfigPath(tmpRoot)
    expect(fs.existsSync(path.dirname(target))).toBe(false)
    await ensureManagerMirrorConfig(tmpRoot)
    expect(fs.existsSync(target)).toBe(true)
  })

  it('does not overwrite an existing modern config (preserves user customisations)', async () => {
    const target = _internals.modernConfigPath(tmpRoot)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const original = '[default]\nchannel_url = https://my.custom.mirror/\n'
    fs.writeFileSync(target, original, 'utf-8')

    await ensureManagerMirrorConfig(tmpRoot)

    expect(fs.readFileSync(target, 'utf-8')).toBe(original)
  })

  it('skips seeding when a legacy ComfyUI-Manager config exists', async () => {
    // Migrated installs may carry a pre-existing legacy config. Pre-seeding the
    // modern path while the legacy one exists would silently trigger Manager's
    // legacy-migration code path (pip install + dir rename). Skip entirely.
    const legacyTarget = _internals.legacyConfigPath(tmpRoot)
    fs.mkdirSync(path.dirname(legacyTarget), { recursive: true })
    fs.writeFileSync(legacyTarget, '[default]\nchannel_url = legacy\n', 'utf-8')

    await ensureManagerMirrorConfig(tmpRoot)

    expect(fs.existsSync(_internals.modernConfigPath(tmpRoot))).toBe(false)
  })

  it('targets <installPath>/ComfyUI/user/__manager/config.ini for modern installs', () => {
    expect(_internals.modernConfigPath('/some/install')).toBe(
      path.join('/some/install', 'ComfyUI', 'user', '__manager', 'config.ini')
    )
  })

  it('targets <installPath>/ComfyUI/user/default/ComfyUI-Manager/config.ini for legacy', () => {
    expect(_internals.legacyConfigPath('/some/install')).toBe(
      path.join('/some/install', 'ComfyUI', 'user', 'default', 'ComfyUI-Manager', 'config.ini')
    )
  })

  it('written config parses as INI with channel_url under [default]', async () => {
    await ensureManagerMirrorConfig(tmpRoot)
    const lines = fs.readFileSync(_internals.modernConfigPath(tmpRoot), 'utf-8').split('\n')
    const defaultStart = lines.findIndex((l) => l.trim() === '[default]')
    expect(defaultStart).toBeGreaterThanOrEqual(0)
    // All non-empty, non-section lines after [default] are key=value pairs
    // and there are no other sections, so the keys live under [default].
    const nextSection = lines.slice(defaultStart + 1).findIndex((l) => /^\[.+\]$/.test(l.trim()))
    expect(nextSection).toBe(-1)
    const bodyAfter = lines.slice(defaultStart + 1).filter((l) => l.trim().length > 0)
    expect(bodyAfter.some((l) => l.startsWith('channel_url ='))).toBe(true)
    expect(bodyAfter.some((l) => l.startsWith('bypass_ssl = true'))).toBe(true)
  })
})
