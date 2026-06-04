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
    const target = _internals.managerConfigPath(tmpRoot)
    expect(fs.existsSync(target)).toBe(true)
    const written = fs.readFileSync(target, 'utf-8')
    expect(written).toContain('[default]')
    expect(written).toContain(`channel_url = ${_internals.MANAGER_MIRROR_CHANNEL_URL}`)
    expect(written).toContain('bypass_ssl = true')
    expect(written).toContain('network_mode = public')
  })

  it('creates intermediate directories when they do not exist', async () => {
    const target = _internals.managerConfigPath(tmpRoot)
    expect(fs.existsSync(path.dirname(target))).toBe(false)
    await ensureManagerMirrorConfig(tmpRoot)
    expect(fs.existsSync(target)).toBe(true)
  })

  it('does not overwrite an existing config (preserves user customizations)', async () => {
    const target = _internals.managerConfigPath(tmpRoot)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const original = '[default]\nchannel_url = https://my.custom.mirror/\n'
    fs.writeFileSync(target, original, 'utf-8')

    await ensureManagerMirrorConfig(tmpRoot)

    expect(fs.readFileSync(target, 'utf-8')).toBe(original)
  })

  it('targets <installPath>/ComfyUI/user/__manager/config.ini', () => {
    const target = _internals.managerConfigPath('/some/install')
    expect(target).toBe(path.join('/some/install', 'ComfyUI', 'user', '__manager', 'config.ini'))
  })
})
