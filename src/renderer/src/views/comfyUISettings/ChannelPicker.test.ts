import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import type { ActionDef, DetailField } from '../../types/ipc'
import { TID } from '../../../../shared/testIds'
import BaseSelect from '../../components/ui/BaseSelect.vue'
import ChannelPicker from './ChannelPicker.vue'

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: {} },
  missingWarn: false,
  fallbackWarn: false
})

const STABLE_TAGS = ['v0.24.1', 'v0.23.0', 'v0.22.1']

/** Stable channel field for an install sitting on the latest stable tag, so the
 *  server attaches no `update-comfyui` action (the up-to-date case). */
function upToDateStableField(): DetailField {
  return {
    id: 'updateChannel',
    label: 'Update channel',
    value: 'stable',
    editable: true,
    editType: 'channel-cards',
    options: [
      {
        value: 'stable',
        label: 'Stable',
        data: {
          installedVersion: 'v0.24.1',
          latestVersion: 'v0.24.1',
          updateAvailable: false,
          actions: undefined
        }
      },
      {
        value: 'latest',
        label: 'Latest',
        data: { installedVersion: 'v0.24.1', latestVersion: 'abc1234', updateAvailable: false }
      }
    ]
  } as unknown as DetailField
}

async function mountPicker(field: DetailField) {
  const wrapper = mount(ChannelPicker, {
    props: { field },
    global: { plugins: [i18n] }
  })
  await flushPromises()
  return wrapper
}

/** The second BaseSelect in the template is the stable version dropdown. */
function versionSelect(wrapper: ReturnType<typeof mount>) {
  const selects = wrapper.findAllComponents(BaseSelect)
  return selects[selects.length - 1]!
}

beforeEach(() => {
  window.api = {
    getStableTags: vi.fn().mockResolvedValue([...STABLE_TAGS])
  } as unknown as typeof window.api
})

describe('ChannelPicker version selector', () => {
  it('shows no update button when the picked tag matches the installed tag', async () => {
    const wrapper = await mountPicker(upToDateStableField())
    // Defaults to the installed tag — nothing to update to.
    expect(wrapper.find(`[data-testid="${TID.updateActionButton('update-comfyui')}"]`).exists()).toBe(
      false
    )
  })

  it('surfaces an update action after picking a different (older) stable tag', async () => {
    const wrapper = await mountPicker(upToDateStableField())

    await versionSelect(wrapper).vm.$emit('update:modelValue', 'v0.22.1')
    await flushPromises()

    const btn = wrapper.find(`[data-testid="${TID.updateActionButton('update-comfyui')}"]`)
    expect(btn.exists()).toBe(true)

    await btn.trigger('click')
    const emitted = wrapper.emitted('action')!
    expect(emitted).toHaveLength(1)
    const action = emitted[0]![0] as ActionDef
    expect(action.id).toBe('update-comfyui')
    expect(action.data).toMatchObject({ channel: 'stable', targetTag: 'v0.22.1' })
  })

  it('does not synthesize an update for an install whose current tag is unknown', async () => {
    const field = upToDateStableField()
    // An install ahead of its base stable tag renders as "v0.24.1 +5", which
    // isn't a clean tag — we can't pin it, so no synthesized downgrade button.
    ;(field.options![0]!.data as Record<string, unknown>).installedVersion = 'v0.24.1 +5'
    const wrapper = await mountPicker(field)

    await versionSelect(wrapper).vm.$emit('update:modelValue', 'v0.22.1')
    await flushPromises()

    expect(wrapper.find(`[data-testid="${TID.updateActionButton('update-comfyui')}"]`).exists()).toBe(
      false
    )
  })
})
