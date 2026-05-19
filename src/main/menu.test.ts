import { beforeEach, describe, expect, it, vi } from 'vitest'

const { setApplicationMenu, buildFromTemplate } = vi.hoisted(() => ({
  setApplicationMenu: vi.fn(),
  buildFromTemplate: vi.fn((template: unknown) => ({ __template: template })),
}))

vi.mock('electron', () => ({
  Menu: {
    setApplicationMenu,
    buildFromTemplate,
  },
}))

import { installAppMenu } from './menu'

beforeEach(() => {
  setApplicationMenu.mockClear()
  buildFromTemplate.mockClear()
})

describe('installAppMenu', () => {
  it('clears the application menu on win32 without dev overrides', () => {
    installAppMenu('win32')
    expect(setApplicationMenu).toHaveBeenCalledTimes(1)
    expect(setApplicationMenu).toHaveBeenCalledWith(null)
    expect(buildFromTemplate).not.toHaveBeenCalled()
  })

  it('clears the application menu on linux without dev overrides', () => {
    installAppMenu('linux')
    expect(setApplicationMenu).toHaveBeenCalledTimes(1)
    expect(setApplicationMenu).toHaveBeenCalledWith(null)
    expect(buildFromTemplate).not.toHaveBeenCalled()
  })

  it('installs a View submenu on win32 when dev overrides wire Toggle DevTools', () => {
    const toggleEmbeddedDevTools = vi.fn()
    installAppMenu('win32', { toggleEmbeddedDevTools })
    expect(buildFromTemplate).toHaveBeenCalledTimes(1)
    expect(setApplicationMenu).toHaveBeenCalledTimes(1)

    const template = buildFromTemplate.mock.calls[0]?.[0] as Array<{
      role?: string
      label?: string
      submenu?: Array<{ role?: string; label?: string; click?: () => void }>
    }>
    expect(template).toEqual([
      expect.objectContaining({
        label: 'View',
        submenu: expect.arrayContaining([
          expect.objectContaining({ role: 'reload' }),
          expect.objectContaining({ label: 'Toggle Developer Tools', click: expect.any(Function) }),
        ]),
      }),
    ])
  })

  it('installs a sanitized template on darwin without close / closeAllWindows', () => {
    installAppMenu('darwin')
    expect(buildFromTemplate).toHaveBeenCalledTimes(1)
    expect(setApplicationMenu).toHaveBeenCalledTimes(1)

    const template = buildFromTemplate.mock.calls[0]?.[0] as Array<{
      role?: string
      label?: string
      submenu?: Array<{ role?: string; type?: string }>
    }>
    expect(template).toBeTruthy()

    const topLevelRoles = template.map((entry) => entry.role ?? entry.label)
    expect(topLevelRoles).toEqual(['appMenu', 'editMenu', 'Window'])

    const windowEntry = template.find((entry) => entry.label === 'Window')
    expect(windowEntry).toBeTruthy()
    const windowRoles = (windowEntry?.submenu ?? []).map((item) => item.role)
    expect(windowRoles).toContain('minimize')
    expect(windowRoles).toContain('zoom')
    expect(windowRoles).toContain('front')
    expect(windowRoles).not.toContain('close')
    expect(windowRoles).not.toContain('closeAllWindows')

    const collectRoles = (
      items: Array<{ role?: string; submenu?: unknown }> | undefined,
    ): string[] => {
      if (!items) return []
      const out: string[] = []
      for (const item of items) {
        if (item.role) out.push(item.role)
        if (Array.isArray(item.submenu)) {
          out.push(...collectRoles(item.submenu as Array<{ role?: string; submenu?: unknown }>))
        }
      }
      return out
    }
    const allRoles = collectRoles(template as unknown as Array<{ role?: string; submenu?: unknown }>)
    expect(allRoles).not.toContain('close')
    expect(allRoles).not.toContain('closeAllWindows')
  })

  it('inserts a View submenu with click-based Toggle Developer Tools when dev overrides are passed', () => {
    const toggleEmbeddedDevTools = vi.fn()
    installAppMenu('darwin', { toggleEmbeddedDevTools })
    const template = buildFromTemplate.mock.calls[0]?.[0] as Array<{
      role?: string
      label?: string
      submenu?: Array<{ label?: string; click?: (...args: unknown[]) => void }>
    }>
    const labels = template.map((e) => e.role ?? e.label)
    expect(labels).toContain('View')
    const viewEntry = template.find((e) => e.label === 'View')
    const toggle = viewEntry?.submenu?.find((i) => i.label === 'Toggle Developer Tools')
    expect(typeof toggle?.click).toBe('function')
  })
})
