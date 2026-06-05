import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { nextTick } from 'vue'

import { en } from '../../lib/i18nMessages.ts'
import StatusFactPanel from './StatusFactPanel.vue'
import type { Installation } from '../../types/ipc'

function makeI18n() {
  return createI18n({ legacy: false, locale: 'en', messages: { en } })
}

function makeInstall(name: string): Installation {
  return {
    id: 'inst-1',
    name,
    sourceLabel: 'Standalone',
    sourceCategory: 'local',
    status: 'installed',
    installPath: '/tmp/inst-1',
  } as Installation
}

function makeCloudInstall(name: string): Installation {
  return {
    id: 'cloud-1',
    name,
    sourceLabel: 'Cloud',
    sourceCategory: 'cloud',
    status: 'installed',
  } as Installation
}

function mountPanel(props: {
  installation: Installation | null
  onRename?: (newName: string) => Promise<boolean>
}) {
  return mount(StatusFactPanel, {
    props: { sections: [], diskUsage: null, ...props },
    global: { plugins: [makeI18n()] },
  })
}

describe('StatusFactPanel — hero name', () => {
  // Guards that the imperatively-painted hero shows the name on mount (the watcher must key on the element ref, not just the name).
  it('shows the install name on initial mount, before any edit', async () => {
    const wrapper = mountPanel({ installation: makeInstall('Maanil\'s Comfy') })
    await nextTick()
    const name = wrapper.find('.status-fact-hero-name')
    expect(name.exists()).toBe(true)
    expect(name.text()).toBe("Maanil's Comfy")
  })

  it('commits a changed name through onRename on blur', async () => {
    const onRename = vi.fn().mockResolvedValue(true)
    const wrapper = mountPanel({ installation: makeInstall('Old'), onRename })
    await nextTick()

    const el = wrapper.find('.status-fact-hero-name')
    ;(el.element as HTMLElement).textContent = 'New Name'
    await el.trigger('blur')

    expect(onRename).toHaveBeenCalledWith('New Name')
  })

  it('does not call onRename when the name is unchanged', async () => {
    const onRename = vi.fn().mockResolvedValue(true)
    const wrapper = mountPanel({ installation: makeInstall('Same'), onRename })
    await nextTick()

    const el = wrapper.find('.status-fact-hero-name')
    await el.trigger('blur')

    expect(onRename).not.toHaveBeenCalled()
  })

  it('reverts to the canonical name when onRename rejects (duplicate)', async () => {
    const onRename = vi.fn().mockResolvedValue(false)
    const wrapper = mountPanel({ installation: makeInstall('Original'), onRename })
    await nextTick()

    const el = wrapper.find('.status-fact-hero-name')
    ;(el.element as HTMLElement).textContent = 'Duplicate'
    await el.trigger('blur')
    await nextTick()

    expect(onRename).toHaveBeenCalledWith('Duplicate')
    expect((el.element as HTMLElement).textContent).toBe('Original')
  })

  it('renders the Cloud name as static, non-editable text (issue #922)', async () => {
    const onRename = vi.fn().mockResolvedValue(true)
    const wrapper = mountPanel({ installation: makeCloudInstall('Comfy Cloud'), onRename })
    await nextTick()

    const name = wrapper.find('.status-fact-hero-name')
    expect(name.exists()).toBe(true)
    expect(name.text()).toBe('Comfy Cloud')
    // No contenteditable affordance and no pencil hint.
    expect(name.attributes('contenteditable')).toBeUndefined()
    expect(wrapper.find('.status-fact-hero-name-static').exists()).toBe(true)
    expect(wrapper.find('.status-fact-hero-edit-hint').exists()).toBe(false)

    // Blur must not commit a rename for the Cloud entry.
    await name.trigger('blur')
    expect(onRename).not.toHaveBeenCalled()
  })

  it('repaints the hero when the installation name prop changes', async () => {
    const wrapper = mountPanel({ installation: makeInstall('First') })
    await nextTick()
    expect(wrapper.find('.status-fact-hero-name').text()).toBe('First')

    await wrapper.setProps({ installation: makeInstall('Second') })
    await nextTick()
    expect(wrapper.find('.status-fact-hero-name').text()).toBe('Second')
  })
})
